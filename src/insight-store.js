// insight 存储与策略：单一 insight 实体，scope 分层 task(task.insights[]) / project(insights.json) /
// global(global.json)。去重靠双向 token overlap：≥ dedupOverlap 合并，reinforceBand 起只强化（不改正文）；
// 提升 = 字段变更（不跨文件复制）；归档 = 软删（archived:true，不进召回/注入），物理删除只在容量溢出；
// 写盘前过滤密钥/token/私钥形态，命中即拒绝写入。
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { normalizedTokenOverlap, findBestOverlapMatch, insightMatchText } from './similarity.js'
import { acquireDirLock, writeJsonAtomic } from './util/fs.js'
import { debugPersistence } from './util/persist.js'
import { trackDirty, untrackDirty } from './util/flush.js'
import { backfillDerivedTriggers } from './readiness.js'
import { vectorText } from './vector-index.js'
import { tokenize } from './util/search.js'

export const INSIGHT_KINDS = ['lesson', 'decision', 'procedure', 'experience']
export const INSIGHT_SCOPES = ['task', 'project', 'global']

export const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
  /(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i,
]

/** 检测疑似密钥/token/私钥形态内容；命中返回第一个命中字段名，否则 null。 */
export function containsSecretFields(ins, fields = ['title', 'body', 'pattern', 'fix', 'problem', 'solution', 'choice', 'reason', 'steps']) {
  for (const f of fields) {
    const v = ins && ins[f]
    if (!v) continue
    const text = Array.isArray(v) ? v.join('\n') : String(v)
    for (const re of SECRET_PATTERNS) if (re.test(text)) return f
  }
  return null
}

function num(v, d) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d
}

/** 两个 ISO 时间戳的先后；缺失/非法一律 0。 */
function newerIso(a, b) {
  const ta = Date.parse(a || '') || 0
  const tb = Date.parse(b || '') || 0
  return ta - tb
}

/** 合并配置（config.insight 之上补默认）。 */
export function cfgInsight(config) {
  const c = (config && config.insight) || {}
  const cfg = {
    dedupOverlap: num(c.dedupOverlap, 0.7),
    reinforceBand: num(c.reinforceBand, 0.65),
    // 向量带（需 leanvec；没装就退化成纯词法带）。阈值由真实 store 标定：47 条 live 条目、1081 对
    // 余弦 max=0.655 / p99=0.531；改写后 min=0.688 / p50=0.809。0.90 自动覆盖（逐字级再记录）、
    // 0.70 提示（真实条目零噪声，改写后 78% 落进来）、0.65 起误伤（1/1081）。**0 = 关闭**这条带。
    autoMergeCos: num(c.autoMergeCos, 0.9),
    // 自动覆盖还要求"第一名明显领先第二名"，否则同话题撞两条时不知道该覆盖谁。
    autoMergeMargin: num(c.autoMergeMargin, 0.05),
    hintCos: num(c.hintCos, 0.7),
    // `forget` 关键词删除的上限：超了不删、只列候选。真删且无撤销——一次 `forget 'pnpm'`
    // 扫掉十几条精选记忆不可接受。
    maxForgetMatches: num(c.maxForgetMatches, 10),
    maxProject: num(c.maxProject, 100),
    maxGlobalProcedures: num(c.maxGlobalProcedures, 200),
    promoteConfidence: num(c.promoteConfidence, 0.7),
    globalPromoteTasks: num(c.globalPromoteTasks, 3),
    decayDays: num(c.decayDays, 90),
    globalFile: typeof c.globalFile === 'string' && c.globalFile ? c.globalFile : null,
  }
  if (cfg.reinforceBand > cfg.dedupOverlap) cfg.reinforceBand = cfg.dedupOverlap
  return cfg
}

export function defaultGlobalFile() {
  return path.join(os.homedir(), '.config', 'dsh-project-memory', 'global.json')
}

export function emptyInsightsDoc() {
  return { version: 1, migratedAt: null, items: [] }
}

export function makeInsightId() {
  return `ins_${randomUUID()}`
}

const TEXT_FIELDS = ['title', 'body', 'pattern', 'fix', 'problem', 'solution', 'choice', 'reason']
const ARRAY_FIELDS = ['steps', 'files', 'symbols', 'tags', 'sourceTaskIds']

/** 由工具/测试传入的 raw 构造规范 insight（scope/source/timestamps 由调用方定）。 */
export function normalizeInsight(raw, extra = {}) {
  const kind = INSIGHT_KINDS.includes(raw.kind) ? raw.kind : 'lesson'
  const now = extra.nowIso || new Date().toISOString()
  const ins = {
    id: extra.id || makeInsightId(),
    kind,
    scope: extra.scope || 'project',
    // 标题推导必须覆盖 `save_lesson` 的三种最小输入（title / pattern / choice），否则只给 choice 的
    // decision 会落成 `(untitled)`；顺序与 `vectorText` 兜底链一致（写入侧向量文本也走这里）。
    title: String(raw.title || raw.pattern || raw.problem || raw.choice || raw.topic || '(untitled)').slice(0, 200),
    source: extra.source || raw.source || 'agent',
    draft: raw.draft === true || extra.draft === true,
    confidence: num(raw.confidence, num(extra.confidence, 0.8)),
    hitCount: 0,
    createdAt: extra.createdAt || now,
    updatedAt: now,
  }
  if (extra.sourceTaskIds) ins.sourceTaskIds = [...extra.sourceTaskIds]
  if (extra.movedFrom) ins.movedFrom = extra.movedFrom
  for (const f of TEXT_FIELDS) {
    if (raw[f] !== undefined && raw[f] !== null && raw[f] !== '') ins[f] = String(raw[f])
  }
  if (Array.isArray(raw.steps) && raw.steps.length) ins.steps = raw.steps.map((s) => String(s))
  for (const f of ARRAY_FIELDS) {
    if (Array.isArray(raw[f]) && raw[f].length) ins[f] = [...new Set(raw[f].map((x) => String(x)))]
  }
  if (raw.trigger && typeof raw.trigger === 'object') {
    // 所有 kind 通用：when 是唯一触发面 / guard 只收窄 / prevents 是准入条件；
    // 旧字段 keywords / symbols / actions / paths / scope 继续接受（readiness 在内存内迁移）。
    const tr = {}
    for (const f of ['keywords', 'symbols', 'actions', 'paths', 'scope']) {
      if (Array.isArray(raw.trigger[f]) && raw.trigger[f].length) tr[f] = raw.trigger[f].map(String)
    }
    const when = raw.trigger.when
    if (when && typeof when === 'object') {
      const w = {}
      for (const f of ['ops', 'writes', 'intents']) {
        if (Array.isArray(when[f]) && when[f].length) w[f] = when[f].map(String)
      }
      if (Object.keys(w).length) tr.when = w
    }
    const guard = raw.trigger.guard
    if (guard && typeof guard === 'object') {
      const g = {}
      for (const f of ['paths', 'not_paths', 'hosts', 'tags']) {
        if (Array.isArray(guard[f]) && guard[f].length) g[f] = guard[f].map(String)
      }
      if (Object.keys(g).length) tr.guard = g
    }
    if (typeof raw.trigger.prevents === 'string' && raw.trigger.prevents.trim()) {
      tr.prevents = raw.trigger.prevents.trim()
    }
    if (Object.keys(tr).length) ins.trigger = tr
  }
  return ins
}

