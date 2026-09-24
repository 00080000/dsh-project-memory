/**
 * 取消息里的纯文本块（多个 text 块按换行拼接）。
 * 宿主消息块与流式分片都可能缺字段，这里对空块/空消息一律跳过而不是抛错。
 * @param {{ content?: Array<{ type?: unknown, text?: unknown } | null> } | null | undefined} message
 * @returns {string}
 */
export function textOf(message) {
  const blocks = (message && message.content) || []
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

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