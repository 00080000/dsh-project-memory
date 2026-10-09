/**
 * Client 服务软探测 —— 顶层 `inject` 是「整半边静默消失」的开关，这里把它降级成运行时探测。
 *
 * cordis 的顶层 `inject` 是**装配期门控**：只要声明的一项在当前客户端装配里不可用，
 * 它根本不会调用 `apply()`。这是插件能遇到的最坏失败形态 —— 没有面板、没有 `/` 组、
 * 也没有任何报错（0.1.7 会话格式变更、0.2.0 装配差异都踩过这一条）。
 *
 * 所以本插件的 client 半边把必需服务全部当**软依赖**：
 *   - 顶层 `inject` 留空 → `apply()` 一定被调用，插件一定挂载；
 *   - 每个服务用 `ctx.get(name)` 现场读（cordis 里它**不需要 inject**），读不到就降级；
 *   - 缺什么由 {@link missingServices} 说清楚：面板上显示、日志里告警，而不是静默消失。
 *
 * 另一条与 `inject` 同源的坑：**属性路径（`ctx.remote.commands`）也是 inject 门控的**。
 * 子命名空间在 cordis 里是**独立注册的扁平服务**（名字就叫 `remote.commands`，由 gateway 的
 * `RemoteNamespaceService` 在嵌套 fiber 里 provide），读它只有 `ctx.get('remote.commands')`
 * 这一条路不需要 inject；`ctx.remote.commands` 会走 ctx 代理，报
 * `cannot get property "remote.commands" without inject` —— 于是"宿主明明有，插件却说缺"。
 * 见 {@link service}：整名优先，属性路径只作老宿主回退。
 */

/**
 * 必需服务。带 `.` 的名字（`remote.commands`）是 cordis 里**独立注册的扁平服务名**，
 * 不是"父服务上的属性"——只是老宿主可能把它挂在服务对象上，`service()` 才留了属性回退。
 * 顺序即告警文案里的顺序，从"没有它就没有界面"到"没有它只是少个数据通道"。
 */
export const REQUIRED_SERVICES = ['slots', 'sessions', 'remote', 'remote.commands', 'locale'] as const

/**
 * 读一个服务（或它的属性路径），**永不抛出**。
 *
 * 读法有两条，顺序不能反：
 *  1. **整名优先**：`ctx.get('remote.commands')`。cordis 里子命名空间就是独立注册的扁平服务，
 *     这条路不经过 inject 门控 —— 它是"没有顶层 inject 的插件"读 `remote.commands` 的**唯一**可行路径。
 *  2. **属性路径回退**：`ctx.get('remote').commands`。老宿主 / 测试替身把子命名空间挂在父服务对象上时走这条。
 *
 * `ctx.get()` 是 cordis 官方的"无 inject 读取"入口；老宿主没有它时回退到 `ctx[name]` —— 但那条路
 * 既会因"没有 inject 又没有实现"**抛错**（而不是返回 undefined），也**读不到扁平子命名空间**，
 * 所以必须整段接住：软依赖的全部意义就是不能让它带崩调用方，读不到就交给调用方按 undefined 处理。
 * @param ctx - client 上下文（宿主没给上下文时返回 undefined）。
 * @param path - 服务名，或 `服务名.属性.属性`。
 * @returns 服务值；缺失/不可读时为 undefined。
 */
export function service(ctx: any, path: string): any {
  const whole = readService(ctx, path)
  if (whole !== undefined) return whole
  const [head, ...rest] = path.split('.')
  if (rest.length === 0) return whole
  let value = readService(ctx, head)
  for (const key of rest) {
    if (value === null || value === undefined) return undefined
    try {
      value = value[key]
    } catch {
      return undefined
    }
  }
  return value
}

/**
 * 读一层服务实现：先 `ctx.get(name)`，再回退到属性访问。
 * @param ctx - client 上下文。
 * @param name - 服务名（不含路径）。
 * @returns 服务值，或 undefined。
 */
function readService(ctx: any, name: string): any {
  if (ctx === null || ctx === undefined) return undefined
  try {
    const get = ctx.get
    if (typeof get === 'function') {
      const found = get.call(ctx, name)
      if (found !== undefined) return found
    }
  } catch {
    // 服务未装配 / 读被拒：继续走属性回退，缺失由调用方按 undefined 处理。
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/**
 * 当前装配里读不到的必需服务。
 * @param ctx - client 上下文。
 * @param names - 待检查的服务路径，默认 {@link REQUIRED_SERVICES}。
 * @returns 缺失的服务路径；全都在时为 `[]`。
 */
export function missingServices(ctx: any, names: readonly string[] = REQUIRED_SERVICES): string[] {
  return names.filter((name) => service(ctx, name) === undefined)
}

/**
 * 降级检查的宽限期（毫秒）。装配是异步的：`apply()` 时某个服务还没到位**不算缺失**
 * （它可能几百毫秒后才 provide），所以只在过了宽限期仍然读不到时才告警。
 */
export const DEGRADED_GRACE_MS = 3000

/**
 * 延后执行一次（宿主 ctx 有 `setTimeout` 就用它的，能随 fiber 一起回收）。
 * @param ctx - client 上下文。
 * @param delay - 毫秒。
 * @param fn - 回调。
 */
export function later(ctx: any, delay: number, fn: () => void): void {
  try {
    if (typeof ctx?.setTimeout === 'function') {
      ctx.setTimeout(fn, delay)
      return
    }
    const handle: any = (globalThis as any).setTimeout(fn, delay)
    // Node（本仓测试就跑在 Node）里 pending 定时器会拖住进程退出；浏览器返回值是数字，这行是 no-op。
    if (handle !== null && typeof handle === 'object' && typeof handle.unref === 'function') handle.unref()
  } catch {
    // 没有可用计时器：插件照常挂载，降级原因仍由面板渲染时显示。
  }
}
