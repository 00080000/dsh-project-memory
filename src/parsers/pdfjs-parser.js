import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const WORKER_SPECIFIER = 'pdfjs-dist/legacy/build/pdf.worker.mjs'

let pdfjsPromise
let configuredWorkerSrc

/**
 * 解析 pdf.js 的 worker 模块位置，返回 file:// URL；解析不到返回 undefined。
 *
 * 为什么必须显式给：pdf.js 只在 `isNodeJS` 为真时兜底 `workerSrc ||= './pdf.worker.mjs'`，
 * 而 `isNodeJS` 排除 `process.versions.electron && process.type !== 'browser'`。宿主的插件
 * 进程正是这种形态 → 默认值整块跳过、worker 也没被禁用，取 workerSrc 时直接抛
 * `No "GlobalWorkerOptions.workerSrc" specified`。纯 Node 测试里 `isNodeJS` 为真，永远看不见。
 *
 * 用 file:// URL 而不是路径：worker 由 pdf.js `import(this.workerSrc)` 加载，Windows 的
 * `C:\...` 会被当成协议。
 */
function resolveWorkerSrc() {
  // Node ≥ 20.6 / 18.19 无 flag；更老的版本这里会抛，退回 require 解析
  try {
    if (typeof import.meta.resolve === 'function') return import.meta.resolve(WORKER_SPECIFIER)
  } catch {}
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve(WORKER_SPECIFIER)).href
  } catch {}
  return undefined
}

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
      .then((mod) => {
        // 显式配置 > pdf.js 自己已设的默认值 > 按文件位置解析出来的 URL。
        // 必须用 `||` 而不是 `??`：GlobalWorkerOptions.workerSrc 的初始值是空字符串
        // （GlobalWorkerOptions.#src = ""），`??` 会停在 "" 上直接跳过兜底解析。
        const workerSrc = configuredWorkerSrc || mod.GlobalWorkerOptions.workerSrc || resolveWorkerSrc()
        if (workerSrc) mod.GlobalWorkerOptions.workerSrc = workerSrc
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
  // 这里没有 useWorker：pdf.js 4.x 不认这个键（只有 useWorkerFetch），
  // worker 是否启用只由 GlobalWorkerOptions.workerSrc 决定。
  // 0 = ERRORS。损坏/线性化缺失的 PDF 会让 pdf.js 打 "Warning: Indexing all PDF objects"
  // 之类的告警——那是它自己的恢复路径，对使用者没有可操作性，静音。
  verbosity: 0,
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
  try {
    const doc = await loadingTask.promise
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

export function configurePdfjsWorker(workerSrc) {
  configuredWorkerSrc = workerSrc
  if (pdfjsPromise) {
    pdfjsPromise.then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = workerSrc
    })
  }
}