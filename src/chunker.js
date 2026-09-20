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
    const rawBlock = section.lines.join('\n')
    if (!rawBlock.trim()) continue
    // `.trim()` 会吃掉段首的空白与换行——把它们算进行号，否则整段的引用行号会偏低。
    const lead = rawBlock.match(/^\s*/)[0]
    let line = section.line + (lead.match(/\n/g) || []).length
    let block = rawBlock.trim()
    while (block.length > chunkChars) {
      let splitAt = block.lastIndexOf('\n\n', chunkChars)
      if (splitAt < chunkChars * 0.5) splitAt = block.lastIndexOf(' ', chunkChars)
      if (splitAt < chunkChars * 0.5) splitAt = chunkChars
      const rawPart = block.slice(0, splitAt)
      const part = rawPart.trim()
      if (part) chunks.push({ title: section.title, text: part, line })
      // 行号按**原始**切片里的换行数推进，再加上被下一次 trim 吃掉的段首换行。
      // 旧写法 `part.split('\n').length` 每次跨行切分都要多算一行，误差会累积。
      const rest = block.slice(splitAt)
      const nextLead = rest.match(/^\s*/)[0]
      line += (rawPart.match(/\n/g) || []).length + (nextLead.match(/\n/g) || []).length
      block = rest.trim()
      if (chunks.length >= maxChunks) break
    }
    if (block) {
      chunks.push({ title: section.title, text: block, line })
    }
    if (chunks.length >= maxChunks) break
  }

  return chunks.filter((c) => c.text).slice(0, maxChunks)
}