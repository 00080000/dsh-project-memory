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

export function deepParseWithTS(filePath, content) {
  if (!ts) return null

  // Create a compiler host that provides the source file from memory
  const host = {
    getSourceFile: (fileName, languageVersion, onError) => {
      if (fileName === filePath) {
        return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true)
      }
      return undefined
    },
    getDefaultLibFileName: (options) => ts.getDefaultLibFileName(options),
    getDefaultLibLocation: () => ts.getDefaultLibFilePath({}),
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
    useCaseSensitiveFileNames: () => true,
    fileExists: (fileName) => fileName === filePath,
    readFile: (fileName) => fileName === filePath ? content : undefined,
    directoryExists: () => true,
    getDirectories: () => [],
  }

  const program = ts.createProgram([filePath], {}, host)
  const sourceFile = program.getSourceFile(filePath)
  if (!sourceFile) return []
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

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const signature = getSignature(node)
      const returnType = getReturnType(signature)
      const typeParams = node.typeParameters?.map(tp => tp.getText()) || []
      const params = node.parameters.map(p => {
        const type = p.type ? getTypeStr(checker.getTypeAtLocation(p.type)) : 'any'
        return `${p.name.getText()}: ${type}`
      })
      const returnTypeStr = getTypeStr(returnType)
      const generics = typeParams.length ? `<${typeParams.join(', ')}>` : ''
      symbols.push({
        name: node.name.getText(),
        kind: 'function',
        typeSig: `${generics}(${params.join(', ')}): ${returnTypeStr}`,
        line: getLine(node)
      })
    } else if (ts.isMethodDeclaration(node) && node.name) {
      const signature = getSignature(node)
      const returnType = getReturnType(signature)
      const typeParams = node.typeParameters?.map(tp => tp.getText()) || []
      const params = node.parameters.map(p => {
        const type = p.type ? getTypeStr(checker.getTypeAtLocation(p.type)) : 'any'
        return `${p.name.getText()}: ${type}`
      })
      const returnTypeStr = getTypeStr(returnType)
      const generics = typeParams.length ? `<${typeParams.join(', ')}>` : ''
      symbols.push({
        name: node.name.getText(),
        kind: 'method',
        typeSig: `${generics}(${params.join(', ')}): ${returnTypeStr}`,
        line: getLine(node)
      })
    } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const parent = node.parent
      if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))) {
        const signature = getSignature(node)
        const returnType = getReturnType(signature)
        const typeParams = node.typeParameters?.map(tp => tp.getText()) || []
        const params = node.parameters.map(p => {
          const type = p.type ? getTypeStr(checker.getTypeAtLocation(p.type)) : 'any'
          return `${p.name.getText()}: ${type}`
        })
        const returnTypeStr = getTypeStr(returnType)
        const generics = typeParams.length ? `<${typeParams.join(', ')}>` : ''
        const name = parent.name?.getText() || '(anonymous)'
        const kind = ts.isArrowFunction(node) ? 'arrow' : 'function'
        symbols.push({
          name,
          kind,
          typeSig: `${generics}(${params.join(', ')}): ${returnTypeStr}`,
          line: getLine(node)
        })
      }
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

  const sf = program.getSourceFile(filePath)
  if (sf) {
    visit(sf)
  }
  return symbols
}

export function enqueueEnhance(store, relPath, filePath, priority = PRIORITY.BATCH, config, root) {
  if (!ts) return Promise.resolve()

  let content
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    // File disappeared between detection and enqueue - skip silently
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
      text: oneLineDeclaration(`${enh.name}${enh.typeSig} -- ${relPath}:${enh.line}`),
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
      text: oneLineDeclaration(`${s.name}${s.typeSig} -- ${relPath}:${s.line}`),
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