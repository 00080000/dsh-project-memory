import path from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { memoryRootFor, relativePath, storeKey } from './util/fs.js'
import { DROP, OVERSIZE, UNCHANGED, commitFileUpdates, fileKind, planFileIndex, toFileUpdate } from './index-pipeline.js'
import { ProjectMemoryStore } from './store.js'
import { onFileObserved } from './enhancer.js'

const STRONG_MARKERS = ['.git', '.hg', '.svn']

const WEAK_MARKERS = [
  '.dsh-project-memory',
  'package.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'pom.xml',
]

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

function sameDir(a, b) {
  return storeKey(path.resolve(a)) === storeKey(path.resolve(b))
}

export function findProjectRoot(filePath, ceiling = path.resolve(tmpdir())) {
  let dir = path.dirname(filePath)
  for (;;) {
    if (!sameDir(dir, ceiling)) {
      for (const marker of STRONG_MARKERS) {
        if (existsSync(path.join(dir, marker))) return dir
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir || sameDir(parent, ceiling)) break
    dir = parent
  }

  dir = path.dirname(filePath)
  let best = null
  for (;;) {
    if (!sameDir(dir, ceiling)) {
      for (const marker of WEAK_MARKERS) {
        if (existsSync(path.join(dir, marker))) return dir
      }
      if (!best && looksLikeProjectRoot(dir)) best = dir
    }
    const parent = path.dirname(dir)
    if (parent === dir || sameDir(parent, ceiling)) break
    dir = parent
  }
  return best || path.dirname(filePath)
}

export async function indexFile(ctx, config, filePath, watchManager = null) {
  const kind = fileKind(path.extname(filePath).toLowerCase())
  if (!kind) return false
  const root = findProjectRoot(filePath)
  if (!root) return false

  const memoryDir = memoryRootFor(root, config.memoryDir)
  const store = new ProjectMemoryStore(memoryDir).load()
  const rel = storeKey(relativePath(root, filePath))
  const record = store.fileRecord(rel)

  let size
  let plan
  try {
    size = statSync(filePath).size
    plan = await planFileIndex({ rel, filePath, kind, config, record, existingEntries: store.entries[rel], size })
  } catch {
    return false
  }
  if (plan.key === UNCHANGED || plan.key === OVERSIZE) return false

  if (watchManager) {
    watchManager.addRoot(root)
    store.addWatch(root)
  }

  if (plan.key !== DROP && plan.type === 'code') {
    onFileObserved(store, rel, filePath, config, root)
  }
  commitFileUpdates(store, { updates: [toFileUpdate(rel, plan, record)] })
  return plan.key !== DROP
}

export function codeFirst(paths) {
  return [...paths].sort((a, b) => {
    const aCode = fileKind(path.extname(a).toLowerCase()) === 'code' ? 0 : 1
    const bCode = fileKind(path.extname(b).toLowerCase()) === 'code' ? 0 : 1
    return aCode - bCode
  })
}

export function setupLazyIndexing(ctx, config, watchManager = null) {
  const pending = new Map()
  let timer = null

  const flush = async () => {
    timer = null
    const batch = codeFirst([...pending.keys()])
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