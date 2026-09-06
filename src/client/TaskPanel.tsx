/**
 * Task Panel — dsh web `shell.overlay` 浮动任务面板。
 * Container 组件：负责数据获取、命令桥接、状态协调
 * Presentational 组件在 TaskComponents.tsx
 */
import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  IconChevronDownOutline14,
  IconCloseOutline16,
  IconFolderOpenOutline16,
  IconQuestionOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { createTranslate, zh, en } from './locales.ts'
import { useTaskData, useTaskDataActions, parseTaskPayloadText, type TaskStep } from './task-data-store.ts'
import { useTaskUI, useTaskUIActions } from './task-ui-store.ts'
import { MiniBar, TaskCard } from './TaskComponents.tsx'
import css from './TaskPanel.module.css'

const NS = 'dsh-project-memory'

const STATUS_CYCLE = ['pending', 'in_progress', 'completed'] as const

function getT() {
  const locale = (typeof navigator !== 'undefined' && navigator.language.startsWith('zh')) ? zh : en
  return createTranslate(locale)
}

function useSessionId(ctx: any): string | null {
  const [, force] = useState(0)
  useEffect(() => {
    const list = ctx?.sessions?.list
    if (!list || typeof list.subscribe !== 'function') return
    return list.subscribe(() => force((n) => n + 1))
  }, [ctx])
  const snap = ctx?.sessions?.list?.getSnapshot?.()
  if (!snap) return null
  if (snap.current) return snap.current
  const first = Array.isArray(snap.items) ? snap.items.find((s: any) => !s.blank) ?? snap.items[0] : undefined
  return first?.sessionId ?? null
}

class PanelErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: unknown) {
    console.warn('[dsh-project-memory] task panel render crashed:', error)
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <button className={css.boundaryFallback} onClick={() => this.setState({ failed: false })} title="重新渲染任务面板">
        任务面板（点击重试）
      </button>
    )
  }
}

export function TaskPanelEntry({ ctx }: { ctx: any }) {
  return (
    <PanelErrorBoundary>
      <TaskPanelView ctx={ctx} />
    </PanelErrorBoundary>
  )
}

