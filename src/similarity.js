// 通用文本相似度：双向 token overlap（归一化 0..1）
// v0.5 去重 / 合并 / 强化共用的**唯一**相似度指标；BM25 只用于排序，禁止当阈值。
//
// 归一化定义：normalized = 共同 token 数 / 两文本中较长者的 token 数（= min(ratioA, ratioB)）。
// 它与 v0.4 experience 层 "双向 ratio ≥ t" 判定等价：
//   ratioA ≥ t 且 ratioB ≥ t  ⟺  overlap / max(lenA, lenB) ≥ t
// 因此 "≥ 0.7 合并 / 0.65~0.7 强化" 只需在此单一尺度上比较，跨库/跨长度可比。
import { tokenize } from './util/search.js'

/**
 * 归一化双向 token overlap。
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1
 */
export function normalizedTokenOverlap(a, b) {
  if (!a || !b) return 0
  const ta = tokenize(String(a))
  const tb = tokenize(String(b))
  if (!ta.length || !tb.length) return 0
  const sa = new Set(ta)
  const sb = new Set(tb)
  let overlap = 0
  for (const t of sa) if (sb.has(t)) overlap++
  return overlap / Math.max(sa.size, sb.size)
}

/** 一条 insight 参与相似度判定的文本（标题 + kind 专属正文）。 */
export function insightMatchText(ins) {
  return `${ins.title || ''} ${ins.problem || ''} ${ins.pattern || ''} ${ins.topic || ''} ${ins.choice || ''} ${ins.body || ''}`.trim()
}

/**
 * 在候选列表里找与 text 重叠分最高（且未归档）的一条。
 * @param {string} text
 * @param {Array<object>} items
 * @param {(item: object) => string} [getText]
 * @returns {{ item: object, score: number } | null}
 */
export function findBestOverlapMatch(text, items, getText = (it) => insightMatchText(it)) {
  let best = null
  let bestScore = 0
  for (const item of items) {
    if (item && item.archived) continue
    const score = normalizedTokenOverlap(text, getText(item))
    if (score > bestScore) {
      bestScore = score
      best = item
    }
  }
  return best ? { item: best, score: bestScore } : null
}
