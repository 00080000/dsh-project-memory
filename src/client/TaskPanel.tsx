/**
 * Task Panel — dsh web `shell.overlay` 浮动任务面板。
 *
 * 升级原 `/tasks` 文本输出为可交互卡片：
 *  - 默认收成右侧浮标（不影响用户操作/不挡对话）；
 *  - 展开时通过宿主 `remote.commands.execute(sessionId, '/tasks')` 拉取最新快照
 *    （命令只读，走 /tasks 同一数据源 = tasks.json，因此与模型维护的 todo 双向一致）；
 *  - 卡片内「切换 / 归档」执行 `/task switch|archive <id>`，服务端返回新快照 JSON，
 *    面板即时刷新，无需再跑一次 /tasks；
 *  - 可拖拽（仅头部把手），位置持久化 localStorage。
 *
 * 依赖仅 react + @deepseek-ai/dsh-client-ui-primitives（宿主 seed 模块）。
 */
import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconCloseOutline16,
  IconRefreshOutline16,
  IconCheckOutline16,
  IconPlayOutline16,
  IconFolderOpenOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { createTranslate, zh, en } from './locales.ts'
import { taskStore, useTaskStore, parseTaskPayloadText, type TaskStep } from './task-store.ts'
import css from './TaskPanel.module.css'

const NS = 'dsh-project-memory'

function getT() {
  const locale = (typeof navigator !== 'undefined' && navigator.language.startsWith('zh')) ? zh : en
  return createTranslate(locale)
}

function timeAgo(iso?: string) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  return `${Math.floor(h / 24)}天前`
}

function StepIcon({ status }: { status: TaskStep['status'] }) {
  if (status === 'completed') return <IconCheckOutline16 className={css.stepDone} />
  if (status === 'in_progress') return <IconPlayOutline16 className={css.stepRun} />
  return <span className={css.stepPending} />
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

/** 行内编辑框：自动按内容增高（最多 160px），Enter 提交、Shift+Enter 换行、Esc 取消、失焦提交。 */
function AutoEdit({ value, onCommit, onCancel, singleLine }: {
  value: string
  onCommit: (value: string) => void
  onCancel: () => void
  singleLine?: boolean
}) {
  const [text, setText] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)
  const settled = useRef(false)
  const once = (fn: () => void) => {
    if (settled.current) return
    settled.current = true
    fn()
  }

  const adjust = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  useEffect(() => {
    adjust()
    const el = ref.current
    el?.focus()
    el?.select()
  }, [])

  return (
    <textarea
      ref={ref}
      className={css.stepInput}
      rows={1}
      value={text}
      onChange={(e) => { setText(e.target.value); adjust() }}
      onBlur={() => once(() => onCommit(text))}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          once(() => onCancel())
        } else if (e.key === 'Enter' && (singleLine || !e.shiftKey)) {
          e.preventDefault()
          once(() => onCommit(text))
        }
      }}
    />
  )
}

/** 折叠迷你条：可拖拽（按住拖动，轻点展开）。 */
function MiniBar({ label, hint, position, theme, onMove, open }: {
  label: string
  hint: string
  position: { x: number; y: number }
  theme: string
  onMove: (pos: { x: number; y: number }) => void
  open: () => void
}) {
  const barRef = useRef<HTMLDivElement>(null)
  const down = useRef<{ dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null)

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const rect = barRef.current?.getBoundingClientRect()
    if (!rect) return
    down.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, sx: e.clientX, sy: e.clientY, moved: false }
    const onMoveEv = (ev: MouseEvent) => {
      const d = down.current
      if (!d) return
      if (!d.moved && Math.abs(ev.clientX - d.sx) + Math.abs(ev.clientY - d.sy) > 4) d.moved = true
      if (d.moved) {
        const w = barRef.current?.offsetWidth ?? 260
        const h = barRef.current?.offsetHeight ?? 34
        const x = Math.max(8, Math.min(window.innerWidth - w - 8, ev.clientX - d.dx))
        const y = Math.max(8, Math.min(window.innerHeight - h - 8, ev.clientY - d.dy))
        onMove({ x, y })
      }
    }
    const onUpEv = () => {
      const d = down.current
      down.current = null
      window.removeEventListener('mousemove', onMoveEv)
      window.removeEventListener('mouseup', onUpEv)
      if (d && !d.moved) open()
    }
    window.addEventListener('mousemove', onMoveEv)
    window.addEventListener('mouseup', onUpEv)
  }

  return (
    <div
      ref={barRef}
      className={css.miniBar}
      style={{ left: position.x, top: position.y }}
      data-theme={theme === 'native' ? undefined : theme}
      onMouseDown={onMouseDown}
      role="button"
      title={hint}
      aria-label={hint}
    >
      <IconFolderOpenOutline16 className={css.miniIcon} />
      <span className={css.miniText}>{label}</span>
      <IconChevronUpOutline14 className={css.miniChevron} />
    </div>
  )
}

