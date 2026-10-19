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
import { rankEntriesMergedScored, rankEntriesStreaming, tokenizeRaw, CJK_RANGE } from './util/search.js'

/**
 * 短拉丁片段不算检索证据（只用于经验/洞察两层）。
 *
 * tokenizer 按 `[a-z0-9_]+` 切词，`no-op` / `--no-edit` 会留下 `no`、`op` 这类两字母片段。
 * 它们在散文语料里没有独立语义，却因为稀缺而拿到不低的 BM25：查询 `zzz-no-such-topic-xyz`
 * 就靠 `no` 命中一条无关笔记。所以这两层的查询词里，拉丁项短于 3 个字符的直接丢弃。
 *
 * 为什么只在这两层：doc/symbol 层是代码与路径，`js` / `id` 这类短标识符本来就该命中
 * （见上方 `matchedFloor` 的注释）。两种模式（有/无向量）一律适用——闸门不能随向量层开关变形。
 */
const MIN_LATIN_QUERY_TERM = 3
function gatedQueryText(q) {
  return tokenizeRaw(String(q ?? ''))
    .filter((t) => CJK_RANGE.test(t) || t.length >= MIN_LATIN_QUERY_TERM)
    .join(' ')
}

/**
 * 最小相关性闸门：命中的**不同查询词数**至少 min(2, 查询词数)。
 *
 * 为什么需要：`score > 0` 不是"相关"的证据。实测把 `zzz-no-such-topic-xyz` 丢进 query_memory，
 * 它命中了 1 条无关经验——因为查询被 `-` 切出的 2 字符片段 `no` 恰好是那条经验里的一个真实 token
 * （来自 `git commit --amend --no-edit`），于是单个片段就拿走了 3.13 分。提示通道早就有这条规则
 * （`hintMinMatched`，默认 min(2, 词数)），**工具路径与这两层一直漏着**。
 *
 * ⚠ **只对没有语义分的条目生效**，而且是**逐条**判——不是"有 rerank 就整条关掉"。这是同查询集
 * A/B 实测出来的（36 条、同一个 store）：
 *   · 纯词法下加闸门：BM25 的 hit@1/3/5/10 = 39/50/58/69% **完全不变**，只是不再对乱码查询出声；
 *   · 有向量时对**所有**条目加闸门：融合 hit@5/10 从 64/72% 掉到 58/64%，"完全没召回"从 10 涨到 13。
 * 原因是结构性的：**向量救回来的那批，恰恰就是词法弱到不足 2 个命中的**——用词法的尺子去筛，
 * 等于把向量的全部价值砍掉。所以：拿到语义分的条目豁免，没拿到的照旧过闸。
 *
 * 旧实现按 `Boolean(rerank)` 整条关闸，于是"装了 leanvec 但这一轮给不出余弦"（查询编码失败、
 * embed 抛异常、或者根本没有候选可编码）时，弱命中会漏进来——那不是降级，是**换了行为**：
 * 注释承诺的"逐字段退回纯词法"在那种情况下并不成立。
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
  // `typeof vector === 'number'` 只在融合真给出了有限余弦时为真（见 fuseVectorHits）。
  return scored.filter((r) => typeof r.vector === 'number' || (r.matched ?? 0) >= need)
}

/** 各层先验：insight 是"踩过的坑"，略高于普通文档；经验笔记（同库、kind 区分）留痕价值略低。 */
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
 *   - `kind:'experience'`（v0.4 经验笔记，加载时导入）**也在这里**——统一存储后没有第二个真相源，
 *     它由 experience 那一桶按 kind 取走；本函数不做排除（排除会让同一内容在别的视图里消失）。
 * @param {{ store?: object, globalStore?: object, boundTaskId?: string|null }} opts
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
 * **边界**：`rankEntriesMergedScored` 只返回 **BM25 分 > 0** 的条目，所以本函数只能**重排**，
 * **拉不进**零词重叠的条目——那需要"并集"形态（向量 top-k 追加到短名单）。
 *
 * 并集为什么不在这里做（0.6.x 复核过一次，仍不做）：
 *   · 收益是真的：并集 hit@10 92% vs 81%；
 *   · 但它**单独存在时是空操作**：并集候选的词法分是 0，立刻被 `matchedFloor` 挡掉
 *     （matched=0 < min(2,词数)）。要让它们活下来，必须让"高余弦名次"**替代**词法闸门——
 *     那就是一个向量闸门，而 auto-inject 里那条路已经量过：绝对余弦在两个方向上都不成立
 *     （合成池上像样、真实交付上 0.42 会剪掉 45/45；换成相对分/名次也只在名次 ≤4 时有
 *     0.46 vs 0.24 的精度差，代价是误杀 4/10 个真命中）。所以并集不是"再加一段代码"，
 *     而是"改准入策略"——需要先有人工金标准，不能顺手带上。
 *   · 返回条数翻倍的代价反而是次要的（候选可以并集、交付照样截断到 limit）。
 *
 * @param {{item: object, score: number, matched?: number}[]} scored - 已按 BM25 降序
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
  const alpha = Math.max(0, Math.min(1, typeof rerank.alpha === 'number' ? rerank.alpha : 0.5))
  const top0 = scored[0].score || 1
  const rows = scored.map((s) => {
    const v = cosOf.get(s.item?.insightId) ?? cosOf.get(s.item?.id)
    return { s, v: typeof v === 'number' && Number.isFinite(v) ? v : undefined }
  })
  // 一条都没拿到余弦（查询编码失败 / embed 抛异常 / 向量层返回空 Map）→ **原样返回**。
  // 与"整条关掉闸门"不同：这条路径连归一化都不做，于是 matchedFloor 逐条生效，
  // 输出与纯词法逐字段一致（这是勘误：旧行为会在这里漏过词法弱命中）。
  const withVec = rows.filter((r) => r.v !== undefined)
  if (!withVec.length) return scored
  // 缺向量分的条目按**这一轮已有余弦的均值**补（不是拿 0 罚它，也不是留一个隐式 0.5）。
  // 旧写法 `score = rel` 等价于补 α·0.5：真实 store 上 7381 对的余弦中位数只有 0.28、
  // 查询→标题 top-1 也多在 0.51~0.63，于是"有低余弦"的条目会被"完全没有向量"的条目压住，
  // 与注释承诺的"缺向量不等于不相关"正好相反。均值是这里假设最少的补法（缺分=平均水平）。
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
 * @param {object} opts
 * @param {object} [opts.store] - ProjectMemoryStore；提供 doc/symbol 池与 IDF 缓存。
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
    // 经验层不再是第二个 store：它就是 `kind:'experience'` 的 insight（v0.4 的旧笔记在加载时导入、
    // 旧文件归档为 experience.json.migrated）。池子与 insight 层同源，所以两边必须**互斥**：
    // insight 桶排除 experience，否则同一内容会同时出现在 `## Insights` 与 `## Experience` 里。
    // `entries` 给了就用给的：那是一份"调用方指定了这个层"的池子，不再按 kind 二次筛。
    const expPool = entries !== null
      ? entries
      : visibleInsights({ store, globalStore, boundTaskId }).filter((it) => it.kind === 'experience')
    // **与洞察层共用一个适配器**（`insightToEntry`）。这里曾经用 v0.4 的 `{problem,solution}`
    // 形状打分，而统一存储之后 `kind:'experience'` 也能由 `save_lesson` 写出——它的参数表里
    // 没有 problem / solution，于是那种条目的 BM25 文档是三个字面量 `undefined`：任何正常查询
    // 都 0 分，而洞察桶又排除了 experience → 两条拉取路径同时不通，条目在库里但永远查不到。
    // 打分用 entry，命中后再换回原始条目：渲染与记账要 problem / sourceFile / id。
    const byId = new Map(expPool.map((it) => [it?.id, it]))
    const expEntries = expPool.map((it) => (it && typeof it.type === 'string' ? it : insightToEntry(it)))
    // 有向量时在**全量** BM25 序上融合（见 fuseVectorHits 注释），截断到 limit 放到融合之后；
    // 没有向量时沿用原来的 limit 语义，输出与纯词法路径逐字段一致。
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
    // 与经验桶同一条顺序：融合 → 逐条闸门 → 截断。闸门在融合之后是刻意的——
    // 融合会把"词法弱但语义近"的条目抬上台面，先闸后融等于先把它们删掉。
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
