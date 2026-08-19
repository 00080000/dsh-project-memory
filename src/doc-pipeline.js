import path from 'node:path'
import { looksLikeDump, readTextFile } from './util/fs.js'
import { parsePdf } from './parsers/pdfjs-parser.js'
import { chunkText } from './chunker.js'
import { extractDocEntry } from './llm.js'

export async function extractTextFromFile(filePath, { maxFileSizeMb = 50, maxPdfPages = 1000 } = {}) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.pdf') {
    const result = await parsePdf(filePath, { maxPages: maxPdfPages })
    return result.markdown
  }
  return readTextFile(filePath, maxFileSizeMb * 1024 * 1024)
}

export async function buildDocEntries(llm, filePath, { chunkChars = 3000, maxChunks = 40, maxFileSizeMb = 50 } = {}) {
  const text = await extractTextFromFile(filePath, { maxFileSizeMb, maxPdfPages: Math.min(maxChunks * 3, 1000) })
  if (looksLikeDump(text)) return null
  const chunks = chunkText(text, chunkChars, maxChunks)
  const entries = []
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const meta = await extractDocEntry(llm, chunk, filePath)
    entries.push({
      id: `${relativeId(filePath)}#${i}`,
      sourcePath: filePath,
      sourceLine: chunk.line,
      type: 'doc',
      title: meta.title,
      summary: meta.summary,
      keywords: meta.keywords,
    })
  }
  return entries
}

function relativeId(filePath) {
  return String(filePath).replace(/[\\/:\s]/g, '_')
}