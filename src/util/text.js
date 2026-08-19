export function truncate(text, maxChars) {
  if (typeof text !== 'string') return String(text)
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + `\n\n...[truncated at ${maxChars} chars]`
}