export function unionStrings(base = [], add = []) {
  const out = new Set(base || [])
  for (const x of add || []) if (x !== undefined && x !== null) out.add(String(x))
  return [...out]
}

/**
 * 跨 scope 移动（promote/demote）时保留"使用痕迹"：命中数、创建时间、`triggerDerived`
 * （提示通道拿它当检索词）。这些字段不在 {@link normalizeInsight} 白名单里，必须显式带回，
 * 否则每次移动都会让条目"看起来从没被用过"。
 * @param {object} copy - 已归一化到新 scope 的副本
 * @param {object} src - 原条目
 */
export function carryUsageFields(copy, src) {
  copy.hitCount = num(src.hitCount, 0)
  if (src.lastHitAt) copy.lastHitAt = src.lastHitAt
  if (src.createdAt) copy.createdAt = src.createdAt
  if (src.triggerDerived) copy.triggerDerived = src.triggerDerived
  // `prev` 是被覆盖挤掉的那一版，必须跟着条目走：promote/demote 走白名单，漏了它就丢了"还能还原"。
  if (src.prev && typeof src.prev === 'object') copy.prev = src.prev
  return copy
}

/**
 * 写一个字段，并把被挤掉的旧值留在 `prev` 单槽：只留**上一个**值，刚好够"误覆盖后写回"，
 * O(1)、无需压实，也不构成第二个真相源。空值不算旧值（`''`/undefined 不写 prev）。
 * @param {object} item 条目（原地修改）；@param {string} key 字段名；@param {unknown} next 新值
 * @param {string[]} replaced 被真正改动过的字段名，调用方据此回报
 */
function putField(item, key, next, replaced) {
  const old = item[key]
  if (JSON.stringify(old) === JSON.stringify(next)) return
  if (old !== undefined && old !== null && old !== '' && !(Array.isArray(old) && !old.length)) {
    if (!item.prev || typeof item.prev !== 'object' || Array.isArray(item.prev)) item.prev = {}
    item.prev[key] = old
  }
  item[key] = next
  replaced.push(key)
}

/** 自动合并会改写的正文字段（title 也在内：0.90 以上的两条标题本就近乎同一句）。 */
const MERGE_FIELDS = ['title', 'pattern', 'fix', 'choice', 'reason', 'problem', 'solution', 'body']

/**
 * 把 base 合并进既有条目：**正文取新值**（旧值进 `prev`），成员/文件/符号并集，置信取高，记命中。
 * 提升路径只传成员/文件/符号/置信，不传正文字段，语义未变。
 * @returns {{item: object, replaced: string[]}} 被改动的字段名（供调用方回报）
 */
export function mergeInto(existing, base, cfg, nowIso) {
  const now = nowIso || new Date().toISOString()
  existing.sourceTaskIds = unionStrings(existing.sourceTaskIds, base.sourceTaskIds)
  existing.files = unionStrings(existing.files, base.files)
  existing.symbols = unionStrings(existing.symbols, base.symbols)
  existing.tags = unionStrings(existing.tags, base.tags)
  const replaced = []
  for (const f of MERGE_FIELDS) {
    const b = base[f]
    if (b === undefined || b === null || b === '') continue
    putField(existing, f, String(b), replaced)
  }
  if (Array.isArray(base.steps) && base.steps.length) putField(existing, 'steps', base.steps.map(String), replaced)
  if (base.trigger && typeof base.trigger === 'object') putField(existing, 'trigger', base.trigger, replaced)
  existing.confidence = Math.max(num(existing.confidence, 0.5), num(base.confidence, 0.5))
  existing.hitCount = (existing.hitCount || 0) + 1
  existing.lastHitAt = now
  existing.updatedAt = now
  if (existing.archived) existing.archived = false // 重新被使用 → 复活
  return { item: existing, replaced }
}

/** 就地更新的可写字段（比自动合并宽：kind/confidence/files 等显式改动也允许）。 */
const UPDATE_FIELDS = ['title', 'kind', 'body', 'pattern', 'fix', 'problem', 'solution', 'choice', 'reason', 'steps', 'trigger', 'files', 'symbols', 'tags', 'confidence']
const UPDATE_ARRAYS = ['steps', 'files', 'symbols', 'tags']

/** 显式就地更新（`save_lesson` 带 id）：只动调用方给的字段，其余原样，旧值进 `prev`。 */
export function applyUpdate(item, raw, nowIso) {
  const now = nowIso || new Date().toISOString()
  const replaced = []
  for (const f of UPDATE_FIELDS) {
    const v = raw[f]
    if (v === undefined || v === null || v === '') continue
    if (f === 'kind') {
      if (INSIGHT_KINDS.includes(v)) putField(item, 'kind', v, replaced)
      continue
    }
    if (f === 'confidence') {
      const n = num(v, NaN)
      if (Number.isFinite(n)) putField(item, 'confidence', Math.max(0, Math.min(1, n)), replaced)
      continue
    }
    if (UPDATE_ARRAYS.includes(f)) {
      if (!Array.isArray(v) || !v.length) continue
      putField(item, f, [...new Set(v.map((x) => String(x)))], replaced)
      continue
    }
    if (f === 'trigger') {
      if (typeof v === 'object') putField(item, 'trigger', v, replaced)
      continue
    }
    putField(item, f, String(v), replaced)
  }
  item.updatedAt = now
  if (item.archived) item.archived = false
  // 显式编辑一条草稿 = 作者确认：reflection 产出的 draft 可被 save_lesson 带 id 直接改正文并转正。
  if (item.draft === true) item.draft = false
  return replaced
}

/**
 * 向量近邻：拿 base 的标题问可选向量层，返回池内最像的一条与第二名。判据用**余弦**而非词法：实测
 * 1081 对里 `insightMatchText` 最大 0.256，够不到 0.70；余弦同一池子 max=0.655 / p99=0.531，无向量 → null。
 * @param {string} text - 本次要写入的文本（用 {@link vectorText} 的口径）
 * @param {object[]} items - 候选池
 * @param {(text: string, items: object[]) => Map<string, number>} [cosine] - 向量打分（同步）
 * @returns {{item: object, top1: number, top2: number}|null}
 */
