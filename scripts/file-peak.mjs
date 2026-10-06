#!/usr/bin/env node
/**
 * 峰值系数实测 —— 回答 ROADMAP §1 的 #5：
 * 「PDF 与代码共用同一个 maxFileSizeMb，而峰值是它的几倍」——实测是 19–21 倍，不是 2–4 倍。
 *
 * 口径（三条，缺一条数字就不可信）：
 *  1. **独立子进程**：父进程只负责生成语料与汇总。同进程量会把上一次的 store / pdfjs 模块
 *     缓存算进第二次读数（见 scripts/bench.mjs 的同一教训）。
 *  2. **heapUsed 与 RSS 都报**：heapUsed 是 V8 堆，RSS 含 ArrayBuffer/外部内存与未归还页。
 *     放大系数按「峰值 / 磁盘字节」给，两个口径各算一份；**以 RSS 为准**——heap 峰值受 GC
 *     时序影响会非单调（同一档符号密集语料 32MB 量出 625MB、50MB 反而 328MB）。
 *  3. **峰值取两处最大**：`setInterval` 采样只在事件循环空闲时跑得到（pdfjs 逐页 await 之间能采到，
 *     一长段同步代码里采不到），所以再叠加「每个阶段结束后尚未回收的 heapUsed」——
 *     这些阶段里的分配都是**同时存活**的，阶段后读数即该阶段的真实驻留。
 *
 * 用法:
 *   node --expose-gc scripts/file-peak.mjs                 # 生成 50MB × 3 语料并跑两种路径
 *   node --expose-gc scripts/file-peak.mjs --mb=20         # 换档（默认 50）
 *   node --expose-gc scripts/file-peak.mjs code <file>     # 子进程：只量代码路径
 *   node --expose-gc scripts/file-peak.mjs pdf  <file>     # 子进程：只量 PDF 路径
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const mode = argv[0] && !argv[0].startsWith('--') ? argv[0] : null

// ---------- 子进程：内存读数工具 ----------

function mb(n) {
  return +(n / 1048576).toFixed(1)
}

function startSampler() {
  const peak = { heap: 0, rss: 0 }
  const timer = setInterval(() => {
    const m = process.memoryUsage()
    if (m.heapUsed > peak.heap) peak.heap = m.heapUsed
    if (m.rss > peak.rss) peak.rss = m.rss
  }, 2)
  timer.unref?.()
  return { peak, stop: () => clearInterval(timer) }
}

async function measure({ label, stages }) {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('需要 --expose-gc：node --expose-gc bench/file-peak.mjs')
  }
  globalThis.gc()
  const base = process.memoryUsage()
  const sampler = startSampler()
  const rows = []
  let held = base
  for (const [name, fn] of stages) {
    const t0 = process.hrtime.bigint()
    const value = await fn()
    const t1 = process.hrtime.bigint()
    const now = process.memoryUsage()
    if (now.heapUsed > sampler.peak.heap) sampler.peak.heap = now.heapUsed
    if (now.rss > sampler.peak.rss) sampler.peak.rss = now.rss
    rows.push({
      name,
      ms: +(Number(t1 - t0) / 1e6).toFixed(0),
      heap: now.heapUsed,
      rss: now.rss,
    })
    held = now
    if (value !== undefined) rows[rows.length - 1].value = value
  }
  sampler.stop()
  globalThis.gc()
  const after = process.memoryUsage()
  return {
    label,
    base,
    peak: sampler.peak,
    held,
    after,
    rows,
  }
}

function emit(result, extra = {}) {
  process.stdout.write('\nPEAK_JSON ' + JSON.stringify({ ...result, ...extra }) + '\n')
}

// ---------- 子进程：两种路径 ----------

async function runCode(file) {
  const { readFileForIndex } = await import('../src/util/fs.js')
  const { scanSymbols } = await import('../src/symbols.js')
  const disk = statSync(file).size
  const st = {}
  const result = await measure({
    label: 'code',
    stages: [
      ['读盘 + 哈希（readFileForIndex）', () => {
        const { buffer, hash } = readFileForIndex(file)
        st.buffer = buffer
        st.hash = hash
        return undefined
      }],
      ["解码 buffer.toString('utf8')", () => {
        st.text = st.buffer.toString('utf8')
        return st.text.length
      }],
      ['符号扫描 scanSymbols', () => {
        // 与 index-pipeline.js 的生产调用逐字一致：scanSymbols(rel, filePath, text)
        st.entries = scanSymbols(path.basename(file), file, st.text)
        return st.entries.length
      }],
    ],
  })
  emit(result, { disk, kind: 'code', symbols: st.entries.length, textChars: st.text.length })
}

async function runPdf(file) {
  const { extractTextFromFile } = await import('../src/doc-pipeline.js')
  const { chunkText } = await import('../src/chunker.js')
  const { extractTermText, extractKeywords } = await import('../src/doc-index.js')
  const { summarizeText } = await import('../src/util/text.js')
  const disk = statSync(file).size

  const st = {}
  const result = await measure({
    label: 'pdf',
    stages: [
      ['PDF 抽取 + 拼 markdown（parsePdf）', async () => {
        st.text = await extractTextFromFile(file, { maxFileSizeMb: 50, maxPdfPages: 1000 })
        return st.text.length
      }],
      ['分块 chunkText(3000, 40)', () => {
        st.chunks = chunkText(st.text, 3000, 40)
        return st.chunks.length
      }],
      ['建条目（summary + keywords + terms）', () => {
        st.entries = st.chunks.map((c) => ({
          summary: summarizeText(c.text),
          keywords: extractKeywords(c.title, c.text),
          terms: extractTermText(c.text),
        }))
        return st.entries.length
      }],
    ],
  })
  emit(result, {
    disk,
    kind: 'pdf',
    textChars: st.text.length,
    chunks: st.chunks.length,
    entryBytes: st.entries.reduce((s, e) => s + e.summary.length + e.terms.length, 0),
  })
}

// ---------- 语料生成 ----------

const WORDS = ('memory index recall insight trigger budget store shard entry symbol document chunk query latency retention project agent context ' +
  'graph node edge parse stream buffer handle session task archive promote merge token lexical hash window sample ' +
  'strategy policy ledger receipt coverage decay prune migrate replay projection invariant oracle ratchet gate').split(' ')

function* lineSource() {
  let n = 0
  while (true) {
    n++
    const w = []
    for (let i = 0; i < 12; i++) w.push(WORDS[(n * 7 + i * 13) % WORDS.length])
    yield `${n} ${w.join(' ')}`
  }
}

/** 生成 ~targetBytes 的「代码样」文本文件。
 *  density 决定**符号密度**（代码路径的峰值主要由它决定，不由字节数决定）：
 *   typical ≈ 1 个声明 / 1.2 KB（真实源码量级，声明之间有注释填充）；dense ≈ 1 个 / 240 B（极端）。
 */
