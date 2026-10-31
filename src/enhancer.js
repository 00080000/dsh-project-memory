import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { oneLineDeclaration } from './util/text.js'
import { entryIdPrefix } from './util/entry-id.js'

const require = createRequire(import.meta.url)

let ts = null
let tsPath = null
let tsVersion = null

function acceptTsVersion(mod) {
  if (mod && mod.version && mod.version.startsWith('7.')) {
    console.warn(`[dsh-project-memory] TypeScript ${mod.version} 不受支持，回退到 L1 正则。请使用 TS 5.x/6.x 获得增强类型。`)
    return null
  }
  return mod
}

export function initTypeScript(config) {
  if (config?.enableTypeScript === false) {
    // 显式关闭要把已解析的模块放掉：否则 enqueueEnhance 的 `if (!ts)` 仍会放行，
    // 配置上关了、增强器照跑。
    ts = null
    tsPath = null
    tsVersion = null
    return null
  }
  if (ts) return ts

  // 1. 配置指定路径
  if (config?.tsPath) {
    try {
      const req = createRequire(config.tsPath)
      const mod = acceptTsVersion(req(config.tsPath))
      if (mod) {
        ts = mod
        tsPath = config.tsPath
        tsVersion = mod.version
        return ts
      }
    } catch (e) {
      console.warn(`[dsh-project-memory] tsPath 无效: ${config.tsPath}`)
    }
  }

  // 2. 从用户项目 cwd 向上查找 node_modules/typescript
  try {
    const req = createRequire(process.cwd() + '/')
    const mod = acceptTsVersion(req('typescript'))
    if (mod) {
      ts = mod
      tsPath = req.resolve('typescript')
      tsVersion = mod.version
      return ts
    }
  } catch {}

  // 3. 全局（从插件自身位置解析）
  try {
    const mod = acceptTsVersion(require('typescript'))
    if (mod) {
      ts = mod
      tsPath = require.resolve('typescript')
      tsVersion = mod.version
      return ts
    }
  } catch {}

  ts = null
  return null
}

export function getTypeScript() {
  return ts
}

export function hasTypeScript() {
  return ts !== null
}

export function getTsPath() {
  return tsPath
}

export function getTsVersion() {
  return tsVersion
}

const PRIORITY = {
  ACTIVE: 0,
  RECENT: 1,
  BATCH: 2,
  BACKLOG: 3
}

/**
 * TS 增强队列的上界：`index_repo` 会对全部 TS/JS 一次性入队，队列里每条只剩元数据
 * （≈ 几百字节）。取成与 `maxScanFiles`（20000）同量级：正常仓库够不到，它只是
 * 防御"被抬高的 maxScanFiles / 异常调用方"的兜底阀。
 */
const ENHANCE_QUEUE_MAX = 20000

const enhanceQueue = []
let enhanceQueueMax = ENHANCE_QUEUE_MAX
let processing = false
/** `dropped` 计数两类丢弃：被挤掉的旧任务与被拒的新任务；`parsed` 是"出队后才解析"的证据。 */
const enhanceStats = { dropped: 0, parsed: 0 }
let droppedWarned = false

function getCacheKey(content) {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
  return hash
}

export function isTypeScriptFile(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' ||
         ext === '.mjs' || ext === '.cjs' || ext === '.mts' || ext === '.cts'
}

/**
 * 路径归一化：TS 内部一律走 `normalizePath`（`\`→`/`、消解 `.`/`..`、绝对化），
 * 而 `path.join` 给的是平台原生形态（Windows 反斜杠），字符串不同会让 `getSourceFile`
 * 返回 undefined、`deepParseWithTS` 静默返回 `[]`（2026-09-26 Windows CI 就是这样挂的）。
 * 用 TS 自己的 `normalizePath` 才是权威口径；它只在运行时导出、d.ts 无声明，必须 `typeof` 兜底。
 */
function canonicalTsPath(fileName) {
  const s = String(fileName)
  return typeof ts?.normalizePath === 'function' ? ts.normalizePath(s) : s.replace(/\\/g, '/')
}

/** 跟随 ts.sys 的实际大小写语义；拿不到时按平台回落。 */
function tsPathCaseSensitive() {
  if (ts && ts.sys && typeof ts.sys.useCaseSensitiveFileNames === 'boolean') {
    return ts.sys.useCaseSensitiveFileNames
  }
  return process.platform !== 'win32' && process.platform !== 'darwin'
}

