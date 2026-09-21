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
import { insightMatchText, normalizedTokenOverlap } from './similarity.js'
import { BoundedMap, SessionCache } from './util/session-cache.js'
import { cfgInsight, GlobalStore, defaultGlobalFile, recordHit } from './insight-store.js'
import { projectTags } from './project-profile.js'
import { rankEntriesMergedScored } from './util/search.js'
import { insightToEntry, insightScoringText } from './recall.js'
import { buildReadinessContext, hintQueryText, idfCoverage, matchTrigger, normalizeTrigger, relativeHits } from './readiness.js'
import { activityFromCalls } from './ops.js'
import { appendInjectionAudit, appendShadowAudit, auditRecordFrom, cfgAudit, cfgShadow, shadowRecordFrom } from './audit.js'

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
    // 常驻任务卡总开关（entryOn:false = 只做条目注入，不回声任务卡）
    entryOn: c.entryOn !== false,
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
    // 提示通道的**绝对**覆盖底线（IDF 加权覆盖率）：相对阈值分不出"有信号"和"矮子里拔将军"，
    // 只有归一在 [0,1]、有真零点才谈得上下限。0.30 时的实测反例：真实 store（43 条同源洞察）上，
    // 对照组场景「改 pptx 时间戳」以 cov 0.32~0.35 注入了 3 条无关条目——语料同源时共享词多、
    // IDF 分辨力被拉平，"最不坏的一条"就能过 0.30。0.45 落在实测分布的空隙里（假阳性 ≤0.35、
    // 下一个真命中 ≥0.49），合成标注集在 0.6 以前 precision/recall 也仍是 1.00。
    // 用 `--hint-cov` 在真实 store 上重放可复核（见 test/injection-scenarios.test.mjs）。
    hintMinCoverage: typeof c.hintMinCoverage === 'number' && c.hintMinCoverage >= 0 ? c.hintMinCoverage : 0.45,
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
    // 本插件注入的块同样是 role=user。无 source 的老宿主下若把它当兜底查询，
    // 就成了"拿自己上一步注入的内容再检索一遍"的自激——正是 kind==='user' 这道闸要防的。
    if (m.source && m.source.plugin === 'dsh-project-memory') continue
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
  const progress = steps.length ? `${steps.length} 步` : ''
  const card = [
    `任务: ${task.title || '(untitled)'}`,
    `进度: ${progress}`,
    ...steps.slice(0, 12).map((s, i) => `  ${i + 1}. ${s}`),
  ]
  const insights = linesOf(task.insights)
  // 0 是合法值（= 不显示）：cfgEngine 已归一成数字，这里不能再用 `||` 把 0 顶回默认。
  const maxEdited = Number.isFinite(c.editedMax) ? c.editedMax : 3
  const maxInsights = Number.isFinite(c.entryMaxInsights) ? c.entryMaxInsights : 6
  const edited = editedFiles(task, maxEdited)
  const parts = [...card]
  if (withEdited && edited.length) parts.push(`  编辑中: ${edited.join(', ')}`)
  if (insights.length) parts.push(`任务记忆:`, ...insights.slice(0, maxInsights))
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
  if (remaining < min) return null
  if (body.length <= remaining) return body
  return `${body.slice(0, remaining - 1)}…`
}

/**
 * 通道 1：authored trigger 命中（确定性、全文、优先级 1）。procedure 先于其它 kind（步骤更完整）。
 * 准入化（S2）：只有 `when`（op / 写目标 / 意图词）能触发，guard 只能收窄；
 * **没有 `when` 的条目在这里永远不命中**（降级为可发现 + 按需拉取）。
 */
function collectTriggered(cands, ctx) {
  const hits = []
  for (const it of cands) {
    const why = matchTrigger(it.trigger, ctx)
    if (why) hits.push({ it, why })
  }
  hits.sort(
    (a, b) => (a.it.kind === 'procedure' ? 0 : 1) - (b.it.kind === 'procedure' ? 0 : 1)
      || String(a.it.id).localeCompare(String(b.it.id)),
  )
  return hits
}

