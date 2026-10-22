/**
 * Memory View — 记忆三作用域列表（Task 草稿 / Project / Global）
 * 数据通道与任务面板一致：remote.commands.execute 执行 /insight 命令，取 JSON 载荷。
 * 动作：confirm(草稿审核) / promote(向上提升) / demote(向下降级，需绑定任务) / archive / restore / delete
 *
 * 列表是**增量加载**的：首屏只取 PAGE_SIZE 条，滚到底前 600px 预取下一页追加。
 * 分页的决策逻辑在 ./paging.js（纯函数，可单测），本组件只把它接到渲染上。
 */
import { useEffect, useCallback, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { service } from './services.ts'
import { PAGE_SIZE, PREFETCH_MARGIN, SPINNER_DELAY_MS, appendUnique, createRequestGate, insightListLine, normalizeWindow, progressCounts, reloadWindowRequest } from './paging.js'
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
  total: number
  offset: number
  nextOffset: number | null
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
    // 分页字段走 paging.js 归一：老宿主没有 total/nextOffset 时按"一次给全"降级，
    // 新宿主则给出真实的下一页游标。
    const w = normalizeWindow(data, 0)
    return { scope: data.scope ?? 'project', count: w.total, total: w.total, offset: w.offset, nextOffset: w.nextOffset, items: w.items }
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
  showHints,
  t,
}: {
  ctx: any
  sessionId: string | null
  scope: InsightScope
  boundTaskId: string | null
  showHints: boolean
  t: any
}) {
  const [rows, setRows] = useState<InsightRow[]>([])
  const [total, setTotal] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  // 加载指示延迟显示：本地数据几十毫秒就回来，立刻显示只会"闪一下"（见 paging.js）。
  const [showSpinner, setShowSpinner] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ title: '', kind: 'lesson', body: '', steps: '', trigger: '' })
  const [savedTip, setSavedTip] = useState<string | null>(null)
  // 滚动容器（IntersectionObserver 的 root）：哨兵是否"可见"必须相对这个容器判定，
  // 用视口当 root 会让面板自身的 480px 上限失效。
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const runLine = useCallback(
    async (line: string): Promise<{ ok: boolean; text: string }> => {
      // 软探测（services.ts）：`remote.commands` 是独立注册的扁平服务，按整名读（见 services.ts）。
      const commands = service(ctx, 'remote.commands')
      if (!sessionId || !commands || typeof commands.execute !== 'function') {
        return { ok: false, text: 'data channel unavailable (missing client service)' }
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

  // 并发控制走 paging.js 的 createRequestGate()：过期响应丢弃、新请求照发。
  // （早期用"有在途请求就 return"的布尔守卫时，切 scope 的新请求会被直接丢掉，
  //  新列表于是一直空着——见 createRequestGate 的注释。）
  const gateRef = useRef<ReturnType<typeof createRequestGate> | null>(null)
  if (gateRef.current === null) gateRef.current = createRequestGate()
  // 作用域变了之后到达的过期响应必须丢弃，否则会把上一个 scope 的条目追加进来。
  const scopeRef = useRef(scope)
  useEffect(() => {
    scopeRef.current = scope
  }, [scope])

  /**
   * 取一页并落到状态里。
   * @param offset 起始下标。
   * @param limit 本页条数。
   * @param append true=追加到已渲染列表；false=替换成这一页（首屏或前缀重放）。
   */
  const load = useCallback(
    async (offset: number, limit: number, append: boolean): Promise<void> => {
      // 没有活跃会话时不发命令、也不报错：面板顶部已经显示「还没有会话」，
      // 再报一次"同步失败"会让人以为记忆库坏了（0.1.7 上会话快照结构变化时就是这个表象）。
      if (!sessionId) {
        setRows([])
        setTotal(0)
        setNextOffset(null)
        setError(null)
        setLoading(false)
        return
      }
      const requestedScope = scopeRef.current
      const key = `${requestedScope}|${offset}|${limit}|${append}`
      const ticket = gateRef.current!.begin(key)
      if (ticket === false) return
      if (!append) setLoading(true)
      setLoadingMore(append)
      setError(null)
      const spinner = window.setTimeout(() => setShowSpinner(true), SPINNER_DELAY_MS)
      try {
        const res = await runLine(insightListLine(requestedScope, offset, limit))
        // 已被更新的请求取代，或切了作用域：这份响应属于上一个列表，整份丢弃。
        if (gateRef.current!.isStale(ticket, requestedScope, scopeRef.current)) return
        if (!res.ok) {
          setError(res.text)
          return
        }
        const parsed = parseInsightPayloadText(res.text)
        if (!parsed) {
          setError('unparsable payload')
          return
        }
        setRows((prev) => (append ? appendUnique(prev, parsed.items) : parsed.items))
        setTotal(parsed.total)
        setNextOffset(parsed.nextOffset)
      } finally {
        window.clearTimeout(spinner)
        // 加载标志只由最后一次请求回落：过期请求提前清掉会让界面"看起来加载完了"。
        if (gateRef.current!.end(key, ticket)) {
          setShowSpinner(false)
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [runLine, sessionId],
  )

  // load 的身份随 runLine 变（ctx/sessionId 变化）；用 ref 持有它，让下面的 effect
  // 只依赖 scope/sessionId 这两个**原始值**——把函数身份拉进依赖会重跑 effect 并
  // 无限刷 /insight 命令（旧实现用 800ms 频控绕开，这里从根上避免）。
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  useEffect(() => {
    // 换 scope / 换会话 = 换了一个列表：清空并从头取第一页。
    setRows([])
    setTotal(0)
    setNextOffset(null)
    setError(null)
    if (!sessionId) return
    void loadRef.current(0, PAGE_SIZE, false)
  }, [scope, sessionId])

  // 滚到底之前就取下一页（rootMargin 600px）。哨兵消失（nextOffset=null）即停止。
  useEffect(() => {
    if (nextOffset === null || typeof IntersectionObserver === 'undefined') return
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadRef.current(nextOffset, PAGE_SIZE, true)
      },
      // root 用面板自己的滚动容器；取不到时退回视口（仍比"不加载"好）。
      { root: scrollRef.current ?? null, rootMargin: PREFETCH_MARGIN },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [nextOffset, rows.length])

  /**
   * 重载**已加载的整个前缀**（不是重置成第一页）：动作之后用户的位置不该跳回顶部。
   */
  const reloadWindow = useCallback(async (): Promise<void> => {
    const { offset, limit } = reloadWindowRequest(rows.length)
    await loadRef.current(offset, limit, false)
  }, [rows.length])

  const act = async (action: string, id: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const line = `/tasks insight ${action} ${scope} ${id}${action === 'demote' && scope === 'project' && boundTaskId ? ` ${boundTaskId}` : ''}`
      const res = await runLine(line)
      if (!res.ok) setError(res.text)
      else await reloadWindow()
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
        ? `/tasks insight edit ${scope} ${editingId} ${JSON.stringify(fields)}`
        : `/tasks insight save ${scope} ${JSON.stringify(fields)}`
      const res = await runLine(line)
      if (!res.ok) {
        setError(res.text)
      } else {
        setSavedTip(t('mem.saved'))
        closeForm()
        window.setTimeout(() => setSavedTip(null), 2500)
        await reloadWindow()
      }
    } finally {
      setBusy(false)
    }
  }

  const items = rows
  const progress = progressCounts(items.length, total)

  return (
    <div className={css.memoryPane} ref={scrollRef}>
      <div className={css.memToolbar}>
        <span className={css.memCount}>
          {scope === 'task' ? t('mem.scope.task') : scope === 'global' ? t('mem.scope.global') : t('mem.scope.project')}
          {total > 0 ? ` · ${total}` : ''}
        </span>
        <span className={css.memToolbarActs}>
          {savedTip && <span className={css.badge}>{savedTip}</span>}
          {scope !== 'task' && !showNew && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { setShowNew(true); setEditingId(null); setError(null) }}>{t('mem.new')}</Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void reloadWindow()} disabled={loading} title={showHints ? t('panel.refresh') : undefined} aria-label={t('panel.refresh')}>
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
      {error && (
        <div className={css.notice}>
          {t('mem.error')}: {error}
          {/* 失败必须给出口：增量加载里"卡住不动"和"已经加载完"外观一样，没有重试按钮
              用户只能靠开关面板碰运气。 */}
          <Button variant="outline" size="sm" disabled={loading || loadingMore} onClick={() => void reloadWindow()}>{t('mem.retry')}</Button>
        </div>
      )}
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
                {scope !== 'task' && <Button variant="outline" size="sm" disabled={busy} onClick={() => startEdit(row)}>{t('mem.edit')}</Button>}
                {scope === 'task' && !row.archived && (
                  <>
                    {row.draft && <Button variant="outline" size="sm" disabled={busy} onClick={() => void act('confirm', row.id)}>{t('mem.confirm')}</Button>}
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => void act('promote', row.id)}>{t('mem.promote')}</Button>
                  </>
                )}
                {scope === 'project' && (
                  <>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => void act('promote', row.id)}>{t('mem.promote')}</Button>
                    <Button variant="outline" size="sm" disabled={busy || !canDemoteToTask} title={showHints && !canDemoteToTask ? t('mem.needs-bound') : undefined} onClick={() => void act('demote', row.id)}>{t('mem.demote')}</Button>
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
        {/* 增量加载哨兵 + 页脚。预取由上面的 IntersectionObserver 驱动（滚到底前 600px），
            这里只负责：① 放哨兵；② 把"已显示 N / 总数"讲清楚，让无限滚动可预期；
            ③ 环境没有 IntersectionObserver 时退化成手动按钮，绝不静默停住。 */}
        {items.length > 0 && (
          <div className={css.memFooter}>
            {nextOffset !== null && <div ref={sentinelRef} className={css.memSentinel} aria-hidden="true" />}
            {nextOffset !== null && typeof IntersectionObserver === 'undefined' && (
              <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadRef.current(nextOffset, PAGE_SIZE, true)}>
                {t('mem.loadMore')}
              </Button>
            )}
            <span className={css.muted}>
              {progress.loaded < progress.total
                ? t('mem.progress', { loaded: progress.loaded, total: progress.total })
                : t('mem.allLoaded', { total: progress.total })}
              {showSpinner && loadingMore ? ` · ${t('mem.loadingMore')}` : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