function TaskPanelView({ ctx }: { ctx: any }) {
  const t = getT()
  const data = useTaskData()
  const ui = useTaskUI()
  const sessionId = useSessionId(ctx)
  const [syncing, setSyncing] = useState(false)
  const [syncedAt, setSyncedAt] = useState(0)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [showHints, setShowHints] = useState(true)

  const dataActions = useTaskDataActions()
  const uiActions = useTaskUIActions()

  const activeTasks = data.tasks.filter((task) => !task.archived)
  const boundTask = data.boundTaskId ? data.tasks.find((task) => task.id === data.boundTaskId) ?? null : null

  const applyPayload = (text?: string): boolean => {
    const parsed = parseTaskPayloadText(text)
    if (!parsed) return false
    dataActions.setTasks({ tasks: parsed.tasks, boundTaskId: parsed.boundId, archivedCount: parsed.archived })
    setSyncedAt(Date.now())
    setSyncError(null)
    return true
  }

  const runLine = async (line: string): Promise<boolean> => {
    const commands = ctx?.remote?.commands
    if (!sessionId || !commands || typeof commands.execute !== 'function') {
      setSyncError('no session / commands service')
      return false
    }
    let response: any
    try {
      response = await commands.execute(sessionId, line, [])
    } catch (err) {
      setSyncError(String(err?.message ?? err))
      return false
    }
    const envelope = response as { ok?: boolean; value?: any } | null | undefined
    const execution = envelope && typeof envelope === 'object' && 'value' in envelope ? envelope.value : envelope
    const result = execution?.result ?? execution
    if (result?.kind === 'error') {
      setSyncError(result.text ?? 'command error')
      return false
    }
    return applyPayload(result?.text)
  }

  const refresh = async (): Promise<void> => {
    if (syncing) return
    setSyncing(true)
    try {
      const prevBoundId = data.boundTaskId
      await runLine('/tasks')
      const newBoundId = useTaskData.getSnapshot().boundTaskId
      if (newBoundId && newBoundId !== prevBoundId) {
        await runLine(`/task switch ${newBoundId}`)
      }
    } finally {
      setSyncing(false)
    }
  }

  const handleAction = async (verb: 'switch' | 'archive', taskId: string): Promise<void> => {
    if (syncing) return
    setSyncing(true)
    try {
      await runLine(`/task ${verb} ${taskId}`)
    } finally {
      setSyncing(false)
    }
  }

  const pushSteps = (taskId: string, steps: TaskStep[]): void => {
    void runLine(`/task todos ${JSON.stringify(steps.map((s) => ({ content: s.content, status: s.status })))}`)
  }

  const cycleStatus = (taskId: string, index: number) => {
    const task = data.tasks.find((tt) => tt.id === taskId)
    if (!task) return
    const steps = task.steps || []
    const next = steps.map((s, i) => {
      if (i !== index) return s
      const cur = STATUS_CYCLE.indexOf(s.status)
      return { ...s, status: STATUS_CYCLE[(cur + 1) % STATUS_CYCLE.length] }
    })
    pushSteps(taskId, next)
  }

  const commitStepText = (taskId: string, index: number, value: string) => {
    const task = data.tasks.find((tt) => tt.id === taskId)
    const trimmed = value.trim()
    if (!task) return
    const same = (task.steps || [])[index]?.content === trimmed
    if (same || !trimmed) return
    const next = (task.steps || []).map((s, i) => (i === index ? { ...s, content: trimmed } : s))
    pushSteps(taskId, next)
  }

  const reorderSteps = (taskId: string, fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return
    const task = data.tasks.find((tt) => tt.id === taskId)
    if (!task) return
    const steps = [...(task.steps || [])]
    const [moved] = steps.splice(fromIndex, 1)
    const targetIndex = toIndex > fromIndex ? toIndex - 1 : toIndex
    steps.splice(targetIndex, 0, moved)
    pushSteps(taskId, steps)
  }

  const commitTitle = (taskId: string, value: string) => {
    const task = data.tasks.find((tt) => tt.id === taskId)
    const trimmed = value.trim()
    if (!task) return
    const same = task.title === trimmed
    if (same || !trimmed) return
    void runLine(`/task rename ${taskId} ${JSON.stringify(trimmed)}`)
  }

  const expand = () => {
    uiActions.open()
    if (Date.now() - Math.max(data.lastUpdate, syncedAt) > 30_000) {
      void refresh()
    }
  }

  const THEMES = ['native', 'glass', 'brutal', 'mono'] as const
  const style = (THEMES as readonly string[]).includes(ui.theme) ? ui.theme : 'native'
  const styleLabel = t(`style.${style}` as keyof typeof zh)
  const cycleTheme = () => {
    const i = THEMES.indexOf(style as (typeof THEMES)[number])
    uiActions.setTheme(THEMES[(i + 1) % THEMES.length])
  }

  const panelRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)

  const handleDragStart = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    const onMove = (ev: MouseEvent) => {
      if (!drag.current) return
      const width = panelRef.current?.offsetWidth ?? 380
      const height = panelRef.current?.offsetHeight ?? 480
      const x = Math.max(8, Math.min(window.innerWidth - width - 8, ev.clientX - drag.current.dx))
      const y = Math.max(8, Math.min(window.innerHeight - 64, ev.clientY - drag.current.dy))
      uiActions.setPanelPosition({ x, y })
    }
    const onUp = () => {
      drag.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 会话切换时仅同步数据，不自动打开面板
  useEffect(() => {
    if (!sessionId) return
    // 仅当面板已打开时才自动刷新
    if (!ui.closed) {
      void refresh()
    }
  }, [sessionId])

  // 监听模型工具请求打开面板
  useEffect(() => {
    const ctxWithEvents = ctx
    const handler = () => {
      uiActions.open()
      if (Date.now() - Math.max(data.lastUpdate, syncedAt) > 30_000) {
        void refresh()
      }
    }
    ctxWithEvents?.events?.on?.('dsh:task-panel:show', handler)
    return () => {
      ctxWithEvents?.events?.off?.('dsh:task-panel:show', handler)
    }
  }, [ctx, uiActions, data.lastUpdate, syncedAt, refresh])

  // 彻底隐藏：不渲染任何东西
  if (ui.closed) {
    return null
  }

  // 折叠态：迷你条
  if (ui.minimized) {
    const label = boundTask
      ? `${t('minibar.current')}: ${boundTask.title}`
      : activeTasks.length > 0
        ? `${t('minibar.current')}: ${activeTasks.length} ${t('minibar.tasks')}`
        : t('minibar.no-task')
    return (
      <MiniBar
        label={label}
        hint={t('minibar.click-expand')}
        position={ui.panelPosition}
        theme={style}
        onMove={uiActions.setPanelPosition}
        open={expand}
      />
    )
  }

  const doneCount = activeTasks.filter((task) => {
    const steps = task.steps || []
    return steps.length > 0 && steps.every((s) => s.status === 'completed')
  }).length

  return (
    <div
      className={css.panel}
      ref={panelRef}
      style={{ left: ui.panelPosition.x, top: ui.panelPosition.y }}
      data-theme={style === 'native' ? undefined : style}
    >
      <div className={css.dragHandle} onMouseDown={handleDragStart} title={t('task.drag')}>
        <div className={css.handleGrip} />
      </div>
      <header className={css.header}>
        <div className={css.headerLeft}>
          <Button
            type="button"
            className={css.headerIconBtn}
            onClick={cycleTheme}
            title={styleLabel}
            aria-label={styleLabel}
          >
            <IconFolderOpenOutline16 className={css.headerIcon} />
          </Button>
          <h2 className={css.headerTitle}>{t('panel.title')}</h2>
        </div>
        <div className={css.headerRight}>
          <span className={css.counts}>
            {activeTasks.length > 0
              ? `${t('panel.active')} ${activeTasks.length} · ${doneCount}/${activeTasks.length}`
              : ''}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowHints(!showHints)}
            aria-label={showHints ? t('panel.hints-off') : t('panel.hints-on')}
            title={showHints ? t('panel.hints-off') : t('panel.hints-on')}
          >
            <IconQuestionOutline14 size={16} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => uiActions.minimize()}
            aria-label={t('panel.minimize')}
            title={t('panel.minimize')}
          >
            <IconChevronDownOutline14 />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => uiActions.close()}
            aria-label={t('panel.close')}
            title={t('panel.close')}
          >
            <IconCloseOutline16 />
          </Button>
        </div>
      </header>

      {!sessionId && <div className={css.notice}>{t('panel.no-session')}</div>}
      {syncError && <div className={css.notice}>{t('panel.sync-failed')}: {syncError}</div>}

      {activeTasks.length === 0 ? (
        <div className={css.emptyState}>
          <p className={css.emptyTitle}>{t('panel.empty')}</p>
          <p className={css.emptyDesc}>{t('panel.empty-desc')}</p>
          {syncing && <p className={css.syncHint}>{t('panel.syncing')}</p>}
        </div>
      ) : (
        <div className={css.taskList}>
          {activeTasks.map((task) => {
            const steps = task.steps || []
            const expanded = ui.expandedTaskIds.includes(task.id)
            const isBound = data.boundTaskId === task.id
            return (
              <TaskCard
                key={task.id}
                task={task}
                isBound={isBound}
                expanded={expanded}
                onToggleExpand={() => uiActions.toggleTaskExpanded(task.id)}
                onSwitch={() => handleAction('switch', task.id)}
                onUnbind={() => runLine('/task unbind')}
                onArchive={() => handleAction('archive', task.id)}
                onRename={(value) => commitTitle(task.id, value)}
                onEditStep={(index, value) => commitStepText(task.id, index, value)}
                onCycleStatus={(index) => cycleStatus(task.id, index)}
                onReorderSteps={(from, to) => reorderSteps(task.id, from, to)}
                showHints={showHints}
                syncing={syncing}
                t={t}
              />
            )
          })}
          {syncing && <div className={css.syncHint}>{t('panel.syncing')}</div>}
        </div>
      )}
    </div>
  )
}