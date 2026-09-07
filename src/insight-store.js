// v0.5 insight 存储与策略（服务端 .js，纯本地零依赖）
// - 单一 insight 实体，scope 分层：task(tasks.json 内 task.insights[]) / project(insights.json) / global(global.json)
// - 去重：双向 token overlap（src/similarity.js）≥ dedupOverlap 合并；reinforceBand~dedupOverlap 强化（不加内容）
// - 提升 = 字段变更（不跨文件复制）：task 池内同一 insight 命中 ≥2 个任务且 confidence 达标 → project；
//   project 条目 sourceTaskIds ≥ globalPromoteTasks → global
// - 归档 = 软删（archived:true，不进召回/注入）；物理删除只发生在容量溢出
// - 写盘前密文过滤：命中密钥/token/私钥形态 → 拒绝写入
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { normalizedTokenOverlap, findBestOverlapMatch, insightMatchText } from './similarity.js'

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
    const tr = { keywords: Array.isArray(raw.trigger.keywords) ? raw.trigger.keywords.map(String) : [] }
    if (Array.isArray(raw.trigger.symbols)) tr.symbols = raw.trigger.symbols.map(String)
    if (Array.isArray(raw.trigger.scope)) tr.scope = raw.trigger.scope.map(String)
    if (tr.keywords.length) ins.trigger = tr
  }
  return ins
}

export function unionStrings(base = [], add = []) {
  const out = new Set(base || [])
  for (const x of add || []) if (x !== undefined && x !== null) out.add(String(x))
  return [...out]
}

/** 把 base 合并进既有条目（content 加固、成员/文件/符号并集、置信取高、记命中）。 */
export function mergeInto(existing, base, cfg, nowIso) {
  const now = nowIso || new Date().toISOString()
  existing.sourceTaskIds = unionStrings(existing.sourceTaskIds, base.sourceTaskIds)
  existing.files = unionStrings(existing.files, base.files)
  existing.symbols = unionStrings(existing.symbols, base.symbols)
  existing.tags = unionStrings(existing.tags, base.tags)
  for (const [f, b] of [
    ['pattern', base.pattern],
    ['fix', base.fix],
    ['choice', base.choice],
    ['reason', base.reason],
    ['problem', base.problem],
    ['solution', base.solution],
    ['body', base.body],
  ]) {
    if (b && !existing[f]) existing[f] = String(b)
  }
  if (!existing.steps && Array.isArray(base.steps) && base.steps.length) existing.steps = base.steps.map(String)
  if (!existing.trigger && base.trigger) existing.trigger = base.trigger
  existing.confidence = Math.max(num(existing.confidence, 0.5), num(base.confidence, 0.5))
  existing.hitCount = (existing.hitCount || 0) + 1
  existing.lastHitAt = now
  existing.updatedAt = now
  if (existing.archived) existing.archived = false // 重新被使用 → 复活
  return existing
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
    if (it.archived) continue
    if ((it.hitCount || 0) > 0) continue
    if (it.lastHitAt && Date.parse(it.lastHitAt) <= limit) {
      it.archived = true
      it.updatedAt = now
      archived++
    }
  }
  return archived
}

/** 超限先物理删归档里最不活跃的，再归档最不活跃的（下一轮被删），直到回落到上限。 */
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

function writeJsonAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, file)
  } catch (err) {
    try {
      renameSync(tmp, file) // fsync 无关紧要：单文件覆盖 + 崩溃后 .tmp 清理即可
    } catch {
      /* ignore */
    }
    throw err
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
    if (!this.doc) this.doc = normalizeDoc(readJson(this.file, null))
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
 * 统一入口。scope: task 需要 taskId（store 内须存在该任务）；project 走 store 的 insights 文档；
 * global 走 globalStore。
 * 返回 { ok, action: 'created'|'merged'|'reinforced'|'linked-project'|'linked-global'|'promoted'|…, id, hint }
 */
export function saveInsight({ store, globalStore, raw, scope, taskId, cfg, source = 'agent', nowIso }) {
  const cfg2 = cfg || cfgInsight({})
  const now = nowIso || new Date().toISOString()
  const secretField = containsSecretFields(raw)
  if (secretField) {
    return { ok: false, error: `内容疑似包含密钥/token/私钥形态数据（字段: ${secretField}），已拒绝写入` }
  }
  const s = scope || 'project'
  if (!INSIGHT_SCOPES.includes(s)) return { ok: false, error: `非法 scope: ${s}` }
  if (s === 'global') {
    if (!globalStore) return { ok: false, error: 'global 存储未初始化' }
    const res = upsertIntoPool(globalStore.items(), raw, cfg2, now, { source, scope: 'global' })
    if (res.action === 'created') pruneItems(globalStore.items(), cfg2.maxGlobalProcedures, now)
    globalStore.markDirty()
    return { ok: true, ...res, scope: 'global' }
  }
  if (s === 'task') {
    if (!store || !taskId) return { ok: false, error: 'task 级写入需要 taskId' }
    const task = store.getTask(taskId)
    if (!task) return { ok: false, error: `任务不存在: ${taskId}` }
    return saveTaskInsight(store, globalStore, task, raw, cfg2, now, source)
  }
  return saveProjectInsight(store, globalStore, raw, cfg2, now, source)
}

/** 在 items 池内 upsert：≥ dedup 合并；≥ reinforceBand 强化；否则新建。raw 需已过密文检查。 */
function upsertIntoPool(items, raw, cfg, nowIso, extra = {}) {
  const base = { ...raw, source: extra.source, sourceTaskIds: extra.sourceTaskIds || raw.sourceTaskIds }
  const text = insightMatchText(base)
  const hit = findBestOverlapMatch(text, items)
  if (hit && hit.score >= cfg.dedupOverlap) {
    mergeInto(hit.item, base, cfg, nowIso)
    return { action: 'merged', id: hit.item.id }
  }
  if (hit && hit.score >= cfg.reinforceBand) {
    reinforceOnly(hit.item, base, nowIso)
    return { action: 'reinforced', id: hit.item.id }
  }
  const ins = normalizeInsight(base, { scope: extra.scope || 'project', source: extra.source, nowIso })
  items.push(ins)
  return { action: 'created', id: ins.id }
}

// ---- scope = project ----

function saveProjectInsight(store, globalStore, raw, cfg, now, source) {
  const items = store.insightItems()
  const res = upsertIntoPool(items, raw, cfg, now, { source, scope: 'project' })
  store.replaceInsightItems(items) // 一律标脏（created/merged/reinforced 都改了数组）
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
  if (pruned && pruned.removed) bits.push(`容量清理 ${pruned.removed} 条`)
  if (promoted) bits.push(`自动提升 global ${promoted} 条`)
  return bits.length ? bits.join('；') : ''
}

// ---- scope = task ----

function saveTaskInsight(store, globalStore, task, raw, cfg, now, source) {
  // 1) 已有 project 级知识 → 挂成员/命中，不再在 task 层重复存
  const pjItems = store.insightItems()
  const base = { ...raw, source, sourceTaskIds: [task.id] }
  const text = insightMatchText(base)
  const pjHit = findBestOverlapMatch(text, pjItems)
  if (pjHit && pjHit.score >= cfg.dedupOverlap) {
    mergeInto(pjHit.item, base, cfg, now)
    store.replaceInsightItems(pjItems)
    applyDecay(pjItems, cfg, now)
    pruneItems(pjItems, cfg.maxProject, now)
    const promoted = promoteProjectToGlobal(store, globalStore, cfg, now)
    return { ok: true, action: 'linked-project', id: pjHit.item.id, scope: 'project', hint: `该知识已在 project 级，累计第 ${(pjHit.item.sourceTaskIds || []).length} 个任务命中${promoted ? '；已自动提升 global' : ''}` }
  }
  // 2) 已有 global 级知识 → 同样只挂命中
  if (globalStore) {
    const glHit = findBestOverlapMatch(text, globalStore.items())
    if (glHit && glHit.score >= cfg.dedupOverlap) {
      mergeInto(glHit.item, base, cfg, now)
      globalStore.markDirty()
      return { ok: true, action: 'linked-global', id: glHit.item.id, scope: 'global', hint: `该知识已在 global 级，累计第 ${(glHit.item.sourceTaskIds || []).length} 个任务命中` }
    }
  }
  // 3) 跨任务池去重合并（同一坑只留一份，sourceTaskIds 累积）
  const pool = allTaskInsights(store)
  const hit = findBestOverlapMatch(text, pool)
  if (hit && hit.score >= cfg.dedupOverlap) {
    mergeInto(hit.item, base, cfg, now)
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
        hint: `跨任务去重：并入任务 ${holderId} 既有条目（现 ${size} 个任务命中）${promoted ? `；自动提升 project ${promoted} 条` : ''}`,
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
      const moved = {
        ...normalizeInsight(ins, { scope: 'project', source: ins.source, nowIso: now }),
        id: ins.id,
        draft: false,
        confidence: num(ins.confidence, cfg.promoteConfidence),
        hitCount: ins.hitCount || 0,
        lastHitAt: ins.lastHitAt,
        createdAt: ins.createdAt || now,
        movedFrom: { scope: 'task', id: ins.id, at: now },
      }
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
      const movedIns = {
        ...normalizeInsight(ins, { scope: 'global', source: ins.source, nowIso: now }),
        id: ins.id,
        draft: false,
        confidence: num(ins.confidence, cfg.promoteConfidence),
        hitCount: ins.hitCount || 0,
        lastHitAt: ins.lastHitAt,
        createdAt: ins.createdAt || now,
        movedFrom: { scope: 'project', id: ins.id, at: now },
      }
      glItems.push(movedIns)
    }
    items.splice(items.indexOf(ins), 1)
    moved++
  }
  if (moved) {
    store.replaceInsightItems(items)
    globalStore.markDirty()
  }
  return moved
}

// ---- 降级（反向，PR3 UI 使用；现在提供最小实现） ----

export function demoteToProject(store, globalStore, id, nowIso) {
  if (!globalStore) return { ok: false, error: 'global 存储未初始化' }
  const now = nowIso || new Date().toISOString()
  const idx = globalStore.items().findIndex((i) => i.id === id)
  if (idx === -1) return { ok: false, error: `global 无此条目: ${id}` }
  const ins = globalStore.items()[idx]
  const items = store.insightItems()
  const copy = normalizeInsight(ins, { scope: 'project', nowIso: now })
  copy.id = `${ins.id}_d${Date.now().toString(36)}`
  copy.movedFrom = { scope: 'global', id: ins.id, at: now }
  items.push(copy)
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
  const copy = normalizeInsight(ins, { scope: 'task', nowIso: now })
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
