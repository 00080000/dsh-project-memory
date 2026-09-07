// PR 3 服务器侧：/insight 命令（记忆视图：task 草稿 / project / global）
// 动作：list / confirm / promote / demote / archive / restore / delete
// 纯函数 actInsight / listInsights 操作传入的 store/gs 内存对象，持久化由调用方
// （命令 handler：store.commit + gs.commit）统一负责，便于单测。
import { ProjectMemoryStore } from '../store.js'
import { memoryRootFor } from '../util/fs.js'
import { cfgInsight, GlobalStore, normalizeInsight, defaultGlobalFile, saveInsight, INSIGHT_KINDS } from '../insight-store.js'
import { projectRootFor } from '../setup/taskbridge.js'

function insSummary(ins, extra = {}) {
  const s = ins || {}
  return {
    id: s.id,
    kind: s.kind || 'lesson',
    scope: s.scope || 'project',
    title: s.title || '',
    // 摘要按 kind 暴露“非标题正文”，编辑表单据此精确预填（不再用单一 body 猜）
    fix: s.fix && s.fix !== s.title ? s.fix : undefined,
    solution: s.solution && s.solution !== s.title ? s.solution : undefined,
    reason: s.reason && s.reason !== s.title ? s.reason : undefined,
    pattern: s.pattern && s.pattern !== s.title ? s.pattern : undefined,
    problem: s.problem && s.problem !== s.title ? s.problem : undefined,
    choice: s.choice && s.choice !== s.title ? s.choice : undefined,
    body: (() => {
      if (s.kind === 'procedure' && Array.isArray(s.steps) && s.steps.length) {
        return `步骤 ${s.steps.length} 条：${String(s.steps[0]).slice(0, 80)}`
      }
      const byKind = s.kind === 'lesson' ? s.fix : s.kind === 'decision' ? s.reason : s.kind === 'experience' ? s.solution : s.body
      const cands = [byKind, s.fix, s.solution, s.reason, s.body, s.choice, s.pattern, s.problem]
      for (const v of cands) if (v && v !== s.title) return v
      return ''
    })(),
    draft: s.draft === true,
    archived: s.archived === true,
    confidence: typeof s.confidence === 'number' ? s.confidence : null,
    hitCount: s.hitCount || 0,
    members: (s.sourceTaskIds || []).length,
    files: (s.files || []).length,
    symbols: (s.symbols || []).length,
    trigger: s.trigger ? { keywords: s.trigger.keywords || [], scope: s.trigger.scope || [] } : null,
    steps: Array.isArray(s.steps) ? s.steps.slice(0, 50) : null,
    updatedAt: s.updatedAt || '',
    ...extra,
  }
}

function findTaskInsight(store, id) {
  for (const t of store.getTasks() || []) {
    const hit = (t.insights || []).find((i) => i.id === id)
    if (hit) return { task: t, insight: hit }
  }
  return null
}

/** 列出某 scope 的记忆（task 聚合所有任务草稿；project/global 各自池）。 */
export function listInsights(store, gs, scope) {
  const s = scope || 'project'
  const items = []
  if (s === 'task') {
    for (const t of store.getTasks() || []) {
      for (const i of t.insights || []) items.push(insSummary(i, { taskId: t.id, taskTitle: t.title }))
    }
  } else if (s === 'global') {
    for (const i of (gs ? gs.items() : [])) items.push(insSummary(i))
  } else {
    for (const i of store.insightItems()) items.push(insSummary(i))
  }
  return { scope: s, count: items.length, items }
}

/**
 * 记忆动作（内存变更）。返回 { ok, text }；失败不动任何数据。
 * action: confirm(draft→正式) | promote(向上移一级) | demote(向下移一级) |
 *         archive | restore | delete；scope: task|project|global（列表里条目的当前 scope）。
 * demote 到 task 需要 taskId；promote/global 之上无层级时返回错误。
 */
