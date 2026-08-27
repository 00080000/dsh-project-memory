import { readFile } from 'node:fs/promises'

let pdfjsPromise
let configuredWorkerSrc

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
      .then((mod) => {
        if (configuredWorkerSrc) {
          mod.GlobalWorkerOptions.workerSrc = configuredWorkerSrc
        }
        return mod
      })
      .catch((err) => {
        pdfjsPromise = undefined
        throw err
      })
  }
  return pdfjsPromise
}

const PDFJS_OPTIONS = {
  useSystemFonts: true,
  isEvalSupported: false,
  useWorkerFetch: false,
  useWorker: false,
}

function buildMarkdown(pages) {
  return pages
    .map((p) => (pages.length > 1 ? `## Page ${p.page}\n\n${p.text}` : p.text))
    .join('\n\n')
}

function extractPageText(items) {
  const lines = []
  let currentY = null
  let currentLine = ''
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue
    const y = item.transform ? item.transform[5] : 0
    if (currentY === null || Math.abs(y - currentY) < 2) {
      currentY = y
      currentLine += (currentLine && !currentLine.endsWith(' ') ? ' ' : '') + item.str
    } else {
      lines.push(currentLine)
      currentY = y
      currentLine = item.str
    }
  }
  if (currentLine) lines.push(currentLine)
  return lines.join('\n')
}

export async function parsePdf(filePath, { pages = null, maxPages = 1000, backend = 'pdfjs', collectLayoutStats = false } = {}) {
  const data = new Uint8Array(await readFile(filePath))
  const { getDocument } = await loadPdfjs()
  const loadingTask = getDocument({ data, ...PDFJS_OPTIONS })
  const doc = await loadingTask.promise

  try {
    const total = doc.numPages
    if (total > maxPages) {
      throw new Error(`PDF has ${total} pages, over the maxPages limit of ${maxPages}`)
    }

    const pageList = []
    let imageCount = 0
    let sampledPages = 0
    for (let n = 1; n <= total; n++) {
      if (pages && !pages.has(n)) continue
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      pageList.push({ page: n, text: extractPageText(content.items) })

      if (collectLayoutStats && sampledPages < 5) {
        const { OPS } = await loadPdfjs()
        const opList = await page.getOperatorList()
        for (const fn of opList.fnArray) {
          if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) imageCount++
        }
        sampledPages++
      }
    }
    if (pageList.length === 0) {
      throw new Error('No pages matched the selection, or the PDF contains no extractable text')
    }

    const totalTextChars = pageList.reduce((sum, p) => sum + p.text.length, 0)
    return {
      pageCount: pageList.length,
      pages: pageList,
      markdown: buildMarkdown(pageList),
      backend,
      stats: collectLayoutStats
        ? {
            totalTextChars,
            avgImagesPerPage: sampledPages ? imageCount / sampledPages : 0,
          }
        : undefined,
    }
  } finally {
    await loadingTask.destroy()
  }
}

export async function parsePdfInfo(filePath, maxPages = 1000) {
  const data = new Uint8Array(await readFile(filePath))
  const { getDocument } = await loadPdfjs()
  const loadingTask = getDocument({ data, ...PDFJS_OPTIONS })
  const doc = await loadingTask.promise

  try {
    if (doc.numPages > maxPages) {
      throw new Error(`PDF has ${doc.numPages} pages, over the maxPages limit of ${maxPages}`)
    }
    let meta = {}
    try {
      meta = await doc.getMetadata()
    } catch {
      // metadata is optional
    }
    const info = meta.info || {}
    return {
      pageCount: doc.numPages,
      title: info.Title ?? null,
      author: info.Author ?? null,
      subject: info.Subject ?? null,
      created: info.CreationDate ?? null,
      modified: info.ModDate ?? null,
      encrypted: doc.isEncrypted,
    }
  } finally {
    await loadingTask.destroy()
  }
}

export function configurePdfjsWorker(workerSrc) {
  configuredWorkerSrc = workerSrc
  if (pdfjsPromise) {
    pdfjsPromise.then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = workerSrc
    })
  }
}