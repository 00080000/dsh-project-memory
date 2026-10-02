/**
 * `show_task_panel` 工具调用的会话内视图 —— 它的作用就是**把面板打开**。
 *
 * 为什么这件事必须在这里做：面板的显示状态（closed / minimized）是**浏览器侧**的
 * （`task-ui-store.ts`），宿主进程碰不到它。宿主侧原本写的是
 * `exec.ctx.events.emit('dsh:task-panel:show')`，而宿主契约里根本没有 `ctx`：
 *
 *   packages/core/tools/src/index.ts:418
 *   export interface ToolRunContext extends ToolExecution {
 *     deferContext(context: UserMessage): void
 *     concludeTurn(): void
 *   }
 *
 * 于是那个工具每次都只返回「无法获取上下文」，面板从来不会打开 —— 插件里唯一的
 * 宿主命令之外，这是第二个"写了但没生效"的面（详见 CHANGELOG 0.5.14）。
 *
 * 正确的位置是宿主给出的扩展点：`ui-tool` 注册了 `conversation.chat.node`（key `tool-call`），
 * 其下有个按**工具名**分发的子槽 `tool.call.toolview`（契约原文：*Any name is allowed,
 * including tools registered by your package. Register with `key: '<tool name>'`*）。
 * 在这里认领 `show_task_panel` 这个 key，工具结果一渲染就把面板打开。
 */
import { useEffect, useRef } from 'react'
import { taskUIStore } from './task-ui-store.ts'

/**
 * 只在**现场执行**时打开面板。
 *
 * 历史节点在刷新 / 切换会话后挂载时会**直接**处于 `result` 阶段；现场调用则会先经过
 * `preparing` / `start`。这与 `/tasks` 命令节点用的判据同款（见 `TaskCommandNode.tsx`
 * 的 `live` ref）：刷新后只展示、不再开面板，否则每次打开会话都会弹一次面板。
 */
export function ShowTaskPanelNode(props: any) {
  const phase = props?.phase
  const live = useRef(phase !== 'result')
  useEffect(() => {
    if (phase !== 'result' || !live.current) return
    live.current = false
    taskUIStore.actions.open()
  }, [phase])
  // 不渲染任何行：认领 key 会**替换**通用工具行，而这次调用的全部意义就是开面板，
  // 留一行"打开面板"的噪音不如让面板自己说话。
  return null
}

/** 把 `show_task_panel` 的视图注册进宿主的 `tool.call.toolview` 槽。 */
export function registerShowTaskPanelView(slots: any): void {
  slots.inject('tool.call.toolview', () => slots.register(
    { name: 'tool.call.toolview', key: 'show_task_panel' },
    ShowTaskPanelNode,
  ))
}
