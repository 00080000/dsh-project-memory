/**
 * 统一召回核心（pull 侧）：每层一个适配器映射到同一条目契约，每层各自 top-k 后合并。
 * 跨层不给伪可比的单一分数：桶内归一 rel 再乘层先验，只用于提示级排序，展示按层分节。
 * @module dsh-project-memory/recall
 */
import { rankEntriesMergedScored, rankEntriesStreaming, tokenizeRaw, CJK_RANGE } from './util/search.js'
import { CYRILLIC_RANGE } from './util/ru.js'

/**
 * 短拉丁片段不算检索证据（只用于经验/洞察两层）：`no-op` 会切出 `no` / `op`，
 * 两个字母因稀缺能拿不低的 BM25，足以让乱码查询命中无关笔记，所以拉丁项短于 3 丢弃。
 * doc/symbol 层是代码与路径，`js` / `id` 本来就该命中；西里尔不吃这条（`ии` / `бд`
 * 是实义词，虚词已在分词阶段由 `RU_STOPWORDS` 去掉）。两种模式一律适用。
 */
const MIN_LATIN_QUERY_TERM = 3
/**
 * 给 experience/insight 两层的查询做过滤，但不提前词干：返回值随后会被
 * `rankEntriesMergedScored()` 再 tokenize，而 Snowball 词干不幂等（память → памя → пам），
 * 必须保留原词让真正的打分器只词干一次；CJK bigram / 拉丁 token 输出不变。
 */
function gatedQueryText(q) {
  return tokenizeRaw(String(q ?? ''), { stem: false })
    .filter((t) => CJK_RANGE.test(t) || CYRILLIC_RANGE.test(t) || t.length >= MIN_LATIN_QUERY_TERM)
    .join(' ')
}

/**
 * 最小相关性闸门：命中的不同查询词数至少 min(2, 查询词数)。
 * ⚠ 只对没有语义分的条目逐条生效，不是"有 rerank 就整条关掉"——向量救回的恰恰是
 * 词法弱到不足 2 个命中的，用词法的尺子筛等于把向量的价值砍掉。
 * 只作用于 experience/insight 两层（短标题语料）；单词查询 need=1，等价于 score>0。
 */
function matchedFloor(scored, queries) {
  const qTokens = new Set()
  for (const q of queries) for (const t of tokenizeRaw(String(q ?? ''))) qTokens.add(t)
  const need = Math.min(2, qTokens.size)
  if (need <= 1) return scored
  // `typeof vector === 'number'` 只在融合真给出了有限余弦时为真（见 fuseVectorHits）。
  return scored.filter((r) => typeof r.vector === 'number' || (r.matched ?? 0) >= need)
}

/** 各层先验：insight 略高于普通文档；经验笔记（同库、kind 区分）留痕价值略低。 */
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
 * 规范段先验：doc 条目标题命中规范词集时提权，其余恒为 1。
 * @param {{ title?: string }} entry 任意检索条目（通常是 doc chunk）。
 * @returns {number} 1 或 {@link NORMATIVE_PRIOR}。
 */
export function normativePrior(entry) {
  return NORMATIVE_HEADING.test(String(entry?.title || '')) ? NORMATIVE_PRIOR : 1
}

