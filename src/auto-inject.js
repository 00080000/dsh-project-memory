// 静默注入引擎（entry 常驻块 + relevance 门控）。
// 安全约定：buildInjection 是纯函数可单测；唯一接线点是宿主 agent/pre-step 瀑布事件；
// 任何异常/无会话 cwd 都交回合法决策，绝不返回 undefined（宿主直接读 decision.kind）。
// 注入文本带 [Memory Inject] 前缀，作为一条 plugin source 的 user 消息追加，按会话指纹去重。
import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ProjectMemoryStore } from './store.js'
import { hasProjectMarker, memoryRootFor, resolveProjectMemoryRoot, rootRejection } from './util/fs.js'
import { textOf } from './util/text.js'
import { stepContent } from './util/task-view.js'
import { insightMatchText, normalizedTokenOverlap } from './similarity.js'
import { createVectorCosine, createVectorRerank, vectorItemsFrom } from './vector-index.js'
import { BoundedMap, SessionCache } from './util/session-cache.js'
import { sessionWorkingDir } from './util/session-dir.js'
import { cfgInsight, GlobalStore, defaultGlobalFile, recordHit } from './insight-store.js'
import { projectTags } from './project-profile.js'
import { rankEntriesMergedScored } from './util/search.js'
import { insightToEntry, insightScoringText } from './recall.js'
import { buildReadinessContext, hintQueryText, corpusTermSets, idfCoveragePrepared, matchTrigger, normalizeTrigger, relativeHits } from './readiness.js'
import { activityFromCalls } from './ops.js'
import { appendInjectionAudit, appendShadowAudit, auditRecordFrom, cfgAudit, cfgShadow, shadowRecordFrom } from './audit.js'

export const INJECT_MARK = '[Memory Inject]'

/**
 * 注入块抬头里的插件名。
 * 消息的 `source.kind` 只有宿主看得到（请求序列化只取 `role` 与 `content`），抬头是模型与 GUI 用户
 * 唯一能看见生产者的地方。抬头不是行为契约：客户端不解析它，判据也不读它。
 */
export const PLUGIN_NAME = 'dsh-project-memory'

/**
 * 本插件在 `message.source` 上声明的生产者 kind。
 * 会话格式 v4 没有 `plugin` 兜底 kind：宿主会直接拒绝 `kind === 'plugin'` 的消息，
 * 且拒绝发生在编码落盘那一刻——整轮运行失败。
 * 值取 `plugin:<包名>`：这正是宿主 v3→v4 迁移改写本插件历史消息的结果，新写与迁移后是同一个
 * 生产者身份，自激闸门（isOwnInjection）不必按新旧分叉。
 */
export const SOURCE_KIND = 'plugin:dsh-project-memory'

/**
 * 这条消息是不是本插件自己注入的？三种写法都要认，因为同一条历史消息在不同阶段形状不同：
 * `plugin:dsh-project-memory`（现在写的，也是迁移结果）、`project-memory`（保留的别名，将来换 kind
 * 时自激闸门不失效）、`plugin: 'dsh-project-memory'`（迁移前尚未落盘的旧形状）。
 * @param {object|undefined|null} source - message.source
 * @returns {boolean}
 */
export function isOwnInjection(source) {
  if (!source || typeof source !== 'object') return false
  return source.kind === SOURCE_KIND
    || source.kind === 'project-memory'
    || source.plugin === 'dsh-project-memory'
}

/** 注入正文的最小可用长度：预算塞不下就宁可不注入（记 dropped）——stub 只消耗 token 不传递信息。 */
const MIN_BODY_CHARS = { trigger: 48, hint: 120 }