export function vectorNear(text, items, cosine) {
  if (typeof cosine !== 'function' || !text || !Array.isArray(items) || !items.length) return null
  let m = null
  try { m = cosine(text, items) } catch { return null }
  if (!(m instanceof Map)) return null
  let top1 = -1
  let top2 = -1
  let item = null
  // 池内分布：给"绝对阈值"做本语料的定标（见 autoMergeTarget）。n ≤ 300，顺路算完。
  let n = 0
  let sum = 0
  let sumSq = 0
  for (const it of items) {
    if (!it || it.archived) continue
    const v = m.get(it.id)
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    n++
    sum += v
    sumSq += v * v
    if (v > top1) {
      top2 = top1
      top1 = v
      item = it
    } else if (v > top2) top2 = v
  }
  if (!item) return null
  // 分布必须**排除候选自己**：top1 是待检验的值，算进 μ/σ 会把自己的极端值摊进方差
  // （一条 0.92 + 三条 0.2 会把 σ 抬到 0.33）。排除后 μ/σ 描述"随机一条有多像"，那才是零假设。
  const restN = n - 1
  const restSum = sum - top1
  const restSumSq = sumSq - top1 * top1
  const mu = restN > 0 ? restSum / restN : 0
  const sigma = restN > 1 ? Math.sqrt(Math.max(0, restSumSq / restN - mu * mu)) : 0
  return { item, top1, top2: top2 < 0 ? 0 : top2, mu, sigma, n }
}

/** 近邻是否够"较高"（提示带）；`hintCos <= 0` = 关闭该带。够就返回给调用方回报的形状。 */
function hintOf(near, cfg) {
  if (!near || !(cfg.hintCos > 0) || near.top1 < cfg.hintCos) return null
  return { id: near.item.id, cos: Number(near.top1.toFixed(3)), title: String(near.item.title || '').slice(0, 40) }
}

/**
 * 自动覆盖的"池内相对"系数：题面余弦要同时高于 `μ + k·σ`。0.9 绝对阈值只在**当前语料 +
 * 当前模型**下安全，而这条带是**破坏性写入**：语料模板化会把最近邻余弦整体抬高，换模型/换表
 * 会让余弦尺度整体平移。取 `max(autoMergeCos, μ + k·σ)` 只可能**收紧**：当前 store（122 条、
 * 7381 对）mean=0.281 / sd=0.104 → μ+3σ ≈ 0.59 < 0.9，行为不变。k=3 是零假设分位数
 * （池子 ≤300 时随机撞上的最大余弦 ≈ μ+2.9σ）；再大会退化成"永不自动覆盖"，再小会命中噪声。
 */
const AUTO_MERGE_SIGMA = 3

/**
 * 自动覆盖判定：够高**且**第一名明显领先第二名；`autoMergeCos <= 0` = 关闭。
 * 门槛取"绝对下限"与"池内 μ+k·σ"的较大者（只收紧不放宽，见 {@link AUTO_MERGE_SIGMA}）。
 */
function autoMergeTarget(near, cfg) {
  if (!near || !(cfg.autoMergeCos > 0)) return null
  const floor = Math.max(cfg.autoMergeCos, near.mu + AUTO_MERGE_SIGMA * near.sigma)
  if (near.top1 < floor) return null
  if (near.top1 - near.top2 < cfg.autoMergeMargin) return null
  return near
}

/**
 * 使用记账：条目被**真正用到**时更新活跃度——注入进了上下文，或被 `query_memory` 命中。
 * `applyDecay` / `pruneItems` 判活跃度看 `lastHitAt || updatedAt || createdAt`，而 `lastHitAt`
 * 只由 merge/reinforce 写；不记账的话，天天被注入但没人重写的教训会在 decayDays 后被归档。
 * 记账**不参与任何注入判据**，只影响活跃度/衰减与离线样本标签；语义是"曝光次数"而非"被采纳次数"。
 * 只记非归档条目。返回实际加一的条数，调用方据此决定是否落盘。
 * @returns {number} 被加一的条目数
 */
export function recordHit({ store, globalStore, ids, nowIso } = {}) {
  const want = new Set((ids || []).filter(Boolean))
  if (!want.size) return 0
  const now = nowIso || new Date().toISOString()
  let n = 0
  const touch = (items) => {
    let c = 0
    for (const it of items || []) {
      if (!it || it.archived || !want.has(it.id)) continue
      it.hitCount = num(it.hitCount, 0) + 1
      it.lastHitAt = now
      c++
    }
    n += c
    return c
  }
  if (store && typeof store.insightItems === 'function') {
    const items = store.insightItems()
    if (touch(items)) store.replaceInsightItems(items) // 标脏；落盘由调用方决定
  }
  if (globalStore && typeof globalStore.items === 'function') {
    if (touch(globalStore.items())) globalStore.markDirty()
  }
  return n
}

export function reinforceOnly(existing, base, nowIso) {
  const now = nowIso || new Date().toISOString()
  existing.sourceTaskIds = unionStrings(existing.sourceTaskIds, base.sourceTaskIds)
  existing.hitCount = (existing.hitCount || 0) + 1
  existing.lastHitAt = now
  existing.updatedAt = now
  if (existing.archived) existing.archived = false
  return existing
}

function allTaskInsights(store) {
  const out = []
  for (const t of store.getTasks() || []) for (const ins of t.insights || []) out.push(ins)
  return out
}

function taskContaining(store, insightId) {
  for (const t of store.getTasks() || []) {
    if ((t.insights || []).some((i) => i.id === insightId)) return t
  }
  return null
}

function removeFromTask(store, insightId) {
  const t = taskContaining(store, insightId)
  if (!t) return
  t.insights = (t.insights || []).filter((i) => i.id !== insightId)
  store.markTasksDirty()
}

// ---- 容量与衰减（归档代替硬删） ----

const DAY_MS = 86400000

function tsOf(ins, field) {
  const v = ins[field]
  return v ? Date.parse(v) || 0 : 0
}

function activityOf(ins) {
  return tsOf(ins, 'lastHitAt') || tsOf(ins, 'updatedAt') || tsOf(ins, 'createdAt') || 0
}

export function applyDecay(items, cfg, nowIso) {
  const now = nowIso || new Date().toISOString()
  const limit = Date.parse(now) - cfg.decayDays * DAY_MS
  let archived = 0
  for (const it of items) {
    if (!it || it.archived) continue
    // 用"最近活动"而不是 lastHitAt：后者只由 merge/reinforce 写（同时加 hitCount），
    // 先判 `hitCount > 0 → continue` 会让 lastHitAt 分支永远不可达，decayDays 成了死开关。
    const last = activityOf(it)
    if (last && last <= limit) {
      it.archived = true
      it.updatedAt = now
      archived++
    }
  }
  return archived
}

/**
 * 超限按"最不活跃"物理删除，直到回落到上限，已有 archived 条目优先。
 * 注意：没有归档可删时，本轮归档的条目会在同一次调用的后续循环里被删掉——
 * `archived` 计数是"先归档、随即被删"，不是"留下了软删副本"。
 */
