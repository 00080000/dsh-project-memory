// TS 增强队列：node test/enhancer.test.mjs
//
// 动机：`src/enhancer.js` 此前**零测试覆盖**（test/ 下没有任何文件 import 它）。于是下面这条
// 直接打死宿主、且只在"一次同步批次里连续入队 ≥3 个文件"时才现形的 bug 一路活到线上：
//
//   dsh: fatal load failure: ReferenceError: Cannot access 'p' before initialization
//       at enqueueEnhance (src/enhancer.js:320:5)
//
// 机理（值得记住，因为它极难复现）：
//   · `deepParseWithTS()` 是**同步**的；文件产不出增强符号时，任务体根本走不到那个 `await`，
//     于是 `finally` 在**同步阶段**就执行；
//   · 旧实现把队列条目登记在任务启动**之后**，并在 finally 里用 `q.promise === p` 反查自己；
//   · 队列为空时 `findIndex` 的回调压根不被调用，`p` 不被求值 → 看起来正常；
//   · 队列非空（调度器正忙时后面几条会积压）→ 回调被调用 → 读到尚未初始化的 `const p` → TDZ。
//   watch 一轮轮询会在**同一个同步循环**里连续回调 onFileChanged 几十次，正是这个形状。
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProjectMemoryStore } from '../src/store.js'
import { deepParseWithTS, enqueueEnhance, getTsVersion, initTypeScript, onFileChanged, onFileIndexed } from '../src/enhancer.js'
import { WatchManager } from '../src/watch.js'

let passed = 0
let failed = 0
function check(name, cond) {
  if (cond) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    console.error(`FAIL  ${name}`)
  }
}

/**
 * 轮询到条件成立为止。
 *
 * 旧实现是 `setTimeout(300)` 然后看一眼 —— 固定睡眠在慢 CI（Windows runner + Defender）上
 * 必然不稳，而这正是本文件在 Windows 上失败的方式：断言的不是"处理了"，而是"跑完了"。
 */
async function waitFor(fn, ms = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return fn()
}

/** 这个 rel 下的条目是否真的被 TS 增强过（`enhanced: true` 由 applyEnhancedSymbols 写入）。 */
const enhanced = (store, rel) => (store.entries[rel] || []).some((e) => e.enhanced === true)

initTypeScript()
if (!getTsVersion()) {
  // 没装 typescript 时 L2 增强整体关闭（enqueueEnhance 直接早返回），本文件无从断言。
  console.log('  --  typescript not resolvable, skipping (L2 enhancer is off)')
  console.log('\nALL CHECKS PASSED (0 passed)')
  process.exit(0)
}
console.log(`  --  typescript ${getTsVersion()}`)

const dir = mkdtempSync(path.join(tmpdir(), 'pm-enhancer-'))
const store = new ProjectMemoryStore(path.join(dir, '.dsh-project-memory'))
const write = (name, text) => {
  const file = path.join(dir, name)
  writeFileSync(file, text)
  return file
}
const withSymbols = (name, fnName) => write(name, `export function ${fnName}(x: number) { return x }\n`)
const noSymbols = (name) => write(name, '') // 空文件 → deepParseWithTS 返回 [] → 同步跑完 finally

console.log('\n== deepParseWithTS 真的认得出 root path（平台无关的功能断言）==')
{
  // 这条直接盯住功能本身，不依赖 store/队列等间接信号。2026-09-26 的 Windows CI 挂的是
  // 下面「增强结果落进了 store」——那只是它的间接投影。真正的病因有两个：
  //  ① host 用 `fileName === filePath` 认文件，而 TS 走 normalizePath（Windows 上反斜杠）→ 恒不相等
  //  ② `createProgram` 的 options 是 `{}`，TS 的扩展名闸门在**问 host 之前**就拒掉
  //     `.js/.jsx/.mjs/.cjs` —— 也就是说增强层对绝大多数真实文件从来没生效过（不分平台）。
  const cases = [
    ['direct.ts', 'export function direct(x: number): string { return String(x) }\nexport class Direct { run(): void {} }\n'],
    ['plain.js', 'export function plain(x) { return x }\n'],
    ['esm.mjs', 'export const arrow = (y) => y * 2\n'],
  ]
  for (const [name, src] of cases) {
    const file = write(name, src)
    const out = deepParseWithTS(file, readFileSync(file, 'utf8'))
    check(
      `deepParseWithTS 对 ${name} 返回非空（实际 ${Array.isArray(out) ? out.length : 'null'} 个符号）`,
      Array.isArray(out) && out.length > 0,
    )
  }
  const tsFile = path.join(dir, 'direct.ts')
  const tsOut = deepParseWithTS(tsFile, readFileSync(tsFile, 'utf8'))
  check('.ts 符号里含 direct 函数', Array.isArray(tsOut) && tsOut.some((s) => s.name === 'direct'))
  check('.ts 符号里带推导出的 typeSig', Array.isArray(tsOut) && tsOut.some((s) => s.typeSig && s.typeSig.includes('string')))
}

