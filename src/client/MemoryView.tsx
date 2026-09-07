/**
 * Memory View — 记忆三作用域列表（Task 草稿 / Project / Global）
 * 数据通道与任务面板一致：remote.commands.execute 执行 /insight 命令，取 JSON 载荷。
 * 动作：confirm(草稿审核) / promote(向上提升) / demote(向下降级，需绑定任务) / archive / restore / delete
 */
import { useEffect, useCallback, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './TaskPanel.module.css'

export type InsightScope = 'task' | 'project' | 'global'

export interface InsightRow {
  id: string
  kind: string
  scope: InsightScope
  title: string
  body?: string
  fix?: string
  solution?: string
  reason?: string
  pattern?: string
  problem?: string
  choice?: string
  draft?: boolean
  archived?: boolean
  confidence?: number | null
  hitCount?: number
  members?: number
  files?: number
  symbols?: number
  trigger?: { keywords: string[]; scope: string[] } | null
  steps?: string[]
  taskId?: string
  taskTitle?: string
  updatedAt?: string
}

interface ListPayload {
  scope: InsightScope
  count: number
  items: InsightRow[]
}

export function parseInsightPayloadText(text?: string | null): ListPayload | null {
  if (!text) return null
  let jsonBlock: string | null = null
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (fenced) jsonBlock = fenced[1]
  else {
    const lastBrace = text.lastIndexOf('{')
    if (lastBrace !== -1) jsonBlock = text.slice(lastBrace)
  }
  if (!jsonBlock) return null
  try {
    const data = JSON.parse(jsonBlock)
    if (!Array.isArray(data.items)) return null
    return { scope: data.scope ?? 'project', count: data.count ?? data.items.length, items: data.items }
  } catch {
    return null
  }
}

function kindText(kind: string, t: any): string {
  const map: Record<string, string> = {
    lesson: t('mem.kind.lesson'),
    decision: t('mem.kind.decision'),
    procedure: t('mem.kind.procedure'),
    experience: t('mem.kind.experience'),
  }
  return map[kind] ?? kind
}

export function MemoryView({
  ctx,
  sessionId,
  scope,
  boundTaskId,
  t,
}: {
  ctx: any
  sessionId: string | null
  scope: InsightScope
  boundTaskId: string | null
  t: any
}) {
  const [payload, setPayload] = useState<ListPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ title: '', kind: 'lesson', body: '', steps: '', trigger: '' })
  const [savedTip, setSavedTip] = useState<string | null>(null)

  const runLine = useCallback(
    async (line: string): Promise<{ ok: boolean; text: string }> => {
      const commands = ctx?.remote?.commands
      if (!sessionId || !commands || typeof commands.execute !== 'function') {
        return { ok: false, text: 'no session / commands service' }
      }
      try {
        const response = await commands.execute(sessionId, line, [])
        const envelope = response as { ok?: boolean; value?: any } | null | undefined
        const execution = envelope && typeof envelope === 'object' && 'value' in envelope ? envelope.value : envelope
        const result = execution?.result ?? execution
        if (result?.kind === 'error') return { ok: false, text: result.text ?? 'command error' }
        return { ok: true, text: result?.text ?? '' }
      } catch (err) {
        return { ok: false, text: String((err as Error)?.message ?? err) }
      }
    },
    [ctx, sessionId],
  )

  // 用 ref 做并发/频控守卫：loading 状态不能进 refresh 的依赖数组，
  // 否则 loading 每次翻转都会重建 refresh → effect 重跑 → 无限循环刷 /insight 命令。
  const inflightRef = useRef(false)
  const lastRunRef = useRef(0)

  const refresh = useCallback(async (force = false): Promise<void> => {
    if (inflightRef.current) return
    const now = Date.now()
    if (!force && now - lastRunRef.current < 800) return
    inflightRef.current = true
    lastRunRef.current = now
    setLoading(true)
    setError(null)
    try {
      const res = await runLine(`/insight list ${scope}`)
      if (!res.ok) {
        setError(res.text)
        setPayload(null)
        return
      }
      const parsed = parseInsightPayloadText(res.text)
      setPayload(parsed)
      if (!parsed) setError('unparsable payload')
    } finally {
      inflightRef.current = false
      setLoading(false)
    }
  }, [runLine, scope])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const act = async (action: string, id: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const line = `/insight ${action} ${scope} ${id}${action === 'demote' && scope === 'project' && boundTaskId ? ` ${boundTaskId}` : ''}`
      const res = await runLine(line)
      if (!res.ok) setError(res.text)
      else void refresh(true)
    } finally {
      setBusy(false)
    }
  }

  const rowToForm = (row: InsightRow) => {
    // 正文按 kind 取专属字段（fix/solution/reason），避免把与标题相同的 pattern/problem 当正文
    const main =
      row.kind === 'lesson' ? row.fix
        : row.kind === 'experience' ? row.solution
          : row.kind === 'decision' ? row.reason
            : row.body
    const body = main && main !== row.title ? main : ''
    return {
      title: row.title || '',
      kind: row.kind || 'lesson',
      body,
      steps: Array.isArray((row as InsightRow & { steps?: string[] }).steps) ? ((row as InsightRow & { steps?: string[] }).steps as string[]).join('\n') : '',
      trigger: (row.trigger?.keywords || []).join(','),
    }
  }

  const startEdit = (row: InsightRow) => {
    setEditingId(row.id)
    setForm(rowToForm(row))
    setShowNew(true)
    setError(null)
  }

  const closeForm = () => {
    setShowNew(false)
    setEditingId(null)
    setForm({ title: '', kind: 'lesson', body: '', steps: '', trigger: '' })
  }

  // 切换类型时把当前输入迁移到目标类型的主内容区，避免换类型后“刚写的东西消失”
  const changeKind = (next: string) => {
    setForm(prev => {
      if (prev.kind === next) return prev
      const fromProc = prev.kind === 'procedure'
      const toProc = next === 'procedure'
      let body = prev.body
      let steps = prev.steps
      if (fromProc && !toProc && !body && steps.trim()) body = steps.trim() // procedure → 正文
      if (toProc && !fromProc && !steps.trim() && body.trim()) steps = body.trim() // 正文 → 步骤
      return { ...prev, kind: next, body, steps }
    })
  }

  const submitNew = async (): Promise<void> => {
    if (scope === 'task' && !editingId) return
    if (busy) return
    const title = form.title.trim()
    if (!title) return
    setBusy(true)
    setError(null)
    try {
      const fields: Record<string, unknown> = { title, kind: form.kind }
      if (form.kind === 'lesson') fields.pattern = title
      if (form.kind === 'decision') fields.choice = title
      if (form.kind === 'experience') fields.problem = title
      if (form.body.trim()) {
        if (form.kind === 'lesson') fields.fix = form.body.trim()
        else if (form.kind === 'decision') fields.reason = form.body.trim()
        else if (form.kind === 'experience') fields.solution = form.body.trim()
        else fields.body = form.body.trim()
      }
      if (form.kind === 'procedure' && form.steps.trim()) {
        fields.steps = form.steps.split('\n').map((s) => s.trim()).filter(Boolean)
      }
      if (form.kind === 'procedure' && form.trigger.trim()) {
        fields.trigger = { keywords: form.trigger.split(/[,，]/).map((s) => s.trim()).filter(Boolean) }
      }
      const line = editingId
        ? `/insight edit ${scope} ${editingId} ${JSON.stringify(fields)}`
        : `/insight save ${scope} ${JSON.stringify(fields)}`
      const res = await runLine(line)
      if (!res.ok) {
        setError(res.text)
      } else {
        setSavedTip(t('mem.saved'))
        closeForm()
        window.setTimeout(() => setSavedTip(null), 2500)
        void refresh(true)
      }
    } finally {
      setBusy(false)
    }
  }

  const items = payload?.items ?? []

  return (
    <div className={css.memoryPane}>
      <div className={css.memToolbar}>
        <span className={css.memCount}>
          {scope === 'task' ? t('mem.scope.task') : scope === 'global' ? t('mem.scope.global') : t('mem.scope.project')}
          {payload ? ` · ${payload.count}` : ''}
        </span>
        <span className={css.memToolbarActs}>
          {savedTip && <span className={css.badge}>{savedTip}</span>}
          {scope !== 'task' && !showNew && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { setShowNew(true); setEditingId(null); setError(null) }}>{t('mem.new')}</Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void refresh(true)} disabled={loading} title={t('panel.refresh')} aria-label={t('panel.refresh')}>
            ↻
          </Button>
        </span>
      </div>
      {showNew && scope !== 'task' && (
        <div className={css.memNew}>
          <input className={css.stepInput} placeholder={t('mem.f.title')} value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus />
          <div className={css.memNewRow}>
            <label className={css.memLabel}>{t('mem.f.kind')}
              <select className={css.stepInput} value={form.kind} onChange={(e) => changeKind(e.target.value)}>
                <option value="lesson">lesson</option>
                <option value="decision">decision</option>
                <option value="procedure">procedure</option>
                <option value="experience">experience</option>
              </select>
            </label>
          </div>
          {form.kind !== 'procedure' && (
            <textarea className={css.stepInput} placeholder={t('mem.f.body')} rows={2} value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })} />
          )}
          {form.kind === 'procedure' && (
            <>
              <textarea className={css.stepInput} placeholder={t('mem.f.steps')} rows={3} value={form.steps}
                onChange={(e) => setForm({ ...form, steps: e.target.value })} />
              <input className={css.stepInput} placeholder={t('mem.f.trigger')} value={form.trigger}
                onChange={(e) => setForm({ ...form, trigger: e.target.value })} />
            </>
          )}
          <div className={css.memActs}>
            <Button variant="outline" size="sm" disabled={busy || !form.title.trim()} onClick={() => void submitNew()}>{t('mem.save')}</Button>
            <Button variant="outline" size="sm" onClick={closeForm}>{t('mem.cancel')}</Button>
          </div>
        </div>
      )}
      {error && <div className={css.notice}>{t('mem.error')}: {error}</div>}
      {loading && !items.length && <div className={css.muted}>{t('mem.loading')}</div>}
      {!loading && !error && items.length === 0 && <div className={css.muted}>{t('mem.empty')}</div>}
      <div className={css.memList}>
        {items.map((row) => {
          const canDemoteToTask = scope === 'project' && !!boundTaskId
          return (
            <div key={row.id} className={`${css.memRow}${row.archived ? ` ${css.memRowArchived}` : ''}`}>
              <div className={css.memRowMain}>
                <span className={css.memTitle}>
                  <span className={css.kindBadge}>{kindText(row.kind, t)}</span>
                  {row.title || row.body}
                </span>
                <span className={css.memMeta}>
                  {row.draft && <span className={`${css.badge} ${css.badgeDraft}`}>{t('mem.draft')}</span>}
                  {row.archived && <span className={`${css.badge} ${css.badgeArchived}`}>{t('mem.archived')}</span>}
                  {row.taskTitle && <span className={css.badge}>@{row.taskTitle}</span>}
                  {row.members !== undefined && row.members > 0 && <span className={css.badge}>×{row.members}</span>}
                  {row.confidence != null && <span className={css.badge}>{Math.round(row.confidence * 100)}%</span>}
                  {row.trigger && row.trigger.keywords.length > 0 && <span className={css.badge}>⚡{row.trigger.keywords.slice(0, 2).join(',')}</span>}
                </span>
              </div>
              {row.body && row.body !== row.title && <div className={css.memBody}>{String(row.body).slice(0, 160)}</div>}
              <div className={css.memActs}>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => startEdit(row)}>{t('mem.edit')}</Button>
                {scope === 'task' && !row.archived && (
                  <>
                    {row.draft && <Button variant="outline" size="sm" disabled={busy} onClick={() => void act('confirm', row.id)}>{t('mem.confirm')}</Button>}
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => void act('promote', row.id)}>{t('mem.promote')}</Button>
                  </>
                )}
                {scope === 'project' && (
                  <>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => void act('promote', row.id)}>{t('mem.promote')}</Button>
                    <Button variant="outline" size="sm" disabled={busy || !canDemoteToTask} title={!canDemoteToTask ? t('mem.needs-bound') : undefined} onClick={() => void act('demote', row.id)}>{t('mem.demote')}</Button>
                  </>
                )}
                {scope === 'global' && (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => void act('demote', row.id)}>{t('mem.demote')}</Button>
                )}
                {row.archived
                  ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void act('restore', row.id)}>{t('mem.restore')}</Button>
                  : <Button variant="outline" size="sm" disabled={busy} onClick={() => void act('archive', row.id)}>{t('mem.archive')}</Button>}
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void act('delete', row.id)}>{t('mem.delete')}</Button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