export function actInsight({ store, gs, action, scope, id, taskId, cfg }) {
  const act = action || ''
  const s = scope || 'project'
  if (!id) return { ok: false, text: '需要 id' }
  const invalid = () => ({ ok: false, text: `insight ${id} 不在 ${s} 层（可能已移动/删除）` })

  if (s === 'task') {
    const found = findTaskInsight(store, id)
    if (!found) return invalid()
    const { task, insight } = found
    if (act === 'confirm') {
      insight.draft = false
      insight.updatedAt = new Date().toISOString()
      store.markTasksDirty()
      return { ok: true, text: `已审核：${insight.title}` }
    }
    if (act === 'delete') {
      task.insights = (task.insights || []).filter((i) => i.id !== id)
      store.markTasksDirty()
      return { ok: true, text: `已删除任务级条目 ${id}` }
    }
    if (act === 'archive' || act === 'restore') {
      insight.archived = act === 'archive'
      insight.updatedAt = new Date().toISOString()
      store.markTasksDirty()
      return { ok: true, text: `已${act === 'archive' ? '归档' : '恢复'}` }
    }
    if (act === 'promote') {
      // task → project（手动提升，无视自动阈值）
      const items = store.insightItems()
      const copy = normalizeInsight(insight, { scope: 'project', source: insight.source, nowIso: new Date().toISOString() })
      copy.id = id
      copy.draft = false
      copy.confidence = Math.max(insight.confidence || 0, (cfg && cfg.promoteConfidence) || 0.7)
      copy.movedFrom = { scope: 'task', id, at: new Date().toISOString() }
      copy.createdAt = insight.createdAt || copy.createdAt
      copy.hitCount = insight.hitCount || 0
      items.push(copy)
      store.replaceInsightItems(items)
      task.insights = (task.insights || []).filter((i) => i.id !== id)
      store.markTasksDirty()
      return { ok: true, text: `已提升到 project：${copy.title}` }
    }
    return { ok: false, text: `task 级不支持动作: ${act}` }
  }

  if (s === 'project') {
    const items = store.insightItems()
    const idx = items.findIndex((i) => i.id === id)
    if (idx === -1) return invalid()
    const ins = items[idx]
    if (act === 'archive' || act === 'restore') {
      ins.archived = act === 'archive'
      ins.updatedAt = new Date().toISOString()
      store.replaceInsightItems(items)
      return { ok: true, text: `已${act === 'archive' ? '归档' : '恢复'}` }
    }
    if (act === 'delete') {
      items.splice(idx, 1)
      store.replaceInsightItems(items)
      return { ok: true, text: `已删除 project 条目 ${id}` }
    }
    if (act === 'promote') {
      // project → global
      if (!gs) return { ok: false, text: 'global 存储不可用' }
      const now = new Date().toISOString()
      const copy = normalizeInsight(ins, { scope: 'global', source: ins.source, nowIso: now })
      copy.id = id
      copy.draft = false
      copy.movedFrom = { scope: 'project', id, at: now }
      copy.createdAt = ins.createdAt || copy.createdAt
      copy.hitCount = ins.hitCount || 0
      gs.items().push(copy)
      gs.markDirty()
      items.splice(idx, 1)
      store.replaceInsightItems(items)
      return { ok: true, text: `已提升到 global：${copy.title}` }
    }
    if (act === 'demote') {
      // project → task（需目标任务）
      const task = store.getTask(taskId)
      if (!task) return { ok: false, text: '降级到任务需要 taskId' }
      const now = new Date().toISOString()
      const copy = normalizeInsight(ins, { scope: 'task', source: ins.source, nowIso: now })
      copy.id = `${id}_d${Date.now().toString(36)}`
      copy.movedFrom = { scope: 'project', id, at: now }
      copy.createdAt = ins.createdAt || copy.createdAt
      if (!Array.isArray(task.insights)) task.insights = []
      task.insights.push(copy)
      store.markTasksDirty()
      items.splice(idx, 1)
      store.replaceInsightItems(items)
      return { ok: true, text: `已降级到任务 ${task.title}` }
    }
    return { ok: false, text: `project 级不支持动作: ${act}` }
  }

  if (s === 'global') {
    if (!gs) return { ok: false, text: 'global 存储不可用' }
    const items = gs.items()
    const idx = items.findIndex((i) => i.id === id)
    if (idx === -1) return invalid()
    const ins = items[idx]
    if (act === 'archive' || act === 'restore') {
      ins.archived = act === 'archive'
      ins.updatedAt = new Date().toISOString()
      gs.markDirty()
      return { ok: true, text: `已${act === 'archive' ? '归档' : '恢复'}` }
    }
    if (act === 'delete') {
      items.splice(idx, 1)
      gs.markDirty()
      return { ok: true, text: `已删除 global 条目 ${id}` }
    }
    if (act === 'demote') {
      // global → project
      const now = new Date().toISOString()
      const pjItems = store.insightItems()
      const copy = normalizeInsight(ins, { scope: 'project', source: ins.source, nowIso: now })
      copy.id = `${id}_d${Date.now().toString(36)}`
      copy.movedFrom = { scope: 'global', id, at: now }
      copy.createdAt = ins.createdAt || copy.createdAt
      pjItems.push(copy)
      store.replaceInsightItems(pjItems)
      items.splice(idx, 1)
      gs.markDirty()
      return { ok: true, text: `已降级到 project：${copy.title}` }
    }
    return { ok: false, text: `global 级不支持动作: ${act}` }
  }
  return { ok: false, text: `未知 scope: ${s}` }
}

