import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { rankExperience, tokenize, tokenizeRaw, extractCjkPhrases, makeSearchText } from './util/search.js'
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
const GITIGNORE_FILE = '.gitignore'
/** ≤0.5.10 的 TS 增强结果缓存目录；0.5.11 起废弃并自愈清理。 */
const LEGACY_TYPE_CACHE_DIR = 'type-cache'

const storeCache = new Map()
/** 单实例超预算的告警只打一次（key = 解析后的 store 目录）。 */
const warnedOverBudget = new Set()
/** 条目数上限（兜底）。 */
const STORE_CACHE_MAX = 32
/**
 * 驻留内存的估算上限。只数"几个 store"是不够的：单个大仓库 store 实测驻留
 * 68MB（`load()` 后）～110MB（物化 `searchText` + 建 IDF/符号索引后），
 * 语料是 deepseek-harness / 70119 条目。32 个就是几 GB。
 * 估算口径见 `_estimateResidentBytes`（对内存里的对象图精确计数，不再用读盘文本量换算）。
 */
let STORE_CACHE_MAX_BYTES = 256 * 1024 * 1024
/** 每轮 save 最多补写多少个待压实的老分片（有界，避免升级后一次重写整库）。 */
const COMPACT_BATCH = 200

/**
 * 一个值的驻留字节：形状开销 + 字符串的**编码字节数**。
 *
 * 用 `Buffer.byteLength()` 而不是 `String.length`：CJK 在 UTF-8 里 3 字节/字符，而 V8
 * 双字节串 2 字节/字符——UTF-8 对非 ASCII 是偏高的代理指标，对纯 ASCII 精确。缓存预算
 * 容得下这个误差（实测两端 ±13%，见 `test/store-cache.test.mjs` 与 PLAN 附七）。
 *
 * 递归用深度上限而不是 `Set` 去环：store 的对象图来自 `JSON.parse`，本就无环；深度上限
 * 既挡畸形数据，又比逐对象 `Set` 查重快 ~30%（70119 条目实测 36ms vs 52ms）。
 */
const RESIDENT_OBJ_BYTES = 60
const RESIDENT_ARR_BYTES = 40
const RESIDENT_KEY_BYTES = 40
const RESIDENT_STR_BYTES = 16
const RESIDENT_MAX_DEPTH = 8

function residentBytesOf(value, depth = 0) {
  if (depth > RESIDENT_MAX_DEPTH) return 0
  const type = typeof value
  if (type === 'string') return RESIDENT_STR_BYTES + Buffer.byteLength(value)
  if (type === 'number' || type === 'bigint') return 16
  if (type === 'boolean' || value === null) return 8
  if (Array.isArray(value)) {
    let sum = RESIDENT_ARR_BYTES
    for (const item of value) sum += 8 + residentBytesOf(item, depth + 1)
    return sum
  }
  if (type === 'object') {
    let sum = RESIDENT_OBJ_BYTES
    for (const key in value) sum += RESIDENT_KEY_BYTES + residentBytesOf(value[key], depth + 1)
    return sum
  }
  return 0
}

/**
 * 单个 store 的驻留估算：数**内存里留下的对象图**，按版本记忆化。
 *
 * 为什么不是"读盘文本量换算"（旧实现）：那个口径有两个错。
 *  1. 时序错位——它量的是 `load()` 读进来的 JSON 文本，而 `searchText` 要到
 *     `allEntries()` 才物化，同一份数据在物化前后估出两个数（实测 76MB → 107MB）。
 *  2. 账不对物——旧分片里还带着 `searchText` / `linkedSymbols`，`load()` 会
 *     `stripPersistedDerived` 把它们删掉，可文本量已经把被删的字节算进去了。
 *     `/home/sxt/project` 的 store 实测：读盘 212.6MB，真实驻留 101.7MB。
 *
 * 两个版本键都参与失效：`_entriesVersion`（`setEntries` / `removeFile` / `_loadSharded`）
 * 与 `_materializeVersion`（`allEntries()` 物化 `searchText`）。漏掉后者就是旧实现的错。
 *
 * 代价：版本变化后的**一次**全量遍历（70119 条目 ~40ms）。必须记忆化——`evictStoreCache`
 * 是对**整个缓存**逐 store 求和的，不记忆化等于每次冷加载都把缓存里所有 store 重数一遍。
 */