/**
 * 错误边界：任务面板渲染一旦抛错，不再让 shell.overlay 把整条条目退休
 * （宿主对崩溃条目会永久移除直到重载页面）。捕获后显示一个纯文本兜底，
 * 点击重新渲染。
 */
class PanelErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.warn('[dsh-project-memory] task panel render crashed (contained by boundary):', error)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <button
        className={css.boundaryFallback}
        onClick={() => this.setState({ failed: false })}
        title="重新渲染任务面板"
      >
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
  const state = useTaskStore()
  const sessionId = useSessionId(ctx)
  const [syncing, setSyncing] = useState(false)
  const [syncedAt, setSyncedAt] = useState(0)
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  const copyTimer = useRef<number | undefined>(undefined)

  const actions = taskStore.actions

  const activeTasks = state.tasks.filter((task) => !task.archived)
  const boundTask = state.boundTaskId ? state.tasks.find((task) => task.id === state.boundTaskId) ?? null : null

  const applyPayload = (text?: string): boolean => {
    const parsed = parseTaskPayloadText(text)
    if (!parsed) return false
    actions.setTasks({ tasks: parsed.tasks, boundTaskId: parsed.boundId, archivedCount: parsed.archived })
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
      await runLine('/tasks')
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

  // —— 绑定卡片步骤编辑（双击改文案 / 点状态图标循环），与模型 todo_write 走同一数据 ——
  const [editing, setEditing] = useState<{ taskId: string; index: number; value: string } | null>(null)
  const STATUS_CYCLE = ['pending', 'in_progress', 'completed'] as const
  const pushSteps = (taskId: string, steps: TaskStep[]): void => {
    void runLine(`/task todos ${JSON.stringify(steps.map((s) => ({ content: s.content, status: s.status })))}`)
  }
  const cycleStatus = (taskId: string, index: number) => {
    const task = state.tasks.find((tt) => tt.id === taskId)
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
    const task = state.tasks.find((tt) => tt.id === taskId)
    const trimmed = value.trim()
    if (!task) { setEditing(null); return }
    const same = (task.steps || [])[index]?.content === trimmed
    setEditing(null)
    if (same || !trimmed) return
    const next = (task.steps || []).map((s, i) => (i === index ? { ...s, content: trimmed } : s))
    pushSteps(taskId, next)
  }

  // 绑定卡片标题双击改名
  const [editingTitle, setEditingTitle] = useState<{ taskId: string; value: string } | null>(null)
  const commitTitle = (taskId: string, value: string) => {
    const task = state.tasks.find((tt) => tt.id === taskId)
    const trimmed = value.trim()
    if (!task) { setEditingTitle(null); return }
    const same = task.title === trimmed
    setEditingTitle(null)
    if (same || !trimmed) return
    void runLine(`/task rename ${taskId} ${JSON.stringify(trimmed)}`)
  }

  const expand = () => {
    actions.open()
    // 已有 30s 内的快照就不重复执行 /tasks（避免会话里堆命令节点）
    if (Date.now() - Math.max(state.lastUpdate, syncedAt) > 30_000) {
      void refresh()
    }
  }

  const THEMES = ['native', 'glass', 'brutal', 'mono'] as const
  const style = (THEMES as readonly string[]).includes(state.theme) ? state.theme : 'native'
  const styleLabel = t(`style.${style}` as keyof typeof zh)
  const cycleTheme = () => {
    const i = THEMES.indexOf(style as (typeof THEMES)[number])
    actions.setTheme(THEMES[(i + 1) % THEMES.length])
  }

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
      actions.setPanelPosition({ x, y })
    }
    const onUp = () => {
      drag.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const copyPath = (path: string) => {
    if (copiedPath === path) return
    void navigator.clipboard?.writeText(path).catch(() => undefined)
    setCopiedPath(path)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopiedPath(null), 1200)
  }

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  // 首次（store 从未同步过）自动拉一次快照（无论是否折叠，折叠条也要显示计数）
  useEffect(() => {
    if (!sessionId) return
    const snap = taskStore.getSnapshot()
    if (snap.lastUpdate === 0 && !snap.closed) {
      const timer = window.setTimeout(() => void refresh(), 300)
      return () => window.clearTimeout(timer)
    }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // 彻底隐藏（关闭）：不渲染任何东西；输入 /task、/tasks 会重新打开
  if (state.closed) {
    return null
  }

  // 折叠态：可拖拽的顶部迷你条（点击展开，点开即同步）
  if (state.minimized) {
    const label = boundTask
      ? `${t('minibar.current')}: ${boundTask.title}`
      : activeTasks.length > 0
        ? `${t('minibar.current')}: ${activeTasks.length} ${t('minibar.tasks')}`
        : t('minibar.no-task')
    return (
      <MiniBar
        label={label}
        hint={t('minibar.click-expand')}
        position={state.panelPosition}
        theme={style}
        onMove={(pos) => actions.setPanelPosition(pos)}
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
      style={{ left: state.panelPosition.x, top: state.panelPosition.y }}
      data-theme={style === 'native' ? undefined : style}
    >
      <div className={css.dragHandle} onMouseDown={handleDragStart} title={t('task.drag')}>
        <div className={css.handleGrip} />
      </div>
      <header className={css.header}>
        <div className={css.headerLeft}>
          <button
            type="button"
            className={css.headerIconBtn}
            onClick={cycleTheme}
            title={styleLabel}
            aria-label={styleLabel}
          >
            <IconFolderOpenOutline16 className={css.headerIcon} />
          </button>
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
            className={syncing ? css.spinning : undefined}
            onClick={() => void refresh()}
            disabled={syncing}
            aria-label={t('panel.refresh')}
            title={t('panel.refresh')}
          >
            <IconRefreshOutline16 />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => actions.minimize()}
            aria-label={t('panel.minimize')}
            title={t('panel.minimize')}
          >
            <IconChevronDownOutline14 />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => actions.close()}
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
            const done = steps.filter((s) => s.status === 'completed').length
            const expanded = state.expandedTaskIds.includes(task.id)
            const isBound = state.boundTaskId === task.id
            const pct = steps.length > 0 ? Math.round((done / steps.length) * 100) : 0
            return (
              <article key={task.id} className={`${css.card}${isBound ? ` ${css.cardBound}` : ''}`}>
                <button
                  className={css.cardHead}
                  onClick={() => { if (editingTitle?.taskId === task.id) return; actions.toggleTaskExpanded(task.id) }}
                  aria-expanded={expanded}
                >
                  <div className={css.cardTitleRow}>
                    {isBound && <span className={css.boundBadge}>{t('task.current')}</span>}
                    {isBound && editingTitle?.taskId === task.id ? (
                      <AutoEdit
                        value={editingTitle.value}
                        singleLine
                        onCommit={(v) => commitTitle(task.id, v)}
                        onCancel={() => setEditingTitle(null)}
                      />
                    ) : (
                      <span
                        className={`${css.cardTitle}${isBound ? ` ${css.cardTitleEditable}` : ''}`}
                        title={isBound ? t('task.title-edit') : undefined}
                        onDoubleClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          if (isBound) setEditingTitle({ taskId: task.id, value: task.title })
                        }}
                      >
                        {task.title}
                      </span>
                    )}
                  </div>
                  <div className={css.cardMeta}>
                    {steps.length > 0 && (
                      <span className={css.progressText}>
                        {done}/{steps.length}
                      </span>
                    )}
                    <span className={css.updated}>{timeAgo(task.updatedAt || task.lastActiveAt)}</span>
                    <span className={css.chevron}>
                      {expanded ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
                    </span>
                  </div>
                </button>
                {steps.length > 0 && (
                  <div className={css.track}>
                    <div className={css.trackFill} style={{ width: `${pct}%` }} />
                  </div>
                )}
                {expanded && (
                  <div className={css.cardBody}>
                    <div className={css.section}>
                      <div className={css.sectionLabel}>
                        {t('task.steps')}
                        {steps.length > 0 && <span className={css.sectionCount}>{steps.length}</span>}
                      </div>
                      {steps.length > 0 ? (
                        <ol className={css.stepsList}>
                          {steps.map((step, i) => {
                            const isEditing = isBound && editing?.taskId === task.id && editing.index === i
                            return (
                              <li key={i} className={css.stepRow}>
                                {isBound ? (
                                  <button
                                    type="button"
                                    className={css.stepToggle}
                                    disabled={syncing}
                                    onClick={() => cycleStatus(task.id, i)}
                                    title={`${t('step.completed')}/${t('step.in-progress')}/${t('step.pending')}（点击切换）`}
                                  >
                                    <StepIcon status={step.status} />
                                  </button>
                                ) : (
                                  <StepIcon status={step.status} />
                                )}
                                {isEditing ? (
                                  <AutoEdit
                                    value={editing!.value}
                                    onCommit={(v) => commitStepText(task.id, i, v)}
                                    onCancel={() => setEditing(null)}
                                  />
                                ) : (
                                  <span
                                    className={`${css.stepContent}${step.status === 'completed' ? ` ${css.stepContentDone}` : ''}${step.status === 'in_progress' ? ` ${css.stepContentRun}` : ''}${isBound ? ` ${css.stepEditable}` : ''}`}
                                    title={isBound ? t('step.edit-hint') : undefined}
                                    onDoubleClick={() => {
                                      if (isBound) setEditing({ taskId: task.id, index: i, value: String(step.content ?? '') })
                                    }}
                                  >
                                    {step.content}
                                  </span>
                                )}
                              </li>
                            )
                          })}
                        </ol>
                      ) : (
                        <div className={css.muted}>{t('panel.empty-desc')}</div>
                      )}
                    </div>

                    {(task.files?.length ?? 0) > 0 && (
                      <div className={css.section}>
                        <div className={css.sectionLabel}>
                          {t('task.files')}
                          <span className={css.sectionCount}>{task.files.length}</span>
                        </div>
                        <ul className={css.filesList}>
                          {task.files.slice(0, 12).map((file, i) => (
                            <li key={i}>
                              <button
                                className={css.fileRow}
                                onClick={() => copyPath(file.path)}
                                title={`${t(copiedPath === file.path ? 'file.copied' : 'file.copy')}: ${file.path}${file.line ? `:${file.line}` : ''}`}
                              >
                                <span className={css.fileDot} />
                                <span className={css.filePath}>{file.path}</span>
                                {file.line && <span className={css.fileLine}>:{file.line}</span>}
                              </button>
                            </li>
                          ))}
                          {(task.files?.length ?? 0) > 12 && (
                            <li className={css.muted}>… 共 {task.files.length} 个</li>
                          )}
                        </ul>
                      </div>
                    )}

                    <div className={css.cardFooter}>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isBound || syncing}
                        onClick={() => void handleAction('switch', task.id)}
                      >
                        {t('task.switch')}
                      </Button>
                      {isBound && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={syncing}
                          onClick={() => void runLine('/task unbind')}
                          title={t('task.unbind')}
                        >
                          {t('task.unbind')}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={syncing}
                        onClick={() => void handleAction('archive', task.id)}
                      >
                        {t('task.archive')}
                      </Button>
                    </div>
                  </div>
                )}
              </article>
            )
          })}
          {syncing && <div className={css.syncHint}>{t('panel.syncing')}</div>}
        </div>
      )}
    </div>
  )
}