/** 新建/保存记忆（project/global）。内部走与 save_lesson 同一 saveInsight 语义（去重合并）。 */
export function saveMemoryItem({ store, gs, cfg, scope, fields }) {
  const s = scope === 'global' ? 'global' : 'project'
  if (s === 'global' && !gs) return { ok: false, text: 'global 存储不可用' }
  const res = saveInsight({ store, globalStore: gs, raw: fields, scope: s, cfg, source: 'user' })
  if (!res.ok) return res
  return { ok: true, text: `${s} 记忆已保存（${res.action}）` }
}

const EDIT_FIELDS = new Set(['title', 'kind', 'body', 'pattern', 'fix', 'problem', 'solution', 'choice', 'reason', 'confidence', 'steps', 'trigger', 'tags', 'files', 'symbols'])

// kind 各自的“内容字段”；切 kind 时清掉不再属于它的旧字段（否则旧经验文本会残留显示）
const KIND_CONTENT = {
  lesson: ['pattern', 'fix'],
  decision: ['choice', 'reason'],
  procedure: ['steps', 'trigger'],
  experience: ['problem', 'solution'],
}
const ALL_CONTENT = ['body', 'pattern', 'fix', 'problem', 'solution', 'choice', 'reason', 'steps', 'trigger']

/** 编辑既有条目（title/kind/正文/trigger 等白名单字段）。任务级按 id 在任务池定位。 */
export function editMemoryItem({ store, gs, scope, id, fields }) {
  if (!fields || typeof fields !== 'object') return { ok: false, text: 'edit 需要字段对象' }
  const applyTo = (item) => {
    let changed = false
    const oldKind = item.kind
    for (const key of Object.keys(fields)) {
      const v = fields[key]
      if (!EDIT_FIELDS.has(key)) continue
      if (key === 'kind') {
        if (!INSIGHT_KINDS.includes(v) || v === item.kind) continue
        item.kind = v
        changed = true
        continue
      }
      if (key === 'trigger') {
        if (!v || typeof v !== 'object') continue
        item.trigger = {
          keywords: Array.isArray(v.keywords) ? v.keywords.map(String) : [],
          ...(Array.isArray(v.scope) ? { scope: v.scope.map(String) } : {}),
        }
        changed = true
        continue
      }
      if (key === 'steps' || key === 'tags' || key === 'files' || key === 'symbols') {
        if (!Array.isArray(v)) continue
        item[key] = v.map(String)
        changed = true
        continue
      }
      if (key === 'confidence') {
        const n = Number(v)
        if (!Number.isFinite(n)) continue
        item.confidence = Math.max(0, Math.min(1, n))
        changed = true
        continue
      }
      const s = v === null || v === undefined ? '' : String(v)
      if (key === 'title' && !s.trim()) continue
      item[key] = s
      changed = true
    }
    // 切 kind → 清理不再属于新 kind 的旧内容字段
    if (changed && item.kind !== oldKind && KIND_CONTENT[item.kind]) {
      const keep = new Set(KIND_CONTENT[item.kind])
      const isProcedure = item.kind === 'procedure'
      for (const f of ALL_CONTENT) {
        if (keep.has(f)) continue
        if (isProcedure && f === 'body') continue // procedure 保留通用 body
        delete item[f]
      }
    }
    if (changed) item.updatedAt = new Date().toISOString()
    return changed
  }
  const s = scope || 'project'
  if (s === 'task') {
    const found = findTaskInsight(store, id)
    if (!found) return { ok: false, text: `insight ${id} 不在任务层` }
    if (!applyTo(found.insight)) return { ok: false, text: '没有可更新的字段' }
    store.markTasksDirty()
    return { ok: true, text: '已更新任务级记忆' }
  }
  const items = s === 'global' ? (gs ? gs.items() : null) : store.insightItems()
  if (!items) return { ok: false, text: '存储不可用' }
  const item = items.find((i) => i.id === id)
  if (!item) return { ok: false, text: `insight ${id} 不在 ${s} 层` }
  if (!applyTo(item)) return { ok: false, text: '没有可更新的字段' }
  if (s === 'global') gs.markDirty()
  else store.replaceInsightItems(items)
  return { ok: true, text: '已更新记忆条目' }
}

