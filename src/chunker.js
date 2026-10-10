/**
 * 惰性按行扫描：语义与 `text.split(/\r?\n/)` 完全一致（含 `\r\n` 与末尾空行），
 * 但**不**一次性物化整份行数组——那是与文件同阶的一份拷贝。
 */
function* iterLines(text) {
  let start = 0
  for (;;) {
    const nl = text.indexOf('\n', start)
    if (nl === -1) {
      yield text.slice(start)
      return
    }
    let end = nl
    if (end > start && text.charCodeAt(end - 1) === 13) end--
    yield text.slice(start, end)
    start = nl + 1
  }
}

/**
 * 正文 → chunk。
 *
 * 2026-10-11 改为**按 section 流式**：原实现先把整份正文 `split(/\r?\n/)`，再把所有 section
 * 的正文同时留在内存里，峰值与文件大小同阶（实测 PDF 边际 19×、单文件 50 MB → ~1.2 GB RSS）。
 * 现在逐行惰性扫描、一个 section 处理完就放掉，并且**攒够 `maxChunks` 立刻停**。
 *
 * 两条等价性依据（都由差分测试钉住：新旧实现逐例对比随机文档 + 真实文件，要求逐字节一致）：
 *   1. section 之间互不影响——每个 section 的 block 只由它自己的行拼出来；
 *   2. 达到 `maxChunks` 之后可以停——原实现在 while 里 break 后仍会推一次"剩余部分"，
 *      但那一次的下标必然 ≥ `maxChunks`，会被最后的 `.slice(0, maxChunks)` 丢弃。
 * 于是只有"**永远不被保留**"的输入被略过，被保留的 chunk 与行号逐字不变。
 */
export function chunkText(text, chunkChars = 3000, maxChunks = 40) {
  if (!Number.isFinite(chunkChars) || chunkChars < 1) chunkChars = 3000
  if (!Number.isFinite(maxChunks) || maxChunks < 1) maxChunks = 40

  const chunks = []

  /** 把一个 section 切成 chunk（与原实现逐字相同，只是改成按 section 调用）。 */
  const flush = (section) => {
    const rawBlock = section.lines.join('\n')
    if (!rawBlock.trim()) return
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
    // `chunks.length >= maxChunks` 时这次 push 的下标 ≥ maxChunks，原实现随后会把它 slice 掉。
    if (block && chunks.length < maxChunks) chunks.push({ title: section.title, text: block, line })
  }

  let section = { title: '', lines: [], line: 1 }
  let lineNo = 0
  for (const line of iterLines(text)) {
    lineNo++
    if (/^\s*#{1,6}\s/.test(line)) {
      if (section.lines.length) {
        flush(section)
        if (chunks.length >= maxChunks) return chunks
        section = { title: '', lines: [], line: lineNo }
      }
      section.title = line.replace(/^\s*#{1,6}\s*/, '').trim()
      section.line = lineNo
    }
    section.lines.push(line)
  }
  if (section.lines.length) flush(section)

  return chunks.filter((c) => c.text).slice(0, maxChunks)
}
