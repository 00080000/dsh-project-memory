/**
 * 命令处理器的公共接线：/tasks、/task、/insight 三个定义此前各自复制了
 * 「解析 CommandInvocation → 会话与 cwd」和「拼 JSON 围栏载荷」两段代码。
 * 集中在这里，语义只在一处维护。
 */

/**
 * 从命令调用里解出会话上下文。
 *
 * `sid` 优先取 `agent.id`；`session` 优先走 `sessions` 服务（拿到的是宿主实时会话，
 * 带 append 等能力），服务缺失或不可用时退回 `agent.session`。
 * @param {object} invocation - 宿主 CommandInvocation（handler 的入参）。
 * @returns {{agent: object|undefined, sid: string|undefined, session: object|null, cwd: string|undefined}}
 */
export function invocationContext(invocation) {
  const agent = invocation?.agent
  const sid = agent?.id || agent?.session?.id
  const session = sid && agent?.ctx ? agent.ctx.sessions?.get(sid) : (agent?.session || null)
  const cwd = session?.header?.cwd || agent?.session?.header?.cwd
  return { agent, sid, session, cwd }
}

/**
 * 统一的命令输出载荷：人类可读摘要 + ```json 块。
 * 客户端命令节点按尾部 JSON 解析并渲染面板，因此三个命令共用同一格式。
 * @param {string} note - 人类可读摘要（可多行）。
 * @param {string} payload - 已序列化的 JSON 载荷。
 * @returns {string}
 */
export function fencedJson(note, payload) {
  return `${note}\n\n\`\`\`json\n${payload}\n\`\`\``
}
