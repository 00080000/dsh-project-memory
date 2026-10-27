import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tokenizeRaw, makeSearchText } from './util/search.js'
import { acquireDirLock, writeJsonAtomic } from './util/fs.js'
import { debugPersistence } from './util/persist.js'
import { trackDirty, untrackDirty } from './util/flush.js'
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
 * 驻留内存的预算上限。单个大仓库 store 实测驻留 68MB（`load()` 后）～110MB（物化
 * `searchText` + 建索引后），32 个就是几 GB。口径见 `_estimateResidentBytes`。
 */
let STORE_CACHE_MAX_BYTES = 256 * 1024 * 1024
/** 每轮 save 最多补写多少个待压实的老分片（有界，避免升级后一次重写整库）。 */
const COMPACT_BATCH = 200

/**
 * 一个值的驻留字节：形状开销 + 字符串的**编码字节数**。用 `Buffer.byteLength()` 而非
 * `String.length`：UTF-8 对 CJK 偏高（3 字节 vs 内存 2 字节），对 ASCII 精确，实测两端 ±13%。
 * 递归用深度上限而非 `Set` 去环：对象图来自 `JSON.parse` 本就无环，且快 ~30%
 * （70119 条目实测 36ms vs 52ms）。
 */
const RESIDENT_OBJ_BYTES = 60
const RESIDENT_ARR_BYTES = 40
const RESIDENT_KEY_BYTES = 40
const RESIDENT_STR_BYTES = 16
const RESIDENT_MAX_DEPTH = 8

/**
 * 精确计量的版本戳：entries 构成 + `searchText` 物化状态 + 辅助集合内容，三维缺一不可。
 */
function residentStampOf(store) {
  return `${store._entriesVersion}:${store._materializeVersion}:${store._auxVersion}`
}

/**
 * 精确计量的**触发上界**：文本字符数 × 4 + 骨架常数。精确计量要遍历全库字符串（80k 条目
 * 实测 ~40ms），而多数加载离 256MB 预算很远、逐出不可能发生，所以先算上界。
 * 系数取保守：宁可多走一次精确计量也不能把预算算松（真实语料上界/精确值 1.16~1.74×）。
 * 两条腿：`_textChars`（entries，替换式累计）与 `auxCharsOf()`（辅助集合，`load()` 后还会写大）。
 */
const RESIDENT_BOUND_PER_CHAR = 4
const RESIDENT_SKELETON_BYTES = 1024

function residentBoundBytes(store) {
  const stamp = residentStampOf(store)
  if (store._residentStamp === stamp) return store._residentBytes
  return RESIDENT_SKELETON_BYTES + (store._textChars + auxCharsOf(store)) * RESIDENT_BOUND_PER_CHAR
}

/**
 * 写路径的文本量估计（只用于上界）：`searchText` + 不在其内的字段 + 每条的键/JSON 开销；
 * 已在 `searchText` 里的字段不重复计。
 */
function entryTextChars(entries) {
  let sum = 0
  for (const entry of entries) {
    sum += 160
    sum += (entry.searchText || '').length
    sum += (entry.text || '').length
    sum += (entry.id || '').length + (entry.relPath || '').length
  }
  return sum
}

/** 仅供测试与标定：上界口径（必须 ≥ `_estimateResidentBytes`，否则字节预算会被算松）。 */
export function _residentBoundBytesForTest(store) {
  return residentBoundBytes(store)
}

/**
 * 驻留量的对象图遍历。精确口径与上界口径**共用这一份**，避免两份实现漂移。
 * `charsOnly` 为真时只取 `length` 字符数，是安全的上界：×4 后仍 ≥ UTF-8 真字节数
 * （一个 UTF-16 码元最多 3 字节，代理对 2 码元 / 4 字节）。
 */
function residentSizeOf(value, charsOnly, depth = 0) {
  if (depth > RESIDENT_MAX_DEPTH) return 0
  const type = typeof value
  if (type === 'string') return RESIDENT_STR_BYTES + (charsOnly ? value.length : Buffer.byteLength(value))
  if (type === 'number' || type === 'bigint') return 16
  if (type === 'boolean' || value === null) return 8
  if (Array.isArray(value)) {
    let sum = RESIDENT_ARR_BYTES
    for (const item of value) sum += 8 + residentSizeOf(item, charsOnly, depth + 1)
    return sum
  }
  if (type === 'object') {
    let sum = RESIDENT_OBJ_BYTES
    for (const key in value) sum += RESIDENT_KEY_BYTES + residentSizeOf(value[key], charsOnly, depth + 1)
    return sum
  }
  return 0
}

/** 精确口径：内存里留下的对象图，按真字节数（`_estimateResidentBytes` 用）。 */
function residentBytesOf(value) {
  return residentSizeOf(value, false, 0)
}

/**
 * 上界口径：只数字符（`auxCharsOf` 用）。辅助集合条目数小，逐节点求和的代价可忽略；
 * entries 有几万条，仍走增量记账的 `_textChars`。
 */
function residentCharsOf(value) {
  return residentSizeOf(value, true, 0)
}

/**
 * 辅助集合的文本量（上界口径），按 `_auxVersion` 记忆化。`_textChars` 只跟 entries，
 * 而辅助集合在 `load()` 之后还会被写大，不进上界就会在已超预算时跳过计量与逐出
 * （实测单 store 上界 1024 B、实际 19.08 MB）。`evictStoreCache` 对整个缓存逐 store
 * 求和，不记忆化等于每次冷加载重算一遍。
 */
function auxCharsOf(store) {
  if (store._auxStamp === store._auxVersion) return store._auxChars
  store._auxChars =
    residentCharsOf(store.insights) +
    residentCharsOf(store.tasks) +
    residentCharsOf(store.binding) +
    residentCharsOf(store.watchlist)
  store._auxStamp = store._auxVersion
  return store._auxChars
}

