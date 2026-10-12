/**
 * 统一召回核心（pull 侧）。
 *
 * 设计口径：「一个记忆，两种交付契约」——recall 回答"记忆里有什么和这件事有关"，
 * readiness 回答"动手之前必须知道什么"（PR2）。本模块只做前者，且是 pull/push 共用
 * 的检索核心，避免第二次为 insight 层另写一个更弱的匹配器。
 *
 * 三条不变量：
 *   1. 每层一个适配器：把该层条目映射到同一个检索条目契约
 *      （{ title, keywords, summary, terms, sourcePath }，见 util/search.js:weightedFieldText）。
 *   2. 每层各自 top-k 后再合并：20k doc 条目不能把十几条 insight 挤出结果。
 *   3. 跨层不给"伪可比"的单一分数：桶内先按层内 top 归一为 rel，再乘层先验；
 *      该分数只用于提示级排序，pull 的展示始终按层分节。
 *
 * 规范段提权：标题命中"必须遵守 / 禁止 / rules / must"等词集的 doc chunk 在召回中提权。
 * 确定性、零模型、零依赖——不违反「零依赖、零后台、零 LLM 索引期」。
 *
 * @module dsh-project-memory/recall
 */
import { rankEntriesMergedScored, rankEntriesStreaming, rankExperienceScored, tokenizeRaw } from './util/search.js'

/**
 * 最小相关性闸门：命中的**不同查询词数**至少 min(2, 查询词数)。
 *
 * 为什么需要：`score > 0` 不是"相关"的证据。实测把 `zzz-no-such-topic-xyz` 丢进 query_memory，
 * 它命中了 1 条无关经验——因为查询被 `-` 切出的 2 字符片段 `no` 恰好是那条经验里的一个真实 token
 * （来自 `git commit --amend --no-edit`），于是单个片段就拿走了 3.13 分。提示通道早就有这条规则
 * （`hintMinMatched`，默认 min(2, 词数)），**工具路径与这两层一直漏着**。
 *
 * 只作用于 experience / insight 两层：它们是短标题语料，单片段命中几乎没有证据力；
 * doc/symbol 层是代码与路径（`js` / `id` 这类单词查询本来就该命中），不动它。
 * 单词查询不受影响：need = min(2, 1) = 1，与"score>0 即命中"等价。
 */
function matchedFloor(scored, queries) {
  const qTokens = new Set()
  for (const q of queries) for (const t of tokenizeRaw(String(q ?? ''))) qTokens.add(t)
  const need = Math.min(2, qTokens.size)
  if (need <= 1) return scored
  return scored.filter((r) => (r.matched ?? 0) >= need)
}

/** 各层先验：insight 是"踩过的坑"，略高于普通文档；经验层已由 experience 文件服务，略低。 */
export const LAYER_PRIORS = Object.freeze({
  insight: 1.15,
  doc: 1,
  symbol: 1,
  experience: 0.9,
})

