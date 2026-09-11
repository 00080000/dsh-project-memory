// 辅助 LLM 调用的路由解析（D4 修复）。
//
// 背景：宿主 LlmRuntime.stream 要求 provider/model 必填，缺失即抛 NO_ADAPTER。
// 插件此前不传这两个字段，异常被 catch 吞掉，于是文档摘要从未走过 LLM——
// 静默降级（PLAN-v0.6.0 附录 A.3）。本模块负责：
//   1) 从工具 exec / 会话 / 配置解析出 (provider, model)；
//   2) 把「无法路由 / 调用失败」记成可见的 degraded 记录，而不是静默。
//
// 解析优先级（与宿主 compaction summarizer 同序，再补一条后台 hint）：
//   config.llm 显式覆写 > exec 会话 requestHeader().config > exec agent options >
//   最近一次 request/header 事件记下的路由（后台 watch/lazy 兜底）。
//
// 登记规则：路由只影响辅助调用走哪个模型，不改变检索/排序行为。

/** 最近一次在会话里观察到的路由，供无 exec 的后台索引（watch/lazy）兜底。 */
let routeHint = null

/** 无法路由 / 调用失败留下的可见痕迹：code -> { code, reason, at, count }。 */
const degraded = new Map()

function normalize(provider, model, source) {
  if (typeof provider !== 'string' || !provider) return null
  if (typeof model !== 'string' || !model) return null
  return { provider, model, source }
}

function routeFromSession(session) {
  try {
    const config = session?.requestHeader?.()?.config
    return normalize(config?.provider, config?.model, 'session')
  } catch {
    return null
  }
}

/** 记下会话当前路由，作为后台索引的兜底。由 request/header 事件驱动。 */
export function rememberRoute(session) {
  const route = routeFromSession(session)
  if (route) routeHint = { provider: route.provider, model: route.model }
}

/** 显式配置的路由（config.llm.provider + config.llm.model 同时存在才算）。 */
function routeFromConfig(config) {
  return normalize(config?.llm?.provider, config?.llm?.model, 'config')
}

/**
 * 解析一次辅助 LLM 调用的路由。
 * @param exec - 工具执行上下文（可含 agent.session / agent.options），可为空。
 * @param config - 插件配置（可含 llm 覆写）。
 * @returns {{provider: string, model: string, source: string}|null}
 */
export function resolveRoute(exec, config) {
  const configured = routeFromConfig(config)
  if (configured) return configured

  const fromExecSession = routeFromSession(exec?.agent?.session)
  if (fromExecSession) return fromExecSession

  const options = exec?.agent?.options
  const fromOptions = normalize(options?.provider, options?.model, 'agent')
  if (fromOptions) return fromOptions

  if (routeHint) return { ...routeHint, source: 'session-hint' }
  return null
}

/**
 * 记录一次降级（允许降级，不允许静默）。同一 code 只打印一次，避免逐 chunk 刷屏；
 * 计数与最近原因保留下来，供 memory_stats / 测试读取。
 */
export function noteDegraded(code, reason) {
  const at = new Date().toISOString()
  const prev = degraded.get(code)
  if (prev) {
    prev.count += 1
    prev.at = at
    prev.reason = reason
    return prev
  }
  const record = { code, reason, at, count: 1 }
  degraded.set(code, record)
  console.warn(`[dsh-project-memory] degraded ${code}: ${reason}`)
  return record
}

/** 当前累计的降级记录（快照，按 code 去重）。 */
export function degradedList() {
  return [...degraded.values()].map((d) => ({ ...d }))
}

/** 测试用：清空路由 hint 与降级记录。 */
export function resetRouteState() {
  routeHint = null
  degraded.clear()
}