export function pruneItems(items, max, nowIso) {
  const now = nowIso || new Date().toISOString()
  let removed = 0
  let archivedNow = 0
  while (items.length > max) {
    const arch = items.filter((i) => i.archived).sort((a, b) => activityOf(a) - activityOf(b))
    if (arch.length) {
      const victim = arch[0]
      const idx = items.indexOf(victim)
      if (idx !== -1) items.splice(idx, 1)
      removed++
    } else {
      const sorted = [...items].sort((a, b) => activityOf(a) - activityOf(b) || num(a.confidence, 0) - num(b.confidence, 0))
      const victim = sorted[0]
      if (!victim) break
      victim.archived = true
      victim.updatedAt = now
      archivedNow++
    }
  }
  return { removed, archived: archivedNow }
}

// ---- Global 存储（~/.config/dsh-project-memory/global.json） ----

/** 进程内按文件路径复用；整份文档读改写，两个实例会互相覆盖。 */
const globalStoreCache = new Map()

function readJson(file, fallback) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
  try {
    return JSON.parse(raw)
  } catch {
    const backup = `${file}.${Date.now()}.corrupt`
    try {
      renameSync(file, backup)
      console.error(`[dsh-project-memory] corrupted ${path.basename(file)} moved to ${path.basename(backup)}; starting fresh`)
    } catch {
      // 保留现场，回退默认
    }
    return fallback
  }
}

function normalizeDoc(doc) {
  if (doc && typeof doc === 'object' && Array.isArray(doc.items)) {
    if (typeof doc.version !== 'number') doc.version = 1
    if (!Array.isArray(doc.items)) doc.items = []
    return doc
  }
  return emptyInsightsDoc()
}

export class GlobalStore {
  constructor(file) {
    this.file = file
    this.doc = null
    this._dirty = false
    this._baseIds = new Set()
    this._deletedIds = new Set()
    /** 本进程新建的 id：磁盘缺失时只有它们该补写，否则会把对方删掉的条目复活。 */
    this._createdIds = new Set()
    /** 上一次 commit 是否真的落盘（锁竞争时 false）；调用方据此如实回报。 */
    this.lastCommitOk = true
    this._lockWarned = false
    /** 锁竞争后的有限次延迟重试（与 ProjectMemoryStore.save 同一套节拍）。 */
    this._retryTimer = null
    this._retryAttempts = 0
  }

  load() {
    // 整份文档读改写：同一路径必须共用实例，否则两个工具/会话交错时后写覆盖先写。
    // 与 ProjectMemoryStore 的 storeCache 同语义，这里只按路径缓存。
    const key = path.resolve(this.file)
    const hot = globalStoreCache.get(key)
    if (hot) {
      this.doc = hot.doc
      this._dirty = hot._dirty
      return hot
    }
    this.doc = normalizeDoc(readJson(this.file, null))
    // 与 project 级一致：global 条目也要补派生 trigger（提示通道用它提升召回；确定性、幂等）。
    if (backfillDerivedTriggers(this.doc)) this.markDirty()
    this._baseIds = new Set(this.doc.items.map((it) => it?.id).filter(Boolean))
    globalStoreCache.set(key, this)
    return this
  }

  items() {
    return this.doc.items
  }

  markDirty() {
    this._dirty = true
  }

  /**
   * 退出/卸载路径的同步兜底（见 util/flush.js）。`commit()` 返回的是 `fn` 的返回值，
   * 不能当成功信号；这里收敛成 boolean，否则 flushDirtyStores() 会把写成功的 store 计成 0。
   */
  flushPending(timeoutMs = 1500) {
    if (!this._dirty) return true
    this.commit(undefined, { timeoutMs })
    return this.lastCommitOk === true
  }

  /** 锁竞争失败后的有限次延迟重试：没有重试就会永久丢这次写入。 */
  _scheduleRetry() {
    const delays = [100, 500, 2000, 6000, 12000]
    if (this._retryTimer || this._retryAttempts >= delays.length) return
    const delay = delays[this._retryAttempts++]
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null
      try {
        this.commit(undefined, { timeoutMs: 2000 })
      } catch (err) {
        console.error(`[dsh-project-memory] deferred global save failed: ${err?.message || err}`)
      }
    }, delay)
    this._retryTimer.unref?.()
  }

  /**
   * 变更提交：fn(this.doc) 后加锁、合并另一进程的磁盘状态、原子落盘。
   * @param {(doc: object, store: GlobalStore) => any} [fn]
   * @param {{ timeoutMs?: number }} [options] 等锁上限（默认 15s：正确性靠同步等待，不靠重试）
   */
  commit(fn, options = {}) {
    const res = fn ? fn(this.doc, this) : undefined
    if (!this._dirty && res === undefined) return res
    // 本进程从基线里删掉的 id（removeMemory 直接 splice，没有单独的删除 API）。
    const current = new Set(this.doc.items.map((it) => it?.id).filter(Boolean))
    for (const id of this._baseIds) if (!current.has(id)) this._deletedIds.add(id)
    for (const id of current) {
      this._deletedIds.delete(id)
      if (!this._baseIds.has(id)) this._createdIds.add(id)
    }
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000
    const release = acquireDirLock(path.dirname(this.file), { timeoutMs })
    if (!release) {
      this.lastCommitOk = false
      trackDirty(this)
      if (!this._lockWarned) {
        this._lockWarned = true
        debugPersistence(`[dsh-project-memory] global store ${this.file} is busy (another dsh process is writing); this write is pending.`)
      }
      this._scheduleRetry()
      return res
    }
    try {
      const disk = normalizeDoc(readJson(this.file, null))
      const byId = new Map()
      for (const it of disk.items) if (it?.id) byId.set(it.id, it)
      for (const it of this.doc.items) {
        if (!it?.id) continue
        if (this._deletedIds.has(it.id)) {
          byId.delete(it.id)
          continue
        }
        const prev = byId.get(it.id)
        if (!prev) {
          // 磁盘没有：本进程新建的才补写；否则是对方删了，丢掉内存里的旧副本。
          if (this._createdIds.has(it.id)) byId.set(it.id, it)
          continue
        }
        if (newerIso(it.updatedAt, prev.updatedAt) >= 0) byId.set(it.id, it)
      }
      for (const id of this._deletedIds) byId.delete(id)
      this.doc.items = [...byId.values()]
      writeJsonAtomic(this.file, this.doc)
      this._dirty = false
      this._baseIds = new Set(this.doc.items.map((it) => it?.id).filter(Boolean))
      this._createdIds.clear()
      this.lastCommitOk = true
      this._retryAttempts = 0
      untrackDirty(this)
    } catch (err) {
      // 非锁原因的写失败：状态与锁竞争路径一致（lastCommitOk=false + 进退出 flush）。
      this.lastCommitOk = false
      trackDirty(this)
      throw err
    } finally {
      release()
    }
    return res
  }
}

// ---- 单条保存：scope 路由 ----

/**
 * 按 id 在三个 home 里找一条（global → project → 各任务的 task.insights[]）。`id` 是全局键，
 * 模型不该为了改一条记忆先搞清它在哪一层；scope 用条目自己声明的。
 * @returns {{scope: string, item: object, taskId?: string}|null}
 */