export function deepParseWithTS(filePath, content) {
  if (!ts) return null

  const caseSensitive = tsPathCaseSensitive()
  const target = caseSensitive ? canonicalTsPath(filePath) : canonicalTsPath(filePath).toLowerCase()
  const isTarget = (fileName) => {
    const a = canonicalTsPath(fileName)
    return (caseSensitive ? a : a.toLowerCase()) === target
  }
  // 预建唯一的 SourceFile：它就是"这个文件"的真身，host 只负责交出去；后面按对象身份确认 TS 收下了它。
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true)

  const host = {
    getSourceFile: (fileName, languageVersion, onError) => (isTarget(fileName) ? sourceFile : undefined),
    getDefaultLibFileName: (options) => ts.getDefaultLibFileName(options),
    getCanonicalFileName: (fileName) => (caseSensitive ? canonicalTsPath(fileName) : canonicalTsPath(fileName).toLowerCase()),
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
    useCaseSensitiveFileNames: () => caseSensitive,
    fileExists: (fileName) => isTarget(fileName),
    readFile: (fileName) => (isTarget(fileName) ? content : undefined),
    directoryExists: () => true,
    getDirectories: () => [],
  }

  // 刻意不加载默认 lib（`noLib: true`）：host 手里只有这一个文件，加载 lib 需要读盘并重解析
  // lib.d.ts 及引用的 6 个文件（~2.1MB）；实测每 program 重解析 p50=102ms/文件。
  // 代价是全局类型（Promise/Array/DOM）在 typeSig 里塌成 any/unknown（见 CHANGELOG 已知限制）。
  const program = ts.createProgram([filePath], { allowJs: true, noLib: true }, host)
  // 按对象身份确认 TS 收下了这个 SourceFile：`program.getSourceFile(filePath)` 内部用
  // `toPath(name, cwd, ...)` 拼 key，正是上面那条脆弱路径；`sourceFile.parent` 恒为 undefined。
  if (program.getSourceFileByPath(sourceFile.path) !== sourceFile) {
    // host 没认出 root path。刻意不写终端：watch 每 15s 一轮会把"每个文件一条"刷成刷屏，
    // 而返回 [] 不会产出错误结果，调用方本来就按空处理。
    // 不变量由 test/enhancer.test.mjs（「路径形态」+ 末尾静默契约）看护。
    return []
  }
  const checker = program.getTypeChecker()

  const symbols = []

  function getSignature(node) {
    try {
      return checker.getSignatureFromDeclaration(node)
    } catch {
      return undefined
    }
  }

  function getReturnType(signature) {
    if (!signature) return null
    try {
      return checker.getReturnTypeOfSignature(signature)
    } catch {
      return null
    }
  }

  function getTypeStr(type) {
    if (!type) return 'void'
    try {
      return checker.typeToString(type)
    } catch {
      return 'any'
    }
  }

  function getLine(node) {
    const pos = node.getStart()
    if (pos < 0) return 1
    return sourceFile.getLineAndCharacterOfPosition(pos).line + 1
  }

  /**
   * 参数列表的渲染：用源码文本，不是 checker 的类型串。旧实现拼 `name: type` 把无注解
   * 参数一律写成 `: any`，还丢掉 `= 默认值` / `?` / `...rest` / 解构模式；源码文本都保得住，
   * 还省掉每参数一次 checker 调用。单参数限长 80，整行仍由 oneLineDeclaration 收到 200。
   */
  function renderParams(node) {
    return node.parameters.map((p) => oneLineDeclaration(p.getText(), 80)).join(', ')
  }

  /**
   * 返回类型只在有信息量时落进文本：`any`（无注解 JS 的常态）、`unknown`（未载 lib 时的
   * async 推导）、`{}` 只会把一行声明撑长；`void` 保留——它至少说明"没有返回值"。
   */
  function renderReturn(type) {
    const s = getTypeStr(type)
    return s === 'any' || s === 'unknown' || s === '{}' ? '' : `: ${s}`
  }

  /**
   * 函数表达式/箭头函数的名字。白名单必须覆盖 `module.exports.foo = function () {}`：
   * 它的父节点是 BinaryExpression，漏了它 `.cjs`（isTypeScriptFile 明确支持）就产不出符号。
   */
  function callableName(node) {
    const parent = node.parent
    if (!parent) return null
    if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
      return parent.name?.getText() || '(anonymous)'
    }
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = parent.left
      if (ts.isPropertyAccessExpression(left)) {
        // `module.exports = function () {}`（CJS 默认导出）：只取 "exports" 既看不出是默认导出，也易与 exports.foo 混淆，保留全名。
        if (ts.isIdentifier(left.expression) && left.expression.text === 'module' && left.name.text === 'exports') {
          return 'module.exports'
        }
        return left.name.getText()
      }
      if (ts.isIdentifier(left)) return left.getText()
      if (ts.isElementAccessExpression(left) && ts.isStringLiteralLike(left.argumentExpression)) {
        return left.argumentExpression.text
      }
    }
    return null
  }

  /** 三个 callable 分支共用：名字与种类由调用方给，类型串的渲染只此一处。 */
  function pushCallable(node, name, kind) {
    const typeParams = node.typeParameters?.map((tp) => tp.getText()) || []
    const generics = typeParams.length ? `<${typeParams.join(', ')}>` : ''
    symbols.push({
      name,
      kind,
      typeSig: `${generics}(${renderParams(node)})${renderReturn(getReturnType(getSignature(node)))}`,
      line: getLine(node)
    })
  }

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      pushCallable(node, node.name.getText(), 'function')
    } else if (ts.isMethodDeclaration(node) && node.name) {
      pushCallable(node, node.name.getText(), 'method')
    } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const name = callableName(node)
      if (name) pushCallable(node, name, ts.isArrowFunction(node) ? 'arrow' : 'function')
    } else if (ts.isClassDeclaration(node) && node.name) {
      const typeParams = node.typeParameters?.map(tp => tp.getText()) || []
      const generics = typeParams.length ? `<${typeParams.join(', ')}>` : ''
      symbols.push({
        name: node.name.getText(),
        kind: 'class',
        typeSig: generics,
        line: getLine(node)
      })
      ts.forEachChild(node, visit)
    } else if (ts.isInterfaceDeclaration(node)) {
      const members = node.members.map(m => {
        // Skip index signatures (m.name is undefined for index signatures like [key: string]: T)
        if (!m.name) return null
        const type = m.type ? getTypeStr(checker.getTypeAtLocation(m.type)) : 'any'
        return `${m.name.getText()}: ${type}`
      }).filter(Boolean)
      // 成员列表必须有界：一个大 interface 全拼能到几 KB；只留前 6 个，其余记数量。
      const shown = members.slice(0, 6)
      symbols.push({
        name: node.name.getText(),
        kind: 'interface',
        typeSig: `{ ${shown.join('; ')}${members.length > shown.length ? `; … +${members.length - shown.length} more` : ''} }`,
        line: getLine(node)
      })
    } else if (ts.isTypeAliasDeclaration(node)) {
      // checker.getTypeAtLocation 对别名返回别名自身（`type X = {...}` → `X = X`），直接用类型节点的源码文本。
      const typeStr = node.type ? node.type.getText().replace(/\s+/g, ' ').slice(0, 200) : 'any'
      symbols.push({
        name: node.name.getText(),
        kind: 'type',
        typeSig: `= ${typeStr}`,
        line: getLine(node)
      })
    } else {
      ts.forEachChild(node, visit)
    }
  }

  // 用预建的那个（已按对象身份确认进了 program），不再按名字回查——回查依赖 TS 内部命名。
  visit(sourceFile)
  return symbols
}