/**
 * 通道 2：统计信号（提示态、优先级 2）。**双门槛**：层内相对阈值 + IDF 加权覆盖率（绝对下限）。
 * 查询只用「人类消息的意图文字 + 本次写目标」：原始工具参数不是查询文本，它们正是
 * `dcterms→rm`、`*.pptx→论文笔记` 那类假阳性的来源。被门槛拦下的记进 dropped，不静默。
 */
function scoreHints({ cands, query, humanText, hintQuery, cfg, dropped }) {
  const hints = []
  // 影子记录用：本步**全部**被评过分的候选 + 特征 + 判据结果。与 hints/dropped 分开算——
  // 现有两类记录都只覆盖"过得了相对阈值的那部分"，恰恰缺了"因为没到阈值而从未被考虑"的候选，
  // 而那正是离线重放阈值时需要的那批。这里只做加法，不动任何现有判据。
  const candidates = []
  if (!cands.length) return { hints, candidates }
  if (typeof cfg.relevanceMin === 'number') {
    // 兼容：显式 relevanceMin → 旧的绝对 overlap 判据（老 profile 行为不变）
    for (const it of cands) {
      const score = normalizedTokenOverlap(humanText || query || '', insightMatchText(it))
      if (score >= cfg.relevanceMin) hints.push({ it, score, why: `overlap:${score.toFixed(3)}` })
    }
    hints.sort((a, b) => b.score - a.score)
    return { hints, candidates } // 旧判据路径不产出影子候选（已废弃，无重放价值）
  }
  const q = hintQueryText(hintQuery)
  if (!q) return { hints, candidates }
  const byId = new Map(cands.map((it) => [it.id, it]))
  // 覆盖率语料必须与 BM25 排序同源（insightScoringText）：否则"只在 fix/solution 里有匹配"
  // 的查询词 df=0 → supportRatio=0 → 整条提示通道沉默，而排序明明给了它高分。
  const corpus = cands.map((it) => insightScoringText(it))
  // 查询与被测覆盖率的文本用**同一个**过滤后的查询：否则缩写（wsl/npm）会在 BM25 里被剔除、
  // 却仍在覆盖率里计分，"至少两个共同词"就被它们凑够了。
  const scored = rankEntriesMergedScored(cands.map(insightToEntry), [q], cands.length)
  const coverage = new Map(cands.map((it, i) => [it.id, idfCoverage(q, corpus[i], corpus)]))
  const qStats = coverage.get(cands[0].id) || { supported: 0, terms: 0 }
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
    // 共同词数下限按**查询本身的词数**收敛（查询很短时不强求两个），而不是按"语料能表示的词数"：
    // 后者在长而杂的查询上会退化成 1，一个碰巧命中的通用词就能过闸。
    const needMatched = Math.min(typeof cfg.hintMinMatched === 'number' ? cfg.hintMinMatched : 2, ev.terms)
    if (ev.matched < needMatched) {
      dropped.push({ id: it.id, channel: 'hint', reason: `thin:${ev.matched}` })
      continue
    }
    hints.push({ it, score: r.score, why: `relative:${(r.score / (scored[0].score || 1)).toFixed(2)} cov:${ev.coverage.toFixed(2)}/${ev.matched}` })
  }

  // ---- 影子候选（只读、无副作用）：重放一遍**全部**被评分的条目，标出它卡在哪一关 ----
  // 顺序与真实判据一致（support → coverage → thin → relative），最后 'cand' = 过了全部门槛
  // （注意 'cand' 不等于"真的注入了"：还要过去重/预算/冷却，那些写在同一行的 injected/silence）。
  {
    const top = scored[0]?.score || 0
    const ratio = typeof cfg.signalMinRatio === 'number' && Number.isFinite(cfg.signalMinRatio) ? cfg.signalMinRatio : 0.5
    for (const r of scored) {
      const it = byId.get(r.entry.insightId)
      if (!it || !Number.isFinite(r.score) || r.score <= 0) continue
      const ev = coverage.get(it.id) || { coverage: 0, matched: 0, supported: 0, terms: 0 }
      const needMatched = Math.min(typeof cfg.hintMinMatched === 'number' ? cfg.hintMinMatched : 2, ev.terms)
      let decision = 'cand'
      if (channelThin) decision = 'support'
      else if (typeof cfg.hintMinCoverage === 'number' && ev.coverage < cfg.hintMinCoverage) decision = 'coverage'
      else if (ev.matched < needMatched) decision = 'thin'
      else if (r.score < top * Math.max(0, Math.min(1, ratio))) decision = 'relative'
      candidates.push({
        id: it.id,
        channel: 'hint',
        rel: Number((r.score / (top || 1)).toFixed(3)),
        coverage: Number(ev.coverage.toFixed(3)),
        matched: ev.matched,
        support: ev.supported,
        terms: ev.terms,
        decision,
      })
    }
  }
  return { hints, candidates }
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
  // 预算只能是上限，不是目标。两条额度分开：
  //   stepBudget —— 单轮（常驻块 + 条目）共享的 maxTokens；
  //   itemBudget —— 条目还受会话字符额度约束；**常驻块不占这条**（它是状态快照，文档明说不受限）。
  // 旧实现把两者取小成同一个 budgetChars，会话额度用尽后连任务卡都被截成 `…(截断)`。
  const quotaChars = typeof opts.maxChars === 'number' ? opts.maxChars : Infinity
  const maxItems = typeof opts.maxItems === 'number' ? opts.maxItems : Infinity
  const skipItems = opts.skipItems === true
  const stepBudget = Math.max(0, (cfg.maxTokens || 400) * 3)
  const itemBudget = Math.max(0, Math.min(stepBudget, quotaChars))

  const skipItem = typeof opts.skipItem === 'function' ? opts.skipItem : null
  const cands = insightCandidates(store, globalStore, task, cfg).filter((it) => !(skipItem && skipItem(it)))

  // 两条通道：authored trigger（确定性、全文、优先级 1）→ 统计信号提示（优先级 2）。
  const triggered = collectTriggered(cands, ctx)
  if (skipItems) {
    // 会话级限流命中：条目通道本轮整体沉默，但把"本该注入什么"记进 dropped——不做静默降级。
    for (const { it } of triggered) dropped.push({ id: it.id, channel: 'trigger', reason: opts.silenceReason || 'cooldown' })
  }
  // procedure 不进提示通道：它要过 trigger.scope（见 scoreHints 注释）。
  const consumed = new Set(triggered.map((t) => t.it.id))
  const hintCands = skipItems ? [] : cands.filter((it) => !consumed.has(it.id) && it.kind !== 'procedure')
  const { hints, candidates } = scoreHints({
    cands: hintCands,
    query,
    humanText: ctx.humanText,
    hintQuery: [ctx.intent || ctx.humanText || '', ...(ctx.targets || [])].filter(Boolean).join(' '),
    cfg,
    dropped,
  })

  // 常驻块文本。去重指纹只看稳定内容（任务标题/步骤/insights + 相关 insights）：
  // “编辑中”随每次写文件变化，若参与指纹会导致每写一个文件就重发整块（噪音 + token 浪费）。
  const echo = cfg.entryOn !== false && shouldEchoTaskCard(task, cfg)
  const entry = echo ? buildEntryContent(task, cfg) : ''
  const entryStable = echo ? buildEntryContent(task, cfg, { withEdited: false }) : ''
  let used = entry.length
  let itemUsed = 0
  let itemCount = 0

  /** 把一组候选按优先级放进剩余预算：放不下的进 dropped（quota / budget），不静默。 */
  const place = (channel, list, minChars, labelOf) => {
    for (const { it, why } of list) {
      if (itemCount >= maxItems) {
        dropped.push({ id: it.id, channel, reason: 'quota' })
        continue
      }
      // 条目同时受"单轮剩余"与"会话字符剩余"约束；常驻块只占前者。
      const remaining = Math.min(stepBudget - used, itemBudget - itemUsed)
      const body = fitBody(insightBody(it), remaining, minChars)
      if (body === null) {
        dropped.push({ id: it.id, channel, reason: 'budget' })
        continue
      }
      used += body.length + 1
      itemUsed += body.length + 1
      itemCount++
      parts.push(body)
      labels.push(labelOf(it))
      reasons.push({ id: it.id, channel, why, hash: insightItemHash(it), chars: body.length })
    }
  }
  // 限流命中时条目通道整体沉默：triggered 已在上方记进 dropped，这里不再重复排程。
  if (!skipItems) {
    place('trigger', triggered, MIN_BODY_CHARS.trigger, (it) => it.kind)
    place('hint', hints, MIN_BODY_CHARS.hint, () => 'hint')
  }

  const total = [entry, ...parts].filter(Boolean)
  if (!total.length) return { text: '', entry, labels, reasons, dropped }
  // 整块只受单轮预算（maxTokens）约束；会话条目额度已在 place() 里单独扣过。
  const clamp = (t) => (t.length > stepBudget ? `${t.slice(0, stepBudget)}\n…(截断)` : t)
  const dedupeText = clamp([entryStable, ...parts].filter(Boolean).join('\n'))
  return { text: clamp(total.join('\n')), entry, entryStable, labels, reasons, dropped, candidates, dedupeText, itemChars: itemUsed }
}

