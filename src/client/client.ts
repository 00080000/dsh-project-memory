/**
 * dsh-project-memory Client Entry
 *
 * dsh web (rc.1) 的 client 插件契约为 cordis client plugin：
 *   export const inject = [<client 服务名>...]
 *   export function apply(ctx) { ... }
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
import { createSlashSource } from './slash.ts'

const NS = 'dsh-project-memory'

export const name = NS

/** Required client services: slots registry, session scopes, commands remote (data 通道). */
export const inject = ['slots', 'sessions', 'remote', 'remote.commands', 'locale']

/**
 * 执行一条命令行，映射成 composer 的 SubmitOutcome。
 * 与 TaskPanel 走同一个 remote.commands.execute 通道（同样的返回信封）。
 * @param commands - ctx.remote.commands
 * @param session - 会话投影（只读 sessionId）
 * @param line - 完整命令行（含前导斜杠）
 * @param attachments - 提交附件（菜单路径恒为空）
 * @returns {kind:'success'|'error', text?}
 */
async function runCommand(
  commands: any,
  session: any,
  line: string,
  attachments: readonly unknown[] = [],
): Promise<{ kind: 'success' | 'error'; text?: string }> {
  const sessionId = session?.sessionId
  if (typeof sessionId !== 'string' || !commands || typeof commands.execute !== 'function') {
    return { kind: 'error', text: `no session / commands service for ${line}` }
  }
  const response: any = await commands.execute(sessionId, line, [...attachments])
  const envelope = response as { ok?: boolean; error?: any; value?: any } | null | undefined
  if (envelope && typeof envelope === 'object' && envelope.ok === false) {
    return { kind: 'error', text: `command.execute failed: ${envelope.error?.code ?? 'unknown'}` }
  }
  const execution = envelope && typeof envelope === 'object' && 'value' in envelope ? envelope.value : envelope
  const result = execution?.result ?? execution
  if (result?.kind === 'error') return { kind: 'error', text: result.text ?? `${line} failed` }
  return { kind: 'success' }
}

/**
 * 注册自建的 `/` 菜单源（见 slash.ts）。
 *
 * 整段都是**可选增强**：宿主没有 `inputTriggers` 服务、或该服务换了契约时，绝不能因此
 * 让整个 client 插件挂掉——那会连任务面板一起消失。`inputTriggers` 因此不进顶层 `inject`
 * （顶层 inject 未满足时 cordis 根本不会调用 apply），而是走嵌套 inject + 两层 try/catch。
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
          run: (session, line, attachments) => runCommand(scope?.remote?.commands, session, line, attachments),
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

export function apply(ctx: any): void {
  const slots = ctx?.slots
  if (!slots || typeof slots.inject !== 'function') {
    console.warn(`[${NS}] host has no slots service — task panel disabled`)
  } else {
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
    } catch (err) {
      console.warn(`[${NS}] task panel registration failed:`, err)
    }
  }

  registerSlashSource(ctx)
}
