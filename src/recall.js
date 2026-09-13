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
import { rankEntriesMergedScored, rankEntriesStreaming, rankExperienceScored } from './util/search.js'

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
  const keywords = [
    ins?.kind,
    ins?.scope,
    ...(Array.isArray(ins?.files) ? ins.files : []),
    ...(Array.isArray(ins?.symbols) ? ins.symbols : []),
    ...(Array.isArray(ins?.tags) ? ins.tags : []),
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
    terms: [ins?.pattern, ins?.problem, ins?.reason].filter(Boolean).join(' '),
    keywords,
    sourcePath: Array.isArray(ins?.files) && ins.files.length ? ins.files[0] : '',
    status: 'exact',
  }
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
      out.push({ ...it, scope: it.scope || 'task' })
    }
  }
  return out
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
  } = opts
  const qs = (Array.isArray(queries) ? queries : [queries]).map((q) => String(q ?? '')).filter(Boolean)
  const want = new Set(layers)
  const idf = store && typeof store.getIdfCache === 'function' ? store.getIdfCache() : {}
  const buckets = []

  if (want.has('doc') || want.has('symbol')) {
    const pool = (entries || (store && typeof store.allEntries === 'function' ? store.allEntries() : []) || [])
      .filter((e) => e && (e.type === 'doc' || e.type === 'symbol') && want.has(e.type))
    const scored = rankEntriesStreaming(pool, qs, idf, limit)
    const byLayer = new Map([['doc', []], ['symbol', []]])
    for (const { entry, score } of scored) {
      const prior = entry.type === 'doc' ? normativePrior(entry) : LAYER_PRIORS.symbol
      byLayer.get(entry.type).push({ item: entry, score, prior, weightedScore: score * prior })
    }
    for (const layer of ['doc', 'symbol']) {
      const hits = byLayer.get(layer)
      if (!hits.length) continue
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
    const scored = rankExperienceScored((store && store.experience) || [], qs, limit)
    if (scored.length) {
      const top = scored[0].score || 1
      buckets.push({
        layer: 'experience',
        prior: LAYER_PRIORS.experience,
        hits: scored.map(({ item, score }) => ({ item, score, prior: LAYER_PRIORS.experience, weightedScore: score, rel: score / top })),
      })
    }
  }

  if (want.has('insight')) {
    const pool = entries !== null
      ? entries.filter((e) => e && e.type === 'insight')
      : visibleInsights({ store, globalStore, boundTaskId }).map(insightToEntry)
    const scored = rankEntriesMergedScored(pool, qs, limit)
    if (scored.length) {
      const top = scored[0].score || 1
      buckets.push({
        layer: 'insight',
        prior: LAYER_PRIORS.insight,
        hits: scored.map(({ entry, score }) => ({ item: entry, score, prior: LAYER_PRIORS.insight, weightedScore: score, rel: score / top })),
      })
    }
  }

  const flat = buckets
    .flatMap((b) => b.hits.map((h) => ({ ...h, layer: b.layer, layerPrior: b.prior, hint: h.rel * b.prior })))
    .sort((a, b) => b.hint - a.hint)
    .slice(0, limit)
  return { layers: buckets, flat }
}