/**
 * 入队一个 TS 增强任务。两条不变式：
 * 1. 任务体在出队时才跑：入队只读一次文件算 cacheKey，正文与解析结果不留在队列里；
 *    否则 `index_repo` 对整棵 TS 树入队 = 同时持有所有正文与符号数组（RSS 单调爬升）。
 * 2. 有界：超了先挤队尾（最不紧急），挤不动就丢新来的；被丢的 promise 立刻 resolve，
 *    丢弃计数由 `enhanceQueueStats()` 暴露、`index_repo` 写进报告——不静默。
 * 去重：同 relPath 同内容复用，内容变了换掉；已开始跑的任务不在队列里，不受影响。
 */
export function enqueueEnhance(store, relPath, filePath, priority = PRIORITY.BATCH, config, root) {
  if (!ts) return Promise.resolve()

  let content
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    // 文件在"检测到变化"和"入队"之间消失（原子保存 = 写临时文件 + rename）。刻意不写终端：
    // 这是常态，watch 每 15s 一轮会反复重试，而这轮不增强不产出错误结果（返回 resolved）。
    return Promise.resolve()
  }
  const cacheKey = getCacheKey(content)

  // 去重：同 relPath 同内容 → 复用队列里那条 promise。
  const existingIdx = enhanceQueue.findIndex(q => q.relPath === relPath)
  if (existingIdx >= 0) {
    const existing = enhanceQueue[existingIdx]
    if (existing.cacheKey === cacheKey) {
      if (priority < existing.priority) {
        existing.priority = priority
        enhanceQueue.sort((a, b) => a.priority - b.priority)
      }
      return existing.promise
    }
    // 内容变了：那条还没开始跑 → 换掉并让它 promise 立刻 resolve，否则调用方永远悬着。
    existing.resolve()
    enhanceQueue.splice(existingIdx, 1)
  }

  const task = { store, relPath, filePath, priority, cacheKey, promise: null, resolve: null, hadRecord: Boolean(store?.files?.[relPath]) }
  task.promise = new Promise((resolve) => { task.resolve = resolve })

  if (enhanceQueue.length >= enhanceQueueMax) {
    // 满：优先挤掉队尾（priority 数字最大 = 最不紧急）；挤不动（对方更紧急）就丢新来的。
    // 两条路都计数 + 一次告警，绝不静默。
    const last = enhanceQueue[enhanceQueue.length - 1]
    if (last && last.priority > priority) {
      enhanceQueue.pop()
      last.resolve()
      warnDropped()
    } else {
      warnDropped()
      task.resolve()
      return task.promise
    }
  }

  enhanceQueue.push(task)
  enhanceQueue.sort((a, b) => a.priority - b.priority)
  scheduleProcess()
  return task.promise
}

