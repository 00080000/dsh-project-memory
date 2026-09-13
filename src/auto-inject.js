// PR 2 静默注入引擎（entry 常驻块 + relevance 门控）
// 安全约定：
//  - 纯函数 buildInjection 可单测；
//  - 唯一接线点是宿主 agent/pre-step 瀑布事件；任何异常/无会话 cwd → 交回合法决策，
//    绝不让宿主请求受影响（宿主直接读 decision.kind，返回 undefined 会崩掉整步）。
//  - “静默注入”文本带 [Memory Inject] 前缀，作为一条 plugin source 的 user 消息追加；
//    按会话指纹去重，内容未变不重复追加。
import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ProjectMemoryStore } from './store.js'
import { memoryRootFor } from './util/fs.js'
import { insightMatchText } from './similarity.js'
import { normalizedTokenOverlap } from './similarity.js'
import { cfgInsight, GlobalStore, defaultGlobalFile } from './insight-store.js'
import { projectTags } from './project-profile.js'
import { rankEntriesMergedScored } from './util/search.js'
import { insightToEntry } from './recall.js'
import { buildReadinessContext, matchTrigger, relativeHits } from './readiness.js'

export const INJECT_MARK = '[Memory Inject]'

/** 注入引擎配置：insight 默认之上叠加 autoContext 预算/门控参数。 */
export function cfgEngine(config) {
  const c = (config && config.autoContext) || {}
  const base = cfgInsight(config)
  return {
    ...base,
    maxTokens: typeof c.maxTokens === 'number' ? c.maxTokens : 400,
    entryMaxInsights: typeof c.entryMaxInsights === 'number' ? c.entryMaxInsights : 6,
    // 提示通道的相对阈值（层内最高分的比例）：尺度无关，取代旧的"绝对 overlap"常量。
    // 旧判据 normalizedTokenOverlap = |交集| / max(|A|,|B|) 对长消息必然趋零（实测 0.014–0.057）。
    signalMinRatio: typeof c.signalMinRatio === 'number' ? c.signalMinRatio : 0.5,
    // 兼容闸门：显式配置 relevanceMin 时仍走旧的绝对 overlap 判据；不配置则为 null（走相对阈值）。
    relevanceMin: typeof c.relevanceMin === 'number' ? c.relevanceMin : null,
    // resident 任务卡最多显示几个"编辑中"文件（纯写权重，最近写优先）
    editedMax: typeof c.editedMax === 'number' ? c.editedMax : 3,
    // 模型自己写/维护任务清单后、尚无新人类消息时，不把任务卡再回声给模型（省 token）
    skipEchoSelfTodo: c.skipEchoSelfTodo !== false,
  }
}

function textOf(message) {
  const blocks = (message && message.content) || []
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user') {
      const t = textOf(m)
      if (t.trim()) return t.trim()
    }
  }
  return ''
}