// 每会话状态的会话数上限：六张表共用（旧实现把同一个 200 在五处各写一遍）。
const SESSION_STATE_MAX = 200
// 单会话已注入条目表的条数上限。
const INJECTED_ITEMS_MAX = 600
// 单会话保留的 tool/call 观察窗口（够覆盖"最近几步在做什么"）。
const OBSERVED_CALLS_MAX = 8

/**
 * 注入引擎的「每会话一份」状态。
 *
 * 之前六张表散在 installAutoInject 里、各自 hand-roll 淘汰循环，同一个
 * `while (map.size > CAP) map.delete(map.keys().next().value)` 抄了五遍：容量上限写在五处，
 * 抄漏一处就是无界增长，dispose 时也漏清两张表。容量只在这里定义一次。
 */
class InjectionSessions {
  constructor() {
    const cache = (create) => new SessionCache({ maxSessions: SESSION_STATE_MAX, create })
    // 上次注入指纹：用单个变量会让并发会话互相抑制注入。
    this.lastText = cache()
    // 上次预算丢弃签名：预算把条目挤出去时必须留痕一次，而不是静默（degraded 可见性）。
    this.lastDropped = cache()
    // 条目级去重记忆：insightId → { hash, step }。注入的消息留在 append-only 的会话历史里，
    // 所以"整块指纹变了"不等于"内容都是新的"：滑动工具窗口 / 任务卡更新 / 预算截断边界都会
    // 让同一份 procedure 被整块重发（实测 66 步注入 20 次，同一份 1732 字重发 3 次）。
    this.items = cache(() => new BoundedMap(INJECTED_ITEMS_MAX))
    // 会话步数：为 reinjectItemsAfter 提供时间轴。
    this.step = cache(() => 0)
    // 会话级条目额度（S3）：条数 / 字符 / 上次"条目注入"的步号。常驻任务卡不占额度——
    // 它是状态快照，内容变了就该更新；被限流的是记忆条目的推送。
    this.quota = cache(() => ({ items: 0, chars: 0, lastStep: -Infinity }))
    // 反应窗口：本会话最近观察到的 tool/call（参数里有 git commit / npm publish / 改动的路径）。
    // 宿主没有"工具执行前拦截"钩子，所以这是 pre-step 之外唯一能拿到的动作事实。
    this.observed = cache(() => [])
    this._all = Object.values(this)
  }