/**
 * 一条 insight 的正文文本（展示、注入与检索兜底）。顺序即优先级：
 * fix > choice > solution > pattern/problem > body > steps。
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
 * insight → 统一检索条目契约的适配器，复用 doc 条目的字段语义，
 * 于是 title×5 加权、CJK 短语加成、IDF 打分全部现成可用。
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
    // 上一版被覆盖的字段：pull 侧要能显示，模型才知道能不能写回。
    prev: ins?.prev && typeof ins.prev === 'object' ? ins.prev : undefined,
    files: Array.isArray(ins?.files) ? ins.files : [],
    symbols: Array.isArray(ins?.symbols) ? ins.symbols : [],
    title: String(ins?.title || '(untitled)'),
    summary: insightBodyText(ins).slice(0, 300),
    // 检索用词项：pattern/problem/reason 是"症状"侧词汇；fix 已在 summary 里，title 之外单算 1 份。
    terms: [ins?.pattern, ins?.problem, ins?.reason, ...(Array.isArray(derived.paths) ? derived.paths : [])].filter(Boolean).join(' '),
    keywords,
    sourcePath: Array.isArray(ins?.files) && ins.files.length ? ins.files[0] : '',
    status: 'exact',
  }
}

/**
 * 一条 insight 的打分文本（BM25 与 IDF 覆盖率必须用同一份）：
 * 覆盖率 df 曾用另一份文本算，于是"只在解药里有匹配"的查询 df=0 → 提示通道整轮沉默，
 * 而排序给了它高分；两份文本同源于 `insightToEntry` 才不会再漂移。
 * @returns {string}
 */
export function insightScoringText(ins) {
  const e = insightToEntry(ins)
  return [e.title, e.summary, e.terms, ...(e.keywords || [])].filter(Boolean).join('\n')
}

/**
 * 召回可见的 insight：project / global 始终可见；task 只在该会话绑定了对应任务时可见
 * （任务私有，不泄露给别的会话）；两类都挡 archived 与 draft:true。
 * `kind:'experience'` 也在这里——统一存储后没有第二个真相源，本函数不做排除。
 * @returns {object[]} 可检索的 insight 条目。
 */
export function visibleInsights({ store = null, globalStore = null, boundTaskId = null } = {}) {
  const out = []
  for (const it of (store && typeof store.insightItems === 'function' ? store.insightItems() : []) || []) {
    if (!it || it.archived) continue
    if (it.scope === 'task') continue
    if (it.draft === true) continue
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
      // 任务级也要挡草稿：reflection 写的是 draft:true，未确认前不该被召回。
      if (it.draft === true) continue
      out.push({ ...it, scope: it.scope || 'task' })
    }
  }
  return out
}