/** 规范段词集（多语言、确定性）：标题命中即视为"规约/清单"段。 */
export const NORMATIVE_HEADING =
  /(必须|禁止|不得|不要|铁律|规约|规范|规则|约定|清单|检查表|checklist|rules?|requirements?|must|must not|do not|don't|never)/i

/** 规范段提权倍数。取 1.5 与 CJK 短语加成同量级：足以翻转词频差，不足以压过强命中。 */
export const NORMATIVE_PRIOR = 1.5

/**
 * 规范段先验：doc 条目标题命中规范词集时提权，其余条目恒为 1。
 * @param {{ title?: string }} entry - 任意检索条目（通常是 doc chunk）。
 * @returns {number} 1 或 {@link NORMATIVE_PRIOR}。
 */
export function normativePrior(entry) {
  return NORMATIVE_HEADING.test(String(entry?.title || '')) ? NORMATIVE_PRIOR : 1
}

/**
 * 一条 insight 的正文文本（用于展示、注入与检索兜底）。
 * 顺序即优先级：fix > choice > solution > pattern/problem > body > steps。
 * @param {object} ins - 归一化后的 insight 条目。
 * @returns {string} 单行正文。
 */
export function insightBodyText(ins) {
  const parts = []
  if (ins?.fix) parts.push(ins.fix)
  else if (ins?.choice) parts.push(ins.choice)
  else if (ins?.solution) parts.push(ins.solution)
  else if (ins?.pattern) parts.push(ins.pattern)
  else if (ins?.problem) parts.push(ins.problem)
  else if (ins?.body) parts.push(ins.body)
  if (ins?.reason) parts.push(`理由：${ins.reason}`)
  if (Array.isArray(ins?.steps) && ins.steps.length) {
    parts.push(ins.steps.map((s, i) => `${i + 1}. ${s}`).join(' '))
  }
  return parts.filter(Boolean).join(' ')
}

/**
 * insight → 统一检索条目契约的适配器。
 * 复用 doc 条目的字段语义，于是 title×5 字段加权、CJK 短语加成、IDF 打分全部现成可用。
 * @param {object} ins - 归一化后的 insight 条目。
 * @returns {object} 检索条目（额外字段仅供渲染，不参与打分）。
 */
export function insightToEntry(ins) {
  const derived = ins?.triggerDerived || {}
  const keywords = [
    ins?.kind,
    ins?.scope,
    ...(Array.isArray(ins?.files) ? ins.files : []),
    ...(Array.isArray(ins?.symbols) ? ins.symbols : []),
    ...(Array.isArray(ins?.tags) ? ins.tags : []),
    // 派生信号（PR3）：只提升召回，不参与强制注入
    ...(Array.isArray(derived.keywords) ? derived.keywords : []),
    ...(Array.isArray(derived.actions) ? derived.actions : []),
  ].filter(Boolean)
  return {
    id: `insight:${ins?.id}`,
    insightId: ins?.id,
    type: 'insight',
    kind: ins?.kind,
    scope: ins?.scope,
    confidence: ins?.confidence,
    files: Array.isArray(ins?.files) ? ins.files : [],
    symbols: Array.isArray(ins?.symbols) ? ins.symbols : [],
    title: String(ins?.title || '(untitled)'),
    summary: insightBodyText(ins).slice(0, 300),
    // 检索用词项：pattern/problem/reason 是"症状"侧词汇，fix 已在 summary 里（title×5 之外单算 1 份）。
    terms: [ins?.pattern, ins?.problem, ins?.reason, ...(Array.isArray(derived.paths) ? derived.paths : [])].filter(Boolean).join(' '),
    keywords,
    sourcePath: Array.isArray(ins?.files) && ins.files.length ? ins.files[0] : '',
    status: 'exact',
  }
}

/**
 * 一条 insight 的**打分文本**（BM25 与 IDF 覆盖率必须用同一份）。
 *
 * 为什么要有这个函数：提示通道的"这条查询离语料有多远"（`idfCoverage` 的 df）曾经用
 * `insightMatchText` 计算，而排序用 `insightToEntry`（含 fix/solution/reason/steps）。
 * 于是"只在解药里有匹配"的查询词 df=0 → supportRatio=0 → **整条提示通道本轮沉默**，
 * 而排序明明给了它高分。两份文本永远来自同一个 entry，才不会再漂移。
 * @param {object} ins
 * @returns {string}
 */
export function insightScoringText(ins) {
  const e = insightToEntry(ins)
  return [e.title, e.summary, e.terms, ...(e.keywords || [])].filter(Boolean).join('\n')
}

/**
 * 召回可见的 insight 集合：作用域可见性跟随会话绑定。
 *   - project / global：始终可见（归档除外）；
 *   - task：只在该会话绑定了对应任务时可见（任务私有，不泄露给别的会话）；
 *   - 迁移影子（kind=experience 且 source=migrate）不在此列：它们由 experience 层服务，
 *     否则同一内容会在 `## Insights` 与 `## Experience` 里各出现一次。
 * @param {{ store?: object, globalStore?: object, boundTaskId?: string|null }} opts
 * @returns {object[]} 可检索的 insight 条目。
 */
export function visibleInsights({ store = null, globalStore = null, boundTaskId = null } = {}) {
  const out = []
  for (const it of (store && typeof store.insightItems === 'function' ? store.insightItems() : []) || []) {
    if (!it || it.archived) continue
    if (it.scope === 'task') continue
    if (it.draft === true) continue
    if (it.kind === 'experience' && it.source === 'migrate') continue // v0.4 影子，交给 experience 层
    out.push(it)
  }
  for (const it of (globalStore && typeof globalStore.items === 'function' ? globalStore.items() : []) || []) {
    if (!it || it.archived || it.draft === true) continue
    out.push(it)
  }
  if (boundTaskId && store && typeof store.getTask === 'function') {
    const task = store.getTask(boundTaskId)
    for (const it of (task && task.insights) || []) {
      if (!it || it.archived) continue
      // 任务级也要挡草稿：reflection 写的是 draft:true，未确认前不该被 query_memory 召回
      // （project/global 一直有这道闸，任务级漏了）。
      if (it.draft === true) continue
      out.push({ ...it, scope: it.scope || 'task' })
    }
  }
  return out
}

/**
 * 向量融合（可选、默认关闭）：只作用于**经验/洞察层**。
 *
 * 为什么只给这两层：它们的池子小（实测真实 store ≤103 条），融合代价 = 每查询一次编码（~2ms）
 * + 池内点积（可忽略），且向量由调用方按条目缓存一次即可；而 doc/symbol 池是 10⁴ 量级
 * （某真实 TS 仓库 15.6k 条目），同一做法要 60s/查询——所以那一层继续纯词法。
 *
 * 为什么是**融合**而不是"有向量就只用向量"：实测（36 条刻意无词重叠的查询 / 103 条池）
 *   · 纯向量替换 BM25：hit@10 53% vs **81%**，明显更差；
 *   · 权重融合在小 k 上更优：k=3 64% vs 58%、k=5 72% vs 67%（α=0.75；α=0.5 时 64%/69%）；
 *   · 并集召回最高（92%）但要返回 ~2k 条，模型可见的内容会翻倍。
 * 所以取 α=0.5：拿到小 k 的收益，又不至于把 BM25 的正确项挤出 top-10。
 *
 * 融合必须在**全量** BM25 序上做（不是先截断再重排），否则"词法排 20 名但语义很近"的条目
 * 永远进不来——那正是向量唯一能补的那类。截断到 limit 发生在融合之后。
 *
 * **边界**：`rankEntriesMergedScored` / `rankExperienceScored` 只返回 **BM25 分 > 0** 的条目，
 * 所以本函数只能**重排**，**拉不进**零词重叠的条目——那需要"并集"形态（向量 top-k 追加到短名单）。
 * 并集的召回更高（实测 hit@10 92% vs 81%）但返回条数约翻倍，对"只给模型少数几条"不友好，
 * 故这里明确不做；要放宽时另开一个模式并重新量一遍。
 *
 * @param {{item: object, score: number}[]} scored - 已按 BM25 降序
 * @param {string[]} queries
 * @param {{score: (q: string, items: object[]) => Map<string, number>, alpha?: number}} [rerank]
 * @returns {{item: object, score: number, vector?: number}[]}
 */
function fuseVectorHits(scored, queries, rerank) {
  if (!rerank || typeof rerank.score !== 'function' || !scored.length) return scored
  const cosOf = new Map()
  for (const q of queries) {
    let m = null
    try { m = rerank.score(q, scored.map((s) => s.item)) } catch { m = null } // 向量层异常不得影响召回
    if (!(m instanceof Map)) continue
    for (const [id, v] of m) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      if (!cosOf.has(id) || v > cosOf.get(id)) cosOf.set(id, v) // 与多查询的 BM25 合并同语义：取最高
    }
  }
  if (!cosOf.size) return scored // 查询无法编码 / 没有向量 → 原样返回（降级到纯词法）
  const alpha = Math.max(0, Math.min(1, typeof rerank.alpha === 'number' ? rerank.alpha : 0.5))
  const top0 = scored[0].score || 1
  const fused = scored.map((s) => {
    const v = cosOf.get(s.item?.insightId) ?? cosOf.get(s.item?.id)
    const has = typeof v === 'number'
    // 没有向量分的条目只保留归一后的词法分（缺向量不等于不相关）
    return { item: s.item, vector: has ? v : undefined, score: has ? (1 - alpha) * (s.score / top0) + alpha * v : s.score / top0 }
  })
  fused.sort((a, b) => b.score - a.score)
  return fused
}

