import path from 'node:path'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isSupportedCode, isSupportedDoc, memoryRootFor, relativePath, sha256OfFile } from './util/fs.js'
import { buildDocEntries } from './doc-pipeline.js'
import { scanSymbols } from './symbols.js'
import { linkEntries } from './link.js'
import { ProjectMemoryStore, withStoreLock } from './store.js'

const PROJECT_MARKERS = [
  '.dsh-project-memory',
  '.git',
  '.hg',
  '.svn',
  'package.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'pom.xml',
]

const MAX_ASCENT = 8

const SOURCE_DIR_NAMES = new Set([
  'src', 'app', 'lib', 'libs', 'tools', 'include', 'core', 'modules',
  'scripts', 'components', 'assets', 'utils', 'shared', 'common', 'server', 'client',
])

function looksLikeProjectRoot(dir) {
  let hasReadmeFile = false
  let sourceDirs = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name.toLowerCase()
      if (entry.isDirectory()) {
        if (SOURCE_DIR_NAMES.has(name)) sourceDirs++
      } else if (name.startsWith('readme')) {
        hasReadmeFile = true
      }
    }
  } catch {
    return false
  }
  return sourceDirs >= 2 || (hasReadmeFile && sourceDirs >= 1)
}

export function findProjectRoot(filePath) {
  let dir = path.dirname(filePath)
  let best = null
  for (let i = 0; i < MAX_ASCENT; i++) {
    for (const marker of PROJECT_MARKERS) {
      if (existsSync(path.join(dir, marker))) return dir
    }
    if (looksLikeProjectRoot(dir)) best = dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return best || path.dirname(filePath)
}

export async function indexFile(ctx, config, filePath, watchManager = null) {
  const root = findProjectRoot(filePath)
  if (!root) return false
  const ext = path.extname(filePath).toLowerCase()
  if (!isSupportedDoc(ext) && !isSupportedCode(ext)) return false

  const memoryDir = memoryRootFor(root, config.memoryDir)
  return withStoreLock(memoryDir, async () => {
    const store = new ProjectMemoryStore(memoryDir).load()
    const rel = relativePath(root, filePath)
    const existing = store.fileRecord(rel)
    const { hash, size } = await sha256OfFile(filePath)
    if (existing && existing.sha256 === hash) return false

    if (watchManager) watchManager.addRoot(root)

    let entries
    if (isSupportedCode(ext)) {
      entries = scanSymbols(filePath, readFileSync(filePath, 'utf8'))
      store.markFile(rel, { sha256: hash, size, type: 'code', indexedAt: new Date().toISOString() })
    } else {
      entries = await buildDocEntries(ctx.llm, filePath, {
        chunkChars: config.chunkChars,
        maxChunks: config.maxChunksPerFile,
        maxFileSizeMb: config.maxFileSizeMb,
      })
      if (entries === null) {
        store.removeFile(rel)
        store.save()
        return false
      }
      store.markFile(rel, { sha256: hash, size, type: 'doc', indexedAt: new Date().toISOString() })
    }
    store.setEntries(rel, entries)
    store.save()
    const links = linkEntries(store)
    if (links) store.save()
    return true
  })
}

export function setupLazyIndexing(ctx, config, watchManager = null) {
  const pending = new Map()
  let timer = null

  const flush = async () => {
    timer = null
    const batch = [...pending.keys()]
    pending.clear()
    for (const filePath of batch) {
      try {
        await indexFile(ctx, config, filePath, watchManager)
      } catch (err) {
        console.error(`[dsh-project-memory] lazy index failed for ${filePath}: ${err.message}`)
      }
    }
  }

  const queue = (filePath) => {
    pending.set(filePath, true)
    if (!timer) {
      timer = setTimeout(flush, 300)
      if (timer.unref) timer.unref()
    }
  }

  ctx.on('fs/observed', (target, observation) => {
    if (!target || !observation || observation.kind !== 'present') return
    if (typeof target.displayPath !== 'string' || !target.displayPath) return
    queue(target.displayPath)
  })

  ctx.effect(() => () => {
    if (timer) clearTimeout(timer)
  })
}