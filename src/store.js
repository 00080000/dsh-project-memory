import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { rankEntries, rankExperience, tokenize } from './util/search.js'

const FORMAT_FILE = 'format.json'
const INDEX_FILE = 'index.json'
const ENTRIES_FILE = 'entries.json'
const EXPERIENCE_FILE = 'experience.json'
const WATCH_FILE = 'watch.json'
const SHARDS_DIR = 'shards'

const storeCache = new Map()

function loadJson(filePath, fallback) {
  let raw
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return fallback
  }
  try {
    return JSON.parse(raw)
  } catch {
    const backup = `${filePath}.${Date.now()}.corrupt`
    try {
      renameSync(filePath, backup)
      console.error(`[dsh-project-memory] corrupted ${path.basename(filePath)} moved to ${path.basename(backup)}; starting fresh`)
    } catch (err) {
      console.error(`[dsh-project-memory] corrupted ${path.basename(filePath)} could not be backed up: ${err.message}`)
    }
    return fallback
  }
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, filePath)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // tmp already gone (rename succeeded) or undeletable; nothing to do
    }
    throw err
  }
}

function shardRelPath(dir, rel) {
  return path.join(dir, SHARDS_DIR, createHash('sha256').update(rel).digest('hex') + '.json')
}

export class ProjectMemoryStore {
  constructor(memoryDir) {
    this.dir = memoryDir
    this.files = {}
    this.entries = {}
    this.experience = []
    this.watchlist = []
    this._dirtyShards = new Set()
    this._removedShards = new Set()
    this._dirtyExperience = false
    this._dirtyWatch = false
    this._formatWritten = false
  }

  load() {
    const key = path.resolve(this.dir)
    const hot = storeCache.get(key)
    if (hot && hot !== this) return hot
    this._migrateLegacyIfNeeded()
    this._loadSharded()
    storeCache.set(key, this)
    return this
  }

  _migrateLegacyIfNeeded() {
    const formatPath = path.join(this.dir, FORMAT_FILE)
    if (loadJson(formatPath, null)?.version === 2) {
      // 迁移在“写完标记、删旧文件前”崩溃会留下死文件；这里顺手清掉
      for (const stale of [path.join(this.dir, ENTRIES_FILE), path.join(this.dir, INDEX_FILE)]) {
        if (existsSafe(stale)) {
          try {
            unlinkSync(stale)
            console.error(`[dsh-project-memory] removed leftover legacy file ${path.basename(stale)} after migration`)
          } catch {
            // locked or gone; will be retried next load
          }
        }
      }
      return
    }
    const legacyEntriesPath = path.join(this.dir, ENTRIES_FILE)
    if (!existsSafe(legacyEntriesPath)) return
    const index = loadJson(path.join(this.dir, INDEX_FILE), {})
    const files = index.files || {}
    const entries = loadJson(legacyEntriesPath, {})
    const orphans = Object.keys(entries).filter((rel) => !(rel in files))
    if (orphans.length) {
      console.error(
        `[dsh-project-memory] migration dropped ${orphans.length} entry group(s) with no index record: ${orphans.slice(0, 3).join(', ')}${orphans.length > 3 ? ' …' : ''}`,
      )
    }
    mkdirSync(path.join(this.dir, SHARDS_DIR), { recursive: true })
    for (const rel of Object.keys(files)) {
      writeJsonAtomic(shardRelPath(this.dir, rel), { relPath: rel, record: files[rel], entries: entries[rel] || [] })
    }
    writeJsonAtomic(formatPath, { version: 2, layout: 'sharded' })
    for (const stale of [legacyEntriesPath, path.join(this.dir, INDEX_FILE)]) {
      try {
        unlinkSync(stale)
      } catch {
        // already renamed away by corrupt backup, or gone; nothing to do
      }
    }
    console.error(`[dsh-project-memory] migrated legacy store at ${this.dir} to sharded layout (${Object.keys(files).length} files)`)
  }

  _loadSharded() {
    let shardNames = []
    try {
      shardNames = readdirSync(path.join(this.dir, SHARDS_DIR)).filter((n) => n.endsWith('.json'))
    } catch {
      shardNames = []
    }
    for (const name of shardNames) {
      const shard = loadJson(path.join(this.dir, SHARDS_DIR, name), null)
      if (!shard || typeof shard.relPath !== 'string' || !shard.record) continue
      this.files[shard.relPath] = shard.record
      this.entries[shard.relPath] = shard.entries || []
    }
    this.experience = loadJson(path.join(this.dir, EXPERIENCE_FILE), [])
    this.watchlist = loadJson(path.join(this.dir, WATCH_FILE), [])
    this._formatWritten = existsSafe(path.join(this.dir, FORMAT_FILE))
  }

  cleanStaleTmp() {
    const scanDirs = [this.dir, path.join(this.dir, SHARDS_DIR)]
    const now = Date.now()
    for (const dir of scanDirs) {
      let entries
      try {
        entries = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of entries) {
        if (!name.endsWith('.tmp')) continue
        try {
          if (now - statSync(path.join(dir, name)).mtimeMs > 60000) unlinkSync(path.join(dir, name))
        } catch {
          // already gone or locked; skip
        }
      }
    }
  }