function fingerprint(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

function linesOf(list) {
  const out = []
  for (const it of list || []) {
    if (!it || it.archived || it.draft) continue
    const body = it.fix || it.solution || it.choice || (Array.isArray(it.steps) ? `步骤 ${it.steps.length} 条` : '')
    out.push(`- [${it.id}] ${it.kind}: ${it.title}${body ? ` — ${String(body).slice(0, 120)}` : ''}`)
  }
  return out
}

/** 任务卡上"编辑中"文件（写过、最近写优先，最多 max 个）。 */
export function editedFiles(task, max) {
  if (!task || !task.fileMeta) return []
  const meta = task.fileMeta
  // task.files 已由 taskbridge 保持热序（写过在前、按 lastWriteAt 倒序）
  return (task.files || []).filter((f) => meta[f] && meta[f].lastWriteAt).slice(0, max)
}

/**
 * 是否回声 resident 任务卡：最近一次推进是模型自己 todo 写步骤、且之后没有新人类消息时，
 * 不回声（模型刚写的东西再喂回去 = 噪音/浪费 token）。保留相关 insights 注入不变。
 */
export function shouldEchoTaskCard(task, cfg) {
  if (!task) return false
  const c = cfg || {}
  if (c.skipEchoSelfTodo === false) return true
  const lt = task.lastTodoAt
  const lh = task.lastHumanAt
  if (lt && lh) return !(lt > lh)
  return true
}

/** 任务卡 + 非草稿任务级 insights 摘要（常驻块主体）。
 * withEdited=false 用于去重指纹：排除随写文件高频变化的“编辑中”行。 */
export function buildEntryContent(task, cfg, { withEdited = true } = {}) {
  if (!task) return ''
  const c = cfg || {}
  const steps = (task.steps || []).map((s) => (typeof s === 'string' ? s : s.content || s.text || '').slice(0, 80))
  const card = [`任务: ${task.title || '(untitled)'}`, `进度: ${steps.filter((s) => true).length ? `${steps.length} 步` : ''}`, ...steps.slice(0, 12).map((s, i) => `  ${i + 1}. ${s}`)]
  const insights = linesOf(task.insights)
  const edited = editedFiles(task, c.editedMax || 3)
  const parts = [...card]
  if (withEdited && edited.length) parts.push(`  编辑中: ${edited.join(', ')}`)
  if (insights.length) parts.push(`任务记忆:`, ...insights.slice(0, c.entryMaxInsights || 6))
  return parts.join('\n')
}

/** 候选池：project + global + 绑定任务（同一 id 只取一次；归档/草稿不进注入）。 */
function insightCandidates(store, globalStore, task) {
  const out = []
  const seen = new Set()
  const push = (it) => {
    if (!it || it.archived || it.draft) return
    const key = it.id || `${it.kind}:${it.title}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(it)
  }
  for (const it of (store ? store.insightItems() : []) || []) push(it)
  for (const it of (globalStore ? globalStore.items() : []) || []) push(it)
  for (const it of (task && task.insights) || []) push(it)
  return out
}

/** 一条 insight 的注入正文：procedure 给全步骤，其余给标题 + 结论。 */
function insightBody(it) {
  return it.kind === 'procedure' && Array.isArray(it.steps)
    ? `【${it.title}】\n${it.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    : `- [${it.id}] ${it.title}${it.fix || it.solution || it.choice ? ` — ${it.fix || it.solution || it.choice}` : ''}`
}

/** 把正文塞进剩余预算：放不下就截断，绝不超过预算。 */
function fitBody(body, remaining) {
  if (remaining <= 24) return null
  if (body.length <= remaining) return body
  return `${body.slice(0, remaining - 1)}…`
}

/**
 * 构建注入内容（不写盘、无副作用）。
 *
 * 交付契约：**authored trigger（所有 kind）= 确定性全文注入，优先级 1；统计信号 = 截断提示，
 * 优先级 2**。预算排程为：常驻任务卡 → trigger 命中 → 提示。每一步都记 `reasons`（为什么注入）
 * 与 `dropped`（为什么没注入），让"注入/未注入"可审计——而不是只有静默的门槛。
 * @param {object} opts { query, readiness, task, store, globalStore, projectTagsList, cfg }
 * @returns {{ text: string, labels: string[], reasons: object[], dropped: object[] }}
 */
export function buildInjection(opts) {
  const { query, task, globalStore, cfg } = opts
  const store = opts.store || null
  const tags = opts.projectTagsList || []
  const ctx = buildReadinessContext(opts.readiness || { humanText: query || '' })
  const labels = []
  const reasons = []
  const dropped = []
  const parts = []
  const budgetChars = (cfg.maxTokens || 400) * 3

  const cands = insightCandidates(store, globalStore, task)

  // 通道 1：authored trigger —— 确定性、全文、优先级 1。procedure 先于其它 kind（步骤更完整）。
  const triggered = []
  for (const it of cands) {
    const why = matchTrigger(it.trigger, ctx)
    if (!why) continue
    const scope = it.trigger?.scope
    if (Array.isArray(scope) && scope.length && tags.length && !scope.some((s) => tags.includes(s))) continue
    triggered.push({ it, why })
  }
  triggered.sort(
    (a, b) => (a.it.kind === 'procedure' ? 0 : 1) - (b.it.kind === 'procedure' ? 0 : 1)
      || String(a.it.id).localeCompare(String(b.it.id)),
  )

  // 通道 2：统计信号 —— 提示态、优先级 2，判据是层内相对阈值（尺度无关）。
  // procedure 只走 trigger 通道：否则会被统计通道绕过 trigger.scope 的画像过滤。
  const consumed = new Set(triggered.map((t) => t.it.id))
  const hintCands = cands.filter((it) => !consumed.has(it.id) && it.kind !== 'procedure')
  const hints = []
  if (hintCands.length) {
    if (typeof cfg.relevanceMin === 'number') {
      // 兼容：显式 relevanceMin → 旧的绝对 overlap 判据（老 profile 行为不变）
      for (const it of hintCands) {
        const score = normalizedTokenOverlap(ctx.humanText || query || '', insightMatchText(it))
        if (score >= cfg.relevanceMin) hints.push({ it, score, why: `overlap:${score.toFixed(3)}` })
      }
      hints.sort((a, b) => b.score - a.score)
    } else {
      const byId = new Map(hintCands.map((it) => [it.id, it]))
      const scored = rankEntriesMergedScored(
        hintCands.map(insightToEntry),
        [ctx.humanText, ctx.actionText].filter(Boolean),
        hintCands.length,
      )
      for (const r of relativeHits(scored, { ratioMin: cfg.signalMinRatio })) {
        const it = byId.get(r.entry.insightId)
        if (it) hints.push({ it, score: r.score, why: `relative:${(r.score / (scored[0].score || 1)).toFixed(2)}` })
      }
    }
  }

  // 常驻块文本。去重指纹只看稳定内容（任务标题/步骤/insights + 相关 insights）：
  // “编辑中”随每次写文件变化，若参与指纹会导致每写一个文件就重发整块（噪音 + token 浪费）。
  const echo = shouldEchoTaskCard(task, cfg)
  const entry = echo ? buildEntryContent(task, cfg) : ''
  const entryStable = echo ? buildEntryContent(task, cfg, { withEdited: false }) : ''
  let used = entry.length

  for (const { it, why } of triggered) {
    const body = fitBody(insightBody(it), budgetChars - used)
    if (body === null) {
      dropped.push({ id: it.id, channel: 'trigger', reason: 'budget' })
      continue
    }
    used += body.length + 1
    parts.push(body)
    labels.push(it.kind === 'procedure' ? 'procedure' : it.kind)
    reasons.push({ id: it.id, channel: 'trigger', why })
  }
  for (const { it, why } of hints) {
    const body = fitBody(insightBody(it), budgetChars - used)
    if (body === null) {
      dropped.push({ id: it.id, channel: 'hint', reason: 'budget' })
      continue
    }
    used += body.length + 1
    parts.push(body)
    labels.push('hint')
    reasons.push({ id: it.id, channel: 'hint', why })
  }

  const total = [entry, ...parts].filter(Boolean)
  if (!total.length) return { text: '', labels, reasons, dropped }
  const clamp = (t) => (t.length > budgetChars ? `${t.slice(0, budgetChars)}\n…(截断)` : t)
  const dedupeText = clamp([entryStable, ...parts].filter(Boolean).join('\n'))
  return { text: clamp(total.join('\n')), labels, reasons, dropped, dedupeText }
}

/** 注册 agent/pre-step 监听，向每步请求的 enter 决策追加记忆消息（默认开）。
 * 宿主瀑布事件签名为 (payload, next)：payload.agent.session 提供会话（header.cwd=项目根）。
 * 任何异常/无会话 cwd → 原样返回默认决策，零副作用，绝不让宿主请求受影响。
 */
export function installAutoInject(ctx, config) {
  const auto = (config && config.autoContext) || {}
  if (auto.enabled === false) return
  const cfg = cfgEngine(config)
  // 每个会话一份“上次注入指纹”。用单个变量会让并发会话互相抑制注入。
  const lastFpBySession = new Map()
  const LAST_FP_MAX = 200
  // 每个会话一份"上次预算丢弃指纹"：预算把条目挤出去时必须留痕一次，而不是静默（degraded 可见性）。
  const lastDroppedBySession = new Map()
  // 反应窗口：本会话最近观察到的 tool/call（参数里有 git commit / npm publish / 改动的路径）。
  // 宿主没有"工具执行前拦截"钩子，所以这是 pre-step 之外唯一能拿到的动作事实。
  const observedBySession = new Map()
  const OBSERVED_MAX = 8
  const OBSERVED_SESSIONS = 200
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'tool/call') return
      const sid = session && session.id
      if (!sid) return
      const data = event.data || {}
      const rec = observedBySession.get(sid) || []
      rec.push({ name: String(data.name || ''), arguments: String(data.arguments || '') })
      while (rec.length > OBSERVED_MAX) rec.shift()
      observedBySession.set(sid, rec)
      while (observedBySession.size > OBSERVED_SESSIONS) {
        observedBySession.delete(observedBySession.keys().next().value)
      }
    } catch {
      // 观察失败绝不影响宿主请求
    }
  })
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => observedBySession.clear())
  }
  ctx.on('agent/pre-step', async (payload, next) => {
    // 宿主契约是 waterfall(payload, next)，next 一定存在；但一旦宿主版本漂移、或事件被当
    // 普通事件调用，next 缺失会让本监听器 reject（历史事故正是 `next is not a function`）。
    // 更致命的是返回 undefined：宿主 agent.ts 直接读 `decision.kind`，会崩掉整步 → 无法回复。
    // 因此两种情况都退化为一个合法的 enter 决策，绝不让宿主请求受影响。
    const fallback = () => ({ kind: 'enter', messages: (payload && payload.messages) || [] })
    const decision = typeof next === 'function' ? await next() : fallback()
    if (!decision) return fallback()
    if (decision.kind !== 'enter') return decision
    try {
      const agent = payload && payload.agent
      const session = agent && agent.session
      const root = session && session.header && session.header.cwd
      const sessionId = session && session.id
      if (!root || !sessionId) return decision
      const query = lastUserText(decision.messages)
      const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
      const globalStore = new GlobalStore(cfgInsight(config).globalFile || defaultGlobalFile()).load()
      const boundTaskId = store.getBoundTaskId(sessionId) ? store.getBoundTaskId(sessionId) : null
      const task = boundTaskId ? store.getTask(boundTaskId) : null
      // 两个窗口合并进同一个就绪上下文：人类消息（先发）+ 已观察动作（反应）。
      const observed = observedBySession.get(sessionId) || []
      const readiness = buildReadinessContext({
        humanText: query || '',
        actionText: observed.map((c) => `${c.name} ${c.arguments}`).join('\n'),
      })
      const built = buildInjection({ query: query || '', readiness, task, store, globalStore, projectTagsList: projectTags(root), cfg })
      const fp = fingerprint(built.dedupeText ?? built.text)
      const shouldInject = Boolean(built.text) && fp !== lastFpBySession.get(sessionId)
      let injectMessage = null
      if (shouldInject) {
        // 以宿主 createUserMessage 构造的完整 user 消息追加（带 id/source，plan-mode narration 同款）。
        // 裸 {role,content} 消息缺 source 会让宿主逐条读 message.source.kind 时崩溃。
        lastFpBySession.set(sessionId, fp)
        if (lastFpBySession.size > LAST_FP_MAX) lastFpBySession.delete(lastFpBySession.keys().next().value)
        injectMessage = createUserMessage({
          content: [{ type: 'text', text: `\n\n${INJECT_MARK} auto-context\n${built.text}` }],
          // 这一块是「同一生产者后续快照会取代的当前状态」，不是一次性通知。
          // 宿主 ContextFormed 是判别联合：snapshot 必须带 sections（notice 才需要 summary）。
          // 通道不变（仍走 agent/pre-step 追加 user 消息），只修语义。
          source: {
            kind: 'plugin',
            plugin: 'dsh-project-memory',
            form: 'snapshot',
            sections: [{ name: 'project-memory', text: built.text }],
          },
        })
      }
      // 未注入 ≠ 无事发生：因预算被挤掉的条目留一条 degraded 记录（每个会话同一组合只记一次）。
      if (built.dropped && built.dropped.length) {
        const sig = built.dropped.map((d) => `${d.id}:${d.reason}`).join(',')
        if (lastDroppedBySession.get(sessionId) !== sig) {
          lastDroppedBySession.set(sessionId, sig)
          while (lastDroppedBySession.size > LAST_FP_MAX) {
            lastDroppedBySession.delete(lastDroppedBySession.keys().next().value)
          }
          console.error(
            `[dsh-project-memory] auto-inject degraded: ${built.dropped.length} insight(s) kept out by budget — `
            + built.dropped.map((d) => `${d.id}(${d.reason})`).join(', '),
          )
        }
      }
      if (injectMessage) return { ...decision, messages: [...decision.messages, injectMessage] }
    } catch (err) {
      console.error(`[dsh-project-memory] auto-inject skipped: ${err?.message || err}`)
    }
    return decision
  })
}