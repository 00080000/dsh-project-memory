import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { rankEntries, rankExperience, tokenize } from './util/search.js'

const INDEX_FILE = 'index.json'
const ENTRIES_FILE = 'entries.json'
const EXPERIENCE_FILE = 'experience.json'
const WATCH_FILE = 'watch.json'

const dirLocks = new Map()

export async function withStoreLock(memoryDir, fn) {
  const key = path.resolve(memoryDir)
  const prev = dirLocks.get(key) || Promise.resolve()
  let release
  const cur = new Promise((resolve) => {
    release = resolve
  })
  const chain = prev.then(() => cur)
  dirLocks.set(key, chain)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (dirLocks.get(key) === chain) dirLocks.delete(key)
  }
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, filePath)
}

export class ProjectMemoryStore {
  constructor(memoryDir) {
    this.dir = memoryDir
    this.files = {}
    this.entries = {}
    this.experience = []
    this.watchlist = []
  }

  load() {
    const index = loadJson(path.join(this.dir, INDEX_FILE), {})
    this.files = index.files || {}
    this.entries = loadJson(path.join(this.dir, ENTRIES_FILE), {})
    this.experience = loadJson(path.join(this.dir, EXPERIENCE_FILE), [])
    this.watchlist = loadJson(path.join(this.dir, WATCH_FILE), [])
    return this
  }

  save() {
    mkdirSync(this.dir, { recursive: true })
    writeJsonAtomic(path.join(this.dir, INDEX_FILE), { version: 1, files: this.files })
    writeJsonAtomic(path.join(this.dir, ENTRIES_FILE), this.entries)
    writeJsonAtomic(path.join(this.dir, EXPERIENCE_FILE), this.experience)
    writeJsonAtomic(path.join(this.dir, WATCH_FILE), this.watchlist)
  }

  addWatch(root) {
    if (!this.watchlist.includes(root)) {
      this.watchlist.push(root)
      return true
    }
    return false
  }

  fileRecord(relPath) {
    return this.files[relPath]
  }

  markFile(relPath, record) {
    this.files[relPath] = record
  }

  setEntries(relPath, entries) {
    if (entries.length) {
      this.entries[relPath] = entries
    } else {
      delete this.entries[relPath]
    }
  }

  removeFile(relPath) {
    delete this.files[relPath]
    delete this.entries[relPath]
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

  searchExperience(query, limit = 5) {
    const scored = this.experience.map((item) => ({ item, score: scoreExperience(item, query) }))
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.item)
  }

  addExperience({ problem, solution, sourceFile }) {
    const existing = this.findSupersede(problem)
    const now = new Date().toISOString()
    if (existing) {
      existing.problem = problem
      existing.solution = solution
      if (sourceFile) existing.sourceFile = sourceFile
      existing.updatedAt = now
      return { id: existing.id, superseded: true }
    }
    const id = randomUUID()
    this.experience.push({ id, problem, solution, sourceFile, createdAt: now, updatedAt: now })
    this.pruneExperience()
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
      const base = Math.min(tokens.length, itemTokens.length)
      if (base && overlap / base >= 0.6 && overlap > bestOverlap) {
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
    return before - this.experience.length
  }

  stats() {
    return {
      files: Object.keys(this.files).length,
      entries: this.allEntries().length,
      experience: this.experience.length,
    }
  }
}

function scoreExperience(item, query) {
  const tokens = tokenize(query)
  if (!tokens.length) return 0
  const problemTokens = tokenize(item.problem)
  const solutionTokens = tokenize(item.solution || '')
  let score = 0
  score += problemTokens.filter((t) => tokens.includes(t)).length * 4
  score += solutionTokens.filter((t) => tokens.includes(t)).length * 2
  const lower = `${item.problem} ${item.solution}`.toLowerCase()
  if (tokens.some((t) => lower.includes(t))) score += 2
  return score
}