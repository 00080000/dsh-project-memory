/**
 * dsh-project-memory Client Entry
 *
 * dsh web (rc.1) 的 client 插件契约为 cordis client plugin：
 *   export const inject = [<client 服务名>...]
 *   export function apply(ctx) { ... }
 *
 * 本插件**不用顶层 `inject` 声明必需服务**（见 services.ts）：它是装配期门控，缺一项宿主
 * 就根本不调用 apply()，表现是"插件出问题、界面上却静默消失"。服务改由 `service()` 现场探测，
 * 缺了照常挂载、面板上显示原因、日志里打一条点名缺失项的告警。
 *
 * 面板注册进 `shell.overlay`（Frame 级浮动层，additive 列表槽）：
 * 该槽由 ui-layout 的 AppFrame 声明渲染（scope root，独立于滚动容器），
 * 默认 click-through，条目自身需开启 pointer-events。
 *
 * 只依赖宿主 seed 提供的模块（react / dsh-client-ui-primitives），
 * 数据经 remote.commands.execute 执行 /tasks 命令获取 JSON 快照。
 *
 * 另有一个可选增强：自建的 `/` 菜单源（slash.ts），把三条命令收进一个带图标和
 * 小节标题的「工作流」组。它**整体是可选的**——宿主没有 slash 触发器服务时静默跳过。
 */
import { createElement } from 'react'
import { TaskPanelEntry } from './TaskPanel.tsx'
import { TaskCommandNode } from './TaskCommandNode.tsx'
import { registerShowTaskPanelView } from './ShowTaskPanelNode.tsx'
import { taskUIStore } from './task-ui-store.ts'
import { createSlashSource } from './slash.ts'
import { DEGRADED_GRACE_MS, later, missingServices, service } from './services.ts'

const NS = 'dsh-project-memory'

export const name = NS

/**
 * 顶层 `inject` **留空**（必需服务的软依赖清单在 services.ts 的 `REQUIRED_SERVICES`）。
 *
 * 这不是省略，而是契约选择：cordis 的顶层 inject 是装配期门控，缺一项就根本不调用
 * `apply()` —— 整个 client 半边静默消失。留空后 apply() 一定会被调用，服务缺失由
 * `missingServices()` 在运行时说清楚（面板上显示 + 日志告警）。
 */
export const inject: readonly string[] = []

/**
 * 注册自建的 `/` 菜单源（见 slash.ts）。
 *
 * 整段都是**可选增强**：宿主没有 `inputTriggers` 服务、或该服务换了契约时，绝不能因此
 * 让整个 client 插件挂掉——那会连任务面板一起消失。`inputTriggers` 因此不进任何 `inject`
 * 声明，而是走嵌套 `ctx.inject` + 两层 try/catch（顶层 inject 未满足时 cordis 根本不会
 * 调用 apply，见 services.ts）。
 * @param ctx - client 根上下文
 */
function registerSlashSource(ctx: any): void {
  if (typeof ctx?.inject !== 'function') {
    console.warn(`[${NS}] host has no ctx.inject — slash menu group disabled`)
    return
  }
  try {
    ctx.inject(['inputTriggers', 'sessions', 'remote.commands'], (scope: any) => {
      try {
        const inputTriggers = scope?.inputTriggers
        if (!inputTriggers || typeof inputTriggers.registerSource !== 'function') {
          console.warn(`[${NS}] host has no inputTriggers.registerSource — slash menu group disabled`)
          return
        }
        const source = createSlashSource(scope, {
          sessions: scope.sessions,
          // 菜单行是「打开面板的某一页」：直接落到 UI store，不绕宿主命令
          // （面板的 closed/view 是浏览器侧状态，宿主命令碰不到）。
          openView: (view) => taskUIStore.actions.openView(view),
        })
        scope.effect(() => inputTriggers.registerSource(source), 'dsh-project-memory: slash source')
      } catch (err) {
        console.warn(`[${NS}] slash source registration failed:`, err)
      }
    })
  } catch (err) {
    console.warn(`[${NS}] slash source injection failed:`, err)
  }
}

/**
 * 挂载任务面板（`shell.overlay` 浮层 + 会话内命令节点 + `show_task_panel` 工具视图）。
 *
 * `slots` 同样是软依赖：现成的就用；没有就**等它**（cordis 的 `ctx.inject` 是嵌套注入，
 * 只门控这一段回调，插件本身照样挂载）。等不到时由 {@link reportDegradedLater} 说明原因。
 * @param ctx - client 根上下文
 */
function registerTaskPanel(ctx: any): void {
  const mount = (slots: any): void => {
    if (!slots || typeof slots.inject !== 'function') {
      console.warn(`[${NS}] host has no slots service — task panel disabled`)
      return
    }
    try {
      slots.inject('shell.overlay', () => slots.register(
        {
          name: 'shell.overlay',
          id: 'dsh-project-memory-task-panel',
          order: 100, // 浮层顺序：低于 toast/弹窗即可，越高越靠后渲染
        },
        () => createElement(TaskPanelEntry, { ctx })
      ))

      // 会话内命令节点：按命令名 key 接管渲染，替换内置大段文本卡片
      // （文本含 JSON 载荷，只有面板需要它），避免载荷刷屏对话。
      // 合并后只剩一条用户命令 /tasks（子动词都记在同一个命令名下）。
      const nodeKeys = ['tasks']
      for (const key of nodeKeys) {
        slots.inject('conversation.chat.commandview', () => slots.register(
          { name: 'conversation.chat.commandview', key },
          TaskCommandNode
        ))
      }

      // 工具调用视图：`show_task_panel` 的唯一实际效果就是开面板，而面板状态在浏览器侧；
      // 宿主进程碰不到它（宿主契约里 `ToolRunContext` 没有 `ctx`）。认领这个**工具名**后，
      // 工具结果一渲染就把面板打开 —— 见 ShowTaskPanelNode.tsx。
      registerShowTaskPanelView(slots)
    } catch (err) {
      console.warn(`[${NS}] task panel registration failed:`, err)
    }
  }

  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['slots'], (scope: any) => mount(scope?.slots ?? service(ctx, 'slots')))
      return
    } catch (err) {
      console.warn(`[${NS}] slots injection failed:`, err)
    }
  }
  mount(service(ctx, 'slots'))
}

/**
 * 过了宽限期仍然读不到必需服务时，打**一条**点名缺失项的告警。
 *
 * 为什么不在 `apply()` 里立刻报：装配是异步的，apply 时某个服务还没 provide 是正常的
 * （那样每次启动都会误报）。宽限期后还缺，就是真的缺 —— 这条日志是"静默消失"的反面。
 * @param ctx - client 根上下文
 */
function reportDegradedLater(ctx: any): void {
  later(ctx, DEGRADED_GRACE_MS, () => {
    const missing = missingServices(ctx)
    if (missing.length === 0) return
    console.warn(
      `[${NS}] degraded: client service(s) unavailable in this assembly: ${missing.join(', ')}`
      + ' — the client half is mounted anyway; the task panel shows the same reason.',
    )
  })
}

export function apply(ctx: any): void {
  // 顶层不再有任何硬依赖：这里的三步都在缺服务时降级，绝不早退（早退就是静默消失）。
  registerTaskPanel(ctx)
  registerSlashSource(ctx)
  reportDegradedLater(ctx)
}
