/**
 * /tasks、/task、/insight 命令在会话中的节点渲染器（conversation.chat.commandview，按命令名 key）。
 * 列表型命令（/tasks、无动词 /task、/insight list）只显示一行摘要；/insight 的动作类只显示一句结果——
 * 目的：大 JSON 载荷绝不整段渲染进对话（否则切视图会刷屏）。
 */
import { useEffect, useRef } from 'react'
import { IconFolderOpenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseTaskPayloadText, taskDataStore } from './task-data-store.ts'
import { parseInsightPayloadText } from './MemoryView.tsx'
import { taskUIStore } from './task-ui-store.ts'
import css from './TaskCommandNode.module.css'

export function TaskCommandNode({ node }: { node?: any }) {
  const name = node?.name ?? 'task'
  const outcome = node?.outcome ?? null
  const args = typeof node?.args === 'string' ? node.args : ''
  const verb = args.trim().split(/\s+/)[0] ?? ''
  const isList = name === 'tasks' || !verb
  const text = outcome?.text ?? ''

  const parsedTasks = name !== 'insight' ? parseTaskPayloadText(text) : null
  const parsedInsights = name === 'insight' ? parseInsightPayloadText(text) : null

  // 该节点是否“现场执行”（挂载时处于执行中）：为 true 说明是用户当场输入的命令，
  // 完成后同步数据并打开面板。刷新/切换会话后历史节点以完成态重挂载，
  // 此时只做展示、不再写数据/开面板（面板保持关闭，与“刷新后不显示”一致）。
  const live = useRef(outcome === null)

  // 载荷进数据 store；列表型任务命令（/tasks、无动词 /task）同步数据并打开面板
  useEffect(() => {
    if (!parsedTasks || !live.current) return
    taskDataStore.actions.setTasks({
      tasks: parsedTasks.tasks,
      boundTaskId: parsedTasks.boundId,
      archivedCount: parsedTasks.archived,
    })
    if (isList) taskUIStore.actions.open()
  }, [text])

  if (outcome === null) {
    return <div className={css.row} data-variant="running">/{name} 执行中…</div>
  }

  if (outcome.kind === 'error') {
    const brief = String(text ?? '').split('\n')[0].slice(0, 120)
    return <div className={css.row} data-variant="error">/{name} 失败{brief ? `：${brief}` : ''}</div>
  }

  // /insight：列表只显示一行摘要，动作类只显示一句结果（永不整段渲染）
  if (name === 'insight') {
    if (verb === 'list' && parsedInsights) {
      const scope = parsedInsights.scope
      const count = parsedInsights.count ?? parsedInsights.items.length
      return (
        <div className={css.row} data-variant="ok">
          <IconFolderOpenOutline16 className={css.icon} />
          <span>记忆 {scope} · {count} 条 · 已同步到记忆视图</span>
        </div>
      )
    }
    const note = String(text ?? '').split('\n')[0].slice(0, 120)
    return <div className={css.row} data-variant="ok">/insight {verb} {note || '已完成'}</div>
  }

  if (!isList) {
    const note = String(text ?? '')
      .split(/\n{2,}/)[0]
      .replace(/```.*$/s, '')
      .trim()
      .slice(0, 200)
    return <div className={css.row} data-variant="ok">/{name} {note || '已完成'}</div>
  }

  const count = parsedTasks ? parsedTasks.tasks.length : 0
  const archived = parsedTasks ? parsedTasks.archived : 0
  const label = parsedTasks
    ? `任务 ${count} 套${archived ? `（归档 ${archived}）` : ''} · 已同步到任务面板`
    : `/${name} 已执行`
  return (
    <div className={css.row} data-variant="ok">
      <IconFolderOpenOutline16 className={css.icon} />
      <span>{label}</span>
    </div>
  )
}