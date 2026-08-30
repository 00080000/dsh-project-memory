import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let ts = null
let tsPath = null

export function initTypeScript(config) {
  if (ts) return ts

  if (config?.tsPath) {
    try {
      ts = require(config.tsPath)
      tsPath = config.tsPath
      return ts
    } catch (e) {
      console.warn(`[dsh-project-memory] tsPath 无效: ${config.tsPath}`)
    }
  }

  try {
    ts = require('typescript')
    tsPath = require.resolve('typescript')
    return ts
  } catch {}

  try {
    ts = require('typescript')
    tsPath = require.resolve('typescript')
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

const PRIORITY = {
  ACTIVE: 0,
  RECENT: 1,
  BATCH: 2,
  BACKLOG: 3
}

const enhanceQueue = []
let processing = false

function getCacheDir(config) {
  const base = config.memoryDir || '.dsh-project-memory'
  return join(process.cwd(), base, 'type-cache')
}

function getCacheKey(filePath, content) {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
  return hash
}

function getCacheFile(cacheDir, key) {
  return join(cacheDir, `${key}.json`)
}

async function loadTypeCache(cacheDir, key) {
  const file = getCacheFile(cacheDir, key)
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
    const file = getCacheFile(cacheDir, key)
    writeFileSync(file, JSON.stringify(data))
  } catch {}
}

export function deepParseWithTS(filePath, content) {
  if (!ts) return null

  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true)
  const program = ts.createProgram([filePath], {})
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
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
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
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
      })
    } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      // Handle arrow functions and function expressions assigned to variables
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
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
        })
      }
    } else if (ts.isClassDeclaration(node) && node.name) {
      const typeParams = node.typeParameters?.map(tp => tp.getText()) || []
      const generics = typeParams.length ? `<${typeParams.join(', ')}>` : ''
      symbols.push({
        name: node.name.getText(),
        kind: 'class',
        typeSig: generics,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
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
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
      })
    } else if (ts.isTypeAliasDeclaration(node)) {
      const typeStr = node.type ? getTypeStr(checker.getTypeAtLocation(node.type)) : 'any'
      symbols.push({
        name: node.name.getText(),
        kind: 'type',
        typeSig: `= ${typeStr}`,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
      })
    } else {
      ts.forEachChild(node, visit)
    }
  }

  visit(sourceFile)
  return symbols
}

export function enqueueEnhance(store, relPath, filePath, priority = PRIORITY.BATCH, config) {
  if (!ts) return Promise.resolve()

  const existing = enhanceQueue.find(q => q.relPath === relPath)
  if (existing) {
    if (priority < existing.priority) {
      existing.priority = priority
    }
    return existing.promise
  }

  const p = (async () => {
    try {
      const content = readFileSync(filePath, 'utf8')
      const cacheDir = getCacheDir(config)
      const cacheKey = await getCacheKey(filePath, content)
      const cached = await loadTypeCache(cacheDir, cacheKey)
      if (cached) {
        return applyEnhancedSymbols(store, relPath, cached.symbols)
      }

      const enhanced = deepParseWithTS(filePath, content)
      if (enhanced?.length) {
        await saveTypeCache(cacheDir, cacheKey, { symbols: enhanced })
        await store.commit(fn => applyEnhancedSymbols(fn, relPath, enhanced))
      }
    } finally {
      const idx = enhanceQueue.findIndex(q => q.relPath === relPath)
      if (idx >= 0) enhanceQueue.splice(idx, 1)
    }
  })()

  enhanceQueue.push({ relPath, filePath, priority, promise: p })
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
      await task.promise
      await new Promise(r => setImmediate(r))
    }
    processing = false
  }

  processNext()
}

function applyEnhancedSymbols(fn, relPath, enhanced) {
  const record = fn.files?.get?.(relPath)
  if (!record) return
  const newEntries = enhanced.map(s => ({
    id: `${relPath.replace(/[\\/:\s]/g, '_')}#${s.line}`,
    sourcePath: relPath,
    sourceLine: s.line,
    type: 'symbol',
    title: `${s.name} (${s.kind})`,
    keywords: [s.name, s.kind],
    text: `${s.name}${s.typeSig} — ${relPath}:${s.line}`
  }))
  record.entries = newEntries
  record.enhanced = true
}

export function onFileObserved(store, relPath, filePath, config) {
  enqueueEnhance(store, relPath, filePath, PRIORITY.ACTIVE, config)
}

export function onFileChanged(store, relPath, filePath, config) {
  enqueueEnhance(store, relPath, filePath, PRIORITY.RECENT, config)
}

export function onFileIndexed(store, relPath, filePath, config) {
  enqueueEnhance(store, relPath, filePath, PRIORITY.BATCH, config)
}