console.log('\n== 路径形态不因写法不同而失效（Windows 反斜杠的回归面）==')
{
  // 形态必须来自**字符串本身**。不能用 path.join 造差异：path.join 自己就会消解 `.`/`..`
  // 并统一分隔符 —— `path.join(dir, '.', 'shape.ts')` 与 `path.join(dir, 'shape.ts')` 是**同一个
  // 字符串**，那样的断言在旧代码（`fileName === filePath`）上也是绿的，等于没测。
  // TS 的 normalizePath 在任何平台都把 `\` 归一成 `/`，所以这三条在 Linux 上就能锁住
  // "host 认文件不靠字符串身份"，不必等 Windows CI 才有结论。
  const file = write('shape.ts', 'export function shaped(a: number): boolean { return true }\n')
  const content = readFileSync(file, 'utf8')
  const baseline = deepParseWithTS(file, content)
  const shapes = [
    ['反斜杠（Windows 形态）', `${dir.replace(/\//g, '\\')}\\shape.ts`],
    ['裸 ./ 段', `${dir}/./shape.ts`],
    ['裸 .. 段', `${dir}/sub/../shape.ts`],
  ]
  for (const [label, shape] of shapes) {
    const out = deepParseWithTS(shape, content)
    check(
      `${label} 得到同样多的符号（基线 ${baseline?.length} vs 实际 ${Array.isArray(out) ? out.length : 'null'}）`,
      Array.isArray(out) && out.length === baseline.length && out.length > 0,
    )
  }
}

console.log('\n== isTypeScriptFile 认的每种扩展名都真的产出符号（allowJs 的覆盖面）==')
{
  // 旧实现 `createProgram([filePath], {}, host)`：options 为空 → TS 的扩展名闸门在**问 host
  // 之前**就拒掉整个 .js 家族，而 isTypeScriptFile() 明确把它们列为可增强对象。
  // 内容直接喂进去（不落盘）：这里测的是闸门，不是文件系统。
  const exts = {
    '.ts': 'export function a(x: number): string { return String(x) }\n',
    '.tsx': 'export const Tsx = (p: { n: number }) => <i>{p.n}</i>\n',
    '.js': 'export function b(x) { return x }\n',
    '.jsx': 'export const Jsx = (p) => <i>{p.n}</i>\n',
    '.mjs': 'export const m = (y) => y * 2\n',
    '.cjs': 'export function c(x) { return x }\n',
    '.mts': 'export function n(x: number): number { return x }\n',
    '.cts': 'export function s(x: number): number { return x }\n',
  }
  const empty = []
  for (const [ext, src] of Object.entries(exts)) {
    const out = deepParseWithTS(path.join(dir, `ext${ext}`), src)
    if (!Array.isArray(out) || out.length === 0) empty.push(ext)
  }
  check(`8 种扩展名全部产出符号（空: ${empty.join(' ') || '无'}）`, empty.length === 0)
}

console.log('\n== L2 重写 L1 文本时不许丢信息（无注解 JS 的文本保真）==')
{
  // applyEnhancedSymbols 会**就地重写** L1 已提取条目的 text。旧实现把参数一律渲染成
  // `${name}: ${type}`，于是 `.js` 里的 `chunkChars = 3000` 变成 `chunkChars: any`：变长、
  // 变噪音、默认值消失（本仓库 51 个 .js/.mjs 实测 52 个带默认值的条目丢 36 个）。
  // 每条断言盯住一个具体的信息位，而不是整串格式。
  const sigOf = (src) => deepParseWithTS(path.join(dir, 'fidelity.js'), src)?.[0]?.typeSig || ''
  const withDefaults = sigOf('export function chunkText(text, chunkChars = 3000, maxChunks = 40) { return text }\n')
  check(`默认值留在签名里（${withDefaults}）`, withDefaults.includes('chunkChars = 3000') && withDefaults.includes('maxChunks = 40'))
  check(`无注解参数不再写成 ": any"（${withDefaults}）`, withDefaults.length > 0 && !withDefaults.includes(': any'))
  const noInfo = sigOf('export function passthrough(a) { return a }\n')
  check(`推不出类型时不追加返回注解（${noInfo}）`, noInfo.length > 0 && !/\): (any|unknown|\{\})/.test(noInfo))
  check(`推得出类型时保留返回注解（${sigOf("export function label() { return 'x' }\n")}）`, sigOf("export function label() { return 'x' }\n").includes('): string'))
  check(`rest / 解构参数保真（${sigOf('export function all({ a, b = 2 }, ...xs) { return a }\n')}）`, sigOf('export function all({ a, b = 2 }, ...xs) { return a }\n').includes('...xs'))
}

