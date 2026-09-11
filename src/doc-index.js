// 文档索引的结构化词项（零 LLM，索引期铁律见 de-TODO.md「零 LLM 索引期」）。
//
// 动机：检索只吃 title/keywords/summary/sourcePath（util/search.js 的 weightedFieldText），
// 而 summary 为了注入预算被压到 300 字符 —— 一个 3000 字符的 chunk 有九成内容检索不到。
// 这里把「注入用的短摘要」和「检索用的词项」拆开：summary 仍然短，terms 覆盖整个 chunk。
//
// 纯规则、确定性、可重放：tokenizeRaw（拉丁词 + CJK bigram）→ 去停用词/纯数字 → 词频排序 → 截断。
import { tokenizeRaw } from './util/search.js'

export const MAX_TERMS = 160
export const MAX_KEYWORDS = 8

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her', 'was', 'one',
  'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'new', 'now', 'old', 'see', 'two',
  'way', 'who', 'boy', 'did', 'use', 'that', 'this', 'with', 'from', 'they', 'will', 'would', 'there',
  'their', 'what', 'about', 'which', 'when', 'make', 'like', 'time', 'just', 'know', 'take', 'into',
  'your', 'some', 'them', 'than', 'then', 'only', 'come', 'over', 'also', 'back', 'after', 'other',
  'many', 'most', 'such', 'even', 'much', 'more', 'been', 'were', 'have', 'each', 'does', 'doing',
  'should', 'could', 'these', 'those', 'being', 'where', 'while', 'because', 'before', 'between',
  'under', 'again', 'further', 'once', 'here', 'both', 'few', 'same', 'too', 'very', 'own', 'off',
  'per', 'via', 'etc', 'see', 'note', 'used', 'using', 'uses', 'may', 'must', 'shall',
])

/** 一个 token 是否值得作为检索词项。 */
function isUseful(token) {
  if (token.length < 2) return false
  if (STOPWORDS.has(token)) return false
  if (/^\d+$/.test(token)) return false
  return true
}

/**
 * 整个 chunk 的字面词项（唯一、按词频排序、有上限）。
 * @returns {string[]} 词项数组（已去重）
 */
export function extractTerms(text, { max = MAX_TERMS } = {}) {
  const counts = new Map()
  for (const token of tokenizeRaw(text)) {
    if (!isUseful(token)) continue
    counts.set(token, (counts.get(token) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([token]) => token)
}

/**
 * 结构化的检索词项串（用于 entry.terms，并入 BM25 的检索文本）。
 */
export function extractTermText(text, { max = MAX_TERMS } = {}) {
  return extractTerms(text, { max }).join(' ')
}

/**
 * 规则化关键词：标题重复一次以取得小幅加权（替代此前依赖 LLM 的 5–10 个关键词）。
 */
export function extractKeywords(title, text, { max = MAX_KEYWORDS } = {}) {
  const source = title ? `${title} ${title} ${text}` : text
  return extractTerms(source, { max })
}

/**
 * 旧 store 的 doc 条目没有 `terms`：需要一次定向回填，否则内容哈希未变的文件会被跳过，
 * 新的检索覆盖不会生效。只对 doc 条目判断，code 条目（符号表）不需要 terms。
 */
export function docEntriesNeedBackfill(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return true
  return entries.some((e) => e && e.type === 'doc' && typeof e.terms !== 'string')
}
