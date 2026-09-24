/**
 * 任务步骤的读取与展示（纯函数，零依赖，commands/ 与 tools/ 共用）。
 *
 * 步骤在数据里出现过三种形状：早期裸字符串、`{ text }` 时代、现在的 `{ content, status }`。
 * 「取文本 / 归一状态 / 数完成度 / 相对时间 / 取 exec 会话 id」这几件事原本在
 * commands/tasks.js、commands/task-actions.js、tools/query-memory.js、tools/task-tools.js、
 * tools/lesson-tools.js、setup/taskbridge.js、auto-inject.js、reflection-pipeline.js 里各抄了一份，
 * 并且已经漂移成两种取文本语义（`??` 与 `||`）和三种状态归一（无校验 / Set 白名单 / 数组白名单）。
 * 收敛到这里，只保留一个事实：
 *   - 文本：content 优先，缺失才回退 text；**content 为空串不再回退**（显式清空的步骤不该顶出旧 text）；
 *   - 状态：只认宿主 todo/write 的三个合法值，其余（含裸字符串步骤）一律 pending。
 */

/** 宿主 todo/write 认得的三个状态。 */
export const STEP_STATUSES = new Set(['pending', 'in_progress', 'completed'])

/**
 * 步骤文本。字符串步骤原样返回；对象步骤按 `content ?? text ?? ''` 读。
 * @param {string | { content?: unknown, text?: unknown } | null | undefined} step
 * @returns {string}
 */
export function stepContent(step) {
  if (typeof step === 'string') return step
  return step?.content ?? step?.text ?? ''
}

/**
 * 步骤状态：非法值、缺失值、以及无状态信息的裸字符串步骤一律归一到 `pending`。
 * @param {string | { status?: unknown } | null | undefined} step
 * @returns {'pending' | 'in_progress' | 'completed'}
 */
export function stepStatus(step) {
  if (typeof step === 'string') return 'pending'
  const status = step?.status
  return STEP_STATUSES.has(status) ? status : 'pending'
}

/**
 * 任务进度：已完成步数 / 总步数。
 * @param {{ steps?: unknown[] } | null | undefined} task
 * @returns {{ done: number, total: number }}
 */
export function stepProgress(task) {
  const steps = task?.steps || []
  let done = 0
  for (const step of steps) {
    if (stepStatus(step) === 'completed') done++
  }
  return { done, total: steps.length }
}

/** 相对时间（中文）：面板、list_tasks、/tasks 三处文案共用同一套阈值。 */
export function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  return `${Math.floor(h / 24)}天前`
}

/** 工具执行上下文里的会话 id：agent.session 优先，退化到 ctx.session。 */
export function sessionIdOf(exec) {
  return exec?.agent?.session?.id || exec?.ctx?.session?.id
}