function genCode(file, targetBytes, density = 'typical') {
  const padLines = density === 'dense' ? 0 : 13
  const parts = []
  let bytes = 0
  let n = 0
  const gen = lineSource()
  while (bytes < targetBytes) {
    n++
    let block =
      `// module ${n}: ${gen.next().value}\n` +
      `export function fn_${n}(a, b) { const x = a + b; return x * ${n % 97} }\n` +
      `export const TABLE_${n} = ['${WORDS[n % WORDS.length]}', '${WORDS[(n + 3) % WORDS.length]}']\n`
    for (let i = 0; i < padLines; i++) block += `// ${gen.next().value}\n`
    parts.push(block)
    bytes += Buffer.byteLength(block)
  }
  writeFileSync(file, parts.join(''))
  return bytes
}

/** 生成最小但合法的 PDF：pages 页、每页 linesPerPage 行文本（未压缩流 → 磁盘大小≈文本量）。 */
function buildPdf(pages, linesPerPage) {
  const chunks = []
  let pos = 0
  const offsets = {}
  const push = (s) => {
    const b = Buffer.from(s, 'latin1')
    chunks.push(b)
    pos += b.length
  }
  const startObj = (n) => {
    offsets[n] = pos
    push(`${n} 0 obj\n`)
  }
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')

  const pageObj = (i) => 3 + i
  const contentObj = (i) => 3 + pages + i

  startObj(1)
  push(`<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`)
  startObj(2)
  const kids = []
  for (let i = 1; i <= pages; i++) kids.push(`${pageObj(i)} 0 R`)
  push(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>\nendobj\n`)
  startObj(3)
  push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`)

  const gen = lineSource()
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  for (let i = 1; i <= pages; i++) {
    startObj(pageObj(i))
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObj(i)} 0 R ` +
        `/Resources << /Font << /F1 3 0 R >> >> >>\nendobj\n`
    )
    let body = ''
    // 每 68 行重新起一个文本对象：y 一旦落到页面外（MediaBox 之下），pdf.js 的
    // getTextContent 就不再返回那些 item（实测每页只抽到 71 行 = 780/11）。真实 PDF
    // 是分页排版的，所以这里也按「一屏一块」重排，保证抽出的正文与流里的文本等量。
    for (let l = 0; l < linesPerPage; l++) {
      if (l % 68 === 0) body += `ET BT /F1 9 Tf 20 780 Td 11 TL\n`
      body += `(${esc(gen.next().value)}) Tj T*\n`
    }
    const stream = `BT /F1 9 Tf 20 780 Td 11 TL\n${body}ET\n`
    startObj(contentObj(i))
    push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream\nendobj\n`)
  }

  const size = 3 + 2 * pages + 1
  const xrefPos = pos
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`
  for (let n = 1; n < size; n++) xref += `${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`
  push(xref)
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`)

  return Buffer.concat(chunks)
}