/** 注入引擎配置：insight 默认之上叠加 autoContext 预算/门控参数。 */
export function cfgEngine(config) {
  const c = (config && config.autoContext) || {}
  const base = cfgInsight(config)
  return {
    ...base,
    maxTokens: typeof c.maxTokens === 'number' ? c.maxTokens : 400,
    entryMaxInsights: typeof c.entryMaxInsights === 'number' ? c.entryMaxInsights : 6,
    // 提示通道的相对阈值（层内最高分比例）：尺度无关；旧 overlap 判据对长消息必然趋零（实测 0.014–0.057）。
    signalMinRatio: typeof c.signalMinRatio === 'number' ? c.signalMinRatio : 0.5,
    // 兼容闸门：显式配置 relevanceMin 时仍走旧的绝对 overlap 判据；不配置则为 null（走相对阈值）。
    relevanceMin: typeof c.relevanceMin === 'number' ? c.relevanceMin : null,
    // resident 任务卡最多显示几个"编辑中"文件（纯写权重，最近写优先）
    editedMax: typeof c.editedMax === 'number' ? c.editedMax : 3,
    // 常驻任务卡总开关（entryOn:false = 只做条目注入，不回声任务卡）
    entryOn: c.entryOn !== false,
    // 模型自己写/维护任务清单后、尚无新人类消息时，不把任务卡再回声给模型（省 token）
    skipEchoSelfTodo: c.skipEchoSelfTodo !== false,
    // 预算审计日志级别（stderr）。默认 off：预算挤掉低优先级条目是正常降级、不是故障，而终端
    // 是用户可见面，默认打印会让一次启动刷出多行（off / once / all 三档）。
    budgetLog: ['off', 'once', 'all'].includes(c.budgetLog) ? c.budgetLog : 'off',
    // 同一条 insight 在本会话重复注入的冷却（pre-step 步数）。0（默认）= 内容没变就不再注入
    // （宿主不压缩历史）；>0 用于历史可能被外部裁剪的场景。
    reinjectItemsAfter: typeof c.reinjectItemsAfter === 'number' && c.reinjectItemsAfter >= 0 ? c.reinjectItemsAfter : 0,
    // legacy `trigger.scope` 默认 **ignore**（保留历史数据、不静默改用户数据）：作者手写的值
    // 落不进自动派生的画像 tag 空间，当收窄条件等于判死条目；显式配 'filter' 才恢复旧语义。
    legacyScope: c.legacyScope === 'filter' ? 'filter' : 'ignore',
    // 条目通道的步间隔：两次条目注入至少隔这么多步（常驻任务卡不受限——它是状态快照）。
    gateCooldownSteps: typeof c.gateCooldownSteps === 'number' && c.gateCooldownSteps >= 0 ? c.gateCooldownSteps : 2,
    // 每会话条目注入上限（条数 / 字符）：这是**保险丝**，不是节流阀——节流由 maxTokens 与 gateCooldownSteps
    // 负责，这两个数只兜住病态 runaway。旧默认 12 条 / 4000 字符实测 11/81 个会话打满后永久静默
    // （1234 步失明），最长会话用 35 条 / 8640 字符，故取 60 / 24000。
    maxItemsPerSession: typeof c.maxItemsPerSession === 'number' && c.maxItemsPerSession >= 0 ? c.maxItemsPerSession : 60,
    maxItemCharsPerSession: typeof c.maxItemCharsPerSession === 'number' && c.maxItemCharsPerSession >= 0 ? c.maxItemCharsPerSession : 24000,
    // 提示通道的**绝对**覆盖底线（IDF 加权覆盖率）：只有归一在 [0,1]、有真零点才谈得上下限。
    // 0.30 的实测反例：真实 store（43 条同源洞察）上对照场景以 cov 0.32~0.35 注入 3 条无关条目
    // （同源语料共享词多、IDF 分辨力被拉平）。0.45 落在实测空隙里（假阳性 ≤0.35、下一个真命中
    // ≥0.49）；合成标注集在 0.6 以前 precision/recall 仍是 1.00。
    hintMinCoverage: typeof c.hintMinCoverage === 'number' && c.hintMinCoverage >= 0 ? c.hintMinCoverage : 0.45,
    // 提示通道还要求至少这么多个共同词：单个通用词（"插件"）也能拿到 coverage=1.00。
    hintMinMatched: typeof c.hintMinMatched === 'number' && c.hintMinMatched >= 0 ? c.hintMinMatched : 2,
    // 通道级沉默：查询里能在语料中找到对应的词占比低于它时，整条提示通道本轮不出声
    // （长句里只有一两个词碰巧命中时，coverage 会虚高到 1.00）。
    hintMinSupport: typeof c.hintMinSupport === 'number' && c.hintMinSupport >= 0 ? c.hintMinSupport : 0.15,
    // 可选向量层（leanvec）：`vectorDir` 无默认值 = 默认纯词法；配了目录/环境变量/可选依赖才构造 rerank。
    vectorDir: typeof c.vectorDir === 'string' && c.vectorDir ? c.vectorDir : null,
    vectorAlpha: typeof c.vectorAlpha === 'number' && c.vectorAlpha >= 0 && c.vectorAlpha <= 1 ? c.vectorAlpha : 0.5,
    // 写入侧近重复检测的独立开关（默认开）。**不跟随 vectorAlpha**：后者是排序权重，设 0 只该关重排，
    // 不该连带停掉 0.9 自动覆盖 / 0.7 近邻提示。
    vectorDedup: c.vectorDedup !== false,
    // 两个**实验性**旋钮：没有可发布的默认值（见 scoreHints 的注释），所以不设就不启用。
    vectorItemMin: typeof c.vectorItemMin === 'number' && Number.isFinite(c.vectorItemMin) ? c.vectorItemMin : undefined,
    vectorSpeakMin: typeof c.vectorSpeakMin === 'number' && Number.isFinite(c.vectorSpeakMin) ? c.vectorSpeakMin : undefined,
  }
}

