export function chunkText(text, chunkChars = 3000, maxChunks = 40) {
  if (!Number.isFinite(chunkChars) || chunkChars < 1) chunkChars = 3000
  if (!Number.isFinite(maxChunks) || maxChunks < 1) maxChunks = 40
  const lines = text.split(/\r?\n/)
  const sections = []
  let current = { title: '', lines: [], line: 1 }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*#{1,6}\s/.test(line)) {
      if (current.lines.length) {
        sections.push(current)
        current = { title: '', lines: [], line: i + 1 }
      }
      current.title = line.replace(/^\s*#{1,6}\s*/, '').trim()
      current.line = i + 1
    }
    current.lines.push(line)
  }
  if (current.lines.length) sections.push(current)

  const chunks = []
  for (const section of sections) {
    if (!section.lines.join('').trim()) continue
    let block = section.lines.join('\n').trim()
    let line = section.line
    while (block.length > chunkChars) {
      let splitAt = block.lastIndexOf('\n\n', chunkChars)
      if (splitAt < chunkChars * 0.5) splitAt = block.lastIndexOf(' ', chunkChars)
      if (splitAt < chunkChars * 0.5) splitAt = chunkChars
      const part = block.slice(0, splitAt).trim()
      if (part) chunks.push({ title: section.title, text: part, line })
      line += part.split('\n').length
      block = block.slice(splitAt).trim()
      if (chunks.length >= maxChunks) break
    }
    if (block) {
      chunks.push({ title: section.title, text: block, line })
    }
    if (chunks.length >= maxChunks) break
  }

  return chunks.filter((c) => c.text).slice(0, maxChunks)
}