  clear() {
    for (const cache of this._all) cache.clear()
  }
}

/** 记录会话里的 tool/call：ops.js 从这些参数解析出 op / 写目标 / 主机。 */
function installCallObserver(ctx, sessions) {
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'tool/call') return
      const sessionId = session && session.id
      if (!sessionId) return
      const data = event.data || {}
      const calls = sessions.observed.ensure(sessionId)
      calls.push({ name: String(data.name || ''), arguments: String(data.arguments || '') })
      if (calls.length > OBSERVED_CALLS_MAX) calls.shift()
    } catch {
      // 观察失败绝不影响宿主请求
    }
  })
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
  const shadow = cfgShadow(config)
  const sessions = new InjectionSessions()

  installCallObserver(ctx, sessions)
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => sessions.clear())
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
      return (await injectForStep({ payload, decision, config, cfg, audit, shadow, sessions })) || decision
    } catch (err) {
      console.error(`[dsh-project-memory] auto-inject skipped: ${err?.message || err}`)
      return decision
    }
  })
}

/**
 * 一个 pre-step 的注入决策：解析会话 → 排程 → 必要时构造消息。
 * 返回 null 表示本步无事可做（交回原决策）。
 */
async function injectForStep({ payload, decision, config, cfg, audit, shadow, sessions }) {
  const session = payload && payload.agent && payload.agent.session
  const root = session && session.header && session.header.cwd
  const sessionId = session && session.id
  if (!root || !sessionId) return null

  const query = lastUserText(decision.messages)
  const memoryRoot = memoryRootFor(root, config.memoryDir)
  const store = new ProjectMemoryStore(memoryRoot).load()
  const globalStore = new GlobalStore(cfg.globalFile || defaultGlobalFile()).load()
  const boundTaskId = store.getBoundTaskId(sessionId)
  const task = boundTaskId ? store.getTask(boundTaskId) : null

  // 两个窗口合并进同一个就绪上下文：人类消息（先发）+ 已观察动作（反应）。
  // 动作平面（S1）：把"最近做过什么"解析成 op / 写目标 / 主机——不再把原始参数当文本搜。
  const observed = sessions.observed.ensure(sessionId)
  const activity = activityFromCalls(observed)
  const readiness = buildReadinessContext({
    humanText: query || '',
    actionText: observed.map((c) => `${c.name} ${c.arguments}`).join('\n'),
    ops: activity.ops,
    targets: activity.targets,
    hosts: activity.hosts,
  })

  const stepNo = sessions.step.ensure(sessionId) + 1
  sessions.step.set(sessionId, stepNo)
  const quota = sessions.quota.ensure(sessionId)
  const silence = sessionSilence({ cfg, quota, stepNo })
  // 条目级去重：本会话已注入过、且正文未变的条目不再参与排程（正文被编辑过 → 立刻允许重发）。
  const skipItem = makeSkipItem(sessions.items.ensure(sessionId), stepNo, cfg.reinjectItemsAfter || 0)

  const built = buildInjection({
    query: query || '',
    readiness,
    task,
    store,
    globalStore,
    projectTagsList: projectTags(root),
    cfg,
    skipItem,
    skipItems: silence.reason !== null,
    silenceReason: silence.reason || 'cooldown',
    maxItems: silence.itemsLeft,
    maxChars: silence.charsLeft,
  })

  // 未注入 ≠ 无事发生：因预算被挤掉的条目按 cfg.budgetLog 留痕（默认 off，见 cfgEngine）。
  // 留痕仍然记账（去重 + 上限），只是默认不外泄到用户的终端。
  recordDropped({ sessions, sessionId, dropped: built.dropped, budgetLog: cfg.budgetLog })

  // 影子记录：**每步**都写一行（含零注入的静默步与对照组），带全部候选的判据特征。
  // 主审计只在真的注入时写，静默步零痕迹 → 日志无法离线重放"换个阈值会怎样"，
  // 也攒不出训练样本。只写盘、不进 prompt、不花 token。
  appendShadowAudit(memoryRoot, shadowRecordFrom({
    sessionId,
    root,
    step: stepNo,
    query: query || '',
    ops: readiness.ops,
    writes: readiness.targets,
    reasons: built.reasons,
    candidates: built.candidates,
    silence: silence.reason,
  }), shadow)

  const fp = fingerprint(built.dedupeText ?? built.text)
  if (!built.text || fp === sessions.lastText.peek(sessionId)) return null
  sessions.lastText.set(sessionId, fp)

  // 只记真的进了上下文的那几条：dropped 的没被看到，不能记账（否则以后永远不再注入）。
  const seen = sessions.items.ensure(sessionId)
  for (const r of built.reasons) {
    if (r && r.id && r.hash) seen.set(r.id, { hash: r.hash, step: stepNo })
  }
  // 会话额度只被"条目"消耗；任务卡不算（否则任务一多就把记忆挤没了）。
  if (built.reasons.length) {
    quota.items += built.reasons.length
    quota.chars += typeof built.itemChars === 'number' ? built.itemChars : 0
    quota.lastStep = stepNo
  }

  // 使用记账：注入进上下文 = 这条记忆被用到了。必须在这里显式落盘——注入路径不会走到
  // 任何其它 save()，只标脏等于进程退出就丢。记账失败绝不影响注入（与审计同约定）。
  if (built.reasons.length) {
    try {
      if (recordHit({ store, globalStore, ids: built.reasons.map((r) => r.id) })) {
        store.save()
        globalStore.commit()
      }
    } catch {
      /* ignore：记账是旁路，不能拖累注入 */
    }
  }

  // S0 观测：只记真的进了上下文的那一次（dropped 单独出现不写，否则每步刷屏）。
  appendInjectionAudit(memoryRoot, auditRecordFrom({
    sessionId,
    root,
    step: stepNo,
    text: built.text,
    labels: built.labels,
    reasons: built.reasons,
    dropped: built.dropped,
    budget: { items: quota.items, chars: quota.chars, lastStep: Number.isFinite(quota.lastStep) ? quota.lastStep : null },
    silence: silence.reason,
  }), audit)

  return { ...decision, messages: [...decision.messages, injectionMessage(built.text)] }
}