/**
 * 给写入路径（`save_lesson` / `remember`）用的向量打分器：**没装/没配就是 null**。
 * 与注入路径共用解析入口（`openEngine`），但**不共用开关**：写入去重由 `autoContext.vectorDedup`
 * 控制，不受 `vectorAlpha`（排序权重）影响。返回的函数是同步的，供 `saveInsight` 在写事务里直接调用；
 * 任何异常都降级成 null，绝不因为可选的向量层挡住写入。
 * @param {object} config - 插件配置
 * @param {{storeDir: string|null, items: object[]}} o - 持久化位置与候选池（见 vectorItemsFrom）
 * @returns {Promise<((text: string, items: object[]) => Map<string, number>)|null>}
 */
export async function createWriteCosine(config, { storeDir = null, items = [] } = {}) {
  const engine = cfgEngine(config)
  try {
    return await createVectorCosine({ storeDir, items, vectorDir: engine.vectorDir, dedup: engine.vectorDedup })
  } catch {
    return null
  }
}

/**
 * 从一份消息列表里取"人说的话"。
 * 只认 `role=user` **且**（`source.kind === 'user'` 或无 source 的老宿主/测试）：`agent-message`、
 * `subagent-settled`、`tool-jobs`、`time-context`、`runtime-context` 都不是人说的。实测子代理报告里的
 * "发布/渲染"曾被当成用户意图，触发 `intent:release` 与 `intent:渲染` 两条无关 procedure。
 * `agent/pre-step` 的 `messages` 是 claimed **delta**，会话中段通常没有真人消息——调用方应回退到
 * 每会话缓存（见 `InjectionSessions.humanText`）。
 * @param {object[]} messages
 * @returns {string} 人类消息正文；没有则空串
 */
export function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== 'user') continue
    const t = textOf(m)
    if (!t.trim()) continue
    // 本插件注入的块也是 role=user：绝不能再拿它当查询（自激）。
    if (isOwnInjection(m.source)) continue
    const kind = m.source && m.source.kind
    if (kind && kind !== 'user') continue
    return t.trim()
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
 * 是否回声 resident 任务卡：最近一次推进是模型自己 todo 写步骤、且之后没有新人类消息时不回声
 * （刚写的东西再喂回去 = 噪音/浪费 token）。保留相关 insights 注入不变。
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
 * 去重指纹**包含**“编辑中”行：否则常驻卡会停在第一次注入时的文件列表（写文件不改变指纹）。 */
