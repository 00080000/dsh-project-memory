// v0.5 insight 存储与策略（服务端 .js，纯本地零依赖）
// - 单一 insight 实体，scope 分层：task(tasks.json 内 task.insights[]) / project(insights.json) / global(global.json)
// - 去重：双向 token overlap（src/similarity.js）≥ dedupOverlap 合并；reinforceBand~dedupOverlap 强化（不加内容）
// - 提升 = 字段变更（不跨文件复制）：task 池内同一 insight 命中 ≥2 个任务且 confidence 达标 → project；
//   project 条目 sourceTaskIds ≥ globalPromoteTasks → global
// - 归档 = 软删（archived:true，不进召回/注入）；物理删除只发生在容量溢出
// - 写盘前密文过滤：命中密钥/token/私钥形态 → 拒绝写入
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { normalizedTokenOverlap, findBestOverlapMatch, insightMatchText } from './similarity.js'
import { writeJsonAtomic } from './util/fs.js'
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
export function containsSecretFields(ins, fields = ['title', 'body', 'pattern', 'fix', 'problem', 'solution', 'choice', 'reason']) {
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

/** 合并配置（config.insight 之上补默认）。 */
export function cfgInsight(config) {
  const c = (config && config.insight) || {}
  const cfg = {
    dedupOverlap: num(c.dedupOverlap, 0.7),
    reinforceBand: num(c.reinforceBand, 0.65),
    // 向量带（需要 leanvec；没装就自动退化成上面的纯词法带）。阈值由真实 store 标定：
    // 47 条 live 条目、1081 对的余弦 max=0.655 / p99=0.531；本机 4B 把同一条知识改写后与
    // 原文的余弦 min=0.688 / p50=0.809。所以：
    //   · 0.90 自动覆盖 —— 落在负样本之上 0.245，只会命中逐字级再记录（"非常非常相似"）；
    //   · 0.70 提示 —— 在全部 1081 对真实条目上零噪声，而改写后的再记录有 78% 落进来。
    // 0.65 会开始误伤真实条目（1/1081），别往下调：提示是往上下文里加字的。
    autoMergeCos: num(c.autoMergeCos, 0.9),
    // 自动覆盖还要求"第一名明显领先第二名"，否则同一话题撞两条时不知道该覆盖谁。
    autoMergeMargin: num(c.autoMergeMargin, 0.05),
    hintCos: num(c.hintCos, 0.7),
    // `forget` 用关键词删除时的上限：超了不删、只列出来，逼调用方给更具体的词或逐个 id。
    // 关键词删除是**真删**且没有撤销——一次 `forget 'pnpm'` 扫掉十几条精选记忆是不可接受的。
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
    title: String(raw.title || raw.pattern || raw.problem || raw.topic || '(untitled)').slice(0, 200),
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
    // 所有 kind 通用。准入化 schema：when（唯一触发面）/ guard（只收窄）/ prevents（准入条件）；
    // 旧字段 keywords / symbols / actions / paths / scope 继续接受（readiness 会内存内迁移）。
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
 * 跨 scope 移动（promote/demote）时保留"使用痕迹"。
 *
 * 提升/降级只改 scope，不该清零命中数、创建时间，也不该丢掉 `triggerDerived`
 * （提示通道拿它当检索词）。这些字段不在 {@link normalizeInsight} 的白名单里，
 * 必须显式带回——否则每次移动都会让条目"看起来从没被用过"，global 层更是每次都丢派生词。
 * @param {object} copy - 已归一化到新 scope 的副本
 * @param {object} src - 原条目
 */
export function carryUsageFields(copy, src) {
  copy.hitCount = num(src.hitCount, 0)
  if (src.lastHitAt) copy.lastHitAt = src.lastHitAt
  if (src.createdAt) copy.createdAt = src.createdAt
  if (src.triggerDerived) copy.triggerDerived = src.triggerDerived
  // `prev` 是被自动覆盖/就地更新挤掉的那一版。它必须跟着条目走：promote/demote 走的是
  // normalizeInsight 白名单，不带这一步的话，一次提升就把"还能还原"这件事丢掉了。
  if (src.prev && typeof src.prev === 'object') copy.prev = src.prev
  return copy
}

/**
 * 写一个字段，并把被挤掉的旧值留在 `prev` 单槽。
 *
 * 为什么是"单槽"而不是历史：历史要折叠、要压实、要每个读者都懂两个真相源（已经判过不做）。
 * 这里只保留**上一个**值——刚好够"误覆盖后写回去"，O(1)、无需压实、不构成第二个真相源。
 * 空值不算旧值（`''`/undefined 不写 prev），所以首次填充不会产生噪声。
 * @param {object} item - 条目（原地修改）
 * @param {string} key - 字段名
 * @param {unknown} next - 新值
 * @param {string[]} replaced - 被真正改动过的字段名，调用方据此回报
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
 *
 * 与旧实现的区别就是那一个 `if (b && !existing[f])`：以前字段已有值就**静默丢掉新文本**，
 * 于是"我记错了，改成正确的"永远落不进去（只加 hitCount）。现在反过来——新值落地、旧值可还原。
 * 提升路径只传成员/文件/符号/置信，不传正文字段，所以它们的语义一字未变。
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
  return replaced
}

/**
 * 向量近邻：拿 base 的标题去问可选向量层，返回池内最像的一条与第二名。
 *
 * 判据用**余弦**而不是词法重叠，是因为词法在这份 store 上根本够不到阈值：实测 1081 对里
 * `insightMatchText` 的最大值只有 0.256，而 `cfgInsight` 的合并带是 0.70——那条自动通道
 * 实际上只在"逐字重写"时才可能触发。余弦（标题编码）同一份池子上 max=0.655 / p99=0.531，
 * 配 0.90 自动覆盖 / 0.70 提示两条带才有分辨力（标定见 cfgInsight 注释）。
 *
 * 没有向量（leanvec 未装/未配）→ 返回 null，调用方逐字段退回原来的纯词法行为。
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
  for (const it of items) {
    if (!it || it.archived) continue
    const v = m.get(it.id)
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    if (v > top1) {
      top2 = top1
      top1 = v
      item = it
    } else if (v > top2) top2 = v
  }
  if (!item) return null
  return { item, top1, top2: top2 < 0 ? 0 : top2 }
}

/** 近邻是否够"较高"（提示带）；够就返回给调用方回报的形状。 */
function hintOf(near, cfg) {
  if (!near || near.top1 < cfg.hintCos) return null
  return { id: near.item.id, cos: Number(near.top1.toFixed(3)), title: String(near.item.title || '').slice(0, 40) }
}

/** 自动覆盖判定：够高**且**第一名明显领先第二名（否则不知道该覆盖谁）。 */
function autoMergeTarget(near, cfg) {
  if (!near || near.top1 < cfg.autoMergeCos) return null
  if (near.top1 - near.top2 < cfg.autoMergeMargin) return null
  return near
}

/**
 * 使用记账：条目被**真正用到**时更新活跃度——注入进了上下文，或被 `query_memory` 命中。
 *
 * 为什么必须有：`applyDecay` / `pruneItems` 判活跃度只看 `lastHitAt || updatedAt || createdAt`，
 * 而 `lastHitAt` 此前只由 merge/reinforce 写（= 模型又写了一条相近的知识）。于是一条天天被注入、
 * 但从没人重写它的教训，`decayDays`（默认 90）之后会被自动归档、再也不会被推送——**用得最多的
 * 反而等于没人用过**。这是行为缺陷，不是调优问题。
 *
 * 记账**不参与任何注入判据**：它只影响活跃度/衰减，以及离线训练样本的标签。
 * 语义是"曝光次数"而非"被采纳次数"——更强的信号（模型是否真的照着做了）需要另外的回路。
 * 只记非归档条目（归档件本来就召回不到）。返回实际加一的条数，调用方据此决定是否落盘。
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
    // 用"最近活动"而不是 lastHitAt：lastHitAt 只由 merge/reinforce 写，而那两处同时把
    // hitCount 加一。旧实现先 `hitCount > 0 → continue`，于是 lastHitAt 分支永远不可达，
    // decayDays 实际是个死开关。activityOf 退到 updatedAt/createdAt，没命中过的条目也能衰减。
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
 * 超限按"最不活跃"物理删除，直到回落到上限。已有 archived 条目优先被删。
 * 注意：没有归档可删时，本轮归档的条目会在同一次调用的后续循环里被删掉——
 * `archived` 计数表示"先归档、随即被删"，不是"留下了软删副本"。
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
  }

  load() {
    if (!this.doc) {
      this.doc = normalizeDoc(readJson(this.file, null))
      // 与 project 级一致：global 条目也要补派生 trigger（提示通道用它提升召回；确定性、幂等）。
      if (backfillDerivedTriggers(this.doc)) this.markDirty()
    }
    return this
  }

  items() {
    return this.doc.items
  }

  markDirty() {
    this._dirty = true
  }

  /** 变更提交：fn(this.doc) 后原子落盘。 */
  commit(fn) {
    const res = fn ? fn(this.doc, this) : undefined
    if (this._dirty || res !== undefined) {
      writeJsonAtomic(this.file, this.doc)
      this._dirty = false
    }
    return res
  }
}

// ---- 单条保存：scope 路由 ----

/**
 * 按 id 在三个 home 里找一条（global → project → 各任务的 task.insights[]）。
 *
 * 为什么要有它：`id` 是全局键，模型不该为了改一条记忆先搞清它在哪一层——那正是"散"。
 * 找到后 scope 用条目自己声明的，调用方据此决定往哪个文件落盘。
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
 *
 * 为什么不是 `normalizedTokenOverlap`（两侧取大）：删除查询通常很短（一个词），
 * 用两侧取大算出来的分会被长正文稀释到接近 0，"删掉 pnpm 那条"就永远删不掉。
 * 这也与旧行为一致——旧层的删除一直是这个公式，换层不该顺带改判据。
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
 * 全层删除：task 内嵌 / project / global。一套判据、一次调用。
 *
 * 为什么是"全层一套"而不是给 insight 再开一条通道：对模型来说这本来就是一件事——
 * "把那条记错的删掉"，它不该先搞清自己在哪个层。
 * @param {object} o
 * @param {string} o.idOrQuery - 精确 id，或用于匹配的关键词
 * @param {number} [o.maxMatches] - 关键词命中上限；超过则**一条都不删**，只回报候选
 * @returns {{ok: boolean, removed?: object[], matches?: object[], tooMany?: boolean}}
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
    removeEntries({ store, globalStore }, byId)
    return { ok: true, removed: byId }
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
  removeEntries({ store, globalStore }, matches)
  return { ok: true, removed: matches }
}

/** 按 home 把条目从各自真相源里移除。 */
function removeEntries({ store, globalStore }, entries) {
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
}

/**
 * 统一入口。scope: task 需要 taskId（store 内须存在该任务）；project 走 store 的 insights 文档；
 * global 走 globalStore。
 *
 * `raw.id` 给定时走**就地更新**（忽略 scope 路由：条目留在它原来的 home，只覆盖显式给的字段，
 * 旧值进 `prev`）。`cosine` 给定时启用向量带：≥ autoMergeCos 且领先第二名 ≥ autoMergeMargin
 * → 自动覆盖；≥ hintCos → 新建但回报近邻 id。两者都不给就是原来的纯词法行为。
 * 返回 { ok, action: 'created'|'merged'|'auto-merged'|'reinforced'|'updated'|'linked-project'|…, id, replaced, near, hint }
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
    const replaced = applyUpdate(found.item, raw, now)
    if (found.scope === 'global') globalStore.markDirty()
    else if (found.scope === 'task') store.markTasksDirty()
    else store.replaceInsightItems(store.insightItems())
    return {
      ok: true,
      action: 'updated',
      id: raw.id,
      scope: found.scope,
      replaced,
      hint: replaced.length ? `已就地更新（覆盖字段：${replaced.join('/')}，旧值在 prev）` : '没有字段变化',
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
 * 在 items 池内 upsert：向量带（自动覆盖/提示）优先，其次原来的词法带（合并/强化/新建）。
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
  // 1) 已有 project 级知识 → 挂成员/命中，不再在 task 层重复存
  const pjItems = store.insightItems()
  const base = { ...raw, source, sourceTaskIds: [task.id] }
  const text = insightMatchText(base)
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
  // 3) 跨任务池去重合并（同一坑只留一份，sourceTaskIds 累积）
  const pool = allTaskInsights(store)
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
