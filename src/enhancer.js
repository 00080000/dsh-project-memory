import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { linkEntries } from './link.js'

const require = createRequire(import.meta.url)

let ts = null
let tsPath = null
let tsVersion = null

function acceptTsVersion(mod) {
  if (mod && mod.version && (mod.version.startsWith('6.') || mod.version.startsWith('7.'))) {
    console.warn(`[dsh-project-memory] TypeScript ${mod.version} 不受支持，回退到 L1 正则。请使用 TS 5.x 获得增强类型。`)
    return null
  }
  return mod
}

export function initTypeScript(config) {
  if (config?.enableTypeScript === false) return null
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

function getCacheDirForRoot(root, config) {
  return join(root, config.memoryDir || '.dsh-project-memory', 'type-cache')
}

function getCacheKey(content) {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
  return hash
}

async function loadTypeCache(cacheDir, key) {
  const file = join(cacheDir, `${key}.json`)
  if (!existsSync(file)) return null
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return data
  } catch {
    return null
  }
}

async function saveTypeCache(cacheDir, key, data) {
  try {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })
    const file = join(cacheDir, `${key}.json`)
    writeFileSync(file, JSON.stringify(data))
  } catch {}
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
      }).filter(Boolean).join('; ')
      symbols.push({
        name: node.name.getText(),
        kind: 'interface',
        typeSig: `{ ${members} }`,
        line: getLine(node)
      })
    } else if (ts.isTypeAliasDeclaration(node)) {
      const typeStr = node.type ? getTypeStr(checker.getTypeAtLocation(node.type)) : 'any'
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

  const p = (async () => {
    try {
      const content = readFileSync(filePath, 'utf8')
      const cacheKey = getCacheKey(content)
      const cacheDir = getCacheDirForRoot(root || process.cwd(), config)
      const cached = await loadTypeCache(cacheDir, cacheKey)
      if (cached) {
        // Cache hit: persist via store.commit
        await store.commit(fn => applyEnhancedSymbols(fn, relPath, cached.symbols))
        return
      }

      const enhanced = deepParseWithTS(filePath, content)
      if (enhanced?.length) {
        await saveTypeCache(cacheDir, cacheKey, { symbols: enhanced })
        await store.commit(fn => applyEnhancedSymbols(fn, relPath, enhanced))
      }
    } catch (err) {
      console.warn(`[dsh-project-memory] enhance failed for ${relPath}: ${err.message}`)
    } finally {
      // Remove only this task's own queue entry (not a newer one for the same relPath)
      const idx = enhanceQueue.findIndex(q => q.promise === p)
      if (idx >= 0) enhanceQueue.splice(idx, 1)
    }
  })()

  // Update or add to queue
  const existingIdx2 = enhanceQueue.findIndex(q => q.relPath === relPath)
  if (existingIdx2 >= 0) {
    enhanceQueue[existingIdx2] = { relPath, filePath, priority, cacheKey, promise: p }
  } else {
    enhanceQueue.push({ relPath, filePath, priority, cacheKey, promise: p })
  }
  enhanceQueue.sort((a, b) => a.priority - b.priority)

  scheduleProcess()
  return p
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
      text: `${enh.name}${enh.typeSig} -- ${relPath}:${enh.line}`,
      typeSig: enh.typeSig,
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
      text: `${s.name}${s.typeSig} -- ${relPath}:${s.line}`,
      enhanced: true
    })
  }

  // Write to store.entries via setEntries so the shard is marked dirty and persisted
  fn.setEntries(relPath, [...mergedEntries, ...newEntries])

  // Refresh doc<->symbol links for newly added symbols
  if (newEntries.length) linkEntries(fn)

  // Also update fn.files metadata
  if (fn.files[relPath]) {
    fn.files[relPath].enhanced = true
  }
}

export function onFileObserved(store, relPath, filePath, config, root) {
  if (!isTypeScriptFile(filePath)) return
  enqueueEnhance(store, relPath, filePath, PRIORITY.ACTIVE, config, root)
}

export function onFileChanged(store, relPath, filePath, config, root) {
  if (!isTypeScriptFile(filePath)) return
  enqueueEnhance(store, relPath, filePath, PRIORITY.RECENT, config, root)
}

export function onFileIndexed(store, relPath, filePath, config, root) {
  if (!isTypeScriptFile(filePath)) return
  enqueueEnhance(store, relPath, filePath, PRIORITY.BATCH, config, root)
}