/** 只打一次：这是降级说明（有些文件这轮没有 L2 增强），不是每轮刷屏的故障。 */
function warnDropped() {
  enhanceStats.dropped++
  if (droppedWarned) return
  droppedWarned = true
  console.warn(
    `[dsh-project-memory] TS 增强队列已满（上限 ${enhanceQueueMax}）：优先级最低的任务被丢弃。` +
      '这些文件仍有 L1 正则符号，只是没有 L2 类型增强；下次索引 / 改动会重新入队。',
  )
}

/**
 * 队列现状。`index_repo` 用它把"这轮丢了多少"写进报告（不静默），测试用它断言
 * 「入队同步阶段只解析 1 个」与上界。
 */
export function enhanceQueueStats() {
  return { queued: enhanceQueue.length, max: enhanceQueueMax, dropped: enhanceStats.dropped, parsed: enhanceStats.parsed }
}

/** 仅供测试：临时收窄队列上限（返回恢复函数），免得测试真去排两万条。 */
export function _setEnhanceQueueMaxForTest(n) {
  const previous = enhanceQueueMax
  enhanceQueueMax = Number.isFinite(n) && n > 0 ? n : ENHANCE_QUEUE_MAX
  return () => { enhanceQueueMax = previous }
}

/** 出队之后才真正干活：此刻才读正文、才解析（正文与解析结果只活到这一步结束）。 */
async function runEnhance(task) {
  let content
  try {
    content = readFileSync(task.filePath, 'utf8')
  } catch {
    return // 同入队路径：文件没了不是故障，安静跳过
  }
  enhanceStats.parsed++
  try {
    const enhanced = deepParseWithTS(task.filePath, content)
    if (enhanced?.length) {
      await task.store.commit(fn => applyEnhancedSymbols(fn, task.relPath, enhanced, { hadRecord: task.hadRecord }))
    }
  } catch (err) {
    console.warn(`[dsh-project-memory] enhance failed for ${task.relPath}: ${err.message}`)
  } finally {
    task.resolve()
  }
}

