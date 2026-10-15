/**
 * 会话「当前工作目录」的唯一取值口。
 *
 * 为什么需要它：dsh 0.2.1 引入了 `@deepseek-ai/dsh-working-directory`，把**当前执行目录**
 * 从 `Session.header.cwd` 里拆了出去——`header.cwd` 现在只表示「原始项目身份 / 权限根」，
 * `working_directory({cd})` 改的是会话投影 `workingDirectory`，**不写回 header**。
 * 本插件的全部根解析（索引 / 检索 / 懒索引 / 审计注入 / 任务桥 / watch）用的都是「人明确
 * 选择的工作位置」这层语义（见 util/fs.js 的根推导注释），所以必须跟着这条新权威走，
 * 否则用户 cd 到另一个项目后，记忆仍落在原项目的 store 上（不报错，只是静默错根）。
 *
 * 兼容策略：新服务用 `ctx.get()` **软探测**——它既不在插件的顶层 inject 里（那是装配期
 * 门控，缺一项插件就整个不挂载），在老宿主（< 0.2.1）上也根本不存在；两者都回退到
 * `header.cwd`，也就是该服务出现之前"当前工作目录"的存放位置。
 */

/**
 * 读该会话的当前工作目录。
 *
 * 取值顺序（前者只在真的可用时才生效）：
 *  1. `workingDirectory.get(session)` —— 0.2.1+ 的权威。该投影的 `init` 就是
 *     `header => header.cwd ?? null`，所以**没 cd 过时它与 header.cwd 恒等**，
 *     本函数对既有行为是 no-op；cd 过才返回改写后的目录。
 *  2. `session.header.cwd` —— 服务缺失（老宿主）或会话不是宿主 Session 时的回退。
 *  3. `agent.session.header.cwd` —— 会话对象与服务都拿不到时的最后回退。
 *
 * 全程不抛出：根解析在审计 / 注入等旁路里被调用，那里读不到目录只应降级，不应带崩调用方。
 * @param {object|null} [session] - 宿主 Session（`workingDirectory.get` 需要它）。
 * @param {{agent?: object, ctx?: object}} [opts] - `agent` 提供 `agent.ctx` 回退；`ctx` 直接指定宿主上下文（任务桥这类只有 ctx 的地方）。
 * @returns {string|undefined} 绝对目录；都取不到时 undefined。
 */
export function sessionWorkingDir(session, opts = {}) {
  const agent = opts.agent
  const target = session || agent?.session || null
  const host = opts.ctx || agent?.ctx || null

  try {
    const svc = host && typeof host.get === 'function' ? host.get('workingDirectory') : null
    if (svc && typeof svc.get === 'function' && target) {
      const dir = svc.get(target)
      if (typeof dir === 'string' && dir) return dir
    }
  } catch {
    // 老宿主没有该服务；或 session 不是宿主认识的 Session——两种情况都走 header 回退。
  }

  const cwd = target?.header?.cwd ?? agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd ? cwd : undefined
}