export function buildEntryContent(task, cfg, { withEdited = true } = {}) {
  if (!task) return ''
  const c = cfg || {}
  const steps = (task.steps || []).map((s) => stepContent(s).slice(0, 80))
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
 * 准入化：只有 `when`（op / 写目标 / 意图词）能触发，guard 只能收窄；
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
 * 查询只用人类消息意图 + 本次写目标：原始工具参数正是 `dcterms→rm`、`*.pptx→论文笔记` 类假阳性的来源。
 * 可选的 `rerank` 只改层内排序与 `relative` 那一关，闸门（支持度/覆盖率/共同词数）仍由词法决定。
 * @param {{ score: (q: string, cands: object[]) => Map<string, number>, alpha?: number, itemMin?: number, speakMin?: number }} [rerank]
 *   `itemMin` 低于则不进提示通道（只作用于提示，不碰 trigger）；`speakMin` 达到则免于被通道级 `hintMinSupport` 静音。
 *   ⚠ 两个旋钮**都没有可发布的默认值**：itemMin 在真实交付上分辨力为零（绝对常量不可移植、尺度无关量也不行、
 *   逐条标签不稳，kappa −0.05）；speakMin 的对照与真命中只隔 0.016。
 */
function scoreHints({ cands, query, humanText, hintQuery, cfg, dropped, rerank = null }) {
  const hints = []
  // 影子记录用：本步**全部**被评过分的候选 + 特征 + 判据结果。与 hints/dropped 分开算——
  // 那两类只覆盖"过得了相对阈值"的部分，缺的正是离线重放阈值时要的那批。
  const candidates = []
  // 真正用于评分的查询文本。影子记录必须留下它：`query`（人类消息原文）与它不是一回事，
  // 写目标驱动的步 `query` 为空、候选却非空。
  const q = hintQueryText(hintQuery)
  if (!cands.length) return { hints, candidates, scoreQuery: q }
  if (typeof cfg.relevanceMin === 'number') {
    // 兼容：显式 relevanceMin → 旧的绝对 overlap 判据（老 profile 行为不变）
    for (const it of cands) {
      const score = normalizedTokenOverlap(humanText || query || '', insightMatchText(it))
      if (score >= cfg.relevanceMin) hints.push({ it, score, why: `overlap:${score.toFixed(3)}` })
    }
    hints.sort((a, b) => b.score - a.score)
    return { hints, candidates, scoreQuery: q } // 旧判据路径不产出影子候选
  }
  if (!q) return { hints, candidates, scoreQuery: q }
  const byId = new Map(cands.map((it) => [it.id, it]))
  // 覆盖率语料必须与 BM25 排序同源（insightScoringText），否则只在 fix/solution 匹配的词
  // df=0 → supportRatio=0 → 整条提示通道沉默，而排序明明给了高分。
  const corpus = cands.map((it) => insightScoringText(it))
  // 查询与覆盖率文本用**同一个**过滤后的查询：否则缩写会在 BM25 里被剔除、却仍计入覆盖率。
  const scored = rankEntriesMergedScored(cands.map(insightToEntry), [q], cands.length)
  // ---- 向量重排（可选、默认关闭）：只改**排序**与 `relative` 那一关，绝不碰 support/coverage/thin ----
  // 实测（8 场景/24 条池）expect 为空的对照场景纯向量 top-1 = 0.38，多条真命中只有 0.20~0.38，
  // 余弦与真值区间重叠 → 任何绝对余弦阈值要么放过对照、要么杀掉真命中；所以闸门继续由词法决定。
  // `rerank.score` 返回 Map<insightId, cos∈[0,1]>；**查询无法编码时应返回空 Map**——排序退化回纯词法。
  if (rerank && typeof rerank.score === 'function') {
    const alpha = Math.max(0, Math.min(1, typeof rerank.alpha === 'number' ? rerank.alpha : 0.5))
    let cos = null
    try { cos = rerank.score(q, cands) } catch { cos = null } // 向量层任何异常都不得影响注入
    const top0 = scored[0]?.score || 1
    for (const r of scored) {
      const v = cos instanceof Map ? cos.get(r.entry.insightId) : undefined
      const has = typeof v === 'number' && Number.isFinite(v)
      // 先留一份**未融合**的 BM25 原分：影子记录的 `rel` 必须继续是词法相对分，否则离线重放会被融合分污染。
      r.bm25 = r.score
      r.vector = has ? v : null
      // 有向量分的：归一后词法分与余弦按 α 混合；没有的只保留归一后词法分（缺向量不等于不相关）。
      r.score = has ? (1 - alpha) * (r.score / top0) + alpha * v : r.score / top0
    }
    scored.sort((a, b) => b.score - a.score)
  } else {
    for (const r of scored) r.vector = null
  }
  // 语料词集合建**一次**再逐条算覆盖率：逐条 idfCoverage 是 O(C²) tokenize（实测单步 147ms → 1.3ms，109×，结果一致）。
  const corpusSets = corpusTermSets(corpus)
  const coverage = new Map(cands.map((it, i) => [it.id, idfCoveragePrepared(q, corpus[i], corpusSets)]))
  const qStats = coverage.get(cands[0].id) || { supported: 0, terms: 0 }
  const supportRatio = qStats.terms > 0 ? qStats.supported / qStats.terms : 0
  // 通道级沉默：查询里绝大多数词在语料里没有对应 → "覆盖率 1.00"只是假象。它是**比率**，长句在小语料上
  // 必然低（自然语言实测只有 0.11~0.13）。因此加一条**可选**语义救援：提供了向量层且层内最高余弦达到
  // `speakMin` 时本轮不沉默。它**不放松任何逐条闸门**（coverage/matched/relative 照旧），没有向量时行为不变。
  let vectorRescue = false
  if (rerank && typeof rerank.speakMin === 'number') {
    let topCos = 0
    for (const r of scored) if (typeof r.vector === 'number' && r.vector > topCos) topCos = r.vector
    vectorRescue = topCos >= rerank.speakMin
  }
  const channelThin = typeof cfg.hintMinSupport === 'number' && supportRatio < cfg.hintMinSupport && !vectorRescue
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
    // 共同词数下限按**查询本身的词数**收敛（查询很短时不强求两个）：按"语料能表示的词数"会在长杂查询上退化成 1。
    const needMatched = Math.min(typeof cfg.hintMinMatched === 'number' ? cfg.hintMinMatched : 2, ev.terms)
    if (ev.matched < needMatched) {
      dropped.push({ id: it.id, channel: 'hint', reason: `thin:${ev.matched}` })
      continue
    }
    // item 级余弦地板（可选）：**只作用于提示通道**——authored trigger 是确定性全文注入契约，绝不能被向量拦。
    // 实测（24 条池）：假阳性 0.351 vs 真命中 0.530，间隔 0.179；取不到向量时不设限。
    if (rerank && typeof rerank.itemMin === 'number' && typeof r.vector === 'number' && r.vector < rerank.itemMin) {
      dropped.push({ id: it.id, channel: 'hint', reason: `vector:${r.vector.toFixed(2)}` })
      continue
    }
    hints.push({ it, score: r.score, why: `relative:${(r.score / (scored[0].score || 1)).toFixed(2)} cov:${ev.coverage.toFixed(2)}/${ev.matched}` })
  }

  // ---- 影子候选（只读、无副作用）：重放全部被评分的条目，标出它卡在哪一关 ----
  // 顺序与真实判据一致（support → coverage → thin → relative）；'cand' 不等于"真的注入了"（还要过去重/预算/冷却）。
  {
    // 两个分母必须分开：真实判据（`relative`）用**融合后**的分，而影子记录的 `rel` 承诺**词法**相对分；
    // 共用会让 `rel` 到 5.925（应当 ≤1），离线拿它重放阈值全歪。
    const top = scored[0]?.score || 0
    let lexTop = 0
    for (const r of scored) {
      const lex = r.bm25 ?? r.score
      if (Number.isFinite(lex) && lex > lexTop) lexTop = lex
    }
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
      else if (rerank && typeof rerank.itemMin === 'number' && typeof r.vector === 'number' && r.vector < rerank.itemMin) decision = 'vector'
      else if (r.score < top * Math.max(0, Math.min(1, ratio))) decision = 'relative'
      const cand = {
        id: it.id,
        channel: 'hint',
        // `rel` 恒为**词法**相对分（分母是词法 top）；融合后的分另记 fused，`decision: 'relative'` 仍用融合分。
        rel: Number(((r.bm25 ?? r.score) / (lexTop || 1)).toFixed(3)),
        coverage: Number(ev.coverage.toFixed(3)),
        matched: ev.matched,
        support: ev.supported,
        terms: ev.terms,
        decision,
      }
      // 只在启用重排时加字段：默认路径的记录与旧版逐字节一致（不引入 undefined 键）。
      if (rerank) {
        cand.fused = Number(r.score.toFixed(3))
        cand.vector = r.vector == null ? null : Number(r.vector.toFixed(3))
        // 本轮是否靠语义救援才免于被 `support` 整条静音（0/1），离线重放靠它区分两条门。
        cand.rescue = vectorRescue ? 1 : 0
      }
      candidates.push(cand)
    }
  }
  return { hints, candidates, scoreQuery: q }
}