/**
 * 单个 store 的驻留估算：数**内存里留下的对象图**，按版本记忆化。不用读盘文本量换算——
 * `searchText` 要到 `allEntries()` 才物化，前后估出两个数（实测 76MB → 107MB），且被
 * `stripPersistedDerived` 删掉的字段也会被算进去。`_entriesVersion` 与 `_materializeVersion`
 * 都参与失效；一次全量遍历 70119 条目 ~40ms，逐出又会遍历整个缓存，所以必须记忆化。
 */
export function _estimateResidentBytes(store) {
  const stamp = residentStampOf(store)
  if (store._residentStamp !== stamp) {
    store._residentBytes =
      residentBytesOf(store.entries) +
      residentBytesOf(store.files) +
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
  // 条数超上限或上界已超字节预算才做精确计量；宽裕时一次对象图遍历都不做。
  let exact = storeCache.size > STORE_CACHE_MAX
  if (!exact) {
    let bound = 0
    for (const store of storeCache.values()) bound += residentBoundBytes(store)
    exact = bound > STORE_CACHE_MAX_BYTES
  }
  let total = 0
  if (exact) for (const store of storeCache.values()) total += _estimateResidentBytes(store)
  while (storeCache.size > STORE_CACHE_MAX || (exact && total > STORE_CACHE_MAX_BYTES)) {
    const oldest = storeCache.keys().next().value
    if (oldest === undefined || oldest === keepKey) break
    if (exact) total -= _estimateResidentBytes(storeCache.get(oldest))
    // 逐出前先落盘：任务热点/人类消息延迟到回合结束才 flush，直接丢实例会丢未落盘的变更。
    const evicted = storeCache.get(oldest)
    if (evicted && evicted.hasDirty()) {
      try {
        evicted.save()
      } catch (err) {
        console.error(`[dsh-project-memory] evicted store save failed: ${err?.message || err}`)
      }
    }
    storeCache.delete(oldest)
  }
  // 没做精确计量就不报单实例超预算：真超预算时下一次加载会走到这里并如实告警。
  if (!exact) return
  // keepKey 豁免是有意的（刚加载的 store 必须立刻可用）；代价是单实例超预算时预算不再是
  // 上界，所以每个这样的 store 每 root 告警一次。
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

/** 两个 ISO 时间戳的先后；缺失/非法一律 0，保证可比较。 */
function newerIso(a, b) {
  const ta = Date.parse(a || '') || 0
  const tb = Date.parse(b || '') || 0
  return ta - tb
}

/**
 * 合并同一任务在两份快照里的 `insights`：以**上次落盘的 id 基线**做三方判断，基线没有、
 * 本地有 → 本地新增；基线有、本地没有 → 本地删除（不复活）；两边都有 → `updatedAt` 新者胜。
 * 不能只按任务 `updatedAt` 选一侧：任务条目写入不 bump 任务时间戳，会整段覆盖另一边。
 * @param {object} local
 * @param {object} disk
 * @param {Set<string>} base
 * @returns {object[]}
 */
function mergeTaskInsights(local, disk, base) {
  const merged = new Map()
  for (const ins of Array.isArray(disk?.insights) ? disk.insights : []) {
    if (ins?.id) merged.set(ins.id, ins)
  }
  const localById = new Map()
  for (const ins of Array.isArray(local?.insights) ? local.insights : []) {
    if (ins?.id) localById.set(ins.id, ins)
  }
  for (const id of base) if (!localById.has(id)) merged.delete(id)
  for (const [id, ins] of localById) {
    const prev = merged.get(id)
    if (!prev) {
      if (!base.has(id)) merged.set(id, ins)
      continue
    }
    if (newerIso(ins.updatedAt, prev.updatedAt) >= 0) merged.set(id, ins)
  }
  return [...merged.values()]
}

/**
 * 落盘的 entry 只保留**不可推导的事实**，两个派生字段永不写盘：`linkedSymbols` 是跨实体
 * 派生（取决于符号表当前状态，读取期由 src/link.js 解算），`searchText` 是自派生（只依赖
 * 本 entry，由 `allEntries()` 在内存里物化）。旧 store 的这两个字段加载时剥掉，下次写盘自然压实。
 */
const PERSISTED_DERIVED = ['linkedSymbols', 'searchText', 'typeSig']
const PERSISTED_DERIVED_SET = new Set(PERSISTED_DERIVED)

/** 有没有派生字段要剥。没有就走零分配路径（绝大多数条目、以及所有新写的分片）。 */
function hasPersistedDerived(entry) {
  for (const key of PERSISTED_DERIVED) if (key in entry) return true
  return false
}

/**
 * 按**非派生键重建**一个对象。不用 `delete`：删除属性会把 entry 推进 V8 字典模式，
 * 之后每个属性都变成哈希表项。本仓库真实条目形状实测 `delete` 后 1196 B/条、重建后
 * 436 B/条（20k 条 / --expose-gc）。`undefined` 值的键也不复制（`typeSig` 是 enhancer
 * 的实现细节，JSON 里本就不存在）。
 */
function rebuildWithoutDerived(entry) {
  const out = {}
  for (const key of Object.keys(entry)) {
    if (PERSISTED_DERIVED_SET.has(key)) continue
    const value = entry[key]
    if (value === undefined) continue
    // JSON.parse 可以把 `__proto__` 变成自有属性，而赋值会去改原型 —— 显式定义。
    if (key === '__proto__') Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
    else out[key] = value
  }
  return out
}

/**
 * 剥掉派生字段（加载路径用）。没有派生字段时**原对象返回**（零分配热路径）。
 * @returns {object} 不含派生字段的条目（可能是同一个对象）
 */
function stripPersistedDerived(entry) {
  if (!entry || typeof entry !== 'object') return entry
  if (!hasPersistedDerived(entry)) return entry
  return rebuildWithoutDerived(entry)
}

/** 返回不含派生字段的条目（写盘路径用，不能动内存里的对象）。 */
function withoutPersistedDerived(entry) {
  if (!entry || typeof entry !== 'object') return entry
  if (!hasPersistedDerived(entry)) return entry
  return rebuildWithoutDerived(entry)
}

/** 仅供测试：加载/写盘路径的剥离实现（内存形状由测试用 --expose-gc 度量）。 */
export function _stripPersistedDerivedForTest(entry) {
  return stripPersistedDerived(entry)
}

function loadJson(filePath, fallback, counter) {
  let raw
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return fallback
  }
  // 累计读盘文本字符数，只供 `residentBoundBytes` 判断要不要精确计量。
  if (counter) counter.chars += raw.length
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
    /** 加载时的分片 hash：跨进程写冲突检测的基准。 */
    this._baseFileSha = new Map()
    /** 本地删除留痕：合并另一进程的磁盘状态时不能把它们复活。 */
    this._deletedInsightIds = new Set()
    this._deletedTaskIds = new Set()
    this._deletedBindings = new Set()
    this._removedWatch = new Set()
    /** 上次落盘/加载时的 insight id 集合：原地 splice 的删除也要能被合并逻辑看见。 */
    this._baseInsightIds = new Set()
    /** task.id → 上次落盘/加载时该任务的 insight id 集合（任务级条目的合并基线，见 mergeTaskInsights）。 */
    this._baseTaskInsightIds = new Map()
    /**
     * 本进程**新建**的条目。"磁盘没有但内存有"可能是新建（要补写）也可能是**对方删了**
     * （不能写回）；没有这个集合，后者会被复活。
     */
    this._createdInsightIds = new Set()
    this._createdTaskIds = new Set()
    /** 上一次 save 是否真的落到盘上（锁竞争/权限失败时为 false）。 */
    this.lastSaveOk = true
    /** `shards/` 的 `.tmp` 清扫节流：NTFS 上 readdir(数千分片) 不便宜，不能每次 save 都扫。 */
    this._lastShardTmpSweep = 0
    /** store 目录 / shards 目录已确认存在：首次写之后不再每次 save 都 mkdir（9p 上每次 ~4ms）。 */
    this._storeDirReady = false
    this._shardsDirReady = false
    this._lockWarned = false
    this._conflictWarned = new Set()
    /** 锁竞争跳过落盘后的有限次延迟重试；unref，避免拖住进程退出。 */
    this._saveRetryTimer = null
    this._saveRetryAttempts = 0
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
     * entries 的文本字符数累计（读盘 + 写条目 + 物化 `searchText`），按文件**替换式**记。
     * **只**供 `residentBoundBytes` 判断要不要精确计量；精确估算数的是对象图。
     */
    this._textChars = 0
    /** 每个文件当前的文本字符数，写入时按文件替换，避免重写同一文件被算两遍。 */
    this._fileTextChars = new Map()
    /**
     * `searchText` 的物化计数：物化只改 entry 对象、不改 entries 构成，不 bump
     * `_entriesVersion`，所以驻留估算的失效键要单独带上它。
     */
    this._materializeVersion = 0
    /**
     * 辅助集合（experience / insights / tasks / binding / watch）的内容版本：它们不在 entries
     * 的记账面里，靠它让精确估算失效、`auxCharsOf` 重算。每个改到它们的写口都要 bump。
     */
    this._auxVersion = 0
    this._auxChars = 0
    this._auxStamp = ''
  }

  load() {
    const key = path.resolve(this.dir)
    const hot = storeCache.get(key)
    // 缓存命中即返回：`hot === this` 时再读一遍盘会静默丢弃本实例尚未 save 的变更。
    if (hot) {
      // LRU：命中挪到队尾，避免"热的先被逐出、冷的常驻"。
      storeCache.delete(key)
      storeCache.set(key, hot)
      return hot
    }
    this._migrateLegacyIfNeeded()
    this._loadSharded()
    this._loadInsights()
    this._pruneBindings()
    this._resetTaskInsightBases()
    this._removeLegacyTypeCache()
    // 有些路径只读不写（审计 jsonl 直接写在 store 目录里），这里补一次自我忽略兜底。
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
      // index.json 是 entries.json → rel 的唯一映射；它缺失时继续迁移会写出 0 个 shard 再删掉
      // 完好的 entries.json，等于静默清空。保留现场，不写 format 标记，等修好后再迁。
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
    for (const rel of Object.keys(files)) {
      // 父目录由 writeJsonAtomic 保证
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

  /**
   * 读一个辅助集合文件（experience / tasks / insights / binding / watch）。它们的文本量
   * **不进** `_textChars`（那份账只跟 entries），交给 `auxCharsOf` 按对象图直接算。
   */
  _loadJson(filePath, fallback) {
    return loadJson(filePath, fallback)
  }

  /** 按文件记文本量：替换而不是累加，重写同一个文件不会算两遍。 */
  _setFileTextChars(relPath, chars) {
    const prev = this._fileTextChars.get(relPath) || 0
    if (chars > 0) this._fileTextChars.set(relPath, chars)
    else this._fileTextChars.delete(relPath)
    this._textChars += chars - prev
  }

  /**
   * 清掉指向已删除/已归档任务的会话绑定，否则 binding.json 会永久留着条目（下一次 todo
   * 写入又会建新任务）。只标脏、不立刻落盘——读路径不应为清理额外写一次盘。
   */
  _pruneBindings() {
    // 旧 store/手工损坏的 JSON 可能不是期望形状；读路径不能因此抛错。
    const tasks = Array.isArray(this.tasks) ? this.tasks : []
    const binding = this.binding
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return
    const byId = new Map(tasks.filter((t) => t && t.id).map((t) => [t.id, t]))
    let changed = false
    for (const sid of Object.keys(binding)) {
      const task = byId.get(binding[sid])
      if (task && !task.archived) continue
      delete binding[sid]
      this._deletedBindings.add(sid)
      changed = true
    }
    if (changed) {
      this._dirtyBinding = true
      this._auxVersion++
    }
  }

  _loadSharded() {
    let shardNames = []
    try {
      shardNames = readdirSync(path.join(this.dir, SHARDS_DIR)).filter((n) => n.endsWith('.json'))
    } catch {
      shardNames = []
    }
    for (const name of shardNames) {
      const counter = { chars: 0 }
      const shard = loadJson(path.join(this.dir, SHARDS_DIR, name), null, counter)
      if (!shard || typeof shard.relPath !== 'string' || !isRecord(shard.record)) continue
      this._setFileTextChars(shard.relPath, counter.chars)
      this.files[shard.relPath] = shard.record
      this._baseFileSha.set(shard.relPath, shard.record.sha256 ?? null)
      // 畸形 shard（entries 不是数组）不能让 `for…of` 抛错，否则一个坏文件会拖垮每次读取。
      const list = Array.isArray(shard.entries) ? shard.entries.filter(isRecord) : []
      // 老分片带着派生字段：内存里立刻剥掉，并排队等 save() 把磁盘上也压实。
      if (list.some((e) => PERSISTED_DERIVED.some((k) => k in e))) this._compactQueue.add(shard.relPath)
      this.entries[shard.relPath] = list.map(stripPersistedDerived)
    }
    this._entriesVersion++
    this.experience = this._loadJson(path.join(this.dir, EXPERIENCE_FILE), [])
    this.tasks = this._loadJson(path.join(this.dir, TASKS_FILE), [])
    this.binding = this._loadJson(path.join(this.dir, BINDING_FILE), {})
    this.watchlist = this._loadJson(path.join(this.dir, WATCH_FILE), [])
    // 这四个集合的内容刚刚被换掉，让 auxCharsOf/精确估算重算（而不是沿用上一份实例的账）。
    this._auxVersion++
    this._formatWritten = existsSafe(path.join(this.dir, FORMAT_FILE))
  }

  /**
   * 清掉 ≤0.5.10 留下的 `type-cache/`：三个增强入口都只在文件重新索引后触发，内容哈希
   * 必然是新值，缓存永远命中不了。实测本仓库残留 9827 个文件、`du` 41MB。
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
  // insight 是**唯一**的记忆实体，`kind:'experience'` 就是 v0.4 的经验笔记。旧 store 的
  // experience.json 只导入一次，随后改名成 `experience.json.migrated` 只读归档（不删）。
  // 归档与导入必须分开判：老用户的 `migratedAt` 早已写上，只看它会让旧文件永远收不走。
  _loadInsights() {
    const doc = this._loadJson(path.join(this.dir, INSIGHTS_FILE), null)
    this.insights = isRecord(doc) && Array.isArray(doc.items)
      // items 里混进 null/非对象（手改或旧版写入）会让迁移与召回逐个 `.title` 抛错——过滤掉。
      ? { ...doc, items: doc.items.filter(isRecord) }
      : { version: 1, migratedAt: null, items: [] }
    this._migrateExperienceToInsights()
    // 懒回填派生 trigger（纯确定性、幂等；不调用模型，不改写已有字段）
    if (backfillDerivedTriggers(this.insights)) this._dirtyInsights = true
    // 迁移与回填都会改 items；换掉整个文档后让 auxCharsOf/精确估算重算。
    this._baseInsightIds = new Set(this.insights.items.map((it) => it?.id).filter(Boolean))
    this._auxVersion++
  }

  _migrateExperienceToInsights() {
    const legacyFile = path.join(this.dir, EXPERIENCE_FILE)
    const legacyOnDisk = existsSafe(legacyFile)
    const legacy = Array.isArray(this.experience) ? this.experience : []
    if (legacyOnDisk && !Array.isArray(this.experience)) {
      console.error(`[dsh-project-memory] ${EXPERIENCE_FILE} is not an array; importing nothing (file kept as-is)`)
      return
    }
    let imported = 0
    // 只有值得写的输入（`migratedAt` 为空 + 旧文件在或有旧条目）才导入：否则 `load()` 会在空目录里
    // mkdir + 写 insights.json，让调用方"目录已存在/有内容"的判断失真（容器目录被当成项目根）。
    if (!this.insights.migratedAt && (legacyOnDisk || legacy.length > 0)) {
      const now = new Date().toISOString()
      const known = new Set(this.insights.items.map((it) => it.id))
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
        writeJsonAtomic(path.join(this.dir, INSIGHTS_FILE), this.insights, { ensureDir: false })
      } catch (err) {
        // 没写进 insights.json 就**不能**把旧文件收走：那会真的丢数据。
        console.error(`[dsh-project-memory] insights migration write failed, keeping ${EXPERIENCE_FILE}: ${err.message}`)
        return
      }
    }
    if (legacyOnDisk) {
      try {
        renameSync(legacyFile, `${legacyFile}.migrated`)
      } catch (err) {
        console.error(`[dsh-project-memory] could not archive ${EXPERIENCE_FILE} (imported ${imported} note(s)): ${err.message}`)
      }
    }
    this.experience = []
  }

  insightsDoc() {
    return this.insights
  }

  insightItems() {
    return this.insights.items
  }

  replaceInsightItems(items) {
    const next = new Set((items || []).map((it) => it?.id).filter(Boolean))
    // 与上次落盘的基线比，而不是与当前数组比：调用方经常先原地 splice 再调用这里。
    for (const id of this._baseInsightIds) if (!next.has(id)) this._deletedInsightIds.add(id)
    for (const id of next) {
      this._deletedInsightIds.delete(id)
      if (!this._baseInsightIds.has(id)) this._createdInsightIds.add(id)
    }
    this.insights.items = items
    this._baseInsightIds = next
    this._dirtyInsights = true
    this._auxVersion++
  }

  /**
   * 调用方**直接改过** task 内容（含 task 内条目）后的标脏入口：任务树不走 `addTask` /
   * `updateTask`，这里不 bump 内容版本的话精确估算会停在前一水位。
   */
  markTasksDirty() {
    this._dirtyTasks = true
    this._auxVersion++
  }

  cleanStaleTmp({ force = false } = {}) {
    // store 根目录只有几个文件，每次扫很便宜；`shards/` 是 O(N)（12k 分片时在 NTFS 上会卡），
    // 60s 扫一次足够，`force` 给测试/诊断用。
    const now = Date.now()
    const scanDirs = [this.dir]
    if (force || now - this._lastShardTmpSweep >= 60_000) {
      this._lastShardTmpSweep = now
      scanDirs.push(path.join(this.dir, SHARDS_DIR))
    }
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
   * store 目录**自我忽略**：放一个内容为 `*` 的 `.gitignore`。不改用户的 `.gitignore`
   * （那是用户的文件，且"忘了加"的代价是误提交）；git 会读取任意子目录下的 `.gitignore`，
   * `*` 连它自己一起命中，整棵树不会进 `git status`。要随仓库提交用 `git add -f`。
   *
   * **不缓存"文件已存在"**：只省一次 stat，却会把外部删除（`git clean -fdx`）变成
   * 本进程剩余生命周期都不再自我忽略，store 可能被下一次 `git add` 带进提交。
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

  /** 重新记下每个任务当前可见的 insight id：只在加载成功 / 整份 tasks 落盘成功后调用。 */
  _resetTaskInsightBases() {
    this._baseTaskInsightIds = new Map()
    for (const task of Array.isArray(this.tasks) ? this.tasks : []) {
      if (!task?.id) continue
      const ids = Array.isArray(task.insights) ? task.insights.map((it) => it?.id).filter(Boolean) : []
      this._baseTaskInsightIds.set(task.id, new Set(ids))
    }
  }

  /** 是否有待落盘的变更；逐出缓存前用它避免为干净 store 触发 save 的旁路副作用。 */
  hasDirty() {
    return this._compactQueue.size > 0
      || this._dirtyShards.size > 0
      || this._removedShards.size > 0
      || this._dirtyInsights
      || this._dirtyTasks
      || this._dirtyBinding
      || this._dirtyWatch
  }

  /**
   * @param {{ timeoutMs?: number }} [options] 等锁上限，默认 15s：写路径的正确性靠**同步等待**，
   *   用户结束对话就会关 dsh，不等后台重试；重试只是长驻进程的兜底。
   * @returns {boolean} 是否真的落盘（无脏数据也算成功）
   */
  save(options = {}) {
    // 没有脏数据就不落盘：watch 每轮对每个根都无条件 commit → save，否则末尾的 IDF 缓存失效
    // 会打在跨实例共享的 store 上，等于每轮清空一次复用。待压实队列不算脏，但也要有界推进。
    const compacting = this._compactQueue.size > 0
    const dirty =
      compacting ||
      this._dirtyShards.size > 0 ||
      this._removedShards.size > 0 ||
      this._dirtyInsights ||
      this._dirtyTasks ||
      this._dirtyBinding ||
      this._dirtyWatch ||
      !this._formatWritten
    if (dirty) {
      // 目录可能在 load 之后被外部删掉：`_storeDirReady` 只当"上次写过"的快路径，命中时补一次
      // stat；失配就重建目录，并让分片/格式/忽略三处的已就绪状态一起失效。
      let dirReady = this._storeDirReady
      if (dirReady) {
        try {
          statSync(this.dir)
        } catch (err) {
          // 只有 ENOENT 才重建；EACCES / ENOTDIR 交给锁走原来的静默失败路径，不升级成抛错。
          if (err?.code === 'ENOENT') dirReady = false
        }
      }
      if (!dirReady) {
        try {
          mkdirSync(this.dir, { recursive: true })
        } catch {
          this.lastSaveOk = false
          trackDirty(this)
          this._scheduleSaveRetry()
          return false
        }
        this._storeDirReady = true
        this._shardsDirReady = false
        this._formatWritten = false
      }
    }
    // 崩溃遗留的 *.tmp 无论有没有脏数据都顺手清掉（两次 readdir，自带 try/catch）
    this.cleanStaleTmp()
    // 无脏数据也要补自我忽略：老版本建出来的 store 会在下一次 save 时补上。
    this.ensureSelfIgnore()
    if (!dirty) {
      this.lastSaveOk = true
      untrackDirty(this)
      return true
    }
    // 跨进程：整段读改写放进目录锁，默认同步等 15s。拿不到锁就保持脏状态并登记退出 flush，
    // 默认静默，不向用户/模型抛提示。
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000
    const release = acquireDirLock(this.dir, { timeoutMs, ensureDir: false })
    if (!release) {
      this.lastSaveOk = false
      trackDirty(this)
      if (!this._lockWarned) {
        this._lockWarned = true
        debugPersistence(`[dsh-project-memory] store ${this.dir} is busy (another dsh process is writing); this write is pending.`)
      }
      this._scheduleSaveRetry()
      return false
    }
    let wroteInsights = false
    let wroteTasks = false
    try {
      // 先合并另一进程已落盘的小文档，再写；分片按“加载时 hash”做冲突检测。
      this._mergeAuxFromDisk()
      if (!this._formatWritten) {
        writeJsonAtomic(path.join(this.dir, FORMAT_FILE), { version: 2, layout: 'sharded' }, { ensureDir: false })
        this._formatWritten = true
      }
      // 存量压实：≤0.5.10 的分片带派生字段，只有重写才消失。每轮最多 COMPACT_BATCH 个，
      // 让升级后的 store 在后续任意一次 save 里自动收敛。
      let compactBudget = COMPACT_BATCH
      for (const rel of this._compactQueue) {
        if (compactBudget <= 0) break
        compactBudget--
        this._compactQueue.delete(rel)
        if (this.files[rel]) this._dirtyShards.add(rel)
      }
      for (const rel of this._dirtyShards) {
        if (this.files[rel]) {
          const nextSha = this.files[rel].sha256 ?? null
          const base = this._baseFileSha.get(rel) ?? null
          const disk = this._shardDiskRecord(rel)
          // 磁盘分片加载后被别的进程改过：按 indexedAt 收敛，本地更新则覆盖，对方更新则读回内存。
          if (disk.exists && disk.sha !== base && disk.sha !== nextSha) {
            const localAt = Date.parse(this.files[rel].indexedAt || '') || 0
            const diskAt = Date.parse(disk.record?.indexedAt || '') || 0
            if (localAt > diskAt) {
              this._ensureShardsDir()
              writeJsonAtomic(shardRelPath(this.dir, rel), { relPath: rel, record: this.files[rel], entries: (this.entries[rel] || []).map(withoutPersistedDerived) }, { ensureDir: false })
              this._baseFileSha.set(rel, nextSha)
              continue
            }
            this._adoptDiskShard(rel, disk)
            this._warnConflict(rel)
            continue
          }
          this._ensureShardsDir()
          writeJsonAtomic(shardRelPath(this.dir, rel), { relPath: rel, record: this.files[rel], entries: (this.entries[rel] || []).map(withoutPersistedDerived) }, { ensureDir: false })
          this._baseFileSha.set(rel, nextSha)
        } else {
          this._removedShards.add(rel)
        }
      }
      this._dirtyShards.clear()
      for (const rel of this._removedShards) {
        const base = this._baseFileSha.get(rel) ?? null
        const disk = this._shardDiskRecord(rel)
        if (disk.exists && disk.sha !== base) {
          // 删除与另一进程的更新撞车：没有删除时间戳可比，保守采用对方版本，让内存与磁盘一致。
          this._adoptDiskShard(rel, disk)
          this._warnConflict(rel)
          continue
        }
        try {
          unlinkSync(shardRelPath(this.dir, rel))
        } catch {
          // shard file already gone; nothing to do
        }
        this._baseFileSha.delete(rel)
      }
      this._removedShards.clear()
      wroteInsights = this._dirtyInsights
      wroteTasks = this._dirtyTasks
      if (wroteInsights) {
        // v2 → v3 是纯语义升级，形状不变；老版本读到 v3 仍按 v2 字段解析。
        if (this.insights && this.insights.version !== 3) this.insights.version = 3
        writeJsonAtomic(path.join(this.dir, INSIGHTS_FILE), this.insights, { ensureDir: false })
        this._dirtyInsights = false
      }
      if (this._dirtyTasks) {
        writeJsonAtomic(path.join(this.dir, TASKS_FILE), this.tasks, { ensureDir: false })
        this._dirtyTasks = false
      }
      if (this._dirtyBinding) {
        writeJsonAtomic(path.join(this.dir, BINDING_FILE), this.binding, { ensureDir: false })
        this._dirtyBinding = false
      }
      if (this._dirtyWatch) {
        writeJsonAtomic(path.join(this.dir, WATCH_FILE), this.watchlist, { ensureDir: false })
        this._dirtyWatch = false
      }
    } catch (err) {
      // 非锁原因的写失败（ENOSPC / EISDIR / 只读挂载）也要置 lastSaveOk=false 并登记 flush。
      this.lastSaveOk = false
      trackDirty(this)
      throw err
    } finally {
      release()
    }
    this._saveRetryAttempts = 0
    this.lastSaveOk = true
    untrackDirty(this)
    // 落盘成功才推进基线：失败时保持"本进程新建"的标记，下一次 save 仍要补写。
    if (wroteInsights) {
      this._baseInsightIds = new Set(this.insights.items.map((it) => it?.id).filter(Boolean))
      this._createdInsightIds.clear()
    }
    if (wroteTasks) {
      // 只有真的落盘成功才推进任务条目的合并基线；失败时保留旧基线，重试仍能识别本地新增/删除。
      this._createdTaskIds.clear()
      this._resetTaskInsightBases()
    }
    return true
  }

  /**
   * 冲突时采用另一进程的分片：内存 record/entries 与磁盘对齐，并让 IDF/驻留账失效。
   * 磁盘 entries 可能损坏或来自旧版本，和 `_loadSharded` 一样只收合法项。
   */
  _adoptDiskShard(rel, disk) {
    const entries = (disk.entries || []).filter(isRecord).map(stripPersistedDerived)
    this.files[rel] = disk.record
    this.entries[rel] = entries
    this._setFileTextChars(rel, entryTextChars(entries))
    this._entriesVersion++
    this._baseFileSha.set(rel, disk.sha)
  }

  /** 读磁盘分片（不存在/损坏都返回 exists:false）。 */
  _shardDiskRecord(rel) {
    try {
      const doc = JSON.parse(readFileSync(shardRelPath(this.dir, rel), 'utf8'))
      if (!isRecord(doc) || typeof doc.relPath !== 'string' || !isRecord(doc.record)) {
        return { exists: false, sha: null, record: null, entries: [] }
      }
      return {
        exists: true,
        sha: doc.record.sha256 ?? null,
        record: doc.record,
        entries: Array.isArray(doc.entries) ? doc.entries : [],
      }
    } catch {
      return { exists: false, sha: null, record: null, entries: [] }
    }
  }

  /** 首次写分片前建一次 shards/；之后每次 save 都省掉一次 mkdir。 */
  _ensureShardsDir() {
    if (this._shardsDirReady) return
    mkdirSync(path.join(this.dir, SHARDS_DIR), { recursive: true })
    this._shardsDirReady = true
  }

  /** 退出/卸载路径的同步兜底（见 util/flush.js）。 */
  flushPending(timeoutMs = 1500) {
    return this.save({ timeoutMs })
  }

  /** 锁竞争后的有限次延迟重试；失败仍保持脏状态，下一次写继续尝试。 */
  _scheduleSaveRetry() {
    // 重试总时长必须超过 staleMs=10s（同机崩溃锁由 pid 判活立即回收，这里只兜跨机 stale 锁）。
    const delays = [100, 500, 2000, 6000, 12000]
    if (this._saveRetryTimer || this._saveRetryAttempts >= delays.length) return
    const delay = delays[this._saveRetryAttempts++]
    this._saveRetryTimer = setTimeout(() => {
      this._saveRetryTimer = null
      try {
        this.save({ timeoutMs: 2000 })
      } catch (err) {
        console.error(`[dsh-project-memory] deferred save failed: ${err?.message || err}`)
      }
    }, delay)
    this._saveRetryTimer.unref?.()
  }

  /** 冲突只提示一次：这是“对方更新更晚”的正常并发结果，不是每轮刷屏的故障。 */
  _warnConflict(rel) {
    if (this._conflictWarned.has(rel)) return
    this._conflictWarned.add(rel)
    console.error(`[dsh-project-memory] ${rel} changed by another dsh process; this local copy was not written (it will be re-derived on the next scan).`)
  }

  /**
   * 写盘前把另一进程已落盘的小文档合并进来：同 id 取 `updatedAt` 新的一侧，本进程删掉的 id
   * 用墓碑挡住，避免"删了又被对方的旧副本复活"。分片不走这里（按 hash 冲突检测）。
   */
  _mergeAuxFromDisk() {
    if (this._dirtyInsights) {
      // 先按“上次落盘基线”记墓碑：prune/applyDecay 等原地 splice 不经过 replaceInsightItems。
      const current = new Set(this.insights.items.map((it) => it?.id).filter(Boolean))
      for (const id of this._baseInsightIds) if (!current.has(id)) this._deletedInsightIds.add(id)
      for (const id of current) this._deletedInsightIds.delete(id)
      const disk = this._loadJson(path.join(this.dir, INSIGHTS_FILE), null)
      if (isRecord(disk) && Array.isArray(disk.items)) {
        const byId = new Map()
        for (const it of disk.items) if (isRecord(it) && it.id) byId.set(it.id, it)
        for (const it of this.insights.items) {
          if (!isRecord(it) || !it.id) continue
          if (this._deletedInsightIds.has(it.id)) {
            byId.delete(it.id)
            continue
          }
          const prev = byId.get(it.id)
          if (!prev) {
            // 磁盘没有：本进程新建的才补写；否则是**对方删了**，丢掉内存里的旧副本。
            if (this._createdInsightIds.has(it.id)) byId.set(it.id, it)
            continue
          }
          if (newerIso(it.updatedAt, prev.updatedAt) >= 0) byId.set(it.id, it)
        }
        for (const id of this._deletedInsightIds) byId.delete(id)
        this.insights = { ...this.insights, items: [...byId.values()] }
        this._baseInsightIds = new Set(this.insights.items.map((it) => it?.id).filter(Boolean))
        this._auxVersion++
      }
    }
    if (this._dirtyTasks) {
      const disk = this._loadJson(path.join(this.dir, TASKS_FILE), [])
      if (Array.isArray(disk)) {
        const byId = new Map()
        for (const t of disk) if (isRecord(t) && t.id) byId.set(t.id, t)
        for (const t of this.tasks) {
          if (!isRecord(t) || !t.id || this._deletedTaskIds.has(t.id)) {
            if (isRecord(t) && t.id) byId.delete(t.id)
            continue
          }
          const prev = byId.get(t.id)
          if (!prev) {
            // 同 insights：磁盘缺失 = 对方删了，只有本进程新建的任务才补写。
            if (this._createdTaskIds.has(t.id)) byId.set(t.id, t)
            continue
          }
          // 任务级条目单独合并：两边都可能新增/删除，按整条任务的时间戳选一侧会静默丢一边。
          const base = this._baseTaskInsightIds.get(t.id) || new Set()
          const mergedInsights = mergeTaskInsights(t, prev, base)
          const winner = newerIso(t.updatedAt || t.lastActiveAt, prev.updatedAt || prev.lastActiveAt) >= 0 ? t : prev
          winner.insights = mergedInsights
          byId.set(t.id, winner)
        }
        // `removeTask` 已把它从内存数组移除，上面循环看不到；不在这里剔除会在同一次 save 里被写回。
        for (const id of this._deletedTaskIds) byId.delete(id)
        this.tasks = [...byId.values()]
        this._auxVersion++
      }
    }
    if (this._dirtyBinding) {
      const disk = this._loadJson(path.join(this.dir, BINDING_FILE), {})
      if (isRecord(disk)) {
        const merged = { ...disk }
        for (const [sid, tid] of Object.entries(this.binding)) merged[sid] = tid
        for (const sid of this._deletedBindings) delete merged[sid]
        this.binding = merged
        this._auxVersion++
      }
    }
    if (this._dirtyWatch) {
      const disk = this._loadJson(path.join(this.dir, WATCH_FILE), [])
      if (Array.isArray(disk)) {
        const set = new Set([...disk, ...this.watchlist])
        for (const root of this._removedWatch) set.delete(root)
        this.watchlist = [...set]
        this._auxVersion++
      }
    }
  }

  getIdfCache() {
    // IDF 只依赖 entries，按 entries 变更计数失效：只写经验/insight 或只做压实不会重建 IDF。
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
      // 语料必须与**检索**同源（search.js 的 weightedFieldText 含 title×5、keywords、summary、
      // terms、sourcePath）；手抄副本曾漏掉 terms/sourcePath，让只出现在 terms 里的词拿到虚高 IDF。
      const terms = tokenizeRaw(makeSearchText(entry))
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
      this._removedWatch.delete(root)
      this._auxVersion++
      return true
    }
    return false
  }

  removeWatch(root) {
    const before = this.watchlist.length
    this.watchlist = this.watchlist.filter((r) => r !== root)
    if (this.watchlist.length !== before) {
      this._removedWatch.add(root)
      this._dirtyWatch = true
      this._auxVersion++
    }
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
      this._setFileTextChars(relPath, entryTextChars(enriched))
    } else {
      delete this.entries[relPath]
      this._setFileTextChars(relPath, 0)
    }
    this._entriesVersion++
    this._dirtyShards.add(relPath)
    this._removedShards.delete(relPath)
  }

  removeFile(relPath) {
    if (relPath in this.files) {
      delete this.files[relPath]
      delete this.entries[relPath]
      this._setFileTextChars(relPath, 0)
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
   * 这个 store 里有没有任何"事实"。用于判断"值不值得为一条记账把它落盘"：从没被索引过、
   * 也没写过任何东西的根，不该因一次**全局** insight 命中就被建出目录（审计侧同理）。
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
    for (const [relPath, list] of Object.entries(this.entries)) {
      let addedChars = 0
      for (const entry of list) {
        // searchText 不落盘，首次用到时按需物化并挂在对象上（同一 entry 只算一次）。
        if (entry.searchText === undefined) {
          entry.searchText = makeSearchText(entry)
          addedChars += entry.searchText.length
          materialized++
        }
        out.push(entry)
      }
      // 物化是实打实的内存增量（70119 条目实测 +34MB），必须进上界——按文件替换，与写路径同语义。
      if (addedChars) this._setFileTextChars(relPath, (this._fileTextChars.get(relPath) || 0) + addedChars)
    }
    // 物化只改 entry 对象、不改 entries 构成，`_entriesVersion` 不动，所以要单独的失效键。
    if (materialized) this._materializeVersion++
    return out
  }

  // v0.4 的 experience 读写入口已随统一存储删除：经验笔记现在是 `kind:'experience'` 的 insight，
  // `experience.json` 只剩 `_migrateExperienceToInsights` 的导入源这一个角色。

  stats() {
    return {
      files: Object.keys(this.files).length,
      entries: this.allEntries().length,
      // 经验笔记 = insight 里 kind:'experience' 的那些（含从 v0.4 导入的）。project 级为准。
      experience: this.insights.items.filter((it) => it && it.kind === 'experience').length,
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
    if (task?.id) {
      this._deletedTaskIds.delete(task.id)
      this._createdTaskIds.add(task.id)
    }
    this._dirtyTasks = true
    this._auxVersion++
  }

  updateTask(id, updates) {
    const task = this.tasks.find((t) => t.id === id)
    if (!task) return false
    Object.assign(task, updates, { updatedAt: new Date().toISOString() })
    this._dirtyTasks = true
    this._auxVersion++
    return true
  }

  removeTask(id) {
    const idx = this.tasks.findIndex((t) => t.id === id)
    if (idx === -1) return false
    this.tasks.splice(idx, 1)
    this._deletedTaskIds.add(id)
    this.removeBindingsForTask(id)
    this._dirtyTasks = true
    this._auxVersion++
    return true
  }

  /**
   * 清掉所有指向该任务的会话绑定。任务已停用时绑定再留着，只会在下一次 todo 写入时被
   * 当成"没有任务"再建一条，旧条目却永远占着 binding.json。
   * @param {string} taskId
   * @returns {boolean} 是否真的删掉了绑定
   */
  removeBindingsForTask(taskId) {
    let changed = false
    for (const sid of Object.keys(this.binding)) {
      if (this.binding[sid] !== taskId) continue
      delete this.binding[sid]
      this._deletedBindings.add(sid)
      changed = true
    }
    if (changed) {
      this._dirtyBinding = true
      this._auxVersion++
    }
    return changed
  }

  setBinding(sessionId, taskId) {
    if (!sessionId) return
    this.binding[sessionId] = taskId
    this._deletedBindings.delete(sessionId)
    this._dirtyBinding = true
    this._auxVersion++
  }

  getBoundTaskId(sessionId) {
    return sessionId ? this.binding[sessionId] : undefined
  }

  removeBinding(sessionId) {
    if (sessionId && sessionId in this.binding) {
      delete this.binding[sessionId]
      this._deletedBindings.add(sessionId)
      this._dirtyBinding = true
      this._auxVersion++
    }
  }

  /**
   * 每项目任务数上限随项目体积自适应；超限按 lastActiveAt 归档最旧（只统计非归档）。
   * **仍被会话绑定的任务不参与裁剪**：绑定意味着"任务还没结束，某个会话随时会回来接着干"。
   * 一刀切会把长期挂着的绑定任务静默归档，会话回来写 todo 时会另建一条新任务，历史被拆成
   * 两条、原条目成归档孤儿。代价是活跃列表可能多出绑定任务数条——这是刻意取舍；想真正
   * 停掉一个任务，先解绑或显式归档。
   * @returns {number} 本轮归档的条数
   */
  pruneTasks() {
    const fileCount = Object.keys(this.files).length
    const maxTasks = Math.min(100, Math.max(5, Math.floor(fileCount / 20)))
    const bound = new Set(Object.values(this.binding || {}))
    const nonArchived = this.tasks.filter((t) => !t.archived && !bound.has(t.id))
    if (nonArchived.length <= maxTasks) return 0
    const ts = (t) => new Date(t.lastActiveAt || t.updatedAt || t.createdAt || 0).getTime()
    const sorted = [...nonArchived].sort((a, b) => ts(a) - ts(b))
    const toArchive = sorted.slice(0, nonArchived.length - maxTasks)
    for (const task of toArchive) {
      task.archived = true
      this._dirtyTasks = true
    }
    if (toArchive.length) this._auxVersion++
    return toArchive.length
  }

  /**
   * @param {(store: ProjectMemoryStore) => any} fn 变更函数
   * @param {{save?: boolean}} [options] save=false 时只标脏，由调用方在回合结束统一 flush
   *   （文件工具每读一次都会更新任务热点，逐次落盘会把 tasks.json 写成每工具调用一次）。
   */
  commit(fn, options = {}) {
    const result = fn(this)
    this.pruneTasks()
    if (options.save !== false) this.save()
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
    // 不调 store.stats()：overview 也会被喂裸桩（测试/子索引汇总），少一个必需方法就少一处崩点。
    experience: Array.isArray(store.insights?.items) ? store.insights.items.filter((it) => it && it.kind === 'experience').length : 0,
    latest,
  }
}