export function findInsightAnywhere({ store, globalStore } = {}, id) {
  if (!id) return null
  if (globalStore && typeof globalStore.items === 'function') {
    const it = globalStore.items().find((i) => i && i.id === id)
    if (it) return { scope: it.scope || 'global', item: it }
  }
  if (store && typeof store.insightItems === 'function') {
    const it = store.insightItems().find((i) => i && i.id === id)
    if (it) return { scope: it.scope || 'project', item: it }
  }
  const tasks = store && typeof store.getTasks === 'function' ? store.getTasks() || [] : []
  for (const t of tasks) {
    const it = (t.insights || []).find((i) => i && i.id === id)
    if (it) return { scope: it.scope || 'task', item: it, taskId: t.id }
  }
  return null
}

/** 一条记忆用于关键词匹配的全文（insight 与旧经验笔记共用一套口径）。 */
function memoryText(it) {
  if (!it) return ''
  return [it.title, it.problem, it.pattern, it.fix, it.solution, it.choice, it.reason, it.body, ...(Array.isArray(it.steps) ? it.steps : [])]
    .filter(Boolean)
    .join(' ')
}

/**
 * 关键词匹配度：**查询侧覆盖率**（命中词 / 查询词数），沿用旧经验层 `removeExperience` 的口径。
 * 不用 `normalizedTokenOverlap`（两侧取大）：删除查询通常只有一个词，取大会被长正文稀释到接近 0，
 * "删掉 pnpm 那条"就永远删不掉。
 */
function queryCoverage(query, text) {
  const q = tokenize(query)
  if (!q.length) return 0
  const t = new Set(tokenize(text))
  if (!t.size) return 0
  let hit = 0
  for (const x of q) if (t.has(x)) hit++
  return hit / q.length
}

/**
 * 最近删除的保留条数。删除仍是**真删**（"no undo" 不变）：这里只把刚删掉的条目按层追加进
 * 同目录的 {@link DELETED_FILE}，滚动保留 5 条。5 够覆盖"刚删错一条/一批"的窗口，又不足以在盘上
 * 长期留正文副本；按层分文件是为了与各自真相源同源，删库/搬家时不会对不上。
 */
export const DELETED_KEEP = 5

/** 删除留痕文件名（与 store 同目录）。 */
export const DELETED_FILE = 'deleted.json'

/** 某层 store 目录下的留痕文件绝对路径。 */
export function deletedFilePath(dir) {
  return dir ? path.join(dir, DELETED_FILE) : null
}

/**
 * 把即将被删的条目写进各自层的留痕文件（滚动保留最近 {@link DELETED_KEEP} 条）。
 * 契约：**永不抛、永不挡删除**，留痕是旁路，写失败只丢留痕。
 * @param {{store?: object, globalStore?: object}} stores - 两个 store；按条目的 `home` 选目录
 * @param {Array<object>} entries - 完整条目副本，须带 `home` 与可选 `taskId`
 * @returns {string[]} 实际写入的留痕文件路径（去重）
 */
export function recordDeleted({ store, globalStore } = {}, entries = []) {
  const now = new Date().toISOString()
  const byDir = new Map()
  for (const e of entries) {
    if (!e || !e.id) continue
    const dir = e.home === 'global'
      ? (globalStore && globalStore.file ? path.dirname(globalStore.file) : null)
      : (store ? store.dir : null)
    if (!dir) continue
    const batch = byDir.get(dir) || []
    batch.push({ ...e, deletedAt: now })
    byDir.set(dir, batch)
  }
  const written = []
  for (const [dir, batch] of byDir) {
    const file = deletedFilePath(dir)
    let prev = []
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8'))
      if (doc && Array.isArray(doc.items)) prev = doc.items
    } catch {
      // 首次删除（文件不存在）或留痕文件损坏：从空开始，不因旁路数据带崩删除。
    }
    try {
      writeJsonAtomic(file, { version: 1, updatedAt: now, items: [...batch, ...prev].slice(0, DELETED_KEEP) })
      written.push(file)
    } catch {
      // 写不进去（只读盘 / 权限）就放弃留痕：删除本身照常进行。
    }
  }
  return [...new Set(written)]
}

/**
 * 全层删除：task 内嵌 / project / global，一套判据、一次调用。对模型来说这本来就是一件事——
 * "把那条记错的删掉"，它不该先搞清自己在哪个层。
 * @param {object} o
 * @param {string} o.idOrQuery - 精确 id，或用于匹配的关键词
 * @param {number} [o.maxMatches] - 关键词命中上限；超过则**一条都不删**，只回报候选
 * @returns {{ok: boolean, removed?: object[], matches?: object[], tooMany?: boolean, keptIn?: string[]}}
 */
export function removeMemory({ store, globalStore, idOrQuery, maxMatches = 10 } = {}) {
  const query = String(idOrQuery ?? '').trim()
  if (!query) return { ok: false, removed: [], matches: [] }
  const at = (home, item, taskId) => ({
    id: item.id,
    home,
    taskId,
    title: String(item.title || item.problem || '(untitled)').slice(0, 60),
  })
  const pools = { project: [], global: [], task: [] }
  for (const it of (store && typeof store.insightItems === 'function' ? store.insightItems() : []) || []) pools.project.push(at('project', it))
  for (const it of (globalStore && typeof globalStore.items === 'function' ? globalStore.items() : []) || []) pools.global.push(at('global', it))
  for (const t of (store && typeof store.getTasks === 'function' ? store.getTasks() : []) || []) {
    for (const it of t.insights || []) pools.task.push(at('task', it, t.id))
  }

  // 1) 精确 id：直接删那一条，不做关键词匹配（id 是模型手里唯一无歧义的键）
  const byId = []
  for (const [home, list] of Object.entries(pools)) {
    const hit = list.find((x) => x.id === query)
    if (hit) byId.push({ ...hit, home })
  }
  if (byId.length) {
    const keptIn = removeEntries({ store, globalStore }, byId)
    return { ok: true, removed: byId, keptIn }
  }

  // 2) 关键词：查询侧覆盖率 ≥ 0.5（与旧经验层同判据）
  const matches = []
  const textOf = (home, id) => {
    if (home === 'project') return memoryText((store.insightItems() || []).find((x) => x.id === id))
    if (home === 'global') return memoryText((globalStore.items() || []).find((x) => x.id === id))
    for (const t of store.getTasks() || []) {
      const it = (t.insights || []).find((x) => x.id === id)
      if (it) return memoryText(it)
    }
    return ''
  }
  for (const list of Object.values(pools)) {
    for (const x of list) if (queryCoverage(query, textOf(x.home, x.id)) >= 0.5) matches.push(x)
  }
  if (matches.length > maxMatches) return { ok: false, tooMany: true, matches, removed: [] }
  const keptIn = removeEntries({ store, globalStore }, matches)
  return { ok: true, removed: matches, keptIn }
}

