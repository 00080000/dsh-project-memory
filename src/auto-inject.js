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
import { buildReadinessContext, hintQueryText, idfCoverage, matchTrigger, normalizeTrigger, relativeHits } from './readiness.js'
import { activityFromCalls } from './ops.js'
import { appendInjectionAudit, auditRecordFrom, cfgAudit } from './audit.js'

export const INJECT_MARK = '[Memory Inject]'

/**
 * 注入正文的最小可用长度：预算塞不下这么多就宁可不注入（记 dropped）。
 * 与其输出 `- [ins_xxx] procedure ` 这种 stub，不如保持沉默——stub 只消耗 token 不传递信息。
 */
const MIN_BODY_CHARS = { trigger: 48, hint: 120 }

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
    // 预算审计日志级别（stderr）。默认 off：预算挤掉低优先级条目是正常降级，不是故障，
    // 而终端是用户可见面——默认打印会让一次启动刷出多行，代价远大于那点可观测性收益。
    //   off  : 永不打印（默认）
    //   once : 每个会话最多一行（首次出现预算丢弃时），够定位又不刷屏
    //   all  : 丢弃组合每变化一次打一行（作者排查用）
    budgetLog: ['off', 'once', 'all'].includes(c.budgetLog) ? c.budgetLog : 'off',
    // 同一条 insight 在本会话里重复注入的冷却（单位：pre-step 步数）。
    // 0（默认）= 内容没变就不再注入：注入消息会留在会话历史里（宿主不压缩历史），
    // 整块重发同一条 1200 字 procedure 只是重复占位。>0 用于历史可能被外部裁剪的场景。
    reinjectItemsAfter: typeof c.reinjectItemsAfter === 'number' && c.reinjectItemsAfter >= 0 ? c.reinjectItemsAfter : 0,
    // ---- S2/S3/S4 新增（准入化改造） ----
    // 旧 `scope` 的处理：'filter'（默认，保留旧语义——不静默改用户数据）或 'ignore'。
    // 注意：实测里唯一带 scope 的条目，其值不在项目画像 tag 空间内，等于被判死刑；
    // 自检会把它报出来，由作者决定改值还是改语义。
    legacyScope: c.legacyScope === 'ignore' ? 'ignore' : 'filter',
    // 条目通道的步间隔：两次"条目注入"之间至少隔这么多步（常驻任务卡不受限——它是状态快照，
    // 内容变了就该更新）。这是"不频繁"的主要旋钮。
    gateCooldownSteps: typeof c.gateCooldownSteps === 'number' && c.gateCooldownSteps >= 0 ? c.gateCooldownSteps : 2,
    // 每会话条目注入的上限（条数 / 字符）：预算只能是上限，不是目标。
    maxItemsPerSession: typeof c.maxItemsPerSession === 'number' && c.maxItemsPerSession >= 0 ? c.maxItemsPerSession : 12,
    maxItemCharsPerSession: typeof c.maxItemCharsPerSession === 'number' && c.maxItemCharsPerSession >= 0 ? c.maxItemCharsPerSession : 4000,
    // 提示通道的**绝对**下限（IDF 加权覆盖率）：相对阈值分不出"有信号"和"矮子里拔将军"。
    // null = 关闭（回到只有相对阈值的老行为）。
    hintMinCoverage: typeof c.hintMinCoverage === 'number' && c.hintMinCoverage >= 0 ? c.hintMinCoverage : 0.3,
    // 提示通道还要求至少这么多个共同词：单个通用词（"插件"）也能拿到 coverage=1.00。
    hintMinMatched: typeof c.hintMinMatched === 'number' && c.hintMinMatched >= 0 ? c.hintMinMatched : 2,
    // 通道级沉默：查询里能在语料中找到对应的词占比低于这个值时，整条提示通道本轮不出声。
    // 长句子里只有一两个词碰巧命中，coverage 会虚高到 1.00——这条门就是为它设的。
    hintMinSupport: typeof c.hintMinSupport === 'number' && c.hintMinSupport >= 0 ? c.hintMinSupport : 0.15,
  }
}

