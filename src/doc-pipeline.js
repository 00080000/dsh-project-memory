import { createHash } from 'node:crypto'
import path from 'node:path'
import { stat } from 'node:fs/promises'
import { looksLikeDump, readTextFile } from './util/fs.js'
import { parsePdf } from './parsers/pdfjs-parser.js'
import { chunkText } from './chunker.js'
import { extractDocEntry } from './llm.js'

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

const DOC_CONCURRENCY = 4

export async function buildDocEntries(llm, a, b, c) {
  // Backward compatible: old signature (llm, filePath, opts) or new (llm, relPath, filePath, opts)
  const [relPath, filePath, opts] = c === undefined ? [a, a, b] : [a, b, c]
  const text = await extractTextFromFile(filePath, opts)
  if (looksLikeDump(text)) return null
  
  // Compute content hash for update detection
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
  
  const chunks = chunkText(text, opts.chunkChars, opts.maxChunks)
  const metas = new Array(chunks.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(DOC_CONCURRENCY, chunks.length) }, () =>
      (async () => {
        while (cursor < chunks.length) {
          const i = cursor++
          metas[i] = await extractDocEntry(llm, chunks[i], filePath)
        }
      })(),
    ),
  )
  return metas.map((meta, i) => ({
    id: `${relativeId(relPath)}#${i}`,
    sourcePath: relPath,
    sourceLine: chunks[i].line,
    type: 'doc',
    title: meta.title,
    summary: meta.summary,
    blindSpots: meta.blindSpots || '',
    keywords: meta.keywords,
    hash,
  }))
}

function relativeId(filePath) {
  return String(filePath).replace(/[\\/:\s]/g, '_')
}