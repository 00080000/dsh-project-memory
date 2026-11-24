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
 * 记录是**记忆挂载点**：镜像宿主的 status / owner / writeScopes（只做展示与提示），
 * 但不吸收某个成员的步骤/自维护时刻（那是单个 agent 的清单，见 taskbridge 的 todo/write 分支）；
 * 冲突告警由宿主的视图现算，不落盘（快照里没有它，存下来只会过期）。
 * 它也不进 taskbridge 的自动建档路径（子代理仍不建档，绑定只能由显式 `select_task` 建立）。
 */
import { hash8 } from '../util/hash.js'

/** 宿主 `TeamTaskId` 的形状：`task-<n>`。 */
const TEAM_TASK_ID_RE = /^task-\d+$/

/** 这个 id 是不是宿主的团队任务 id。 */
export function isTeamTaskId(value) {
  return typeof value === 'string' && TEAM_TASK_ID_RE.test(value)
}

/** 团队任务 → 本地记忆任务记录的 id。
 *
 * **必须带团队树**：宿主 `TeamTaskId` 是团队内编号（`task-1`、`task-2`…），同一个项目里
 * 两个顶层会话各自开团队时编号会重复；只用任务 id 会让两个团队的记忆/状态互相覆盖。
 * @param {string} teamId - 团队树根会话 id（宿主把 `TeamId` 定义为 root session id）。
 * @param {string} teamTaskId - `task-<n>`。
 * @returns {string} `team:<teamId>:task-<n>`。
 */
export function teamMemoryTaskId(teamId, teamTaskId) {
  return `team:${teamId}:${teamTaskId}`
}

/**
 * 调用者所属团队树的 id（root session id）。`getTask` 用它把团队内任务编号变成全局唯一键。
 * 软探测 `subagents` 服务（团队插件本身依赖它），拿不到就返回 null，由调用方当作"无法解析"。
 * @param {object} exec - 工具执行上下文。
 * @returns {string|null}
 */
export function teamIdOf(exec) {
  const caller = exec?.agent
  const ctx = hostCtxOf(exec)
  if (!caller || !ctx || typeof ctx.get !== 'function') return null
  try {
    const subagents = ctx.get('subagents')
    const root = subagents && typeof subagents.rootOf === 'function' ? subagents.rootOf(caller) : null
    const id = root?.session?.id
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
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
 * @returns {{ok: true, view: object} | {ok: false, reason: 'unavailable'|'no-caller'|'not-found'|'error', error?: string}}
 */
export function resolveTeamTask(exec, teamTaskId) {
  const service = teamServiceOf(exec)
  const caller = exec?.agent
  if (!service || typeof service.getTask !== 'function') return { ok: false, reason: 'unavailable' }
  // 宿主契约要求 caller 是 live Agent；PTC/嵌套调用可能没有 agent，这时不是"没装团队插件"。
  if (!caller || typeof caller !== 'object') return { ok: false, reason: 'no-caller' }
  try {
    const view = service.getTask(caller, teamTaskId)
    if (!view || typeof view !== 'object' || view.status === 'deleted') return { ok: false, reason: 'not-found' }
    return { ok: true, view }
  } catch (err) {
    if (err?.code === 'TEAM_TASK_NOT_FOUND') return { ok: false, reason: 'not-found' }
    return { ok: false, reason: 'error', error: err?.message || String(err) }
  }
}

/** 宿主视图里随任务变化、需要带给模型看的那几个字段（advisory，不参与准入判定）。 */
function teamFieldsOf(view) {
  const fields = {}
  if (typeof view.status === 'string') fields.teamTaskStatus = view.status
  if (typeof view.ownerName === 'string') fields.teamOwnerName = view.ownerName
  if (Array.isArray(view.writeScopes)) {
    fields.teamWriteScopes = view.writeScopes.filter((p) => typeof p === 'string')
  }
  return fields
}

/**
 * 把工具参数里的任务引用归一成本地记忆任务 id：本地 id 原样返回；宿主团队 id（`task-<n>`）
 * 如果已经有锚点，返回 `team:task-<n>`；没有锚点则原样返回，由调用方按"找不到"给出可执行的错误。
 * 只做映射，不创建锚点 —— 创建需要宿主视图，入口仍是 `select_task`。
 * @param {object} store - 项目 store。
 * @param {unknown} taskId - 工具参数里的任务 id。
 * @param {string|null} teamId - 调用者所属团队树（`teamIdOf`）；团队 id 缺省时不做映射。
 * @returns {unknown} 归一后的 id。
 */
export function memoryTaskIdFor(store, taskId, teamId) {
  if (typeof taskId !== 'string' || !taskId) return taskId
  if (store.getTask(taskId)) return taskId
  if (!isTeamTaskId(taskId) || !teamId) return taskId
  const anchor = teamMemoryTaskId(teamId, taskId)
  return store.getTask(anchor) ? anchor : taskId
}

/**
 * 团队任务对应的本地记忆任务记录：已有就复用，没有就按宿主视图懒建一条。
 *
 * 标题只在新建时取宿主的 `subject`；之后不跟着变 —— 用户可能已经用 `select_task` 的 `title`
 * 改过名，每次 select 都覆盖会把人工命名冲掉。缺 subject 时用 `团队任务 <id>` 占位。
 * status / owner / writeScopes 每次都从视图刷新（它们是宿主的运行时事实，本地不持有判断）。
 * 复用分支只改内存、不标脏：调用方（select_task）随后统一 `markTasksDirty()` + save。
 * @returns {{task: object, created: boolean}}
 */
export function ensureTeamTaskRecord(store, view, { teamId, root, sid, now }) {
  const id = teamMemoryTaskId(teamId, view.id)
  const existing = store.getTask(id)
  if (existing) {
    Object.assign(existing, teamFieldsOf(view))
    return { task: existing, created: false }
  }
  const subject = typeof view.subject === 'string' ? view.subject.trim() : ''
  const task = {
    id,
    teamId,
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
    ...teamFieldsOf(view),
  }
  store.addTask(task)
  return { task, created: true }
}
