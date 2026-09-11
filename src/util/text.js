export function truncate(text, maxChars) {
  if (typeof text !== 'string') return String(text)
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + `\n\n...[truncated at ${maxChars} chars]`
}

export const MAX_SUMMARY = 300

/** 注入用短摘要：压平空白，按句子边界截断到 max 字符。纯函数，无 LLM。 */
export function summarizeText(text, max = MAX_SUMMARY) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  if (flat.length <= max) return flat
  const clip = max - 1
  const clipped = flat.slice(0, clip)
  const lastBreak = Math.max(clipped.lastIndexOf('。'), clipped.lastIndexOf('.'), clipped.lastIndexOf(';'))
  return lastBreak > clip * 0.4 ? clipped.slice(0, lastBreak + 1) : clipped + '…'
}