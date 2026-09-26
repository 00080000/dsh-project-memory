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
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProjectMemoryStore } from '../src/store.js'
import { enqueueEnhance, getTsVersion, initTypeScript, onFileChanged, onFileIndexed } from '../src/enhancer.js'
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

console.log('\n== 三个回调入口都不允许把 rejection 抛给宿主 ==')
{
  // 未处理的 rejection 会把宿主打成 fatal load failure（本次事故的形状）。
  // 这里装一个监听器，断言这批回调之后一个都没有。
  const seen = []
  const onUnhandled = (err) => seen.push(err?.message || String(err))
  process.on('unhandledRejection', onUnhandled)
  try {
    onFileChanged(store, 'x.ts', withSymbols('x.ts', 'xray'), { enableTypeScript: true }, dir)
    onFileIndexed(store, 'y.ts', withSymbols('y.ts', 'yankee'), { enableTypeScript: true }, dir)
    onFileChanged(store, 'z.ts', noSymbols('z.ts'), { enableTypeScript: true }, dir)
    onFileChanged(store, 'skip.md', write('skip.md', '# not code'), { enableTypeScript: true }, dir)
    await new Promise((r) => setTimeout(r, 300))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  check('onFileChanged / onFileIndexed 不产生未处理的 rejection', seen.length === 0)
  check('增强结果落进了 store（有符号的文件确实被处理过）', existsSync(store.dir))
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
  process.on('unhandledRejection', onUnhandled)
  try {
    wm.addRoot(root)
    await wm.poll()
    await new Promise((r) => setTimeout(r, 400))
  } finally {
    process.off('unhandledRejection', onUnhandled)
    wm.stop()
  }
  check('watch 批量增强多个 .js：无未处理 rejection（旧实现在这里把宿主打成 fatal load failure）', seen.length === 0)
}

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECKS FAILED`} (${passed} passed)`)
process.exit(failed === 0 ? 0 : 1)