/**
 * 构建注入内容（不写盘、无副作用）。
 * 交付契约：**authored trigger（所有 kind）= 确定性全文注入，优先级 1；统计信号 = 截断提示，优先级 2**。
 * 预算排程：常驻任务卡 → trigger 命中 → 提示；每一步都记 `reasons`（为什么注入）与 `dropped`
 * （为什么没注入），让"注入/未注入"可审计。
 * @param {object} opts { query, readiness, task, store, globalStore, projectTagsList, cfg, skipItem? }
 * @param {(it: object) => boolean} [opts.skipItem] 条目级去重：返回 true 的条目直接退出排程
 *   （本会话已注入过且正文未变）。在排程前过滤，省下的预算留给新条目。
 * @returns {{ text: string, labels: string[], reasons: object[], dropped: object[] }}
 */
export function buildInjection(opts) {
  const { query, task, globalStore, cfg } = opts
  const store = opts.store || null
  const tags = opts.projectTagsList || []
  // 就绪上下文可能**已经构建过**（injectForStep 先构建、再传给这里）。二次构建会把第一遍的
  // `actions` 当成"调用方声明的动作"重新信任——散文里的 file-delete 会绕过 PRE_ACTION_OPS 过滤。
  // 结构化标记：带 ops + intentOps 的上下文是构建产物，只补 tags，不再重新归一。
  const built = opts.readiness && Array.isArray(opts.readiness.ops) && Array.isArray(opts.readiness.intentOps)
  const ctx = built
    ? { ...opts.readiness, tags: [...new Set([...(opts.readiness.tags || []), ...tags])] }
    : buildReadinessContext({ ...(opts.readiness || { humanText: query || '' }), tags })
  const labels = []
  const reasons = []
  const dropped = []
  const parts = []
  // 预算只能是上限，不是目标。两条额度分开：stepBudget 是单轮（常驻块 + 条目）共享的 maxTokens；
  // itemBudget 是条目还受的会话字符额度，**常驻块不占这条**（它是状态快照，文档明说不受限）。
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
  // 限流命中时**照旧评分**（只算不注入，`place()` 仍按 skipItems 跳过）：影子记录要能回答"这一步
  // 如果不限流会注入什么"——那正是限流期间最需要回答的问题。
  const hintCands = cands.filter((it) => !consumed.has(it.id) && it.kind !== 'procedure')
  const { hints, candidates, scoreQuery } = scoreHints({
    cands: hintCands,
    query,
    humanText: ctx.humanText,
    hintQuery: [ctx.intent || ctx.humanText || '', ...(ctx.targets || [])].filter(Boolean).join(' '),
    cfg,
    dropped,
    rerank: opts.rerank || null,
  })

  // 常驻块文本。去重指纹包含“编辑中”行：否则这条常驻状态只会在别的条目变化时顺带更新，
  // 模型会一直看到旧文件列表；只有热点文件集合/顺序变化时才重发整块。
  const echo = cfg.entryOn !== false && shouldEchoTaskCard(task, cfg)
  const entry = echo ? buildEntryContent(task, cfg) : ''
  const entryStable = entry
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
        // 带出数字：`budget` 没有量纲，"还剩 38 字符、这条最少要 120" 与"根本没预算"在日志里长得一样。
        dropped.push({ id: it.id, channel, reason: 'budget', remaining, need: minChars })
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

  // 预算层结局写回候选。`decision` 是**门槛层**结论，`outcome` 是**预算层**结论，两者正交：
  // "过了全部门槛却没注入"必须能归因。
  {
    const outcomeById = new Map()
    for (const r of reasons) outcomeById.set(`${r.channel}\u0000${r.id}`, 'injected')
    for (const d of dropped) {
      const key = `${d.channel}\u0000${d.id}`
      if (!outcomeById.has(key)) outcomeById.set(key, d.reason)
    }
    for (const c of candidates) {
      c.outcome = skipItems ? 'idle'
        : c.decision !== 'cand' ? 'gate'
          : outcomeById.get(`hint\u0000${c.id}`) || 'unscheduled'
    }
  }

  const total = [entry, ...parts].filter(Boolean)
  // 早退也必须带上 candidates/scoreQuery：空块不等于"没有候选"（无任务卡 + 全部被预算挤掉就是这种形状）。
  if (!total.length) {
    return { text: '', entry, labels, reasons, dropped, candidates, scoreQuery, itemChars: itemUsed }
  }
  // 整块只受单轮预算（maxTokens）约束；会话条目额度已在 place() 里单独扣过。
  const clamp = (t) => (t.length > stepBudget ? `${t.slice(0, stepBudget)}\n…(截断)` : t)
  const dedupeText = clamp([entryStable, ...parts].filter(Boolean).join('\n'))
  return { text: clamp(total.join('\n')), entry, entryStable, labels, reasons, dropped, candidates, scoreQuery, dedupeText, itemChars: itemUsed }
}