function jsonText(payload, note) {
  return `${note}\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``
}

/** /insight <verb> <args…>：list [task|project|global] | confirm/promote/demote/archive/restore/delete <id> [taskId] */
export function insightCommandDefinition(config, ctx) {
  return {
    name: 'insight',
    description: '记忆视图动作（面板按钮调用）：/insight list project|global|task；/insight <confirm|promote|demote|archive|restore|delete> <scope> <id> [taskId]',
    input: { hint: 'list [scope] | <动作> <scope> <id> [taskId]' },
    handler: (invocation) => {
      try {
        const agent = invocation?.agent
        const sid = agent?.id || agent?.session?.id
        const session = sid && agent?.ctx ? agent.ctx.sessions?.get(sid) : (agent?.session || null)
        const cwd = session?.header?.cwd || agent?.session?.header?.cwd
        const lineRaw = (invocation?.rawInput || '').trim()
        const raw = lineRaw.split(/\s+/).filter(Boolean)
        const root = projectRootFor(cwd)
        if (!raw[0]) return { kind: 'error', text: '[insight] 用法见面板' }
        const verb = raw[0]
        if (verb === 'list') {
          const scope = raw[1] === 'task' || raw[1] === 'global' || raw[1] === 'project' ? raw[1] : 'project'
          const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
          const gs = new GlobalStore(cfgInsight(config).globalFile || defaultGlobalFile()).load()
          const payload = listInsights(store, gs, scope)
          return { kind: 'success', text: jsonText(payload, `记忆 ${scope}：${payload.count} 条`) }
        }
        if (verb === 'save') {
          // /insight save <scope> <json>（新建/合并；project|global）
          const scope = raw[1]
          if (scope !== 'project' && scope !== 'global') return { kind: 'error', text: '[insight] save 仅支持 project|global 作用域' }
          const scopeIdx = lineRaw.indexOf(scope, verb.length)
          const json = scopeIdx === -1 ? '' : lineRaw.slice(scopeIdx + scope.length).trim()
          let fields
          try {
            fields = JSON.parse(json)
          } catch {
            return { kind: 'error', text: '[insight] save 需要 JSON 参数（由面板生成）' }
          }
          if (!fields || typeof fields !== 'object' || (!fields.title && !fields.pattern && !fields.topic)) {
            return { kind: 'error', text: '[insight] save JSON 需要 title/pattern/topic' }
          }
          const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
          const gs = new GlobalStore(cfgInsight(config).globalFile || defaultGlobalFile()).load()
          const res = saveMemoryItem({ store, gs, cfg: cfgInsight(config), scope, fields })
          store.commit(() => 0)
          gs.commit()
          return res.ok ? { kind: 'success', text: res.text } : { kind: 'error', text: res.text }
        }
        if (verb === 'edit') {
          // /insight edit <scope> <id> <json>
          const scope = raw[1]
          const id = raw[2]
          if (!id) return { kind: 'error', text: '[insight] edit 需要 id' }
          const at = lineRaw.indexOf(id, 0)
          const json = at === -1 ? '' : lineRaw.slice(at + id.length).trim()
          let fields
          try {
            fields = JSON.parse(json)
          } catch {
            return { kind: 'error', text: '[insight] edit 需要 JSON 参数（由面板生成）' }
          }
          const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
          const gs = new GlobalStore(cfgInsight(config).globalFile || defaultGlobalFile()).load()
          const res = editMemoryItem({ store, gs, scope, id, fields })
          store.commit(() => 0)
          gs.commit()
          return res.ok ? { kind: 'success', text: res.text } : { kind: 'error', text: res.text }
        }
        const scope = raw[1]
        const id = raw[2]
        const taskId = raw[3]
        if (!['confirm', 'promote', 'demote', 'archive', 'restore', 'delete'].includes(verb) || !id) {
          return { kind: 'error', text: '[insight] 用法: /insight <动作|save|edit> …' }
        }
        const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
        const gs = new GlobalStore(cfgInsight(config).globalFile || defaultGlobalFile()).load()
        const res = actInsight({ store, gs, action: verb, scope, id, taskId, cfg: cfgInsight(config) })
        store.commit(() => 0) // 项目侧（tasks/insights）落盘
        gs.commit() // global 侧若有变更落盘
        return res.ok ? { kind: 'success', text: res.text } : { kind: 'error', text: res.text }
      } catch (err) {
        return { kind: 'error', text: `[insight] ${err?.message || err}` }
      }
    },
  }
}
