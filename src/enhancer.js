import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let ts = null
let tsPath = null
let tsVersion = null

export function initTypeScript(config) {
  if (ts) return ts

  // 1. 配置指定路径
  if (config?.tsPath) {
    try {
      const req = createRequire(config.tsPath)
      ts = req(config.tsPath)
      tsPath = config.tsPath
      tsVersion = ts.version
      return ts
    } catch (e) {
      console.warn(`[dsh-project-memory] tsPath 无效: ${config.tsPath}`)
    }
  }

  // 2. 从用户项目 cwd 向上查找 node_modules/typescript
  try {
    const req = createRequire(process.cwd() + '/')
    ts = req('typescript')
    tsPath = req.resolve('typescript')
    tsVersion = ts.version
    return ts
  } catch {}

  // 3. 全局
  try {
    const req = createRequire(process.cwd() + '/')
    ts = req('typescript')
    tsPath = req.resolve('typescript')
    tsVersion = ts.version
    return ts
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
  const base = config.memoryDir || '.dsh-project-memory'
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
  return ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx'
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
      symbols.push({
        name: node.name.getText(),
        kind: 'interface',
        typeSig: `{ ${node.members.map(m => {
          const type = m.type ? getTypeStr(checker.getTypeAtLocation(m.type)) : 'any'
          return `${m.name.getText()}: ${type}`
        }).join('; ')} }`,
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

  const content = readFileSync(filePath, 'utf8')
  const cacheKey = getCacheKey(content)

  // Dedupe by (relPath, contentHash) - if same content, skip; if different, replace
  const existingIdx = enhanceQueue.findIndex(q => q.relPath === relPath)
  if (existingIdx >= 0) {
    const existing = enhanceQueue[existingIdx]
    if (existing.cacheKey === cacheKey) {
      // Same content, just update priority if higher
      if (priority < existing.priority) {
        enhanceQueue[existingIdx].priority = priority
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
      const idx = enhanceQueue.findIndex(q => q.relPath === relPath)
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
  // fn.files is a plain object, not Map
  const record = fn.files[relPath]
  if (!record) return
  
  // Merge: keep existing L1 entries, update/add enhanced ones
  const existingEntries = record.entries || []
  const enhancedMap = new Map(enhanced.map(s => [`${s.name}#${s.line}`, s]))
  
  const mergedEntries = existingEntries.map(e => {
    const key = `${e.title}#${e.sourceLine}` // approximate key
    return enhancedMap.get(key) ? {
      ...e,
      text: enhancedMap.get(key).text,
      typeSig: enhancedMap.get(key).typeSig,
      enhanced: true
    } : e
  })
  
  // Add new enhanced entries not in L1
  const existingKeys = new Set(existingEntries.map(e => `${e.title}#${e.sourceLine}`))
  const newEntries = enhanced.filter(s => !existingKeys.has(`${s.name}#${s.line}`))
    .map(s => ({
      id: `${s.name}#${s.line}`.replace(/[\/:\s]/g, '_'),
      sourcePath: relPath,
      sourceLine: s.line,
      type: 'symbol',
      title: `${s.name} (${s.kind})`,
      keywords: [s.name, s.kind],
      text: `${s.name}${s.typeSig} -- ${relPath}:${s.line}`,
      enhanced: true
    }))

  record.entries = [...mergedEntries, ...newEntries]
  record.enhanced = true
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