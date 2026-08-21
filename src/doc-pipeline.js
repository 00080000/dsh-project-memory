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
  return readTextFile(filePath, maxFileSizeMb * 1024 * 1024)
}

const DOC_CONCURRENCY = 4

export async function buildDocEntries(llm, filePath, { chunkChars = 3000, maxChunks = 40, maxFileSizeMb = 50, maxPdfPages = 1000 } = {}) {
  const text = await extractTextFromFile(filePath, { maxFileSizeMb, maxPdfPages })
  if (looksLikeDump(text)) return null
  const chunks = chunkText(text, chunkChars, maxChunks)
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
    id: `${relativeId(filePath)}#${i}`,
    sourcePath: filePath,
    sourceLine: chunks[i].line,
    type: 'doc',
    title: meta.title,
    summary: meta.summary,
    keywords: meta.keywords,
  }))
}

function relativeId(filePath) {
  return String(filePath).replace(/[\\/:\s]/g, '_')
}