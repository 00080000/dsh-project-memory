import { createHash } from 'node:crypto'
import path from 'node:path'
import { stat } from 'node:fs/promises'
import { looksLikeDump, readTextFile } from './util/fs.js'
import { summarizeText } from './util/text.js'
import { parsePdf } from './parsers/pdfjs-parser.js'
import { chunkText } from './chunker.js'
import { extractKeywords, extractTermText } from './doc-index.js'

export async function extractTextFromFile(filePath, { maxFileSizeMb = 50, maxPdfPages = 1000 } = {}) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.pdf') {
    if (maxFileSizeMb) {
      const stats = await stat(filePath)
      if (stats.size > maxFileSizeMb * 1024 * 1024) {
        throw new Error(`File too large to index (${(stats.size / 1024 / 1024).toFixed(1)} MB), limit is ${maxFileSizeMb} MB`)
      }
    }
    const result = await parsePdf(filePath, { maxPages: maxPdfPages })
    return result.markdown
  }
  return readTextFile(filePath, maxFileSizeMb ? maxFileSizeMb * 1024 * 1024 : Infinity)
}

/**
 * 文档分片 → 记忆条目（索引期不调用任何模型：纯规则、确定性、可重放）。
 *
 * 注入用 summary 与检索用 terms 分离：
 *   - summary：≤300 字符，进上下文，保持小预算；
 *   - terms：整个 chunk 的字面词项，只进 BM25 检索文本，不进注入。
 * 于是「chunk 只有前 300 字符可检索」的旧限制被移除，且没有任何 LLM 调用。
 * 函数签名里刻意没有 llm —— 索引期零 LLM 由构造保证，而不是靠 catch。
 */
export async function buildDocEntries(relPath, filePath, opts = {}) {
  const text = await extractTextFromFile(filePath, opts)
  if (looksLikeDump(text)) return null

  // Compute content hash for update detection
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)

  const chunks = chunkText(text, opts.chunkChars, opts.maxChunks)
  return chunks.map((chunk, i) => ({
    id: `${relativeId(relPath)}#${i}`,
    sourcePath: relPath,
    sourceLine: chunk.line,
    type: 'doc',
    title: chunk.title || relPath,
    summary: summarizeText(chunk.text),
    blindSpots: '',
    keywords: extractKeywords(chunk.title, chunk.text),
    terms: extractTermText(chunk.text),
    hash,
  }))
}

function relativeId(filePath) {
  return String(filePath).replace(/[\\/:\s]/g, '_')
}