console.log('\n== CJS 的惯用写法也要产出符号 ==')
{
  // isTypeScriptFile() 把 .cjs 列为可增强对象，但旧的父节点白名单只认 `const x = fn` /
  // `{ m: fn }` / `class { m = fn }`：`module.exports.foo = function () {}` 的父节点是
  // BinaryExpression，落空 —— 于是 .cjs 的"增强"在惯用写法下是名义上的。
  const viaAssign = deepParseWithTS(path.join(dir, 'cjs.cjs'), 'module.exports.e = function (z) { return z }\n')
  check(`module.exports.e = function () {} 有符号（实际 ${viaAssign?.length ?? 'null'} 个）`, Array.isArray(viaAssign) && viaAssign.some((s) => s.name === 'e'))
  const viaLiteral = deepParseWithTS(path.join(dir, 'cjs2.cjs'), 'module.exports = { f: function (z) { return z } }\n')
  check('module.exports = { f: function () {} } 仍有符号', Array.isArray(viaLiteral) && viaLiteral.some((s) => s.name === 'f'))
  const viaDefault = deepParseWithTS(path.join(dir, 'cjs3.cjs'), 'module.exports = function (z) { return z }\n')
  check(`CJS 默认导出不叫 "exports"（实际 ${viaDefault?.[0]?.name ?? 'null'}）`, Array.isArray(viaDefault) && viaDefault.some((s) => s.name === 'module.exports'))
}

console.log('\n== 静默契约：失败不许写终端（刷屏比丢诊断更贵）==')
{
  // 这两条路径面对的都不是故障而是**常态**：文件在"检测到变化"和"入队"之间消失（编辑器
  // 原子保存 = 写临时文件 + rename），以及 root path 不被 host 接受。watch 默认 15s 一轮会
  // 反复撞上同一个文件，即使按文件去重也仍会刷屏；而两者都不会产出错误结果（入队 resolve、
  // root 不认时返回 []，与成功路径对调用方无差别）。
  // 所以契约是：**失败安静，看护靠断言**。这条断言正面锁住"别再加日志"这个决定——
  // 2026-09-26 的教训是"静默"藏住了整层失效，但解法是补测试，不是往终端打字。
  const out = []
  const realWarn = console.warn
  const realError = console.error
  console.warn = (...args) => out.push(args.join(' '))
  console.error = (...args) => out.push(args.join(' '))
  let resolved = false
  let emptyOnReject = false
  try {
    const missing = path.join(dir, 'does-not-exist.js')
    await enqueueEnhance(store, 'does-not-exist.js', missing, 2, { enableTypeScript: true }, dir)
    await enqueueEnhance(store, 'does-not-exist.js', missing, 2, { enableTypeScript: true }, dir)
    await enqueueEnhance(store, 'also-missing.js', path.join(dir, 'also-missing.js'), 2, { enableTypeScript: true }, dir)
    resolved = true
    const badRoot = path.join(dir, 'nope.css') // .css 不在 getSupportedExtensions 里 → host 认不出
    const first = deepParseWithTS(badRoot, 'body{}')
    const second = deepParseWithTS(badRoot, 'body{}')
    emptyOnReject = Array.isArray(first) && first.length === 0 && Array.isArray(second) && second.length === 0
  } finally {
    console.warn = realWarn
    console.error = realError
  }
  check(`文件消失 / root 不被接受：终端输出 0 条（实际 ${out.length} 条）`, out.length === 0)
  check('同一批调用的行为契约：入队 resolve、host 不认 root 时安静返回 []', resolved && emptyOnReject)
}

console.log('\n== 同步完成的任务不得让 enqueueEnhance 抛 TDZ ==')
{
  // 顺序很关键，复刻 watch.pollRoot 的同步批次：
  //   ① 入队后立刻被调度器 shift 走（队列空）
  //   ② 调度器正忙 → 这一条积压在队列里
  //   ③ 无增强结果 → **同步**跑完 finally，此时队列非空 ← 旧实现在这里 TDZ
  const jobs = [
    ['a.ts', withSymbols('a.ts', 'alpha')],
    ['b.ts', withSymbols('b.ts', 'beta')],
    ['c.ts', noSymbols('c.ts')],
  ]
  const promises = jobs.map(([rel, file]) => enqueueEnhance(store, rel, file, 2, { enableTypeScript: true }, dir))
  const settled = await Promise.allSettled(promises)
  const rejected = settled.filter((r) => r.status === 'rejected')
  check(
    `批次里三个任务全部 resolve（实际 ${settled.length - rejected.length}/${settled.length}）`,
    rejected.length === 0,
  )
  check('没有 "Cannot access ... before initialization"', !rejected.some((r) => /before initialization/.test(String(r.reason?.message))))
}