  save() {
    mkdirSync(this.dir, { recursive: true })
    this.cleanStaleTmp()
    if (!this._formatWritten) {
      writeJsonAtomic(path.join(this.dir, FORMAT_FILE), { version: 2, layout: 'sharded' })
      this._formatWritten = true
    }
    for (const rel of this._dirtyShards) {
      if (this.files[rel]) {
        mkdirSync(path.join(this.dir, SHARDS_DIR), { recursive: true })
        writeJsonAtomic(shardRelPath(this.dir, rel), { relPath: rel, record: this.files[rel], entries: this.entries[rel] || [] })
      } else {
        this._removedShards.add(rel)
      }
    }
    this._dirtyShards.clear()
    for (const rel of this._removedShards) {
      try {
        unlinkSync(shardRelPath(this.dir, rel))
      } catch {
        // shard file already gone; nothing to do
      }
    }
    this._removedShards.clear()
    if (this._dirtyExperience) {
      writeJsonAtomic(path.join(this.dir, EXPERIENCE_FILE), this.experience)
      this._dirtyExperience = false
    }
    if (this._dirtyWatch) {
      writeJsonAtomic(path.join(this.dir, WATCH_FILE), this.watchlist)
      this._dirtyWatch = false
    }
  }

  addWatch(root) {
    if (!this.watchlist.includes(root)) {
      this.watchlist.push(root)
      this._dirtyWatch = true
      return true
    }
    return false
  }

  removeWatch(root) {
    const before = this.watchlist.length
    this.watchlist = this.watchlist.filter((r) => r !== root)
    if (this.watchlist.length !== before) this._dirtyWatch = true
    return before !== this.watchlist.length
  }

  fileRecord(relPath) {
    return this.files[relPath]
  }

  markFile(relPath, record) {
    this.files[relPath] = record
    this._dirtyShards.add(relPath)
    this._removedShards.delete(relPath)
  }

  setEntries(relPath, entries) {
    if (entries.length) {
      this.entries[relPath] = entries
    } else {
      delete this.entries[relPath]
    }
    this._dirtyShards.add(relPath)
    this._removedShards.delete(relPath)
  }

  removeFile(relPath) {
    if (relPath in this.files) {
      delete this.files[relPath]
      delete this.entries[relPath]
      this._dirtyShards.add(relPath)
      this._removedShards.add(relPath)
    }
  }

  allEntries() {
    const out = []
    for (const list of Object.values(this.entries)) {
      for (const entry of list) out.push(entry)
    }
    return out
  }

  searchEntries(query, limit = 8) {
    return rankEntries(this.allEntries(), query, limit)
  }

  addExperience({ problem, solution, sourceFile }) {
    const existing = this.findSupersede(problem)
    const now = new Date().toISOString()
    if (existing) {
      existing.problem = problem
      existing.solution = solution
      if (sourceFile) existing.sourceFile = sourceFile
      existing.updatedAt = now
      this._dirtyExperience = true
      return { id: existing.id, superseded: true }
    }
    const id = randomUUID()
    this.experience.push({ id, problem, solution, sourceFile, createdAt: now, updatedAt: now })
    this.pruneExperience()
    this._dirtyExperience = true
    return { id, superseded: false }
  }

  pruneExperience() {
    const indexedFileCount = Object.keys(this.files).length
    const max = Math.max(100, Math.min(2000, indexedFileCount * 2))
    if (this.experience.length <= max) return 0
    const sorted = [...this.experience].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))
    const victims = new Set(sorted.slice(0, this.experience.length - max).map((e) => e.id))
    this.experience = this.experience.filter((e) => !victims.has(e.id))
    return victims.size
  }

  findSupersede(problem) {
    const tokens = tokenize(problem)
    if (!tokens.length) return null
    let best = null
    let bestOverlap = 0
    for (const item of this.experience) {
      const itemTokens = tokenize(item.problem)
      const overlap = itemTokens.filter((t) => tokens.includes(t)).length
      if (overlap === 0) continue
      const ratioQuery = overlap / tokens.length
      const ratioItem = overlap / itemTokens.length
      if (ratioQuery >= 0.7 && ratioItem >= 0.7 && overlap > bestOverlap) {
        best = item
        bestOverlap = overlap
      }
    }
    return best
  }

  removeExperience(idOrQuery) {
    const before = this.experience.length
    if (idOrQuery && this.experience.some((item) => item.id === idOrQuery)) {
      this.experience = this.experience.filter((item) => item.id !== idOrQuery)
    } else {
      const tokens = tokenize(idOrQuery)
      if (!tokens.length) return 0
      this.experience = this.experience.filter((item) => {
        const itemTokens = tokenize(`${item.problem} ${item.solution}`)
        if (!itemTokens.length) return true
        const overlap = itemTokens.filter((t) => tokens.includes(t)).length
        return overlap / Math.min(tokens.length, itemTokens.length) < 0.5
      })
    }
    if (this.experience.length !== before) this._dirtyExperience = true
    return before - this.experience.length
  }

  stats() {
    return {
      files: Object.keys(this.files).length,
      entries: this.allEntries().length,
      experience: this.experience.length,
    }
  }

  commit(fn) {
    const result = fn(this)
    this.save()
    return result
  }

  applyFileUpdate(relPath, { expectedHash, hash, entries, meta, deleted, type, size }) {
    const cur = this.fileRecord(relPath)
    if (!deleted && (cur?.sha256 ?? null) !== (expectedHash ?? null)) {
      return { skipped: true }
    }
    if (deleted) {
      this.removeFile(relPath)
      return { ok: true }
    }
    this.markFile(relPath, {
      sha256: hash,
      size,
      type,
      indexedAt: new Date().toISOString(),
    })
    this.setEntries(relPath, entries)
    return { ok: true }
  }
}

function existsSafe(p) {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

export function storeOverview(store) {
  let latest = null
  for (const rec of Object.values(store.files)) {
    if (rec.indexedAt && (!latest || rec.indexedAt > latest)) latest = rec.indexedAt
  }
  return {
    files: Object.keys(store.files).length,
    entries: store.allEntries().length,
    experience: store.experience.length,
    latest,
  }
}