/** 按 home 把条目从各自真相源里移除；删除前先把**完整条目**写进留痕文件。 */
function removeEntries({ store, globalStore }, entries) {
  // entries 是 at() 的摘要（只有 id/home/title），留痕要正文：按 id 回真相源取完整对象，
  // 顺序在 splice 之前，取不到就跳过留痕（不挡删除）。
  const full = []
  for (const e of entries) {
    if (e.home === 'project') {
      const it = (store.insightItems() || []).find((x) => x.id === e.id)
      if (it) full.push({ ...it, home: 'project' })
    } else if (e.home === 'global') {
      const it = (globalStore.items() || []).find((x) => x.id === e.id)
      if (it) full.push({ ...it, home: 'global' })
    } else if (e.home === 'task') {
      const task = store.getTask(e.taskId)
      const it = (task?.insights || []).find((x) => x.id === e.id)
      if (it) full.push({ ...it, home: 'task', taskId: e.taskId })
    }
  }
  const keptIn = recordDeleted({ store, globalStore }, full)

  const projectIds = new Set()
  const globalIds = new Set()
  const taskIds = new Map()
  for (const e of entries) {
    if (e.home === 'project') projectIds.add(e.id)
    else if (e.home === 'global') globalIds.add(e.id)
    else if (e.home === 'task') taskIds.set(e.taskId, [...(taskIds.get(e.taskId) || []), e.id])
  }
  if (projectIds.size) store.replaceInsightItems(store.insightItems().filter((i) => !projectIds.has(i.id)))
  if (globalIds.size) {
    const items = globalStore.items()
    for (let i = items.length - 1; i >= 0; i--) if (globalIds.has(items[i].id)) items.splice(i, 1)
    globalStore.markDirty()
  }
  for (const [taskId, ids] of taskIds) {
    const task = store.getTask(taskId)
    if (!task) continue
    task.insights = (task.insights || []).filter((i) => !ids.includes(i.id))
    store.markTasksDirty()
  }
  return keptIn
}

/**
 * 统一入口。scope: task 需要 taskId（store 内须存在）；project 走 store 的 insights 文档；
 * global 走 globalStore。`raw.id` 给定时走**就地更新**（忽略 scope 路由：条目留在原 home，
 * 只覆盖显式给的字段，旧值进 `prev`）。`cosine` 给定时启用向量带：≥ autoMergeCos 且领先第二名
 * ≥ autoMergeMargin → 自动覆盖；≥ hintCos → 新建但回报近邻 id；都不给就是纯词法行为。
 * 返回 { ok, action, id, replaced, near, hint }。
 */
export function saveInsight({ store, globalStore, raw, scope, taskId, cfg, source = 'agent', nowIso, cosine = null }) {
  const cfg2 = cfg || cfgInsight({})
  const now = nowIso || new Date().toISOString()
  const secretField = containsSecretFields(raw)
  if (secretField) {
    return { ok: false, error: `内容疑似包含密钥/token/私钥形态数据（字段: ${secretField}），已拒绝写入` }
  }
  if (raw && raw.id) {
    const found = findInsightAnywhere({ store, globalStore }, raw.id)
    if (!found) return { ok: false, error: `找不到要更新的条目: ${raw.id}（可能已被删除/提升；用 query_memory 重新确认 id）` }
    const wasDraft = found.item.draft === true
    const replaced = applyUpdate(found.item, raw, now)
    if (found.scope === 'global') globalStore.markDirty()
    else if (found.scope === 'task') store.markTasksDirty()
    else store.replaceInsightItems(store.insightItems())
    const hint = replaced.length
      ? `已就地更新（覆盖字段：${replaced.join('/')}，旧值在 prev）`
      : wasDraft ? '已确认草稿（draft=false）' : '没有字段变化'
    return {
      ok: true,
      action: 'updated',
      id: raw.id,
      scope: found.scope,
      replaced,
      hint: wasDraft && replaced.length ? `${hint}；草稿已确认` : hint,
    }
  }
  const s = scope || 'project'
  if (!INSIGHT_SCOPES.includes(s)) return { ok: false, error: `非法 scope: ${s}` }
  if (s === 'global') {
    if (!globalStore) return { ok: false, error: 'global 存储未初始化' }
    const res = upsertIntoPool(globalStore.items(), raw, cfg2, now, { source, scope: 'global', cosine })
    if (res.action === 'created') pruneItems(globalStore.items(), cfg2.maxGlobalProcedures, now)
    globalStore.markDirty()
    return { ok: true, ...res, scope: 'global', hint: res.hint || buildHint(res) }
  }
  if (s === 'task') {
    if (!store || !taskId) return { ok: false, error: 'task 级写入需要 taskId' }
    const task = store.getTask(taskId)
    if (!task) return { ok: false, error: `任务不存在: ${taskId}` }
    return saveTaskInsight(store, globalStore, task, raw, cfg2, now, source, cosine)
  }
  return saveProjectInsight(store, globalStore, raw, cfg2, now, source, cosine)
}

/**
 * 在 items 池内 upsert：向量带（自动覆盖/提示）优先，其次词法带（合并/强化/新建）。
 * raw 需已过密文检查。
 */
function upsertIntoPool(items, raw, cfg, nowIso, extra = {}) {
  const base = { ...raw, source: extra.source, sourceTaskIds: extra.sourceTaskIds || raw.sourceTaskIds }
  const text = insightMatchText(base)
  const near = vectorNear(vectorText(base), items, extra.cosine)
  const target = autoMergeTarget(near, cfg)
  if (target) {
    const { replaced } = mergeInto(target.item, base, cfg, nowIso)
    return { action: 'auto-merged', id: target.item.id, replaced, cos: Number(target.top1.toFixed(3)) }
  }
  const hit = findBestOverlapMatch(text, items)
  if (hit && hit.score >= cfg.dedupOverlap) {
    const { replaced } = mergeInto(hit.item, base, cfg, nowIso)
    return { action: 'merged', id: hit.item.id, replaced }
  }
  if (hit && hit.score >= cfg.reinforceBand) {
    reinforceOnly(hit.item, base, nowIso)
    return { action: 'reinforced', id: hit.item.id }
  }
  const ins = normalizeInsight(base, { scope: extra.scope || 'project', source: extra.source, nowIso })
  items.push(ins)
  const hint = hintOf(near, cfg)
  return hint ? { action: 'created', id: ins.id, near: hint } : { action: 'created', id: ins.id }
}

// ---- scope = project ----

function saveProjectInsight(store, globalStore, raw, cfg, now, source, cosine) {
  const items = store.insightItems()
  const res = upsertIntoPool(items, raw, cfg, now, { source, scope: 'project', cosine })
  store.replaceInsightItems(items) // 一律标脏（created/merged/auto-merged/reinforced 都改了数组）
  applyDecay(items, cfg, now)
  const pruned = pruneItems(items, cfg.maxProject, now)
  const promoted = promoteProjectToGlobal(store, globalStore, cfg, now)
  return { ok: true, ...res, scope: 'project', hint: buildHint(res, pruned, promoted) }
}

