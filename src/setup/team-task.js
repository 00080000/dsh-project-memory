/**
 * 宿主团队任务（`task-<n>`）→ 本地记忆任务键的唯一映射。
 *
 * 为什么需要这一层：任务级记忆（`save_lesson` 的 `scope: 'task'`）挂在 `tasks.json` 某条任务
 * 记录的 `insights[]` 上，只有**会话绑定到该任务**时，`save_lesson` / `recall` / 注入才看得见它；
 * 而绑定原本只认本地 `tsk_…` 任务。团队模式下 lead 与队友是两个会话，它们唯一的公共任务身份
 * 是宿主的团队任务板（`TeamTaskId` 形如 `task-<n>`）。不做映射，lead 写在任务上的经验队友就
 * 看不到，只能 promote 到 project —— 一个任务的经验被抬成全项目知识，作用域丢失。
 *
 * 软依赖：`ctx.get('agentTeams')` 缺失（没装团队插件 / 老宿主）、调用者不是团队会话、对端任务
 * 不存在或属于别的团队时，这里只返回 `unavailable` / `not-found`，`select_task` 维持原行为。
 * 记录只是一个**记忆挂载点**：不镜像宿主的 status / owner / writeScopes（那是第二刀的事），
 * 也不进 taskbridge 的自动建档路径（子代理仍不建档，绑定只能由显式 `select_task` 建立）。
 */
import { hash8 } from './taskbridge.js'

/** 宿主 `TeamTaskId` 的形状：`task-<n>`。 */
const TEAM_TASK_ID_RE = /^task-\d+$/

/** 这个 id 是不是宿主的团队任务 id。 */
export function isTeamTaskId(value) {
  return typeof value === 'string' && TEAM_TASK_ID_RE.test(value)
}

/** 团队任务 → 本地记忆任务记录的 id。带前缀，免得和 `tsk_…` 混在一起被当成同一种身份。 */
export function teamMemoryTaskId(teamTaskId) {
  return `team:${teamTaskId}`
}

function hostCtxOf(exec) {
  return exec?.agent?.ctx || exec?.ctx || null
}

/**
 * 软探测 `ctx.get('agentTeams')`。cordis 里读它不需要 inject；没有 `ctx.get`（老宿主）
 * 或服务未装配时返回 null，整条团队路径因此不存在。
 */
export function teamServiceOf(exec) {
  const ctx = hostCtxOf(exec)
  if (!ctx || typeof ctx.get !== 'function') return null
  try {
    return ctx.get('agentTeams') || null
  } catch {
    return null
  }
}

/**
 * 读一个团队任务并确认归属。`getTask(caller, id)` 按 caller 所在的 subagent 树取板，
 * 所以不存在的 id、别的团队的任务都会抛 `TEAM_TASK_NOT_FOUND` —— 这里归一成 `not-found`，
 * 让模型看到的错误与本地任务一致；软删（`status: 'deleted'`）同样按找不到处理。
 * @returns {{ok: true, view: object} | {ok: false, reason: 'unavailable'|'not-found'|'error', error?: string}}
 */
export function resolveTeamTask(exec, teamTaskId) {
  const service = teamServiceOf(exec)
  const caller = exec?.agent
  if (!service || typeof service.getTask !== 'function' || !caller) return { ok: false, reason: 'unavailable' }
  try {
    const view = service.getTask(caller, teamTaskId)
    if (!view || typeof view !== 'object' || view.status === 'deleted') return { ok: false, reason: 'not-found' }
    return { ok: true, view }
  } catch (err) {
    if (err?.code === 'TEAM_TASK_NOT_FOUND') return { ok: false, reason: 'not-found' }
    return { ok: false, reason: 'error', error: err?.message || String(err) }
  }
}

/**
 * 团队任务对应的本地记忆任务记录：已有就复用，没有就按宿主视图懒建一条。
 *
 * 标题只在新建时取宿主的 `subject`；之后不跟着变 —— 用户可能已经用 `select_task` 的 `title`
 * 改过名，每次 select 都覆盖会把人工命名冲掉。缺 subject 时用 `团队任务 <id>` 占位。
 * @returns {{task: object, created: boolean}}
 */
export function ensureTeamTaskRecord(store, view, { root, sid, now }) {
  const id = teamMemoryTaskId(view.id)
  const existing = store.getTask(id)
  if (existing) return { task: existing, created: false }
  const subject = typeof view.subject === 'string' ? view.subject.trim() : ''
  const task = {
    id,
    teamTaskId: view.id,
    projectHash: hash8(root),
    projectRoot: root,
    title: subject || `团队任务 ${view.id}`,
    steps: null,
    files: [],
    fileMeta: {},
    archived: false,
    insights: [],
    lastSessionId: sid || null,
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
  }
  store.addTask(task)
  return { task, created: true }
}