/**
 * 按层召回：每层各自 top-k，桶内保留原始分与层内相对分。
 * @param {object} opts
 * @param {object} [opts.store] - ProjectMemoryStore；提供 doc/symbol/experience 池与 IDF 缓存。
 * @param {object} [opts.globalStore] - GlobalStore；提供 global 级 insight。
 * @param {object[]} [opts.entries] - 直接给定检索池（测试/自定义场景），优先于 store。
 * @param {string[]|string} [opts.queries] - 一条或多条查询（LLM 扩展变体也走这里）。
 * @param {string[]} [opts.layers] - 要召回的层；默认四层。
 * @param {number} [opts.limit] - 每层上限。
 * @param {string|null} [opts.boundTaskId] - 当前会话绑定的任务（决定 task 级可见性）。
 * @param {object} [opts.rerank] - 可选向量融合器（**只作用于 experience / insight 层**）。
 *   装了 leanvec 就传，没装就不传 → 行为与纯词法完全一致。见 {@link fuseVectorHits}。
 * @returns {{ layers: object[], flat: object[] }} layers 为分桶结果，flat 为归一化+先验后的跨层提示序。
 */
export function recallItems(opts = {}) {
  const {
    store = null,
    globalStore = null,
    entries = null,
    queries = [],
    layers = ['doc', 'symbol', 'experience', 'insight'],
    limit = 8,
    boundTaskId = null,
    rerank = null,
  } = opts
  const qs = (Array.isArray(queries) ? queries : [queries]).map((q) => String(q ?? '')).filter(Boolean)
  const want = new Set(layers)
  const idf = store && typeof store.getIdfCache === 'function' ? store.getIdfCache() : {}
  const buckets = []

  if (want.has('doc') || want.has('symbol')) {
    const pool = (entries || (store && typeof store.allEntries === 'function' ? store.allEntries() : []) || [])
      .filter((e) => e && (e.type === 'doc' || e.type === 'symbol') && want.has(e.type))
    // 每层各自 top-k（不变量 #2）：一次跨类型取 top-k 会让文档把符号挤出结果——
    // 20 条命中文档 + 1 条命中符号、limit 8 时符号层直接消失。分类型各取一次再分桶。
    for (const layer of ['doc', 'symbol']) {
      const layerPool = pool.filter((e) => e.type === layer)
      if (!layerPool.length) continue
      const scored = rankEntriesStreaming(layerPool, qs, idf, limit)
      if (!scored.length) continue
      const hits = scored.map(({ entry, score }) => {
        const prior = layer === 'doc' ? normativePrior(entry) : LAYER_PRIORS.symbol
        return { item: entry, score, prior, weightedScore: score * prior }
      })
      hits.sort((a, b) => b.weightedScore - a.weightedScore)
      const top = hits[0].weightedScore || 1
      buckets.push({
        layer,
        prior: LAYER_PRIORS[layer],
        hits: hits.map((h) => ({ ...h, rel: h.weightedScore / top })),
      })
    }
  }

  if (want.has('experience')) {
    const expPool = (store && store.experience) || []
    // 有向量时在**全量** BM25 序上融合（见 fuseVectorHits 注释），截断到 limit 放到融合之后；
    // 没有向量时沿用原来的 limit 语义，输出与纯词法路径逐字段一致。
    const scored0 = matchedFloor(rankExperienceScored(expPool, qs, rerank ? expPool.length : limit), qs)
    if (scored0.length) {
      const scored = fuseVectorHits(scored0, qs, rerank).slice(0, limit)
      const top = scored[0].score || 1
      buckets.push({
        layer: 'experience',
        prior: LAYER_PRIORS.experience,
        hits: scored.map(({ item, score, vector }) => ({ item, score, vector, prior: LAYER_PRIORS.experience, weightedScore: score, rel: score / top })),
      })
    }
  }

  if (want.has('insight')) {
    const pool = entries !== null
      ? entries.filter((e) => e && e.type === 'insight')
      : visibleInsights({ store, globalStore, boundTaskId }).map(insightToEntry)
    const scored0 = matchedFloor(rankEntriesMergedScored(pool, qs, rerank ? pool.length : limit), qs)
    if (scored0.length) {
      const scored = fuseVectorHits(scored0.map((r) => ({ item: r.entry, score: r.score })), qs, rerank).slice(0, limit)
      const top = scored[0].score || 1
      buckets.push({
        layer: 'insight',
        prior: LAYER_PRIORS.insight,
        hits: scored.map(({ item, score, vector }) => ({ item, score, vector, prior: LAYER_PRIORS.insight, weightedScore: score, rel: score / top })),
      })
    }
  }

  const flat = buckets
    .flatMap((b) => b.hits.map((h) => ({ ...h, layer: b.layer, layerPrior: b.prior, hint: h.rel * b.prior })))
    .sort((a, b) => b.hint - a.hint)
    .slice(0, limit)
  return { layers: buckets, flat }
}