function buildHint(res, pruned, promoted) {
  const bits = []
  if (res.action === 'created') bits.push('已新建')
  else if (res.action === 'merged') bits.push('已与既有条目合并')
  else if (res.action === 'reinforced') bits.push('近重复，已强化命中')
  else if (res.action === 'auto-merged') bits.push(`相似度 ${res.cos}，已自动覆盖既有条目`)
  if (Array.isArray(res.replaced) && res.replaced.length) {
    bits.push(`覆盖字段 ${res.replaced.join('/')}（旧值留在 prev：用同一个 id 再写一次即可写回）`)
  }
  if (res.near && res.near.id !== res.id) {
    bits.push(`近邻 ${res.near.id}（相似度 ${res.near.cos}：《${res.near.title}》）——若这是同一条知识，带 id=${res.near.id} 再写一次即可就地覆盖；确认过时的用 forget 删掉它`)
  }
  if (pruned && pruned.removed) bits.push(`容量清理 ${pruned.removed} 条`)
  if (promoted) bits.push(`自动提升 global ${promoted} 条`)
  return bits.length ? bits.join('；') : ''
}

// ---- scope = task ----

function saveTaskInsight(store, globalStore, task, raw, cfg, now, source, cosine) {
  // 反思产出是**待确认草稿**：只落在当前任务，绝不参与 project/global/跨任务的自动合并或
  // 自动提升，否则一条 LLM 生成的 draft 可以覆盖作者手写的 project 级知识。
  const draftOnly = raw.draft === true || source === 'reflect'
  const base = { ...raw, source, sourceTaskIds: [task.id] }
  const text = insightMatchText(base)
  if (!draftOnly) {
    // 1) 已有 project 级知识 → 挂成员/命中，不再在 task 层重复存
    const pjItems = store.insightItems()
    const pjNear = vectorNear(vectorText(base), pjItems, cosine)
    const pjTarget = autoMergeTarget(pjNear, cfg)
    if (pjTarget) {
      const { replaced } = mergeInto(pjTarget.item, base, cfg, now)
      store.replaceInsightItems(pjItems)
      applyDecay(pjItems, cfg, now)
      pruneItems(pjItems, cfg.maxProject, now)
      const promoted = promoteProjectToGlobal(store, globalStore, cfg, now)
      return { ok: true, action: 'auto-merged', id: pjTarget.item.id, scope: 'project', replaced, cos: Number(pjTarget.top1.toFixed(3)), hint: `相似度 ${pjTarget.top1.toFixed(3)}，已自动覆盖 project 级既有条目${replaced.length ? `（覆盖字段 ${replaced.join('/')}）` : ''}${promoted ? '；已自动提升 global' : ''}` }
    }
    const pjHit = findBestOverlapMatch(text, pjItems)
    if (pjHit && pjHit.score >= cfg.dedupOverlap) {
      const { replaced } = mergeInto(pjHit.item, base, cfg, now)
      store.replaceInsightItems(pjItems)
      applyDecay(pjItems, cfg, now)
      pruneItems(pjItems, cfg.maxProject, now)
      const promoted = promoteProjectToGlobal(store, globalStore, cfg, now)
      return { ok: true, action: 'linked-project', id: pjHit.item.id, scope: 'project', replaced, hint: `该知识已在 project 级，累计第 ${(pjHit.item.sourceTaskIds || []).length} 个任务命中${promoted ? '；已自动提升 global' : ''}` }
    }
    // 2) 已有 global 级知识 → 同样只挂命中
    if (globalStore) {
      const glNear = vectorNear(vectorText(base), globalStore.items(), cosine)
      const glTarget = autoMergeTarget(glNear, cfg)
      if (glTarget) {
        const { replaced } = mergeInto(glTarget.item, base, cfg, now)
        globalStore.markDirty()
        return { ok: true, action: 'auto-merged', id: glTarget.item.id, scope: 'global', replaced, cos: Number(glTarget.top1.toFixed(3)), hint: `相似度 ${glTarget.top1.toFixed(3)}，已自动覆盖 global 级既有条目${replaced.length ? `（覆盖字段 ${replaced.join('/')}）` : ''}` }
      }
      const glHit = findBestOverlapMatch(text, globalStore.items())
      if (glHit && glHit.score >= cfg.dedupOverlap) {
        const { replaced } = mergeInto(glHit.item, base, cfg, now)
        globalStore.markDirty()
        return { ok: true, action: 'linked-global', id: glHit.item.id, scope: 'global', replaced, hint: `该知识已在 global 级，累计第 ${(glHit.item.sourceTaskIds || []).length} 个任务命中` }
      }
    }
    // 3) 跨任务池去重（同一坑只留一份，sourceTaskIds 累积）。非草稿写入不得把正文并进 draft，
    // 否则新知识永远停在待审状态。
    const pool = allTaskInsights(store).filter((it) => it.draft !== true)
    const poolNear = vectorNear(vectorText(base), pool, cosine)
    const poolTarget = autoMergeTarget(poolNear, cfg)
    if (poolTarget) {
      const { replaced } = mergeInto(poolTarget.item, base, cfg, now)
      store.markTasksDirty()
      const holder = taskContaining(store, poolTarget.item.id)
      if (holder) {
        const promoted = promoteAllTasksToProject(store, globalStore, cfg, now)
        return { ok: true, action: 'auto-merged', id: poolTarget.item.id, taskId: holder.id, scope: 'task', replaced, cos: Number(poolTarget.top1.toFixed(3)), hint: `相似度 ${poolTarget.top1.toFixed(3)}，已自动覆盖任务 ${holder.id} 的既有条目${replaced.length ? `（覆盖字段 ${replaced.join('/')}）` : ''}${promoted ? `；自动提升 project ${promoted} 条` : ''}` }
      }
    }
    const hit = findBestOverlapMatch(text, pool)
    if (hit && hit.score >= cfg.dedupOverlap) {
      const { replaced } = mergeInto(hit.item, base, cfg, now)
      const holder = taskContaining(store, hit.item.id)
      if (holder) {
        store.markTasksDirty()
        const holderId = holder.id
        const promoted = promoteAllTasksToProject(store, globalStore, cfg, now)
        const size = (hit.item.sourceTaskIds || []).length
        return {
          ok: true,
          action: 'merged',
          id: hit.item.id,
          taskId: holderId,
          replaced,
          hint: `跨任务去重：并入任务 ${holderId} 既有条目（现 ${size} 个任务命中）${replaced.length ? `，覆盖字段 ${replaced.join('/')}` : ''}${promoted ? `；自动提升 project ${promoted} 条` : ''}`,
        }
      }
    }
  }
  if (draftOnly) {
    // 同一任务的重复反思只保留一份草稿；跨任务不合并（各任务的审核上下文独立）。
    const existingDrafts = (task.insights || []).filter((it) => it && it.draft === true)
    const hit = findBestOverlapMatch(text, existingDrafts)
    if (hit && hit.score >= cfg.dedupOverlap) {
      const { replaced } = mergeInto(hit.item, base, cfg, now)
      store.markTasksDirty()
      return { ok: true, action: 'merged', id: hit.item.id, taskId: task.id, replaced, hint: '已合并到本任务既有草稿' }
    }
  }
  // 4) 新建于当前任务
  if (!Array.isArray(task.insights)) task.insights = []
  const ins = normalizeInsight(raw, { scope: 'task', source, nowIso: now, sourceTaskIds: [task.id], confidence: raw.confidence })
  task.insights.push(ins)
  store.markTasksDirty()
  return { ok: true, action: 'created', id: ins.id, taskId: task.id, hint: '已保存到任务级（草稿/私有）' }
}