console.log('\n== 同步完成的任务不留僵尸队列条目 ==')
{
  // 条目若在任务跑完之后才登记，就会以"已 resolve 的 promise"永久留在队列里：
  // 同 relPath 同内容的第二次调用会直接命中它并返回那个陈旧的 promise，等于**永远不再增强**。
  const file = noSymbols('dedupe.ts')
  const first = enqueueEnhance(store, 'dedupe.ts', file, 2, { enableTypeScript: true }, dir)
  await first
  const second = enqueueEnhance(store, 'dedupe.ts', file, 2, { enableTypeScript: true }, dir)
  await second
  check('任务已结束后再入队是**新任务**（不是命中陈旧条目）', first !== second)
}

console.log('\n== 三个回调入口都不允许把 rejection 抛给宿主，且真的处理了 ==')
{
  // 未处理的 rejection 会把宿主打成 fatal load failure（本次事故的形状）。
  // 这里装一个监听器，断言这批回调之后一个都没有。
  const seen = []
  const onUnhandled = (err) => seen.push(err?.message || String(err))
  process.on('unhandledRejection', onUnhandled)
  try {
    onFileChanged(store, 'x.ts', withSymbols('x.ts', 'xray'), { enableTypeScript: true }, dir)
    onFileIndexed(store, 'y.js', write('y.js', 'export function yankee(a) { return a }\n'), { enableTypeScript: true }, dir)
    onFileChanged(store, 'z.ts', noSymbols('z.ts'), { enableTypeScript: true }, dir)
    onFileChanged(store, 'skip.md', write('skip.md', '# not code'), { enableTypeScript: true }, dir)
    await waitFor(() => enhanced(store, 'x.ts') && enhanced(store, 'y.js'))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  check('onFileChanged / onFileIndexed 不产生未处理的 rejection', seen.length === 0)
  // 旧断言是 `existsSync(store.dir)` —— store 目录只要有**任意一次** commit 就会存在，
  // 于是前面几个 block 已经把它建好，这条就永远真；它验的是"跑过了"，不是"处理了"。
  check('.ts 增强结果落进了 store（xray 带 enhanced 标记）', enhanced(store, 'x.ts'))
  check('.js 增强结果落进了 store（yankee 带 enhanced 标记）', enhanced(store, 'y.js'))
}

console.log('\n== 真实形状：一次 watch 轮询里连续改动多个 .js ==')
{
  // 这就是打死 `dsh web` 的那条路径：pollRoot 在**同一个同步循环**里对每个改动的代码文件
  // 调用 onFileChanged，一次轮询就是十几个 .js → 队列积压 → 同步完成的那个任务踩 TDZ。
  const root = mkdtempSync(path.join(tmpdir(), 'pm-enh-watch-'))
  writeFileSync(path.join(root, 'package.json'), '{}')
  for (const n of ['a', 'b', 'c', 'd', 'e']) {
    writeFileSync(path.join(root, `${n}.js`), `export function ${n}() { return ${n.length} }\n`)
  }
  // 关键：批次里必须有一个**产不出增强符号**的文件（空文件 / 只有注释）。它的任务体会在
  // 同步阶段一路走到 finally，而那时队列里还积压着前面几条 —— 旧实现就在这里读 `p`。
  writeFileSync(path.join(root, 'z-empty.js'), '')
  const wm = new WatchManager({ llm: null }, {
    memoryDir: '.dsh-project-memory',
    maxScanFiles: 100,
    maxScanDepth: 4,
    maxFileSizeMb: 50,
    chunkChars: 3000,
    maxChunksPerFile: 40,
    enableTypeScript: true,
  })
  const seen = []
  const onUnhandled = (e) => seen.push(e?.message || String(e))
  // 用 watcher 自己的取法拿同一个实例（0.5.12 起它不再长期持有 store）
  const wStore = wm.storeFor(root)
  process.on('unhandledRejection', onUnhandled)
  try {
    wm.addRoot(root)
    await wm.poll()
    await waitFor(() => enhanced(wStore, 'a.js'))
  } finally {
    process.off('unhandledRejection', onUnhandled)
    wm.stop()
  }
  check('watch 批量增强多个 .js：无未处理 rejection（旧实现在这里把宿主打成 fatal load failure）', seen.length === 0)
  // 旧用例只看 rejection，`.js` 增强全灭也照样绿。补一条"真的处理了"——这正是
  // `allowJs` 缺失能长期藏身的原因。
  check('watch 轮询里的 .js 真的被增强了（a.js 带 enhanced 标记）', enhanced(wStore, 'a.js'))
}

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECKS FAILED`} (${passed} passed)`)
process.exit(failed === 0 ? 0 : 1)
