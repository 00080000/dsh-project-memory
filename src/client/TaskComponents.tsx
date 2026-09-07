/**
 * Task Panel Presentational 组件 — MiniBar（折叠迷你条）与 TaskCard（任务卡）。
 * 纯渲染 + 卡片局部行内编辑/拖拽状态，动作经 props 回调交给容器（TaskPanel.tsx）。
 */
import { useRef, useState } from 'react'
import {
  Button,
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconCheckOutline16,
  IconPlayOutline16,
  IconFolderOpenOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { createTranslate } from './locales.ts'
import { useTaskDrag } from './task-hooks.ts'
import { type Task, type TaskInsight, type TaskStep } from './task-data-store.ts'
import css from './TaskPanel.module.css'

function insightKindLabel(kind: string, t: ReturnType<typeof createTranslate>): string {
  const map: Record<string, string> = {
    lesson: t('mem.kind.lesson'),
    decision: t('mem.kind.decision'),
    procedure: t('mem.kind.procedure'),
    experience: t('mem.kind.experience'),
  }
  return map[kind] ?? kind
}

type InsightAction = 'confirm' | 'promote' | 'delete'

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

interface MiniBarProps {
  label: string
  hint: string
  position: { x: number; y: number }
  theme: string
  onMove: (pos: { x: number; y: number }) => void
  open: () => void
}

export function MiniBar({ label, hint, position, theme, onMove, open }: MiniBarProps) {
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

interface TaskCardProps {
  task: Task
  isBound: boolean
  expanded: boolean
  onToggleExpand: () => void
  onSwitch: () => void
  onUnbind: () => void
  onArchive: () => void
  onRename: (value: string) => void
  onEditStep: (index: number, value: string) => void
  onCycleStatus: (index: number) => void
  onReorderSteps: (fromIndex: number, toIndex: number) => void
  onInsightAction?: (action: InsightAction, id: string) => void
  showHints: boolean
  syncing: boolean
  t: ReturnType<typeof createTranslate>
}

export function TaskCard({
  task,
  isBound,
  expanded,
  onToggleExpand,
  onSwitch,
  onUnbind,
  onArchive,
  onRename,
  onEditStep,
  onCycleStatus,
  onReorderSteps,
  onInsightAction,
  showHints,
  syncing,
  t,
}: TaskCardProps) {
  const steps = task.steps || []
  const { dragState, dropTargetIndex, startDrag, cancelDrag } = useTaskDrag(task.id, steps, isBound, onReorderSteps)

  // 行内编辑状态（本卡片局部）：双击进入，Enter/失焦提交，Esc 取消。
  const [stepEdit, setStepEdit] = useState<{ index: number; value: string } | null>(null)
  const [titleEdit, setTitleEdit] = useState<{ value: string } | null>(null)

  const done = steps.filter((s) => s.status === 'completed').length
  const pct = steps.length > 0 ? Math.round((done / steps.length) * 100) : 0

  const commitStepEdit = (index: number) => {
    if (!stepEdit || stepEdit.index !== index) return
    const value = stepEdit.value
    setStepEdit(null)
    onEditStep(index, value)
  }

  const commitTitleEdit = () => {
    if (titleEdit === null) return
    const value = titleEdit.value
    setTitleEdit(null)
    onRename(value)
  }

  return (
    <article data-task-id={task.id} className={`${css.card}${isBound ? ` ${css.cardBound}` : ''}`}>
      <button
        className={css.cardHead}
        onClick={() => { if (titleEdit !== null) return; onToggleExpand() }}
        aria-expanded={expanded}
      >
        <div className={css.cardTitleRow}>
          {isBound && <span className={css.boundBadge}>{t('task.current')}</span>}
          {isBound && titleEdit !== null ? (
            <input
              className={css.stepInput}
              value={titleEdit.value}
              autoFocus
              onChange={(e) => setTitleEdit({ value: e.target.value })}
              onBlur={commitTitleEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitleEdit()
                else if (e.key === 'Escape') setTitleEdit(null)
              }}
            />
          ) : (
            <span
              className={`${css.cardTitle}${isBound ? ` ${css.cardTitleEditable}` : ''}`}
              title={isBound ? t('task.title-edit') : undefined}
              onDoubleClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (isBound) setTitleEdit({ value: String(task.title ?? '') })
              }}
            >
              {task.title}
            </span>
          )}
        </div>
        <div className={css.cardMeta}>
          {steps.length > 0 && <span className={css.progressText}>{done}/{steps.length}</span>}
          <span className={css.updated}>{timeAgo(task.updatedAt || task.lastActiveAt)}</span>
          <span className={css.chevron}>{expanded ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}</span>
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
              <>
                <ol className={css.stepsList}>
                  {steps.map((step, i) => {
                    const stepIsEditing = stepEdit !== null && stepEdit.index === i
                    const stepIsDragging = dragState?.dragging && dragState.fromIndex === i
                    const isDropTarget = dropTargetIndex === i
                    const isDropTargetAfter = dropTargetIndex === i + 1
                    return (
                      <li
                        key={i}
                        data-step-row
                        className={`${css.stepRow}${stepIsDragging ? ` ${css.stepDragging}` : ''}${isDropTarget ? ` ${css.dropTargetBefore}` : ''}${isDropTargetAfter ? ` ${css.dropTargetAfter}` : ''}`}
                        onMouseDown={(e) => {
                          if (e.button !== 0) return
                          if (!isBound || syncing) return
                          // 交互控件（状态图标、编辑输入框等）上不进入拖拽
                          const el = e.target as HTMLElement
                          if (el.closest('button, input, textarea, a')) return
                          startDrag(i, step.content, e)
                        }}
                      >
                        {isBound ? (
                          <button
                            type="button"
                            className={css.stepToggle}
                            disabled={syncing}
                            onClick={(e) => { e.stopPropagation(); onCycleStatus(i) }}
                            title={`${t('step.completed')}/${t('step.in-progress')}/${t('step.pending')}`}
                          >
                            <StepIcon status={step.status} />
                          </button>
                        ) : (
                          <StepIcon status={step.status} />
                        )}
                        {stepIsEditing ? (
                          <input
                            className={css.stepInput}
                            value={stepEdit!.value}
                            autoFocus
                            onChange={(e) => setStepEdit({ index: i, value: e.target.value })}
                            onBlur={() => commitStepEdit(i)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitStepEdit(i)
                              else if (e.key === 'Escape') setStepEdit(null)
                            }}
                          />
                        ) : (
                          <span
                            className={`${css.stepContent}${step.status === 'completed' ? ` ${css.stepContentDone}` : ''}${step.status === 'in_progress' ? ` ${css.stepContentRun}` : ''}${isBound ? ` ${css.stepEditable}` : ''}`}
                            title={isBound && showHints ? t('step.edit-hint') : undefined}
                            onDoubleClick={(e) => {
                              e.stopPropagation()
                              if (isBound) setStepEdit({ index: i, value: String(step.content ?? '') })
                            }}
                          >
                            {step.content}
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ol>
                {dragState && dragState.dragging && (
                  <div
                    className={css.dragGhost}
                    style={{
                      left: dragState.clientX + 12,
                      top: dragState.clientY - 20,
                    }}
                  >
                    <div className={css.dragGhostCard}>
                      <span className={css.dragGhostContent}>{dragState.stepContent}</span>
                      <button
                        type="button"
                        className={css.dragGhostClose}
                        style={{ pointerEvents: 'auto' }}
                        onClick={(e) => { e.stopPropagation(); cancelDrag() }}
                        title={showHints ? t('drag.cancel') : undefined}
                        aria-label={t('drag.cancel')}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                )}
              </>
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
                      onClick={() => navigator.clipboard?.writeText(file.path)}
                      title={`${t('file.copy')}: ${file.path}${file.line ? `:${file.line}` : ''}`}
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

          {onInsightAction && Array.isArray(task.insights) && task.insights.length > 0 && (
            <div className={css.section}>
              <div className={css.sectionLabel}>
                {t('mem.section-label')}
                <span className={css.sectionCount}>{task.insights.length}</span>
              </div>
              <ul className={css.memList}>
                {(task.insights as TaskInsight[]).map((ins) => (
                  <li key={ins.id} className={css.memRow}>
                    <div className={css.memTitle}>
                      <span className={css.kindBadge}>{insightKindLabel(ins.kind, t)}</span>
                      <span>{ins.title || ins.id}</span>
                      {ins.draft && <span className={`${css.badge} ${css.badgeDraft}`}>{t('mem.draft')}</span>}
                    </div>
                    <div className={css.memActs}>
                      {ins.draft && (
                        <Button variant="outline" size="sm" disabled={syncing} onClick={() => onInsightAction('confirm', ins.id)}>
                          {t('mem.confirm')}
                        </Button>
                      )}
                      <Button variant="outline" size="sm" disabled={syncing} onClick={() => onInsightAction('promote', ins.id)}>
                        {t('mem.promote')}
                      </Button>
                      <Button variant="outline" size="sm" disabled={syncing} onClick={() => onInsightAction('delete', ins.id)}>
                        {t('mem.delete')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className={css.cardFooter}>
            <Button variant="outline" size="sm" disabled={isBound || syncing} onClick={onSwitch}>
              {t('task.switch')}
            </Button>
            {isBound && (
              <Button variant="outline" size="sm" disabled={syncing} onClick={onUnbind} title={t('task.unbind')}>
                {t('task.unbind')}
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={syncing} onClick={onArchive}>
              {t('task.archive')}
            </Button>
          </div>
        </div>
      )}
    </article>
  )
}