// ---- 提升 = 字段变更 ----

/**
 * task 池扫描：同一 insight 命中 ≥2 个任务 且 confidence ≥ promoteConfidence → 升 project。
 * 先与 project 已有条目去重（重复则并成员并删 task 副本），否则移动。
 * @returns 提升条数
 */
export function promoteAllTasksToProject(store, globalStore, cfg, now) {
  const tasks = store.getTasks() || []
  let promoted = 0
  for (const task of tasks) {
    const list = task.insights || []
    for (const ins of [...list]) {
      if (ins.scope && ins.scope !== 'task') continue
      // 草稿必须先被确认；自动提升绕过审核就等于把 reflection 的猜测变成项目资产。
      if (ins.draft === true) continue
      const members = new Set(ins.sourceTaskIds || [])
      if (members.size < 2) continue
      if (num(ins.confidence, 0) < cfg.promoteConfidence) continue
      // 与 project 已有资产去重：重复 → 并成员，删 task 副本
      const pjItems = store.insightItems()
      const pjHit = findBestOverlapMatch(insightMatchText(ins), pjItems)
      if (pjHit && pjHit.score >= cfg.dedupOverlap) {
        mergeInto(pjHit.item, { sourceTaskIds: ins.sourceTaskIds, files: ins.files, symbols: ins.symbols, tags: ins.tags, confidence: ins.confidence }, cfg, now)
        store.replaceInsightItems(pjItems)
        removeFromTask(store, ins.id)
        promoted++
        continue
      }
      const moved = carryUsageFields(
        normalizeInsight(ins, { scope: 'project', source: ins.source, nowIso: now }),
        ins,
      )
      moved.id = ins.id
      moved.draft = false
      moved.confidence = num(ins.confidence, cfg.promoteConfidence)
      moved.movedFrom = { scope: 'task', id: ins.id, at: now }
      pjItems.push(moved)
      store.replaceInsightItems(pjItems)
      removeFromTask(store, ins.id)
      promoted++
    }
  }
  if (promoted) {
    const items = store.insightItems()
    applyDecay(items, cfg, now)
    pruneItems(items, cfg.maxProject, now)
    promoteProjectToGlobal(store, globalStore, cfg, now)
  }
  return promoted
}

/** project 扫描：sourceTaskIds ≥ globalPromoteTasks → 升 global。返回移动条数。 */
export function promoteProjectToGlobal(store, globalStore, cfg, now) {
  if (!globalStore) return 0
  const items = store.insightItems()
  let moved = 0
  for (const ins of [...items]) {
    if (ins.scope && ins.scope !== 'project') continue
    if (ins.draft === true) continue
    const members = new Set(ins.sourceTaskIds || [])
    if (members.size < cfg.globalPromoteTasks) continue
    const glItems = globalStore.items()
    const glHit = findBestOverlapMatch(insightMatchText(ins), glItems)
    if (glHit && glHit.score >= cfg.dedupOverlap) {
      mergeInto(glHit.item, { sourceTaskIds: ins.sourceTaskIds, files: ins.files, symbols: ins.symbols, tags: ins.tags, confidence: ins.confidence }, cfg, now)
    } else {
      const movedIns = carryUsageFields(
        normalizeInsight(ins, { scope: 'global', source: ins.source, nowIso: now }),
        ins,
      )
      movedIns.id = ins.id
      movedIns.draft = false
      movedIns.confidence = num(ins.confidence, cfg.promoteConfidence)
      movedIns.movedFrom = { scope: 'project', id: ins.id, at: now }
      glItems.push(movedIns)
    }
    items.splice(items.indexOf(ins), 1)
    moved++
  }
  if (moved) {
    store.replaceInsightItems(items)
    // 提升只增不减 global：不在这里收口，maxGlobalProcedures 就形同虚设。
    pruneItems(globalStore.items(), cfg.maxGlobalProcedures, now)
    globalStore.markDirty()
  }
  return moved
}

// ---- 降级（反向，PR3 UI 使用；现在提供最小实现） ----

export function demoteToProject(store, globalStore, id, nowIso, cfg = cfgInsight({})) {
  if (!globalStore) return { ok: false, error: 'global 存储未初始化' }
  const now = nowIso || new Date().toISOString()
  const idx = globalStore.items().findIndex((i) => i.id === id)
  if (idx === -1) return { ok: false, error: `global 无此条目: ${id}` }
  const ins = globalStore.items()[idx]
  const items = store.insightItems()
  const copy = carryUsageFields(normalizeInsight(ins, { scope: 'project', nowIso: now }), ins)
  copy.id = `${ins.id}_d${Date.now().toString(36)}`
  copy.movedFrom = { scope: 'global', id: ins.id, at: now }
  items.push(copy)
  // 降级只增不减 project：同样要收口 maxProject。
  pruneItems(items, cfg.maxProject, now)
  store.replaceInsightItems(items)
  globalStore.items().splice(idx, 1)
  globalStore.markDirty()
  return { ok: true, action: 'demoted', id: copy.id, hint: '已降级回 project' }
}

export function demoteToTask(store, taskId, id, nowIso) {
  const now = nowIso || new Date().toISOString()
  const task = store.getTask(taskId)
  if (!task) return { ok: false, error: `任务不存在: ${taskId}` }
  const items = store.insightItems()
  const idx = items.findIndex((i) => i.id === id)
  if (idx === -1) return { ok: false, error: `project 无此条目: ${id}` }
  const ins = items[idx]
  if (!Array.isArray(task.insights)) task.insights = []
  const copy = carryUsageFields(normalizeInsight(ins, { scope: 'task', nowIso: now }), ins)
  copy.id = `${ins.id}_d${Date.now().toString(36)}`
  copy.movedFrom = { scope: 'project', id: ins.id, at: now }
  task.insights.push(copy)
  items.splice(idx, 1)
  store.replaceInsightItems(items)
  store.markTasksDirty()
  return { ok: true, action: 'demoted', id: copy.id, hint: '已降级到任务级' }
}

/** 便捷：直接对归一化后文本算重叠（测试用）。 */
export function overlapOf(a, b) {
  return normalizedTokenOverlap(String(a), String(b))
}