// 每会话状态的会话数上限：六张表共用。
const SESSION_STATE_MAX = 200
// 单会话已注入条目表的条数上限。
const INJECTED_ITEMS_MAX = 600
// 单会话保留的 tool/call 观察窗口（够覆盖"最近几步在做什么"）。
const OBSERVED_CALLS_MAX = 8

/**
 * 注入引擎的「每会话一份」状态。
 * 六张表都由 SessionCache 管容量，容量只在这里定义一次。
 */
class InjectionSessions {
  constructor() {
    const cache = (create) => new SessionCache({ maxSessions: SESSION_STATE_MAX, create })
    // 上次注入指纹：用单个变量会让并发会话互相抑制注入。
    this.lastText = cache()
    // 上次预算丢弃签名：预算把条目挤出去时必须留痕一次，而不是静默（degraded 可见性）。
    this.lastDropped = cache()
    // 条目级去重记忆：insightId → { hash, step }。注入的消息留在 append-only 的历史里，所以
    // "整块指纹变了"不等于"内容都是新的"：滑动窗口 / 任务卡更新都会让同一份 procedure 被重发
    // （实测 66 步注入 20 次，同一份 1732 字重发 3 次）。
    this.items = cache(() => new BoundedMap(INJECTED_ITEMS_MAX))
    // 会话步数：为 reinjectItemsAfter 提供时间轴。
    this.step = cache(() => 0)
    // 会话级条目额度：条数 / 字符 / 上次"条目注入"的步号。常驻任务卡不占额度——
    // 它是状态快照，被限流的是记忆条目的推送。
    this.quota = cache(() => ({ items: 0, chars: 0, lastStep: -Infinity }))
    // 反应窗口：本会话最近观察到的 tool/call（参数里有 git commit / npm publish / 改动的路径）。
    // 宿主没有"工具执行前拦截"钩子，所以这是 pre-step 之外唯一能拿到的动作事实。
    this.observed = cache(() => [])
    // 本会话最后一条**真人**消息。`agent/pre-step` 拿到的是 claimed delta，会话中段通常是子代理报告 /
    // job 通知 / 时间快照（实测 386 步里只有 31 步有真人 query）。意图是会话状态，不是这一步恰好收到的文本。
    this.humanText = cache()
    // 本会话是否已通告"记忆根是推定的"（会话工作目录，无项目标记）。状态声明只发一次。
    this.rootNoticed = cache(() => false)
    this._all = Object.values(this)
  }

  clear() {
    for (const cache of this._all) cache.clear()
  }
}

/**
 * 记录会话里的两类事实：
 *  - `user/message`（**真人的**）→ 每会话最后一条人类消息。它是会话状态，不是本步增量；
 *  - `tool/call` → 最近 8 次调用，ops.js 从结构化参数解析 op / 写目标 / 主机。
 * 两者都只从**事件**里来，不再把任意工具的参数拼成文本再解析（那会让 subagent 提示词里的
 * "删除/迁移"变成父会话的动作）。
 */