export function _estimateResidentBytes(store) {
  const stamp = `${store._entriesVersion}:${store._materializeVersion}`
  if (store._residentStamp !== stamp) {
    store._residentBytes =
      residentBytesOf(store.entries) +
      residentBytesOf(store.files) +
      residentBytesOf(store.experience) +
      residentBytesOf(store.tasks) +
      residentBytesOf(store.insights) +
      residentBytesOf(store.watchlist) +
      residentBytesOf(store.binding)
    store._residentStamp = stamp
  }
  return store._residentBytes
}

/** 按 LRU 逐出，直到同时满足条数与字节预算；刚加入的 keepKey 即使超预算也保留。 */
function evictStoreCache(keepKey) {
  let total = 0
  for (const store of storeCache.values()) total += _estimateResidentBytes(store)
  while (storeCache.size > STORE_CACHE_MAX || total > STORE_CACHE_MAX_BYTES) {
    const oldest = storeCache.keys().next().value
    if (oldest === undefined || oldest === keepKey) break
    total -= _estimateResidentBytes(storeCache.get(oldest))
    storeCache.delete(oldest)
  }
  // keepKey 豁免是**有意**的：刚加载的 store 必须立刻可用。但它的代价是"单实例超预算时
  // 预算不再是上界"——这个代价不能是隐式的，所以每个这样的 store 告警一次（每 root 一次）。
  const kept = _estimateResidentBytes(storeCache.get(keepKey))
  if (kept > STORE_CACHE_MAX_BYTES && !warnedOverBudget.has(keepKey)) {
    warnedOverBudget.add(keepKey)
    console.error(
      `[dsh-project-memory] store ${keepKey} 单实例驻留约 ${Math.round(kept / 1048576)}MB，` +
        `超过 storeCache 预算 ${Math.round(STORE_CACHE_MAX_BYTES / 1048576)}MB；` +
        '刚加载的 store 不逐出（有意豁免），多 root 场景下其他 store 会被更频繁地逐出。',
    )
  }
}

/** 仅供测试：临时收窄字节预算（返回恢复函数），免得测试真去分配 256MB 字符串。 */
export function _setStoreCacheBudgetForTest(bytes) {
  const previous = STORE_CACHE_MAX_BYTES
  STORE_CACHE_MAX_BYTES = bytes
  return () => {
    STORE_CACHE_MAX_BYTES = previous
  }
}

/** 仅供测试：当前缓存 key 的 LRU 顺序（最旧在前）。 */
export function _storeCacheKeysForTest() {
  return [...storeCache.keys()]
}

/** 已就"无法迁移的旧 store"告警过的目录：避免每次 load() 都刷一行。 */
const migrationWarned = new Set()

/** 纯对象判定（排除 null / 数组）：磁盘读入的 JSON 形状校验统一走它。 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 落盘的 entry 只保留**不可推导的事实**。两个派生字段永远不写盘：
 *  - `linkedSymbols`：跨实体派生（取决于符号表当前状态），读取期由 src/link.js 解算；
 *  - `searchText`：自派生（只依赖本 entry），由 `allEntries()` 在内存里物化。
 * 旧 store 里的这两个字段在加载时剥掉，于是下一次写盘自然压实。
 * 实测两者在一个真实大仓库 store 里合计约 245MB（链接 222.8MB + searchText 22.7MB）。
 */
const PERSISTED_DERIVED = ['linkedSymbols', 'searchText', 'typeSig']

/** 原地剥离派生字段（加载路径用，省掉一次分配）。 */
function stripPersistedDerived(entry) {
  if (!entry || typeof entry !== 'object') return entry
  for (const key of PERSISTED_DERIVED) if (key in entry) delete entry[key]
  return entry
}