function genPdf(file, targetBytes) {
  // 每页正文约 (lineLen + 8) * linesPerPage 字节；先按每页 100KB 估页数，再按实际字节微调。
  const linesPerPage = 1024
  let pages = Math.max(1, Math.round(targetBytes / (linesPerPage * 60)))
  for (let i = 0; i < 8; i++) {
    const buf = buildPdf(pages, linesPerPage)
    if (Math.abs(buf.length - targetBytes) / targetBytes < 0.05) {
      writeFileSync(file, buf)
      return buf.length
    }
    pages = Math.max(1, Math.round((pages * targetBytes) / buf.length))
  }
  const buf = buildPdf(pages, linesPerPage)
  writeFileSync(file, buf)
  return buf.length
}

// ---------- 编排 ----------

function runChild(childMode, file) {
  const r = spawnSync(process.execPath, ['--expose-gc', new URL(import.meta.url).pathname, childMode, file], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0) {
    process.stderr.write(r.stderr || '')
    throw new Error(`${childMode} 子进程失败 (status=${r.status})`)
  }
  const line = String(r.stdout).split('\n').find((l) => l.startsWith('PEAK_JSON '))
  if (!line) throw new Error(`${childMode} 子进程没有输出 PEAK_JSON`)
  return JSON.parse(line.slice('PEAK_JSON '.length))
}

function report(r) {
  const diskMB = r.disk / 1048576
  const peakHeap = Math.max(r.peak.heap, r.held.heapUsed)
  const peakRss = Math.max(r.peak.rss, r.held.rss)
  console.log(`\n=== ${r.kind}：磁盘 ${mb(r.disk)} MB ===`)
  console.log('  阶段                             耗时      阶段后 heap    阶段后 RSS')
  console.log('  ' + '-'.repeat(68))
  for (const row of r.rows) {
    console.log(
      `  ${row.name.padEnd(32)} ${String(row.ms + ' ms').padStart(8)} ${String(mb(row.heap) + ' MB').padStart(13)} ${String(mb(row.rss) + ' MB').padStart(13)}`
    )
  }
  console.log('  ' + '-'.repeat(68))
  console.log(`  基线 heap ${mb(r.base.heapUsed)} MB / RSS ${mb(r.base.rss)} MB`)
  console.log(
    `  峰值 heap ${mb(peakHeap)} MB → **放大 ${(peakHeap / r.disk).toFixed(2)}×**（相对磁盘 ${diskMB.toFixed(1)} MB）`
  )
  console.log(
    `  峰值 RSS  ${mb(peakRss)} MB → **放大 ${(peakRss / r.disk).toFixed(2)}×**；操作后 gc 常驻 heap ${mb(r.after.heapUsed)} MB`
  )
  if (r.kind === 'pdf') {
    console.log(`  抽出的正文 ${mb(r.textChars)} M 字符 → ${r.chunks} 个 chunk，条目文本合计 ${r.entryBytes} 字符`)
  } else if (r.kind === 'code') {
    const per = Math.round(r.disk / Math.max(1, r.symbols))
    console.log(`  正文 ${mb(r.textChars)} M 字符 → 符号条目 ${r.symbols} 个（≈ 1 个 / ${per} 字节）`)
  }
  return { heap: peakHeap, rss: peakRss, disk: r.disk }
}

if (mode === 'code') {
  await runCode(argv[1])
} else if (mode === 'pdf') {
  await runPdf(argv[1])
} else {
  const mbArg = Number((argv.find((a) => a.startsWith('--mb=')) || '').split('=')[1]) || 50
  const dir = path.join(os.tmpdir(), 'dpm-file-peak')
  mkdirSync(dir, { recursive: true })
  const target = mbArg * 1024 * 1024
  const cases = [
    { kind: 'code', density: 'typical', label: `code/typical ${mbArg}MB`, file: path.join(dir, `code-${mbArg}mb-typical.js`) },
    { kind: 'code', density: 'dense', label: `code/dense ${mbArg}MB`, file: path.join(dir, `code-${mbArg}mb-dense.js`) },
    { kind: 'pdf', density: null, label: `pdf ${mbArg}MB`, file: path.join(dir, `pdf-${mbArg}mb.pdf`) },
  ]

  for (const c of cases) {
    const ok = existsSync(c.file) && statSync(c.file).size >= target * (c.kind === 'pdf' ? 0.8 : 0.95)
    if (ok) continue
    console.log(`生成语料 ${c.label} → ${c.file} …`)
    if (c.kind === 'code') genCode(c.file, target, c.density)
    else genPdf(c.file, target)
  }

  const summary = []
  for (const c of cases) {
    const r = runChild(c.kind, c.file)
    const m = report(r)
    summary.push({ label: c.label, ...m, extra: r.kind === 'code' ? `符号 ${r.symbols} 个` : `正文 ${r.textChars} 字符` })
  }

  console.log('\n=== #5 汇总：峰值 / 磁盘 ===')
  for (const s of summary) {
    console.log(
      `  ${s.label.padEnd(20)} 磁盘 ${String(mb(s.disk)).padStart(5)} MB | ` +
        `heap 峰值 ${String(mb(s.heap)).padStart(6)} MB (${(s.heap / s.disk).toFixed(2)}×) | ` +
        `RSS 峰值 ${String(mb(s.rss)).padStart(6)} MB (${(s.rss / s.disk).toFixed(2)}×) | ${s.extra}`
    )
  }
}