function textOf(message) {
  const blocks = (message && message.content) || []
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

export function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  let fallback = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== 'user') continue
    const t = textOf(m)
    if (!t.trim()) continue
    // 真人消息优先：本插件注入的块也是 role=user，若按"最后一条 user"取，
    // 上一步的注入块会变成这一步的就绪查询（自激：拿自己注入的内容再检索一遍）。
    if (m.source && m.source.kind === 'user') return t.trim()
    if (!fallback) fallback = t.trim() // 无 source 的消息（老宿主 / 测试）兜底
  }
  return fallback
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

/** 候选池：project + global + 绑定任务（同一 id 只取一次；归档/草稿不进注入）。
 * 候选在进入匹配前统一走旧 trigger → 新 schema 的归一（幂等，纯内存，不落盘）。 */
function insightCandidates(store, globalStore, task, opts) {
  const out = []
  const seen = new Set()
  const push = (it) => {
    if (!it || it.archived || it.draft) return
    const key = it.id || `${it.kind}:${it.title}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(normalizeTrigger(it, { legacyScope: opts?.legacyScope }))
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

/** 条目级去重键：注入正文的指纹（正文变了才允许再注入一次，见 cfg.reinjectItemsAfter）。 */
export function insightItemHash(it) {
  return createHash('sha256').update(insightBody(it)).digest('hex').slice(0, 12)
}

/** 把正文塞进剩余预算：放不下就截断；连"有用前缀"都留不下就返回 null（由调用方记 dropped）。 */
export function fitBody(body, remaining, min = MIN_BODY_CHARS.hint) {
  if (remaining <= min) return null
  if (body.length <= remaining) return body
  return `${body.slice(0, remaining - 1)}…`
}

/**
 * 构建注入内容（不写盘、无副作用）。
 *
 * 交付契约：**authored trigger（所有 kind）= 确定性全文注入，优先级 1；统计信号 = 截断提示，
 * 优先级 2**。预算排程为：常驻任务卡 → trigger 命中 → 提示。每一步都记 `reasons`（为什么注入）
 * 与 `dropped`（为什么没注入），让"注入/未注入"可审计——而不是只有静默的门槛。
 * @param {object} opts { query, readiness, task, store, globalStore, projectTagsList, cfg, skipItem? }
 * @param {(it: object) => boolean} [opts.skipItem] 条目级去重：返回 true 的条目直接退出排程
 *   （本会话已注入过且正文未变）。在排程前过滤，省下的预算留给新条目。
 * @returns {{ text: string, labels: string[], reasons: object[], dropped: object[] }}
 */
export function buildInjection(opts) {
  const { query, task, globalStore, cfg } = opts
  const store = opts.store || null
  const tags = opts.projectTagsList || []
  const ctx = buildReadinessContext({ ...(opts.readiness || { humanText: query || '' }), tags })
  const labels = []
  const reasons = []
  const dropped = []
  const parts = []
  // 预算只能是上限，不是目标：单轮额度（maxTokens）与会话级剩余额度取小者。
  const quotaChars = typeof opts.maxChars === 'number' ? opts.maxChars : Infinity
  const maxItems = typeof opts.maxItems === 'number' ? opts.maxItems : Infinity
  const skipItems = opts.skipItems === true
  const budgetChars = Math.max(0, Math.min((cfg.maxTokens || 400) * 3, quotaChars))

  const skipItem = typeof opts.skipItem === 'function' ? opts.skipItem : null
  const cands = insightCandidates(store, globalStore, task, cfg).filter((it) => !(skipItem && skipItem(it)))

  // 通道 1：authored trigger —— 确定性、全文、优先级 1。procedure 先于其它 kind（步骤更完整）。
  // 准入化（S2）：只有 `when`（op / 写目标 / 意图词）能触发，guard 只能收窄；
  // **没有 `when` 的条目在这里永远不命中**（降级为可发现 + 按需拉取）。
  const triggered = []
  for (const it of cands) {
    const why = matchTrigger(it.trigger, ctx)
    if (!why) continue
    triggered.push({ it, why })
  }
  triggered.sort(
    (a, b) => (a.it.kind === 'procedure' ? 0 : 1) - (b.it.kind === 'procedure' ? 0 : 1)
      || String(a.it.id).localeCompare(String(b.it.id)),
  )
  if (skipItems) {
    // 会话级限流命中：条目通道本轮整体沉默，但把"本该注入什么"记进 dropped——不做静默降级。
    for (const t of triggered) dropped.push({ id: t.it.id, channel: 'trigger', reason: opts.silenceReason || 'cooldown' })
  }

  // 通道 2：统计信号 —— 提示态、优先级 2。**双门槛**：层内相对阈值 + IDF 加权覆盖率（绝对下限）。
  // 查询只用「人类消息的意图文字 + 本次写目标」：原始工具参数不再进查询，它们正是
  // `dcterms→rm`、`*.pptx→论文笔记` 那类假阳性的来源。procedure 不进本通道（要过 trigger.scope）。
  const consumed = new Set(triggered.map((t) => t.it.id))
  const hintCands = skipItems ? [] : cands.filter((it) => !consumed.has(it.id) && it.kind !== 'procedure')
  const hintQuery = [ctx.intent || ctx.humanText || '', ...(ctx.targets || [])].filter(Boolean).join(' ')
  const hints = []
  if (hintCands.length) {
    if (typeof cfg.relevanceMin === 'number') {
      // 兼容：显式 relevanceMin → 旧的绝对 overlap 判据（老 profile 行为不变）
      for (const it of hintCands) {
        const score = normalizedTokenOverlap(ctx.humanText || query || '', insightMatchText(it))
        if (score >= cfg.relevanceMin) hints.push({ it, score, why: `overlap:${score.toFixed(3)}` })
      }
      hints.sort((a, b) => b.score - a.score)
    } else if (hintQueryText(hintQuery)) {
      const byId = new Map(hintCands.map((it) => [it.id, it]))
      const corpus = hintCands.map((it) => insightMatchText(it))
      // 查询与被测覆盖率的文本用**同一个**过滤后的查询：否则缩写（wsl/npm）会在 BM25 里被剔除、
      // 却仍在覆盖率里计分，"至少两个共同词"就被它们凑够了。
      const q = hintQueryText(hintQuery)
      const scored = rankEntriesMergedScored(hintCands.map(insightToEntry), [q], hintCands.length)
      const coverage = new Map(hintCands.map((it, i) => [it.id, idfCoverage(q, corpus[i], corpus)]))
      const qStats = coverage.get(hintCands[0].id) || { supported: 0, terms: 0 }
      const supportRatio = qStats.terms > 0 ? qStats.supported / qStats.terms : 0
      // 通道级沉默：查询里绝大多数词在语料里根本没有对应 → "覆盖率 1.00"只是假象。
      const channelThin = typeof cfg.hintMinSupport === 'number' && supportRatio < cfg.hintMinSupport
      for (const r of relativeHits(scored, { ratioMin: cfg.signalMinRatio })) {
        const it = byId.get(r.entry.insightId)
        if (!it) continue
        const ev = coverage.get(it.id) || { coverage: 0, matched: 0, supported: 0, terms: 0 }
        if (channelThin) {
          dropped.push({ id: it.id, channel: 'hint', reason: `support:${supportRatio.toFixed(2)}` })
          continue
        }
        // 绝对门槛：覆盖率下限 + 共同词数下限（查询本身很短时下限按可用词数收敛）。
        if (typeof cfg.hintMinCoverage === 'number' && ev.coverage < cfg.hintMinCoverage) {
          dropped.push({ id: it.id, channel: 'hint', reason: `coverage:${ev.coverage.toFixed(2)}` })
          continue
        }
        const needMatched = Math.min(typeof cfg.hintMinMatched === 'number' ? cfg.hintMinMatched : 2, ev.supported)
        if (ev.matched < needMatched) {
          dropped.push({ id: it.id, channel: 'hint', reason: `thin:${ev.matched}` })
          continue
        }
        hints.push({ it, score: r.score, why: `relative:${(r.score / (scored[0].score || 1)).toFixed(2)} cov:${ev.coverage.toFixed(2)}/${ev.matched}` })
      }
    }
  }

  // 常驻块文本。去重指纹只看稳定内容（任务标题/步骤/insights + 相关 insights）：
  // “编辑中”随每次写文件变化，若参与指纹会导致每写一个文件就重发整块（噪音 + token 浪费）。
  const echo = shouldEchoTaskCard(task, cfg)
  const entry = echo ? buildEntryContent(task, cfg) : ''
  const entryStable = echo ? buildEntryContent(task, cfg, { withEdited: false }) : ''
  let used = entry.length
  let itemCount = 0

  for (const { it, why } of triggered) {
    if (skipItems) break
    if (itemCount >= maxItems) {
      dropped.push({ id: it.id, channel: 'trigger', reason: 'quota' })
      continue
    }
    const body = fitBody(insightBody(it), budgetChars - used, MIN_BODY_CHARS.trigger)
    if (body === null) {
      dropped.push({ id: it.id, channel: 'trigger', reason: 'budget' })
      continue
    }
    used += body.length + 1
    itemCount++
    parts.push(body)
    labels.push(it.kind === 'procedure' ? 'procedure' : it.kind)
    reasons.push({ id: it.id, channel: 'trigger', why, hash: insightItemHash(it), chars: body.length })
  }
  for (const { it, why } of hints) {
    if (skipItems) break
    if (itemCount >= maxItems) {
      dropped.push({ id: it.id, channel: 'hint', reason: 'quota' })
      continue
    }
    const body = fitBody(insightBody(it), budgetChars - used, MIN_BODY_CHARS.hint)
    if (body === null) {
      dropped.push({ id: it.id, channel: 'hint', reason: 'budget' })
      continue
    }
    used += body.length + 1
    itemCount++
    parts.push(body)
    labels.push('hint')
    reasons.push({ id: it.id, channel: 'hint', why, hash: insightItemHash(it), chars: body.length })
  }

  const total = [entry, ...parts].filter(Boolean)
  if (!total.length) return { text: '', entry, labels, reasons, dropped }
  const clamp = (t) => (t.length > budgetChars ? `${t.slice(0, budgetChars)}\n…(截断)` : t)
  const dedupeText = clamp([entryStable, ...parts].filter(Boolean).join('\n'))
  return { text: clamp(total.join('\n')), entry, entryStable, labels, reasons, dropped, dedupeText, itemChars: used - entry.length }
}

/** 注册 agent/pre-step 监听，向每步请求的 enter 决策追加记忆消息（默认开）。
 * 宿主瀑布事件签名为 (payload, next)：payload.agent.session 提供会话（header.cwd=项目根）。
 * 任何异常/无会话 cwd → 原样返回默认决策，零副作用，绝不让宿主请求受影响。
 */
export function installAutoInject(ctx, config) {
  const auto = (config && config.autoContext) || {}
  if (auto.enabled === false) return
  const cfg = cfgEngine(config)
  // 审计配置同 cfg：安装时解析一次（与 autoContext 其余开关一致）。
  const audit = cfgAudit(config)
  // 每个会话一份“上次注入指纹”。用单个变量会让并发会话互相抑制注入。
  const lastFpBySession = new Map()
  const LAST_FP_MAX = 200
  // 每个会话一份"上次预算丢弃指纹"：预算把条目挤出去时必须留痕一次，而不是静默（degraded 可见性）。
  const lastDroppedBySession = new Map()
  // 条目级去重记忆：sessionId → Map(insightId → { hash, step })。注入的消息留在会话历史里
  // （宿主只追加、不压缩），所以"整块指纹变了"不等于"内容都是新的"——同一份 procedure 会因为
  // 滑动工具窗口、任务卡更新、预算截断边界变化被整块重发（实测 66 步注入 20 次，其中同一份
  // 1732 字 procedure 重发 3 次、另一份 1008 字的 6 次）。这里按条目记账，正文没变就不再排程。
  const injectedBySession = new Map()
  const INJECTED_ITEMS_MAX = 600
  // 会话步数：为 reinjectItemsAfter 提供时间轴（>0 时才用得上）。
  const stepBySession = new Map()
  // 会话级条目额度（S3）：条数 / 字符 / 上次"条目注入"的步号。常驻任务卡不占这个额度——
  // 它是状态快照，内容变了就该更新；被限流的是记忆条目的推送。
  const budgetBySession = new Map()
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
    ctx.effect(() => () => {
      observedBySession.clear()
      injectedBySession.clear()
      stepBySession.clear()
      budgetBySession.clear()
    })
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
      const memoryRoot = memoryRootFor(root, config.memoryDir)
      const store = new ProjectMemoryStore(memoryRoot).load()
      const globalStore = new GlobalStore(cfgInsight(config).globalFile || defaultGlobalFile()).load()
      const boundTaskId = store.getBoundTaskId(sessionId) ? store.getBoundTaskId(sessionId) : null
      const task = boundTaskId ? store.getTask(boundTaskId) : null
      // 两个窗口合并进同一个就绪上下文：人类消息（先发）+ 已观察动作（反应）。
      // 动作平面（S1）：把"最近做过什么"解析成 op / 写目标 / 主机——不再把原始参数当文本搜。
      const observed = observedBySession.get(sessionId) || []
      const activity = activityFromCalls(observed)
      const readiness = buildReadinessContext({
        humanText: query || '',
        actionText: observed.map((c) => `${c.name} ${c.arguments}`).join('\n'),
        ops: activity.ops,
        targets: activity.targets,
        hosts: activity.hosts,
      })
      // 条目级去重：本会话已注入过、且正文未变的条目不再参与排程（cfg.reinjectItemsAfter=0 时永久，
      // >0 时走冷却步数，用于历史可能被外部裁剪的场景）。正文变了（编辑过 insight）立刻允许重发。
      const stepNo = (stepBySession.get(sessionId) || 0) + 1
      stepBySession.set(sessionId, stepNo)
      while (stepBySession.size > LAST_FP_MAX) stepBySession.delete(stepBySession.keys().next().value)
      const seen = injectedBySession.get(sessionId) || new Map()
      injectedBySession.set(sessionId, seen)
      while (injectedBySession.size > LAST_FP_MAX) injectedBySession.delete(injectedBySession.keys().next().value)
      const cooldown = cfg.reinjectItemsAfter || 0
      const skipItem = cooldown === 0
        ? (it) => {
            const rec = seen.get(it.id)
            return Boolean(rec) && rec.hash === insightItemHash(it)
          }
        : (it) => {
            const rec = seen.get(it.id)
            return Boolean(rec) && rec.hash === insightItemHash(it) && stepNo - rec.step < cooldown
          }
      // 会话级限流（S3）：冷却步数 / 条目条数 / 条目字符。三个任一触顶 → 条目通道整体沉默，
      // 但本轮"本该注入什么"仍会进 dropped（不做静默降级）。
      const budget = budgetBySession.get(sessionId) || { items: 0, chars: 0, lastStep: -Infinity }
      budgetBySession.set(sessionId, budget)
      while (budgetBySession.size > LAST_FP_MAX) budgetBySession.delete(budgetBySession.keys().next().value)
      const cooling = Number.isFinite(budget.lastStep) && stepNo - budget.lastStep < cfg.gateCooldownSteps
      const itemsLeft = Math.max(0, cfg.maxItemsPerSession - budget.items)
      const charsLeft = Math.max(0, cfg.maxItemCharsPerSession - budget.chars)
      const silenceReason = cooling ? 'cooldown'
        : itemsLeft === 0 ? 'session-items'
          : charsLeft === 0 ? 'session-chars' : null
      const built = buildInjection({
        query: query || '',
        readiness,
        task,
        store,
        globalStore,
        projectTagsList: projectTags(root),
        cfg,
        skipItem,
        skipItems: silenceReason !== null,
        silenceReason: silenceReason || 'cooldown',
        maxItems: itemsLeft,
        maxChars: charsLeft,
      })
      const fp = fingerprint(built.dedupeText ?? built.text)
      const shouldInject = Boolean(built.text) && fp !== lastFpBySession.get(sessionId)
      let injectMessage = null
      if (shouldInject) {
        // 以宿主 createUserMessage 构造的完整 user 消息追加（带 id/source，plan-mode narration 同款）。
        // 裸 {role,content} 消息缺 source 会让宿主逐条读 message.source.kind 时崩溃。
        lastFpBySession.set(sessionId, fp)
        if (lastFpBySession.size > LAST_FP_MAX) lastFpBySession.delete(lastFpBySession.keys().next().value)
        // 只记真的进了上下文的那几条：dropped 的没被看到，不能记账（否则以后永远不再注入）。
        for (const r of built.reasons) {
          if (r && r.id && r.hash) seen.set(r.id, { hash: r.hash, step: stepNo })
        }
        while (seen.size > INJECTED_ITEMS_MAX) seen.delete(seen.keys().next().value)
        // 会话额度只被"条目"消耗；任务卡不算（否则任务一多就把记忆挤没了）。
        if (built.reasons.length) {
          budget.items += built.reasons.length
          budget.chars += typeof built.itemChars === 'number' ? built.itemChars : 0
          budget.lastStep = stepNo
        }
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
      // 未注入 ≠ 无事发生：因预算被挤掉的条目按 cfg.budgetLog 留痕（默认 off，见 cfgEngine）。
      // 留痕仍然记账（去重 + 上限），只是默认不外泄到用户的终端。
      if (built.dropped && built.dropped.length && cfg.budgetLog !== 'off') {
        const sig = built.dropped.map((d) => `${d.id}:${d.reason}`).join(',')
        if (lastDroppedBySession.get(sessionId) !== sig) {
          const seenBefore = lastDroppedBySession.has(sessionId)
          lastDroppedBySession.set(sessionId, sig)
          while (lastDroppedBySession.size > LAST_FP_MAX) {
            lastDroppedBySession.delete(lastDroppedBySession.keys().next().value)
          }
          // once：只有本会话第一次丢弃出声，之后继续记账但保持安静。
          if (cfg.budgetLog === 'all' || !seenBefore) {
            console.error(
              `[dsh-project-memory] auto-inject degraded: ${built.dropped.length} insight(s) kept out by budget — `
              + built.dropped.map((d) => `${d.id}(${d.reason})`).join(', '),
            )
          }
        }
      }
      if (injectMessage) {
        // S0 观测：只记真的进了上下文的那一次（dropped 单独出现不写，否则每步刷屏）。
        appendInjectionAudit(memoryRoot, auditRecordFrom({
          sessionId,
          root,
          step: stepNo,
          text: built.text,
          labels: built.labels,
          reasons: built.reasons,
          dropped: built.dropped,
          budget: { items: budget.items, chars: budget.chars, lastStep: Number.isFinite(budget.lastStep) ? budget.lastStep : null },
          silence: silenceReason,
        }), audit)
        return { ...decision, messages: [...decision.messages, injectMessage] }
      }
    } catch (err) {
      console.error(`[dsh-project-memory] auto-inject skipped: ${err?.message || err}`)
    }
    return decision
  })
}