/** 返回不含派生字段的副本（写盘路径用，不能动内存里的对象）。 */
function withoutPersistedDerived(entry) {
  const out = { ...entry }
  for (const key of PERSISTED_DERIVED) delete out[key]
  return out
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
    this._idfCache = null
    /** entries 的变更计数：IDF 缓存与符号索引（读取期链接）都据此失效。 */
    this._entriesVersion = 0
    /** 待压实的老分片（≤0.5.10 落盘时带 linkedSymbols/searchText）；save() 每轮有界补写。 */
    this._compactQueue = new Set()
    /** 驻留字节估算的记忆化结果与版本戳（见 `_estimateResidentBytes`）。 */
    this._residentBytes = 0
    this._residentStamp = ''
    /**
     * `searchText` 的物化计数。它和 `_entriesVersion` 一起构成驻留估算的失效键：
     * 物化只改 entry 对象本身，不改 entries 的构成，所以不会 bump `_entriesVersion`。
     */
    this._materializeVersion = 0
  }

  load() {
    const key = path.resolve(this.dir)
    const hot = storeCache.get(key)
    // 缓存命中即返回：`hot === this` 时再读一遍盘会静默丢弃本实例尚未 save() 的变更
    // （_loadSharded/_loadInsights 会重新赋值 experience/tasks/insights…）。
    if (hot) {
      // LRU：命中挪到队尾，避免"热的先被逐出、冷的常驻"。
      storeCache.delete(key)
      storeCache.set(key, hot)
      return hot
    }
    this._migrateLegacyIfNeeded()
    this._loadSharded()
    this._loadInsights()
    this._removeLegacyTypeCache()
    // 有些路径只读不写（审计 jsonl 直接写在 store 目录里），所以这里也补一次自我忽略，
    // 让老版本建出来的 store 在第一次 load 就补上。
    this.ensureSelfIgnore()
    storeCache.set(key, this)
    evictStoreCache(key)
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
      writeJsonAtomic(shardRelPath(this.dir, rel), { relPath: rel, record: files[rel], entries: (entries[rel] || []).map(withoutPersistedDerived) })
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
      const list = Array.isArray(shard.entries) ? shard.entries.filter(isRecord) : []
      // 老分片带着派生字段：内存里立刻剥掉，并排队等 save() 把磁盘上也压实。
      if (list.some((e) => PERSISTED_DERIVED.some((k) => k in e))) this._compactQueue.add(shard.relPath)
      this.entries[shard.relPath] = list.map(stripPersistedDerived)
    }
    this._entriesVersion++
    this.experience = loadJson(path.join(this.dir, EXPERIENCE_FILE), [])
    this.tasks = loadJson(path.join(this.dir, TASKS_FILE), [])
    this.binding = loadJson(path.join(this.dir, BINDING_FILE), {})
    this.watchlist = loadJson(path.join(this.dir, WATCH_FILE), [])
    this._formatWritten = existsSafe(path.join(this.dir, FORMAT_FILE))
  }

  /**
   * 清掉 ≤0.5.10 留下的 `type-cache/` 目录。
   *
   * 它按内容哈希缓存 TS 增强结果，但三个增强入口（lazy 的 `fs/observed`、watch 轮询、
   * `index_repo`）**都只在"文件已变更并重新索引"之后**才触发，此时内容哈希必然是新值——
   * 这个缓存永远命中不了。实测本仓库残留 9827 个文件（`du` 41MB，内容其实 9.2MB，约 31MB
   * 是 4KB 块开销）。这里做一次自愈清理；删的是纯缓存，不丢任何事实。
   */
  _removeLegacyTypeCache() {
    const dir = path.join(this.dir, LEGACY_TYPE_CACHE_DIR)
    if (!existsSafe(dir)) return
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 权限/占用导致删不掉也不影响 store 本身
    }
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

  /**
   * store 目录**自我忽略**：在目录里放一个内容为 `*` 的 `.gitignore`。
   *
   * 为什么不写进用户的 `.gitignore`：那是用户的文件，插件不该改；而且"忘了加"的代价
   * 是一次误提交。为什么这样就够：git 会读取工作区里**任意**目录下的 `.gitignore`，
   * 而 `*` 连这个 `.gitignore` 自己一起命中，于是 `git status` / `git add -A` 里整棵树
   * 都不出现，用户一个字都不用写（`git check-ignore -v` 可复核）。
   *
   * 顺带的好处：被忽略的文件不会被 `git clean -fd` 删除（未跟踪且未忽略的会被删）。
   * 想把记忆跟着仓库提交：`git add -f .dsh-project-memory`——已跟踪的文件不受忽略规则影响。
   */
  ensureSelfIgnore() {
    if (!existsSafe(this.dir)) return
    const file = path.join(this.dir, GITIGNORE_FILE)
    if (existsSafe(file)) return
    try {
      writeFileSync(file, '# dsh-project-memory: local by default. `git add -f` to commit it.\n*\n')
    } catch {
      // 旁路：写不进去不影响存储本身
    }
  }

  save() {
    // 没有脏数据就不落盘。watch 每轮对每个根都无条件 commit → save；照旧执行的话，
    // 末尾的 ID 缓存失效会打在跨实例共享的 store 上，等于每轮清空一次 IDF 复用（v0.3.4 的 20x）。
    // 待压实队列不算"脏数据"，但它需要有界推进，所以也走这条落盘路径。
    const compacting = this._compactQueue.size > 0
    const dirty =
      compacting ||
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
    // 自我忽略也在无脏数据时执行：老版本建出来的 store 会在下一次 save 时补上。
    this.ensureSelfIgnore()
    if (!dirty) return
    if (!this._formatWritten) {
      writeJsonAtomic(path.join(this.dir, FORMAT_FILE), { version: 2, layout: 'sharded' })
      this._formatWritten = true
    }
    // 存量压实：≤0.5.10 的分片带着派生字段，而那些字段只在分片被重写时才会从磁盘消失。
    // 每轮最多补写 COMPACT_BATCH 个，让升级后的 store 在后续任意一次 save（watch 轮询、
    // 索引、写入）里自动收敛，而不是永远停在旧体积。
    let compactBudget = COMPACT_BATCH
    for (const rel of this._compactQueue) {
      if (compactBudget <= 0) break
      compactBudget--
      this._compactQueue.delete(rel)
      if (this.files[rel]) this._dirtyShards.add(rel)
    }
    for (const rel of this._dirtyShards) {
      if (this.files[rel]) {
        mkdirSync(path.join(this.dir, SHARDS_DIR), { recursive: true })
        writeJsonAtomic(shardRelPath(this.dir, rel), { relPath: rel, record: this.files[rel], entries: (this.entries[rel] || []).map(withoutPersistedDerived) })
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
  }

  getIdfCache() {
    // IDF 只依赖 entries（title/keywords/summary），所以按 entries 的变更计数失效：
    // 只写经验/insight 或只做存量压实的 save 不会再无谓地重建 IDF。
    if (this._idfCache && this._idfCache.version === this._entriesVersion) {
      return this._idfCache.idf
    }
    const idf = this._rebuildIdf()
    this._idfCache = { version: this._entriesVersion, idf }
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
      // searchText 在内存里物化（写入/检索都靠它），但 save() 不会把它写盘。
      const enriched = entries.map((e) => {
        const out = stripPersistedDerived({ ...e })
        out.searchText = makeSearchText(out)
        return out
      })
      this.entries[relPath] = enriched
    } else {
      delete this.entries[relPath]
    }
    this._entriesVersion++
    this._dirtyShards.add(relPath)
    this._removedShards.delete(relPath)
  }

  removeFile(relPath) {
    if (relPath in this.files) {
      delete this.files[relPath]
      delete this.entries[relPath]
      this._entriesVersion++
      this._dirtyShards.add(relPath)
      this._removedShards.add(relPath)
    }
  }

  /** entries 的变更计数：派生缓存（符号索引）据此失效。 */
  get entriesVersion() {
    return this._entriesVersion
  }

  /**
   * 这个 store 里有没有任何"事实"。
   *
   * 用于判断"值不值得为一条记账把它落盘"：一个从没被索引过、也没写过任何东西的根，
   * 不该因为一次**全局** insight 命中就被建出一个 store 目录（审计侧同理，见 audit.js）。
   * 刻意不调 `stats()`——那个会 `allEntries()` 物化 `searchText`。
   */
  get hasContent() {
    return (
      Object.keys(this.files).length > 0 ||
      this.experience.length > 0 ||
      this.tasks.length > 0 ||
      this.insights.items.length > 0 ||
      Object.keys(this.binding).length > 0 ||
      this.watchlist.length > 0
    )
  }

  /** 还有多少个老分片等着被 save() 压实（0 = 存量已收敛）。 */
  get pendingCompaction() {
    return this._compactQueue.size
  }

  allEntries() {
    const out = []
    let materialized = 0
    for (const list of Object.values(this.entries)) {
      for (const entry of list) {
        // searchText 不落盘，首次用到时按需物化并挂在对象上（同一 entry 只算一次）。
        if (entry.searchText === undefined) {
          entry.searchText = makeSearchText(entry)
          materialized++
        }
        out.push(entry)
      }
    }
    // 物化只改 entry 对象、不改 entries 的构成，所以 `_entriesVersion` 不会动；但驻留会实打实
    // 增加（70119 条目实测 +34MB）。这里是它的第二个失效键——漏了它，估算就停在物化前的水位。
    if (materialized) this._materializeVersion++
    return out
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