function installCallObserver(ctx, sessions) {
  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session && session.id
      if (!sessionId || !event) return
      if (event.type === 'user/message') {
        const data = event.data || {}
        const source = data.source
        // 自注入块（包括迁移前的旧形状）不是人话：放进 humanText 会让下一步拿注入正文再检索（自激）。
        // 与 lastUserText 共用同一判据。
        if (isOwnInjection(source)) return
        const kind = source && source.kind
        // 通知 / relay / job / 时间快照都不是人说的；无 source 的老宿主按人话处理（与 lastUserText 同口径）。
        if (kind && kind !== 'user') return
        const text = textOf({ content: data.content })
        if (text.trim()) sessions.humanText.set(sessionId, text.trim())
        return
      }
      if (event.type !== 'tool/call') return
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
 * 宿主瀑布事件签名是 (payload, next)：payload.agent.session 提供会话（header.cwd=项目根）。
 * 任何异常/无会话 cwd → 原样返回默认决策，零副作用，绝不让宿主请求受影响。 */
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
    // 宿主契约是 waterfall(payload, next)，next 一定存在；但宿主版本漂移或事件被当普通事件调用时，
    // next 缺失会让本监听器 reject。更致命的是返回 undefined：宿主 agent.ts 直接读 `decision.kind`，
    // 会崩掉整步 → 无法回复。因此两种情况都退化为一个合法的 enter 决策。
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

/** 已就「会话根不安全」提示过的目录：每个进程、每个根只提示一次。 */
const warnedUnsafeRoots = new Set()

function warnUnsafeSessionRoot(root, rejection) {
  if (warnedUnsafeRoots.has(root)) return
  warnedUnsafeRoots.add(root)
  const field = rejection?.field ? `; adjust \`${rejection.field}\` under \`- id: project-memory\` if this is intentional` : ''
  console.error(
    `[dsh-project-memory] session cwd ${root} is not a project root (${rejection?.reason || 'home / system / package-manager prefix'}${field}); ` +
      'project memory and its audit logs are disabled for this session. Start dsh inside a project directory to enable them.',
  )
}

/**
 * 一个 pre-step 的注入决策：解析会话 → 排程 → 必要时构造消息。
 * 返回 null 表示本步无事可做（交回原决策）。
 */
async function injectForStep({ payload, decision, config, cfg, audit, shadow, sessions }) {
  const session = payload && payload.agent && payload.agent.session
  // 与工具侧同一口径的「当前工作目录」：0.2.1+ 走 workingDirectory 投影（cd 后会变），老宿主回退
  // header.cwd。少了这一步，cd 之后审计与懒索引会落在两个不同的 store 里。
  const cwd = sessionWorkingDir(session, { agent: payload?.agent })
  const sessionId = session && session.id
  if (!cwd || !sessionId) return null
  // 会话 cwd 命中内置名单 / roots.deny / roots.exclude 时整条链路停在这里：不读 store（历史遗留的
  // 超大 store 光是 load() 就能 OOM），也不写审计——`appendShadowAudit` 里的 mkdirSync 正是把
  // `.dsh-project-memory` 造进家目录、进而触发"目录自标记 → 家目录被锁成项目"的那一步。
  const rejection = rootRejection(cwd, config)
  if (rejection) {
    warnUnsafeSessionRoot(cwd, rejection)
    return null
  }
  // 记忆根与懒索引/工具侧同一套解析：项目标记优先，其次是安全的会话工作目录。
  // 少了这一步，同一个会话的审计日志与懒索引会落在两个不同的 store 里。
  const root = resolveProjectMemoryRoot(cwd, config)
  if (!root) return null

  // 意图是**会话状态**：先看本步 delta 有没有新人类消息，没有则回退本会话最后一条。claimed delta
  // 中段通常只有 tool result / 子代理报告 / job 通知，拿它们当查询就是"这步在做什么"用错了来源。
  const deltaHuman = lastUserText(decision.messages)
  const rememberedHuman = sessions.humanText.peek(sessionId) || ''
  const query = deltaHuman || rememberedHuman
  const querySource = deltaHuman ? 'delta' : rememberedHuman ? 'session' : 'none'
  const memoryRoot = memoryRootFor(root, config.memoryDir)
  const store = new ProjectMemoryStore(memoryRoot).load()
  const globalStore = new GlobalStore(cfg.globalFile || defaultGlobalFile()).load()
  const boundTaskId = store.getBoundTaskId(sessionId)
  const task = boundTaskId ? store.getTask(boundTaskId) : null

  // 两个窗口合并进同一个就绪上下文：人类消息（先发）+ 已观察动作（反应）。动作平面**只**从结构化
  // tool/call 归一，不再把全部参数拼成 actionText（那会把 subagent 提示词/remember 正文当成动作）。
  const observed = sessions.observed.ensure(sessionId)
  const activity = activityFromCalls(observed)
  const readiness = buildReadinessContext({
    humanText: query || '',
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
    // 可选向量层：没装/没配就是 null → 提示通道与纯词法逐字段一致（闸门、注入条数都不变，只有层内排序
    // 用到余弦）。构造失败也在 createVectorRerank 内部吞掉并返回 null。
    rerank: await createVectorRerank({
      storeDir: memoryRoot,
      items: vectorItemsFrom(store, globalStore),
      vectorDir: cfg.vectorDir,
      alpha: cfg.vectorAlpha,
      // 两个实验性旋钮：不配就是 undefined → 对应的闸门整段不执行（默认路径与旧版一致）
      itemMin: cfg.vectorItemMin,
      speakMin: cfg.vectorSpeakMin,
    }),
  })

  // 未注入 ≠ 无事发生：因预算被挤掉的条目按 cfg.budgetLog 留痕（默认 off，见 cfgEngine）。
  // 留痕仍然记账（去重 + 上限），只是默认不外泄到用户的终端。
  recordDropped({ sessions, sessionId, dropped: built.dropped, budgetLog: cfg.budgetLog })

  // 影子记录：**每步**都写一行（含零注入的静默步与对照组），带全部候选的判据特征。主审计只在真的
  // 注入时写，静默步零痕迹 → 日志无法离线重放"换个阈值会怎样"。只写盘、不进 prompt、不花 token。
  appendShadowAudit(memoryRoot, shadowRecordFrom({
    sessionId,
    root,
    step: stepNo,
    query: query || '',
    querySource,
    ops: readiness.ops,
    opsIntent: readiness.intentOps,
    writes: readiness.targets,
    reasons: built.reasons,
    candidates: built.candidates,
    scoreQuery: built.scoreQuery,
    dropped: built.dropped,
    silence: silence.reason,
  }), shadow, root)

  // 记忆根通告：根是**推定**的（会话工作目录且无任何项目标记）时，第一次注入前告诉模型"记忆存在哪、
  // 怎么改"。它是状态声明（与常驻任务卡同类），只发一次、不占条目额度。
  const notice = rootNotice({ root, sessionId, sessions, config })

  const fp = built.text ? fingerprint(built.dedupeText ?? built.text) : fingerprint(notice || '')
  const injectedText = notice ? (built.text ? `${notice}\n${built.text}` : notice) : built.text
  if (!injectedText || fp === sessions.lastText.peek(sessionId)) return null
  sessions.lastText.set(sessionId, fp)
  const itemCount = built.reasons.length
  const summary = itemCount
    ? `memory inject: ${itemCount} item(s)${built.entry ? ' + task card' : ''}`
    : built.entry ? 'memory inject: task card' : 'memory root notice'

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

  // 使用记账：注入进上下文 = 这条记忆被用到了。必须在这里显式落盘——注入路径不会走到任何其它
  // save()，只标脏等于进程退出就丢。记账失败绝不影响注入（与审计同约定）。
  if (built.reasons.length) {
    try {
      if (recordHit({ store, globalStore, ids: built.reasons.map((r) => r.id) })) {
        // 只有这个根里真有东西才落盘。否则一次**全局** insight 的命中就会为一个从没被
        // 索引过的容器目录建出整个 store（`save()` 会 mkdir）。审计侧同样不建，见 audit.js。
        if (store.hasContent) store.save()
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
    text: injectedText,
    labels: built.labels,
    reasons: built.reasons,
    dropped: built.dropped,
    budget: { items: quota.items, chars: quota.chars, lastStep: Number.isFinite(quota.lastStep) ? quota.lastStep : null },
    silence: silence.reason,
  }), audit, root)

  return { ...decision, messages: [...decision.messages, injectionMessage(injectedText, summary)] }
}

/**
 * 「记忆根是推定的」一次性通告。
 *
 * 触发条件：根是**安全目录但自身没有任何项目标记**（来自会话工作目录，而不是 `.git`/`package.json`
 * 这类声明）。此时插件会按 cwd 建 `.dsh-project-memory`——必须让模型知道，否则它只看得到记忆来自
 * 一个自己没指定过的位置。通告只发一次，且与常驻任务卡同类：是状态声明，不占条目额度。
 * 关掉它：`autoContext.rootNotice: false`。
 */
function rootNotice({ root, sessionId, sessions, config }) {
  if (config?.autoContext?.rootNotice === false) return null
  if (sessions.rootNoticed.peek(sessionId)) return null
  if (hasProjectMarker(root)) return null
  sessions.rootNoticed.set(sessionId, true)
  return (
    `memory root: ${root} (inferred from the session working directory; no project marker found). ` +
    'If project memory should live elsewhere, pass `root: <dir>` to index_repo / watch_repo / remember / query_memory, ' +
    'or restart dsh inside the project directory.'
  )
}

/**
 * 会话级限流：冷却步数 / 条目条数 / 条目字符。三个任一触顶 → 条目通道整体沉默，
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
function injectionMessage(text, summary) {
  return createUserMessage({
    content: [{ type: 'text', text: `\n\n${INJECT_MARK} ${PLUGIN_NAME} · auto-context\n${text}` }],
    // 宿主对第三方生产者的 `snapshot` 只做追加，不会用后一条替换前一条（只有它自己的 runtime-context
    // 走 replace）。所以这里声明 `notice`：如实表示“这一步注入了什么”，不让 UI 承诺取代先前快照。
    source: {
      kind: SOURCE_KIND,
      form: 'notice',
      summary,
    },
  })
}