/**
 * 会话级限流（S3）：冷却步数 / 条目条数 / 条目字符。三个任一触顶 → 条目通道整体沉默，
 * 但本轮"本该注入什么"仍会进 dropped（不做静默降级）。
 */
function sessionSilence({ cfg, quota, stepNo }) {
  const cooling = Number.isFinite(quota.lastStep) && stepNo - quota.lastStep < cfg.gateCooldownSteps
  const itemsLeft = Math.max(0, cfg.maxItemsPerSession - quota.items)
  const charsLeft = Math.max(0, cfg.maxItemCharsPerSession - quota.chars)
  const reason = cooling ? 'cooldown'
    : itemsLeft === 0 ? 'session-items'
      : charsLeft === 0 ? 'session-chars' : null
  return { reason, itemsLeft, charsLeft }
}

/** 条目级去重判据：会话里注入过且正文未变 → 跳过。cooldown=0 永久有效，>0 走步数冷却。 */
function makeSkipItem(seen, stepNo, cooldown) {
  return (it) => {
    const rec = seen.get(it.id)
    if (!rec || rec.hash !== insightItemHash(it)) return false
    return cooldown === 0 || stepNo - rec.step < cooldown
  }
}

/** 预算丢弃的留痕（cfg.budgetLog）：once=每会话首次，all=丢弃组合每变一次。 */
function recordDropped({ sessions, sessionId, dropped, budgetLog }) {
  if (!dropped || !dropped.length || budgetLog === 'off') return
  const signature = dropped.map((d) => `${d.id}:${d.reason}`).join(',')
  const previous = sessions.lastDropped.peek(sessionId)
  if (previous === signature) return
  sessions.lastDropped.set(sessionId, signature)
  if (budgetLog === 'all' || previous === undefined) {
    console.error(
      `[dsh-project-memory] auto-inject degraded: ${dropped.length} insight(s) kept out by budget — `
      + dropped.map((d) => `${d.id}(${d.reason})`).join(', '),
    )
  }
}

/** 追加的注入消息：必须是带 source 的完整消息——裸 {role,content} 会让宿主读 message.source 时崩。 */
function injectionMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text: `\n\n${INJECT_MARK} auto-context\n${text}` }],
    // 这一块是「同一生产者后续快照会取代的当前状态」，不是一次性通知。
    // 宿主 ContextFormed 是判别联合：snapshot 必须带 sections（notice 才需要 summary）。
    // 通道不变（仍走 agent/pre-step 追加 user 消息），只修语义。
    source: {
      kind: 'plugin',
      plugin: 'dsh-project-memory',
      form: 'snapshot',
      sections: [{ name: 'project-memory', text }],
    },
  })
}