/**
 * 向量融合（可选、默认关闭）：只作用于经验/洞察层，只在全量 BM25 序上重排。
 * 边界：只返回 BM25 分 > 0 的条目，所以向量只重排、不当绝对闸门，拉不进零词重叠的条目。
 * 不先截断再重排，否则"词法排 20 名但语义很近"的条目永远进不来；截断在融合之后。
 * α=0.5：小 k 上融合优于纯向量替换（k=3 64% vs 58%，k=5 72% vs 67%）。
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
  const alpha = Math.max(0, Math.min(1, typeof rerank.alpha === 'number' ? rerank.alpha : 0.5))
  const top0 = scored[0].score || 1
  const rows = scored.map((s) => {
    const v = cosOf.get(s.item?.insightId) ?? cosOf.get(s.item?.id)
    return { s, v: typeof v === 'number' && Number.isFinite(v) ? v : undefined }
  })
  // 一条都没拿到余弦（编码失败 / embed 抛异常 / 返回空 Map）→ 原样返回，matchedFloor 逐条生效，
  // 输出与纯词法逐字段一致；旧行为会在这里漏过词法弱命中。
  const withVec = rows.filter((r) => r.v !== undefined)
  if (!withVec.length) return scored
  // 缺向量分的条目按这一轮已有余弦的均值补（不是拿 0 罚它）：真实 store 上余弦中位数 0.28，
  // 补 0.5 会让"有低余弦"的条目被"完全没有向量"的条目压住，与"缺向量不等于不相关"相反。
  const neutral = withVec.reduce((sum, r) => sum + r.v, 0) / withVec.length
  const fused = rows.map(({ s, v }) => {
    const rel = s.score / top0
    return { item: s.item, matched: s.matched, vector: v, score: (1 - alpha) * rel + alpha * (v === undefined ? neutral : v) }
  })
  fused.sort((a, b) => b.score - a.score)
  return fused
}

/**
 * 按层召回：每层各自 top-k，桶内保留原始分与层内相对分。
 * @param {object} [opts.store] ProjectMemoryStore；提供 doc/symbol 池与 IDF 缓存。
 * @param {object} [opts.globalStore] GlobalStore；提供 global 级 insight。
 * @param {object[]} [opts.entries] 直接给定检索池（测试/自定义场景），优先于 store。
 * @param {string[]|string} [opts.queries] 一条或多条查询（LLM 扩展变体也走这里）。
 * @param {string[]} [opts.layers] 要召回的层，默认四层；`boundTaskId` 决定 task 级可见性。
 * @param {object} [opts.rerank] 可选向量融合器（只作用于 experience / insight 层）。
 * @returns {{ layers: object[], flat: object[] }} layers 为分桶，flat 为归一化 + 先验后的跨层提示序。
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
  // 经验/洞察两层用去掉短拉丁片段的查询（见 `gatedQueryText`）；doc/symbol 层与向量编码仍用原查询。
  const qsLayers = qs.map(gatedQueryText)
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
    // 经验层不再是第二个 store：它就是 `kind:'experience'` 的 insight，与 insight 层同源，
    // 所以两边必须互斥（insight 桶排除 experience），否则同一内容会在两个分节里出现。
    // `entries` 给了就用给的，不再按 kind 二次筛。
    const expPool = entries !== null
      ? entries
      : visibleInsights({ store, globalStore, boundTaskId }).filter((it) => it.kind === 'experience')
    // 与洞察层共用 `insightToEntry`：曾按 v0.4 的 {problem,solution} 打分，而 `save_lesson`
    // 写出的 experience 没有这两个字段，BM25 文档成了三个 `undefined`，查询永远 0 分。
    // 打分用 entry，命中后再换回原始条目：渲染与记账要 problem / sourceFile / id。
    const byId = new Map(expPool.map((it) => [it?.id, it]))
    const expEntries = expPool.map((it) => (it && typeof it.type === 'string' ? it : insightToEntry(it)))
    // 有向量时在全量 BM25 序上融合（见 fuseVectorHits），截断放到融合之后；无向量时与纯词法逐字段一致。
    const ranked = rankEntriesMergedScored(expEntries, qsLayers, rerank ? expEntries.length : limit)
    if (ranked.length) {
      const fused = fuseVectorHits(ranked.map((r) => ({ item: r.entry, score: r.score, matched: r.matched })), qs, rerank)
      // 闸门在融合**之后**、逐条判：拿到语义分的豁免，没拿到的照旧按命中词数筛。
      const scored = matchedFloor(fused, qsLayers).slice(0, limit)
      const top = scored[0]?.score || 1
      if (scored.length) {
        buckets.push({
          layer: 'experience',
          prior: LAYER_PRIORS.experience,
          hits: scored.map(({ item, score, vector }) => ({
            item: byId.get(item?.insightId) || byId.get(item?.id) || item,
            score,
            vector,
            prior: LAYER_PRIORS.experience,
            weightedScore: score,
            rel: score / top,
          })),
        })
      }
    }
  }

  if (want.has('insight')) {
    const pool = entries !== null
      ? entries.filter((e) => e && e.type === 'insight' && e.kind !== 'experience')
      : visibleInsights({ store, globalStore, boundTaskId }).filter((it) => it.kind !== 'experience').map(insightToEntry)
    const ranked = rankEntriesMergedScored(pool, qsLayers, rerank ? pool.length : limit)
    // 与经验桶同一顺序：融合 → 逐条闸门 → 截断；先闸后融等于先删掉词法弱但语义近的条目。
    const scored = matchedFloor(fuseVectorHits(ranked.map((r) => ({ item: r.entry, score: r.score, matched: r.matched })), qs, rerank), qsLayers).slice(0, limit)
    const top = scored[0]?.score || 1
    if (scored.length) {
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