function scheduleProcess() {
  if (processing) return
  processing = true

  const processNext = async () => {
    while (enhanceQueue.length > 0) {
      const task = enhanceQueue.shift()
      try {
        await runEnhance(task)
      } catch (err) {
        // runEnhance 内部已兜底；这里再兜一层，保证调度循环不会因单条任务死掉。
        console.warn(`[dsh-project-memory] enhance task failed: ${err.message}`)
        task.resolve()
      }
      await new Promise(r => setImmediate(r))
    }
    processing = false
  }

  processNext()
}

function applyEnhancedSymbols(fn, relPath, enhanced, { hadRecord = false } = {}) {
  // 入队时这个文件还有记录、轮到执行时却没了：说明它已被删除/移出索引。此时再 setEntries
  // 会写下**没有 files 记录**的孤儿符号，unseen 清理看不到它（只遍历 files），查询却会一直命它。
  // `hadRecord` 为 false 的调用（测试 / 直接对未索引文件增强）保持旧行为：从零建条目。
  if (hadRecord && !fn.files[relPath]) return
  // Store entries in fn.entries[relPath], not fn.files[relPath].entries
  const existingEntries = fn.entries[relPath] || []
  const nameOf = e => (e.title || '').replace(/\s*\([^)]*\)\s*$/, '')
  const enhancedByLine = new Map(enhanced.map(s => [s.line, s]))
  const existingKeys = new Set(existingEntries.map(e => `${nameOf(e)}#${e.sourceLine}`))

  const mergedEntries = existingEntries.map(e => {
    const enh = enhancedByLine.get(e.sourceLine)
    if (!enh || nameOf(e) !== enh.name) return e
    return {
      ...e,
      // 一行声明（限长）。typeSig 只是构建期中间量，不落进 entry（无读取方，且 interface 的 typeSig
      // 就是整个类型体）。分隔符与 L1 的 buildSymbol 一致（` — `）：L2 就地重写 L1 文本，混用会混排格式。
      text: oneLineDeclaration(`${enh.name}${enh.typeSig} — ${relPath}:${enh.line}`),
      typeSig: undefined,
      enhanced: true
    }
  })

  // 补上 L1 漏掉的符号；同一行有多个符号时 id 仍要唯一（如单行 class + method）
  const usedIds = new Set(existingEntries.map(e => e.id))
  const newEntries = []
  for (const s of enhanced) {
    if (existingKeys.has(`${s.name}#${s.line}`)) continue
    const base = `${entryIdPrefix(relPath)}#${s.line}`
    let id = base
    if (usedIds.has(id)) id = `${base}-${s.kind}`
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${s.kind}-${n}`
    usedIds.add(id)
    newEntries.push({
      id,
      sourcePath: relPath,
      sourceLine: s.line,
      type: 'symbol',
      title: `${s.name} (${s.kind})`,
      keywords: [s.name, s.kind],
      text: oneLineDeclaration(`${s.name}${s.typeSig} — ${relPath}:${s.line}`),
      enhanced: true
    })
  }

  fn.setEntries(relPath, [...mergedEntries, ...newEntries])

  // doc<->symbol 链接不在这里维护：它是读取期解算的派生关系（见 src/link.js）

  if (fn.files[relPath]) {
    fn.files[relPath].enhanced = true
  }
}

// 三个入口都不 await 任务，所以必须各自挂 catch：任务体内部已兜底，但**未处理的 rejection
// 会把整个宿主打成 `dsh: fatal load failure`**（2026-09-26 的事故就是这个形状）。这条路径不该向上抛。
const fireAndForget = (p) => {
  if (p && typeof p.catch === 'function') p.catch(() => {})
}

export function onFileObserved(store, relPath, filePath, config, root) {
  if (!isTypeScriptFile(filePath)) return
  fireAndForget(enqueueEnhance(store, relPath, filePath, PRIORITY.ACTIVE, config, root))
}

export function onFileChanged(store, relPath, filePath, config, root) {
  if (!isTypeScriptFile(filePath)) return
  fireAndForget(enqueueEnhance(store, relPath, filePath, PRIORITY.RECENT, config, root))
}

export function onFileIndexed(store, relPath, filePath, config, root) {
  if (!isTypeScriptFile(filePath)) return
  fireAndForget(enqueueEnhance(store, relPath, filePath, PRIORITY.BATCH, config, root))
}