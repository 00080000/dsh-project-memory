/**
 * Task Panel - Floating interactive task management panel
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { h } from 'react'
import {
  Button,
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconCloseOutline16,
  IconMinimizeOutline14,
  IconCheckCircleOutline14,
  IconCircleOutline14,
  IconPlayCircleOutline14,
  IconFolderOutline14,
  IconFileOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { createTranslate, zh, en } from './locales.ts'
import { taskStore, useTaskStore, useTaskActions, type Task, type TaskFile } from './task-store.ts'
import css from './TaskPanel.module.css'

const NS = 'dsh-project-memory'

function getT() {
  const locale = navigator.language.startsWith('zh') ? zh : en
  return createTranslate(locale)
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  return `${Math.floor(h / 24)}天前`
}

function StepIcon({ status }: { status: 'pending' | 'in_progress' | 'completed' }) {
  switch (status) {
    case 'completed':
      return <IconCheckCircleOutline14 className={css.stepIconCompleted} />
    case 'in_progress':
      return <IconPlayCircleOutline14 className={css.stepIconProgress} />
    default:
      return <IconCircleOutline14 className={css.stepIconPending} />
  }
}

function FileRow({ file, onClick }: { file: TaskFile; onClick: () => void }) {
  return (
    <button
      className={css.fileRow}
      onClick={onClick}
      title={`${file.path}${file.line ? `:${file.line}` : ''}`}
    >
      <IconFileOutline14 className={css.fileIcon} />
      <span className={css.filePath}>{file.path}</span>
      {file.line && <span className={css.fileLine}>:{file.line}</span>}
    </button>
  )
}

function StepRow({ step, index }: { step: { content: string; status: 'pending' | 'in_progress' | 'completed' }; index: number }) {
  return (
    <div className={css.stepRow}>
      <StepIcon status={step.status} />
      <span className={`${css.stepContent} ${step.status === 'completed' ? css.stepCompleted : ''}`}>
        {step.content}
      </span>
    </div>
  )
}

function TaskItem({ task, boundTaskId, onToggle, onSwitch, onArchive, expanded, t }: {
  task: Task
  boundTaskId: string | null
  onToggle: (id: string) => void
  onSwitch: (id: string) => void
  onArchive: (id: string) => void
  expanded: boolean
  t: ReturnType<typeof createTranslate>
}) {
  const isBound = boundTaskId === task.id
  const doneSteps = task.steps.filter(s => s.status === 'completed').length
  const totalSteps = task.steps.length
  const progress = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0

  return (
    <div className={css.taskItem}>
      <button
        className={css.taskHeader}
        onClick={() => onToggle(task.id)}
        aria-expanded={expanded}
      >
        <div className={css.taskMain}>
          {isBound && <span className={css.boundBadge}>{t('task.current')}</span>}
          <span className={css.taskTitle}>{task.title}</span>
          <span className={css.taskProgress}>
            {totalSteps > 0 ? `${doneSteps}/${totalSteps}` : t('task.progress')}: 0
          </span>
        </div>
        <div className={css.taskActions}>
          {totalSteps > 0 && (
            <svg className={css.progressRing} viewBox="0 0 32 32">
              <circle
                className={css.progressBg}
                cx="16"
                cy="16"
                r="14"
                fill="none"
                strokeWidth="3"
              />
              <circle
                className={css.progressFg}
                cx="16"
                cy="16"
                r="14"
                fill="none"
                strokeWidth="3"
                strokeDasharray={`${progress * 0.88} ${88 - progress * 0.88}`}
                strokeDashoffset="22"
                style={{ strokeDasharray: `${progress * 0.88} ${88 - progress * 0.88}` }}
              />
            </svg>
          )}
          <span className={css.chevron}>
            {expanded ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
          </span>
        </div>
      </button>

      {expanded && (
        <div className={css.taskExpanded}>
          <div className={css.section}>
            <div className={css.sectionLabel}>{t('task.steps')}</div>
            <div className={css.stepsList}>
              {task.steps.map((step, i) => (
                <StepRow key={i} step={step} index={i} />
              ))}
              {task.steps.length === 0 && <div className={css.empty}>{t('panel.empty-desc')}</div>}
            </div>
          </div>

          {task.files.length > 0 && (
            <div className={css.section}>
              <div className={css.sectionLabel}>{t('task.files')}</div>
              <div className={css.filesList}>
                {task.files.slice(0, 10).map((file, i) => (
                  <FileRow
                    key={i}
                    file={file}
                    onClick={() => {
                      // 这里可以调用编辑器打开，暂时只复制路径
                      navigator.clipboard.writeText(file.path)
                    }}
                  />
                ))}
                {task.files.length > 10 && (
                  <div className={css.moreFiles}>… 共 {task.files.length} 个文件</div>
                )}
              </div>
            </div>
          )}

          <div className={css.taskFooter}>
            <Button variant="outline" size="sm" onClick={() => onSwitch(task.id)}>
              {t('task.switch')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => onArchive(task.id)}>
              {t('task.archive')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function MiniBar({ task, t, onExpand }: { task: Task; t: ReturnType<typeof createTranslate>; onExpand: () => void }) {
  return (
    <div className={css.miniBar} onClick={onExpand} title={t('minibar.click-expand')}>
      <IconFolderOutline14 className={css.miniIcon} />
      <span className={css.miniTitle}>
        {t('minibar.current')}: {task.title}
      </span>
      <IconChevronUpOutline14 className={css.miniChevron} />
    </div>
  )
}

export function TaskPanel({ ctx }: { ctx: any }) {
  const t = getT()
  const state = useTaskStore()
  const actions = useTaskActions()
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const panelRef = useRef<HTMLDivElement>(null)

  // 初始化位置
  useEffect(() => {
    const saved = state.panelPosition
    if (saved.x === 0 && saved.y === 0) {
      actions.setPanelPosition({ x: window.innerWidth - 440, y: 80 })
    }
  }, [])

  const handleDragStart = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    setDragOffset({ x: e.clientX - rect.left, y: e.clientY - rect.top })
    document.addEventListener('mousemove', handleDrag)
    document.addEventListener('mouseup', handleDragEnd)
  }

  const handleDrag = (e: MouseEvent) => {
    const x = Math.max(16, Math.min(window.innerWidth - 376, e.clientX - dragOffset.x))
    const y = Math.max(16, Math.min(window.innerHeight - 576, e.clientY - dragOffset.y))
    actions.setPanelPosition({ x, y })
  }

  const handleDragEnd = () => {
    document.removeEventListener('mousemove', handleDrag)
    document.removeEventListener('mouseup', handleDragEnd)
  }

  const handleToggle = (id: string) => actions.toggleTaskExpanded(id)
  const handleSwitch = (id: string) => ctx.commands?.execute('select_task', { taskId: id })
  const handleArchive = (id: string) => ctx.commands?.execute('archive_task', { taskId: id })

  const activeTasks = state.tasks.filter(t => !t.archived)
  const boundTask = state.boundTaskId ? state.tasks.find(t => t.id === state.boundTaskId) : null

  if (state.minimized) {
    return boundTask ? (
      <MiniBar task={boundTask} t={t} onExpand={() => actions.setMinimized(false)} />
    ) : null
  }

  if (!activeTasks.length) {
    return (
      <div className={css.panel} ref={panelRef} style={{ left: state.panelPosition.x, top: state.panelPosition.y }}>
        <div className={css.dragHandle} onMouseDown={handleDragStart} />
        <header className={css.header}>
          <div className={css.headerLeft}>
            <IconFolderOutline14 className={css.headerIcon} />
            <h2 className={css.headerTitle}>{t('panel.title')}</h2>
            <span className={css.badge}>
              {t('panel.active')}: {activeTasks.length} {t('panel.total')}: {state.tasks.length - state.archivedCount}
            </span>
          </div>
          <div className={css.headerRight}>
            <Button variant="ghost" size="sm" onClick={() => actions.setMinimized(true)} aria-label={t('panel.minimize')}>
              <IconMinimizeOutline14 />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { /* 隐藏面板逻辑 */ }} aria-label={t('panel.close')}>
              <IconCloseOutline16 />
            </Button>
          </div>
        </header>
        <div className={css.emptyState}>
          <IconFolderOutline14 className={css.emptyIcon} />
          <p>{t('panel.empty')}</p>
          <p className={css.emptyDesc}>{t('panel.empty-desc')}</p>
        </div>
      </div>
    )
  }

  return (
    <div
      className={css.panel}
      ref={panelRef}
      style={{ left: state.panelPosition.x, top: state.panelPosition.y }}
    >
      <div className={css.dragHandle} onMouseDown={handleDragStart} />
      <header className={css.header}>
        <div className={css.headerLeft}>
          <IconFolderOutline14 className={css.headerIcon} />
          <h2 className={css.headerTitle}>{t('panel.title')}</h2>
          <span className={css.badge}>
            {t('panel.active')}: {activeTasks.length} {t('panel.total')}: {state.tasks.length - state.archivedCount}
          </span>
        </div>
        <div className={css.headerRight}>
          <Button variant="ghost" size="sm" onClick={() => actions.setMinimized(true)} aria-label={t('panel.minimize')}>
            <IconMinimizeOutline14 />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { /* 隐藏 */ }} aria-label={t('panel.close')}>
            <IconCloseOutline16 />
          </Button>
        </div>
      </header>
      <div className={css.taskList}>
        {activeTasks.map(task => (
          <TaskItem
            key={task.id}
            task={task}
            boundTaskId={state.boundTaskId}
            onToggle={handleToggle}
            onSwitch={handleSwitch}
            onArchive={handleArchive}
            expanded={state.expandedTaskIds.has(task.id)}
            t={t}
          />
        ))}
      </div>
    </div>
  )
}

export function TaskPanelEntry({ ctx }: { ctx: any }) {
  // 监听 command/done 事件，解析 tasks 命令的 JSON 输出
  useEffect(() => {
    const handleCommandDone = (event: any) => {
      if (event.name === 'tasks' && event.result?.kind === 'success') {
        const text = event.result.text || ''
        const match = text.match(/```json\n([\s\S]*?)\n```/)
        if (match) {
          try {
            const data = JSON.parse(match[1])
            taskStore.actions.setTasks({
              tasks: data.tasks || [],
              boundTaskId: data.boundId || null,
              archivedCount: data.archived || 0,
            })
          } catch (e) {
            console.warn('[dsh-project-memory] Failed to parse tasks JSON:', e)
          }
        }
      }
    }

    ctx.on('command/done', handleCommandDone)
    return () => ctx.off('command/done', handleCommandDone)
  }, [ctx])

  return <TaskPanel ctx={ctx} />
}