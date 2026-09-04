/**
 * /tasks、/task 命令在会话中的节点渲染器（conversation.chat.commandview，按命令名 key）。
 *
 * 目标：不再让大段文本+JSON 出现在会话里——
 *  - 列表型（/tasks、无动词的 /task）：只渲染一行极简“已同步 N 套”状态；
 *    同时把节点文本里的 JSON 载荷解析进浮动面板（侧边卡片由它驱动），
 *    面板若被收起则自动展开（等价“输入 /task 就看到卡片”）。
 *  - 动作型（/task switch|archive）：渲染一行操作结果（切换/归档反馈）。
 *  - 错误/执行中：一行极简状态，不倾倒原文。
 */
import { useEffect } from 'react'
import { IconFolderOpenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseTaskPayloadText, taskStore } from './task-store.ts'
import css from './TaskCommandNode.module.css'

/** node = CommandRowOwnerProps.node（CommandNode: name / args / outcome{kind,text}） */
export function TaskCommandNode({ node }: { node?: any }) {
  const name = node?.name ?? 'task'
  const outcome = node?.outcome ?? null
  const args = typeof node?.args === 'string' ? node.args : ''
  const verb = args.trim().split(/\s+/)[0] ?? ''
  const isList = name === 'tasks' || !verb
  const text = outcome?.text ?? ''

  const parsed = parseTaskPayloadText(text)

  // 载荷进面板 + 列表型自动展开面板。
  // 注意：命令节点先以“执行中”创建、完成后原地更新（同一组件实例），
  // 所以 effect 必须在结果文本变化时重跑，而不是只在挂载时跑一次。
  useEffect(() => {
    if (!parsed) return
    taskStore.actions.setTasks({
      tasks: parsed.tasks,
      boundTaskId: parsed.boundId,
      archivedCount: parsed.archived,
    })
    if (isList) taskStore.actions.open()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  // 执行中
  if (outcome === null) {
    return <div className={css.row} data-variant="running">/{name} 执行中…</div>
  }

  // 失败：一行极简，不含大段原文
  if (outcome.kind === 'error') {
    const brief = String(text ?? '').split('\n')[0].slice(0, 120)
    return <div className={css.row} data-variant="error">/{name} 失败{brief ? `：${brief}` : ''}</div>
  }

  // 动作型：取第一段（操作反馈），不带 JSON
  if (!isList) {
    const note = String(text ?? '')
      .split(/\n{2,}/)[0]
      .replace(/```.*$/s, '')
      .trim()
      .slice(0, 200)
    return <div className={css.row} data-variant="ok">/{name} {note || '已完成'}</div>
  }

  // 列表型：一行极简状态
  const count = parsed ? parsed.tasks.length : 0
  const archived = parsed ? parsed.archived : 0
  const label = parsed
    ? `任务 ${count} 套${archived ? `（归档 ${archived}）` : ''} · 已同步到任务面板`
    : `/${name} 已执行`
  return (
    <div className={css.row} data-variant="ok">
      <IconFolderOpenOutline16 className={css.icon} />
      <span>{label}</span>
    </div>
  )
}
