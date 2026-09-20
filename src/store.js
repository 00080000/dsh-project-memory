import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { rankEntries, rankExperience, tokenize, tokenizeRaw, extractCjkPhrases, makeSearchText } from './util/search.js'
import { backfillDerivedTriggers } from './readiness.js'

const FORMAT_FILE = 'format.json'
const INDEX_FILE = 'index.json'
const ENTRIES_FILE = 'entries.json'
const EXPERIENCE_FILE = 'experience.json'
const TASKS_FILE = 'tasks.json'
const BINDING_FILE = 'binding.json'
const WATCH_FILE = 'watch.json'
const INSIGHTS_FILE = 'insights.json'
const SHARDS_DIR = 'shards'

const storeCache = new Map()
const STORE_CACHE_MAX = 32

/** 已就"无法迁移的旧 store"告警过的目录：避免每次 load() 都刷一行。 */
const migrationWarned = new Set()

/** 纯对象判定（排除 null / 数组）：磁盘读入的 JSON 形状校验统一走它。 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

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
    this.insights = { version: 1, migratedAt: null, items: [] }
    this.tasks = []
    this.binding = {}
    this.watchlist = []
    this._dirtyShards = new Set()
    this._removedShards = new Set()
    this._dirtyExperience = false
    this._dirtyInsights = false
    this._dirtyTasks = false
    this._dirtyBinding = false
    this._dirtyWatch = false
    this._formatWritten = false
    this._version = 0
    this._idfCache = null
  }

  load() {
    const key = path.resolve(this.dir)
    const hot = storeCache.get(key)
    // 缓存命中即返回：`hot === this` 时再读一遍盘会静默丢弃本实例尚未 save() 的变更
    // （_loadSharded/_loadInsights 会重新赋值 experience/tasks/insights…）。
    if (hot) return hot
    this._migrateLegacyIfNeeded()
    this._loadSharded()
    this._loadInsights()
    storeCache.set(key, this)
    // 只保留最近打开的项目：长期跨多项目运行时不至于无限增长（被逐出只是下次重新读盘）
    while (storeCache.size > STORE_CACHE_MAX) {
      const oldest = storeCache.keys().next().value
      if (oldest === key) break
      storeCache.delete(oldest)
    }
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
    const legacyIndexPath = path.join(this.dir, INDEX_FILE)
    // 先读两份旧文件：损坏的那份会在这里被 loadJson 备份为 .corrupt（保留现场）。
    const index = loadJson(legacyIndexPath, null)
    const entries = loadJson(legacyEntriesPath, null)
    if (!isRecord(index) || !isRecord(entries)) {
      const hasEntries = isRecord(entries) && Object.keys(entries).length > 0
      if (!hasEntries) {
        // entries 损坏（已备份）或本就是空的：没有可保护的数据，按空旧库收尾。
        writeJsonAtomic(formatPath, { version: 2, layout: 'sharded' })
        for (const stale of [legacyEntriesPath, legacyIndexPath]) {
          try {
            unlinkSync(stale)
          } catch {
            // already renamed away by corrupt backup, or gone; nothing to do
          }
        }
        return
      }
      // index.json 是 entries.json → rel 的唯一映射。它缺失或损坏时继续迁移，会写出 0 个
      // shard、打上 v2 标记、再把**完好的** entries.json 删掉——等于一次静默的数据清空。
      // 保留现场，不写 format 标记，等 index.json 修好后再迁（每次进程只提示一次）。
      if (!migrationWarned.has(this.dir)) {
        migrationWarned.add(this.dir)
        console.error(`[dsh-project-memory] legacy store at ${this.dir} has ${ENTRIES_FILE} but no readable ${INDEX_FILE}; migration skipped to protect it`)
      }
      return
    }
    const files = isRecord(index.files) ? index.files : {}
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
      if (!shard || typeof shard.relPath !== 'string' || !isRecord(shard.record)) continue
      this.files[shard.relPath] = shard.record
      // 畸形 shard（entries 被写成对象/null）不能让 allEntries() 在 `for…of` 上抛错，
      // 否则一个坏文件会拖垮整个进程的每一次读取。
      this.entries[shard.relPath] = Array.isArray(shard.entries) ? shard.entries.filter(isRecord) : []
    }
    this.experience = loadJson(path.join(this.dir, EXPERIENCE_FILE), [])
    this.tasks = loadJson(path.join(this.dir, TASKS_FILE), [])
    this.binding = loadJson(path.join(this.dir, BINDING_FILE), {})
    this.watchlist = loadJson(path.join(this.dir, WATCH_FILE), [])
    this._formatWritten = existsSafe(path.join(this.dir, FORMAT_FILE))
  }

  // ---- v0.5 insights：project 级 insight 文档（任务级在 task.insights[]） ----
  // 迁移语义（旧版 store 的兼容策略）：
  // v0.4 experience.json 仍由 remember/forget/query_memory 服务，不删除；
  // 首次加载把旧笔记**复制导入** insights.json（kind: experience, source: migrate），
  // migratedAt 落盘保证跨进程/崩溃幂等。销毁式收敛放到 recall 统一 PR。
  _loadInsights() {
    const doc = loadJson(path.join(this.dir, INSIGHTS_FILE), null)
    this.insights = isRecord(doc) && Array.isArray(doc.items)
      // items 里混进 null/非对象（手改或旧版写入）会让迁移与召回逐个 `.title` 抛错——过滤掉。
      ? { ...doc, items: doc.items.filter(isRecord) }
      : { version: 1, migratedAt: null, items: [] }
    this._migrateExperienceToInsights()
    // PR3：v1 → v2 懒回填派生 trigger（纯确定性、幂等；不调用模型，不改写已有字段）
    if (backfillDerivedTriggers(this.insights)) this._dirtyInsights = true
  }

  _migrateExperienceToInsights() {
    if (this.insights.migratedAt) return
    const legacy = this.experience
    if (!Array.isArray(legacy) || legacy.length === 0) return
    const now = new Date().toISOString()
    const known = new Set(this.insights.items.map((it) => it.id))
    let imported = 0
    for (const item of legacy) {
      if (!item || !item.problem || known.has(item.id)) continue
      known.add(item.id)
      this.insights.items.push({
        id: item.id,
        kind: 'experience',
        scope: 'project',
        title: String(item.problem).slice(0, 120),
        problem: item.problem,
        solution: item.solution,
        files: item.sourceFile ? [item.sourceFile] : [],
        symbols: [],
        sourceTaskIds: [],
        source: 'migrate',
        confidence: 1,
        hitCount: 0,
        createdAt: item.createdAt || now,
        updatedAt: item.updatedAt || now,
      })
      imported++
    }
    this.insights.migratedAt = now
    try {
      mkdirSync(this.dir, { recursive: true })
      writeJsonAtomic(path.join(this.dir, INSIGHTS_FILE), this.insights)
    } catch (err) {
      console.error(`[dsh-project-memory] insights migration write failed: ${err.message}`)
    }
  }

  insightsDoc() {
    return this.insights
  }

  insightItems() {
    return this.insights.items
  }

  replaceInsightItems(items) {
    this.insights.items = items
    this._dirtyInsights = true
  }

  markTasksDirty() {
    this._dirtyTasks = true
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
    // 没有脏数据就不落盘。watch 每轮对每个根都无条件 commit → save；照旧执行的话，
    // 末尾的 `_version++` + `_idfCache = null` 会打在跨实例共享的 store 上，
    // 等于每 15 秒清空一次 IDF 缓存，废掉查询侧的 IDF 复用（v0.3.4 的 20x）。
    const dirty =
      this._dirtyShards.size > 0 ||
      this._removedShards.size > 0 ||
      this._dirtyExperience ||
      this._dirtyInsights ||
      this._dirtyTasks ||
      this._dirtyBinding ||
      this._dirtyWatch ||
      !this._formatWritten
    if (dirty) mkdirSync(this.dir, { recursive: true })
    // 崩溃遗留的 *.tmp 无论有没有脏数据都顺手清掉（两次 readdir，自带 try/catch）
    this.cleanStaleTmp()
    if (!dirty) return
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
    if (this._dirtyInsights) {
      // PR3：落盘即把格式标记推到 v2（v1 → v2 是纯增量：只多一个可选的 triggerDerived）
      if (this.insights && this.insights.version !== 2) this.insights.version = 2
      writeJsonAtomic(path.join(this.dir, INSIGHTS_FILE), this.insights)
      this._dirtyInsights = false
    }
    if (this._dirtyTasks) {
      writeJsonAtomic(path.join(this.dir, TASKS_FILE), this.tasks)
      this._dirtyTasks = false
    }
    if (this._dirtyBinding) {
      writeJsonAtomic(path.join(this.dir, BINDING_FILE), this.binding)
      this._dirtyBinding = false
    }
    if (this._dirtyWatch) {
      writeJsonAtomic(path.join(this.dir, WATCH_FILE), this.watchlist)
      this._dirtyWatch = false
    }
    this._version++
    this._idfCache = null
  }

  getIdfCache() {
    if (this._idfCache && this._idfCache.version === this._version) {
      return this._idfCache.idf
    }
    const idf = this._rebuildIdf()
    this._idfCache = { version: this._version, idf }
    return idf
  }

  _rebuildIdf() {
    const entries = this.allEntries()
    const N = entries.length
    if (N === 0) return {}
    const df = {}
    for (const entry of entries) {
      const text = entry.title || ''
      const keywords = (entry.keywords || []).join(' ')
      const summary = entry.summary || ''
      const combined = `${text} ${text} ${text} ${text} ${text} ${keywords} ${summary}`.toLowerCase()
      const terms = tokenizeRaw(combined)
      const seen = new Set(terms)
      for (const t of seen) {
        df[t] = (df[t] || 0) + 1
      }
    }
    const idf = {}
    for (const [t, df_t] of Object.entries(df)) {
      idf[t] = Math.log(1 + (N - df_t + 0.5) / (df_t + 0.5))
    }
    return idf
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
      const enriched = entries.map((e) => ({ ...e, searchText: makeSearchText(e) }))
      this.entries[relPath] = enriched
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
      tasks: this.tasks.length,
      tasksActive: this.tasks.filter((t) => !t.archived).length,
      tasksArchived: this.tasks.filter((t) => t.archived).length,
    }
  }

  // ---- TaskBridge: task entities + per-session binding ----

  getTasks() {
    return this.tasks
  }

  getTask(id) {
    return this.tasks.find((t) => t.id === id)
  }

  addTask(task) {
    this.tasks.push(task)
    this._dirtyTasks = true
  }

  updateTask(id, updates) {
    const task = this.tasks.find((t) => t.id === id)
    if (!task) return false
    Object.assign(task, updates, { updatedAt: new Date().toISOString() })
    this._dirtyTasks = true
    return true
  }

  removeTask(id) {
    const idx = this.tasks.findIndex((t) => t.id === id)
    if (idx === -1) return false
    this.tasks.splice(idx, 1)
    for (const sid of Object.keys(this.binding)) {
      if (this.binding[sid] === id) delete this.binding[sid]
    }
    this._dirtyTasks = true
    this._dirtyBinding = true
    return true
  }

  setBinding(sessionId, taskId) {
    if (!sessionId) return
    this.binding[sessionId] = taskId
    this._dirtyBinding = true
  }

  getBoundTaskId(sessionId) {
    return sessionId ? this.binding[sessionId] : undefined
  }

  removeBinding(sessionId) {
    if (sessionId && sessionId in this.binding) {
      delete this.binding[sessionId]
      this._dirtyBinding = true
    }
  }

  /** 每项目任务数上限随项目体积自适应；超限按 lastActiveAt 归档最旧（只统计非归档）。 */
  pruneTasks() {
    const fileCount = Object.keys(this.files).length
    const maxTasks = Math.min(100, Math.max(5, Math.floor(fileCount / 20)))
    const nonArchived = this.tasks.filter((t) => !t.archived)
    if (nonArchived.length <= maxTasks) return 0
    const ts = (t) => new Date(t.lastActiveAt || t.updatedAt || t.createdAt || 0).getTime()
    const sorted = [...nonArchived].sort((a, b) => ts(a) - ts(b))
    const toArchive = sorted.slice(0, nonArchived.length - maxTasks)
    for (const task of toArchive) {
      task.archived = true
      this._dirtyTasks = true
    }
    return toArchive.length
  }

  commit(fn) {
    const result = fn(this)
    this.pruneTasks()
    this.save()
    return result
  }

  /**
   * 写入一条文件更新，以 expectedHash 做 CAS。
   * @returns {boolean} true = 已写入；false = 文件自扫描后又被改动，本次拒绝
   *   （调用方让该条目保持未落快照，下一轮重试）。
   * 移除条目不经过这里：调用方在 commit 里直接 removeFile（见 index-pipeline.js）。
   */
  applyFileUpdate(relPath, { expectedHash, hash, entries, type, size }) {
    if ((this.fileRecord(relPath)?.sha256 ?? null) !== (expectedHash ?? null)) return false
    this.markFile(relPath, {
      sha256: hash,
      size,
      type,
      indexedAt: new Date().toISOString(),
    })
    this.setEntries(relPath, entries)
    return true
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
