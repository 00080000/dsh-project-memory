import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { oneLineDeclaration } from './util/text.js'

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

const enhanceQueue = []
let processing = false

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
 * 路径归一化。
 *
 * 旧实现在 host 里用 `fileName === filePath` 认自己的文件。TypeScript 内部一律走
 * `normalizePath`（`\`→`/`、消解 `.`/`..`、绝对化），而 `path.join` 给出的是平台原生形态 ——
 * Windows 上是反斜杠。两边字符串不同 → `getSourceFile` 返回 undefined → `deepParseWithTS`
 * 静默返回 `[]`：增强整层失效且无日志。2026-09-26 的 Windows CI 就是这样挂的
 * （`test/enhancer.test.mjs` 的「增强结果落进了 store」），同一份代码在 POSIX 上从不现形。
 *
 * 用 TS 自己的 `normalizePath` 而不是自己拼：它才是权威口径。**该函数只在运行时导出、
 * `typescript.d.ts` 里没有声明**，peer 范围覆盖 TS 5/6/7，所以必须做 `typeof` 兜底。
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
  // 预建唯一的 SourceFile：它就是"这个文件"的真身，host 只需把它交出去。
  // 后面按**对象身份**确认 TS 真的收下了它，不依赖 TS 内部怎么命名。
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true)

  // Create a compiler host that provides the source file from memory
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

  // 刻意不加载默认 lib（`noLib: true`）：host 手里只有这一个文件的内容，加载 lib 需要把
  // lib.d.ts 及其引用的 6 个文件（lib.es5 / lib.decorators / lib.decorators.legacy / lib.dom /
  // lib.webworker.importscripts / lib.scripthost，共 ~2.1MB 文本）一并读盘并重解析。
  // 实测：每个 program 重解析 p50=102ms/文件；把解析好的 SourceFile 缓存跨 program 复用
  // （或走 ts.DocumentRegistry）是一次性 ~100ms + 每文件 ~1ms。本版不做，代价是全局类型
  // （Promise/Array/DOM）在 typeSig 里塌成 any/unknown —— 见 CHANGELOG「已知限制（本版未做）」。
  // 旧实现在这里留的是 `getDefaultLibLocation: () => ts.getDefaultLibFilePath({})`，返回的是
  // **文件**路径而不是目录，于是这层加载既没生效、也没人把它写下来。现在把"不载"写成声明。
  const program = ts.createProgram([filePath], { allowJs: true, noLib: true }, host)
  // 按**对象身份**确认 TS 收下了这个 SourceFile。`program.getSourceFile(filePath)` 也能问，
  // 但它内部用 `toPath(name, cwd, getCanonicalFileName)` 拼 key，对相对路径还会拼上 cwd ——
  // 正是上面那条脆弱路径。`sourceFile.parent` 恒为 undefined，不能用它判断。
  if (program.getSourceFileByPath(sourceFile.path) !== sourceFile) {
    // 走到这里 = host 没认出 root path（本该有结果却没有）。**刻意不写终端**：
    //   · 代价：watch 每 15s 一轮、每个不受支持的 root 都会撞上它，"逐轮一条"去重后仍会变成
    //     "每个文件一条"，在真实终端里就是刷屏；
    //   · 收益为 0：返回 [] 只是"这轮没有增强结果"，不会产出错误结果，调用方本来就按空处理。
    // 这个不变量的看护在 test/enhancer.test.mjs（「路径形态」那组 + 末尾的静默契约），不靠日志。
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
   * 参数列表的渲染：用**源码文本**，不是 checker 的类型串。
   *
   * 旧实现拼 `${p.name.getText()}: ${type}`，两个副作用都被「L2 会就地重写 L1 文本」放大：
   *   · 无注解的参数一律写成 `: any`（本仓库 51 个 .js/.mjs 实测：86% 的参数如此），把 L1 正则
   *     已经提取到的 `chunkChars = 3000` 换成纯噪音；
   *   · `= 默认值` / `?` / `...rest` / 解构模式全被丢掉（实测 52 个带默认值的条目里丢了 36 个）。
   * 源码文本两者都保得住，还省掉每个参数一次 checker 调用。单参数限长 80，整行仍由
   * oneLineDeclaration 收到 200 字符。
   */
  function renderParams(node) {
    return node.parameters.map((p) => oneLineDeclaration(p.getText(), 80)).join(', ')
  }

  /**
   * 返回类型只在**有信息量**时落进文本：`any`（无注解 JS 的常态）、`unknown`（未载 lib 时 async
   * 的推导结果）、`{}`（"任意非空值"）都只会把一行声明撑长，旧实现无条件写 `): any`。
   * `void` 保留 —— 它至少说明"没有返回值"。
   */
  function renderReturn(type) {
    const s = getTypeStr(type)
    return s === 'any' || s === 'unknown' || s === '{}' ? '' : `: ${s}`
  }

  /**
   * 函数表达式/箭头函数的名字。旧白名单只有 `const x = fn` / `{ m: fn }` / `class { m = fn }`，
   * 于是 CJS 最常见的 `module.exports.foo = function () {}` 产不出符号（它的父节点是
   * BinaryExpression）—— 而 isTypeScriptFile() 明确把 `.cjs` 列为可增强对象，等于承诺了拿不到。
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
        // `module.exports = function () {}`（CJS 的默认导出）：只取最后一段会得到名字
        // "exports"，既看不出它是默认导出，也容易与 `exports.foo` 混淆。保留全名。
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
      // 成员列表必须有界：一个大 interface 的全部成员拼起来能到几 KB，而它整条只作为
      // "一行声明"存在。只留前 6 个，其余记数量。
      const shown = members.slice(0, 6)
      symbols.push({
        name: node.name.getText(),
        kind: 'interface',
        typeSig: `{ ${shown.join('; ')}${members.length > shown.length ? `; … +${members.length - shown.length} more` : ''} }`,
        line: getLine(node)
      })
    } else if (ts.isTypeAliasDeclaration(node)) {
      // checker.getTypeAtLocation(node.type) 对别名返回的是**别名自身**，于是
      // `type X = { a: string }` 变成 `X= X -- f:1`。直接用类型节点的源码文本。
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

  // 用预建的那个（上面已按对象身份确认它进了 program），不再按名字回查——
  // 回查依赖 TS 内部的命名，正是 Windows 上出问题的那一步。
  visit(sourceFile)
  return symbols
}

export function enqueueEnhance(store, relPath, filePath, priority = PRIORITY.BATCH, config, root) {
  if (!ts) return Promise.resolve()

  let content
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    // 文件在"检测到变化"和"入队"之间消失了（编辑器原子保存 = 写临时文件 + rename，正好落在
    // 这个窗口）。**刻意不写终端**：这不是故障而是常态，watch 每 15s 一轮还会反复重试同一个
    // 文件 —— 即使按文件去重也仍会刷屏，而"这轮不增强"不会产出任何错误结果（返回 resolved，
    // 与成功路径对调用方无差别）。诊断靠断言，不靠日志。
    return Promise.resolve()
  }
  const cacheKey = getCacheKey(content)

  // Dedupe by (relPath, contentHash) - if same content, skip; if different, replace
  const existingIdx = enhanceQueue.findIndex(q => q.relPath === relPath)
  if (existingIdx >= 0) {
    const existing = enhanceQueue[existingIdx]
    if (existing.cacheKey === cacheKey) {
      // Same content, just update priority if higher
      if (priority < existing.priority) {
        enhanceQueue[existingIdx].priority = priority
        enhanceQueue.sort((a, b) => a.priority - b.priority)
      }
      return existing.promise
    } else {
      // Content changed - replace the task
      enhanceQueue[existingIdx] = { relPath, filePath, priority, cacheKey, promise: null }
      // Will create new promise below
    }
  }

  // 先登记队列条目，再启动任务。
  //
  // 任务体可能在**同步阶段**就跑完：`deepParseWithTS` 是同步的，没有增强结果时根本走不到
  // 那个 `await`，于是 `finally` 立刻执行。旧实现在任务启动**之后**才登记条目，并在 finally
  // 里用 `enhanceQueue.findIndex(q => q.promise === p)` 反查自己 ——
  //   · 队列为空时 `findIndex` 的回调根本不会被调用，`p` 不被求值，看不出问题；
  //   · 队列非空（真实的 watch 轮询里必然如此）时回调被调用，读到尚未初始化的 `const p`
  //     → `ReferenceError: Cannot access 'p' before initialization`。
  // `scheduleProcess` 会 await 这个 promise，但 watch 路径上抛出的那一个没人接，未处理的
  // rejection 直接把宿主打成 `dsh: fatal load failure`。
  //
  // 现在：条目先入队，finally 按**对象身份**摘除自己，完全不引用尚未初始化的绑定。
  const entry = { relPath, filePath, priority, cacheKey, promise: null }
  if (existingIdx >= 0) enhanceQueue[existingIdx] = entry
  else enhanceQueue.push(entry)

  entry.promise = (async () => {
    try {
      const content = readFileSync(filePath, 'utf8')
      const enhanced = deepParseWithTS(filePath, content)
      if (enhanced?.length) {
        await store.commit(fn => applyEnhancedSymbols(fn, relPath, enhanced))
      }
    } catch (err) {
      console.warn(`[dsh-project-memory] enhance failed for ${relPath}: ${err.message}`)
    } finally {
      // 只摘自己那一条：同 relPath 的新任务可能已经把它替换掉了（那种情况这里是 -1）。
      const idx = enhanceQueue.indexOf(entry)
      if (idx >= 0) enhanceQueue.splice(idx, 1)
    }
  })()
  enhanceQueue.sort((a, b) => a.priority - b.priority)

  scheduleProcess()
  return entry.promise
}

function scheduleProcess() {
  if (processing) return
  processing = true

  const processNext = async () => {
    while (enhanceQueue.length > 0) {
      const task = enhanceQueue.shift()
      try {
        await task.promise
      } catch (err) {
        console.warn(`[dsh-project-memory] enhance task failed: ${err.message}`)
      }
      await new Promise(r => setImmediate(r))
    }
    processing = false
  }

  processNext()
}

function applyEnhancedSymbols(fn, relPath, enhanced) {
  // Store entries in fn.entries[relPath], not fn.files[relPath].entries
  const existingEntries = fn.entries[relPath] || []
  // L1 entries carry title "name (kind)" + sourceLine but no name/line fields
  const nameOf = e => (e.title || '').replace(/\s*\([^)]*\)\s*$/, '')
  const enhancedByLine = new Map(enhanced.map(s => [s.line, s]))
  const existingKeys = new Set(existingEntries.map(e => `${nameOf(e)}#${e.sourceLine}`))

  // Upgrade L1 entries in place only when TS found the same symbol on the same line
  const mergedEntries = existingEntries.map(e => {
    const enh = enhancedByLine.get(e.sourceLine)
    if (!enh || nameOf(e) !== enh.name) return e
    return {
      ...e,
      // 一行声明（限长）。typeSig 只是构建期的中间量，不落进 entry：它没有读取方，
      // 且 interface 的 typeSig 就是整个类型体，是符号条目变胖的主因。
      // 分隔符与 L1 的 buildSymbol 保持一致（` — `）：L2 是**就地重写** L1 文本，
      // 用不同的分隔符会让同一个文件里的条目混排两种格式。
      text: oneLineDeclaration(`${enh.name}${enh.typeSig} — ${relPath}:${enh.line}`),
      typeSig: undefined,
      enhanced: true
    }
  })

  // Add enhanced symbols that L1 missed; keep ids unique even when several
  // symbols share one line (e.g. one-line class + method)
  const usedIds = new Set(existingEntries.map(e => e.id))
  const newEntries = []
  for (const s of enhanced) {
    if (existingKeys.has(`${s.name}#${s.line}`)) continue
    const base = `${relPath.replace(/[\/:\s]/g, '_')}#${s.line}`
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

  // Write to store.entries via setEntries so the shard is marked dirty and persisted
  fn.setEntries(relPath, [...mergedEntries, ...newEntries])

  // doc<->symbol 链接不在这里维护：它是读取期解算的派生关系（见 src/link.js）

  // Also update fn.files metadata
  if (fn.files[relPath]) {
    fn.files[relPath].enhanced = true
  }
}

// 三个入口都不 await 任务，所以必须各自挂一个 catch：任务体内部已经兜底，但
// **未处理的 rejection 会把整个宿主打成 `dsh: fatal load failure`**（2026-09-26 的事故就是
// 这个形状：一个 TDZ 从 watch 路径逃出去，dsh web 起不来）。这条路径不该有任何机会向上抛。
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