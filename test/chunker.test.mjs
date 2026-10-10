// chunkText 流式重写的等价性回归：node test/chunker.test.mjs
//
// 这次改动的性质是「**不改输出**的性能重写」，所以判据不是"看起来对"，而是
// **与旧实现逐字节一致**。旧实现（整份 `split(/\r?\n/)` + 所有 section 常驻）作为
// 参考实现内联在下面：它不会再被修改，存在的唯一目的就是当标尺。
//
// 背景：先试过"按 maxChunks 上界截断输入"，被这个差分测试否掉了 —— 截断会**静默改变**
// 大文档的分片内容（`chunkText` 会把 section 的剩余部分整块当一个 chunk 推出去，
// 输出因此依赖"还剩多少输入"）。正确形态是改成流式：逐行惰性扫描、按 section 处理、
// 攒够 maxChunks 立刻停。
import assert from 'node:assert/strict'
import { chunkText } from '../src/chunker.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

/** 参考实现：2026-10-11 之前的 chunkText。**不要动它。** */
function refChunkText(text, chunkChars = 3000, maxChunks = 40) {
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
      const rest = block.slice(splitAt)
      const nextLead = rest.match(/^\s*/)[0]
      line += (rawPart.match(/\n/g) || []).length + (nextLead.match(/\n/g) || []).length
      block = rest.trim()
      if (chunks.length >= maxChunks) break
    }
    if (block) chunks.push({ title: section.title, text: block, line })
    if (chunks.length >= maxChunks) break
  }
  return chunks.filter((c) => c.text).slice(0, maxChunks)
}

const PARAMS = [[3000, 40], [500, 10], [120, 5], [40, 3], [3000, 1], [10, 2]]

// ---- 1. 边界输入：空串 / 只有换行 / CRLF / 尾随换行 ----
{
  const EDGES = ['', '\n', '\n\n', 'a', 'a\n', 'a\r\nb', 'a\r\n', '\r\n', '# H', '# H\n',
    '# H\ntext', '   \n  x  \n  ', 'x'.repeat(5000), `# A\n\n${'y'.repeat(500)}\n\n# B\n`]
  for (const d of EDGES) {
    for (const [cc, mc] of PARAMS) {
      assert.deepEqual(chunkText(d, cc, mc), refChunkText(d, cc, mc), `边界输入不一致：${JSON.stringify(d.slice(0, 30))} cc=${cc} mc=${mc}`)
    }
  }
  ok(`边界输入：${EDGES.length} 种 × ${PARAMS.length} 组参数，与参考实现逐字节一致`)
}

// ---- 2. 随机语料差分（定种子，可复现）----
{
  let rng = 20261011
  const rnd = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  let cases = 0
  for (const [cc, mc] of PARAMS) {
    for (let k = 0; k < 200; k++) {
      let doc = ''
      const n = Math.floor(rnd() * 500)
      for (let i = 0; i < n; i++) {
        const r = rnd()
        doc += r < 0.15 ? `# 标题${i}\n` : r < 0.25 ? '\n\n' : r < 0.35 ? '   \n' : `${'x'.repeat(Math.floor(rnd() * 400))}\n`
      }
      assert.deepEqual(
        chunkText(doc, cc, mc), refChunkText(doc, cc, mc),
        `随机语料不一致：len=${doc.length} cc=${cc} mc=${mc}`,
      )
      cases++
    }
  }
  ok(`随机语料差分：${cases} 例（定种子）与参考实现逐字节一致`)
}

// ---- 3. 提前停止：攒够 maxChunks 就不该再读后面的输入 ----
// 这是流式版的全部收益所在，但它**必须**建立在"后面的输入永远不被保留"之上。
// 用一个"后半段会让参考实现产出不同结果"的语料来证明：两者仍一致 = 后半段确实无关。
{
  const head = `# A\n\n${'a'.repeat(200)}\n\n`
  const tail = `# B\n\n${'b'.repeat(9000)}\n\n# C\n\n${'c'.repeat(9000)}\n`
  const doc = head + tail
  for (const [cc, mc] of [[120, 2], [300, 1], [2000, 1]]) {
    assert.deepEqual(chunkText(doc, cc, mc), refChunkText(doc, cc, mc), `提前停止改变了输出：cc=${cc} mc=${mc}`)
  }
  // maxChunks=1 时只需读第一个 section：把后半段换成完全不同的内容，结果必须不变
  const doc2 = head + `# Z\n\n${'z'.repeat(9000)}\n`
  assert.deepEqual(chunkText(doc, 120, 1), chunkText(doc2, 120, 1), 'maxChunks=1 时结果不该依赖第一段之后的内容')
  ok('提前停止：够了 maxChunks 就不读后续输入，且输出与参考实现一致')
}

console.log(`\nchunker tests: ${passed} passed`)
