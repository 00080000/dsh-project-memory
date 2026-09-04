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
 */
import { createElement } from 'react'
import { TaskPanelEntry } from './TaskPanel.tsx'
import { TaskCommandNode } from './TaskCommandNode.tsx'

const NS = 'dsh-project-memory'

export const name = NS

/** Required client services: slots registry, session scopes, commands remote (data 通道). */
export const inject = ['slots', 'sessions', 'remote', 'remote.commands']

export function apply(ctx: any): void {
  const slots = ctx?.slots
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

    // 会话内 /tasks、/task 命令节点：按命令名 key 接管渲染，
    // 替换内置大段文本卡片（文本含 JSON 载荷，只有面板需要它）。
    const nodeKeys = ['tasks', 'task']
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
