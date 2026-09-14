#!/usr/bin/env node
/**
 * 独立基准：给一个真实项目路径，量「冷索引 / 冷加载 / 热查询 / 单文件热重索引 / 存储体积」。
 *
 * 特点：
 * - **不需要运行 dsh**，只 import 插件自己的 src 模块，走的就是线上那条索引与检索路径；
 * - **不碰被测项目**：结果写进临时目录，跑完删除（`--keep` 可保留）；
 * - 索引期零模型调用、零网络请求，所以在任何机器上都能复现。
 *
 * 用法：
 *   node scripts/bench.mjs [projectPath] [--json] [--samples 100] [--no-pdf] [--keep] [--max-files 20000]
 *   node scripts/bench.mjs ./my-project --queries my-queries.json   # 可选：带标注集算 hit@k / MRR
 *
 * `--queries` 的 JSON 形如：
 *   [{ "query": "jwt token validation", "expect": "src/utils/auth.ts" }, ...]
 * `expect` 按子串匹配结果的 sourcePath / title / id（大小写不敏感）。
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { ProjectMemoryStore } from '../src/store.js'
import { buildDocEntries } from '../src/doc-pipeline.js'
import { scanSymbols } from '../src/symbols.js'
import { rankEntriesStreaming } from '../src/util/search.js'
import {
  isSupportedCode,
  isSupportedDoc,
  readFileForIndex,
  relativePath,
  walkDir,
} from '../src/util/fs.js'

// ---------- CLI ----------
const argv = process.argv.slice(2)
const opts = { json: false, samples: 100, pdf: true, keep: false, maxFiles: 20000, queries: null, target: null }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--json') opts.json = true
  else if (a === '--no-pdf') opts.pdf = false
  else if (a === '--keep') opts.keep = true
  else if (a === '--help' || a === '-h') opts.help = true
  else if (a === '--samples') opts.samples = Math.max(1, Number(argv[++i]) || 100)
  else if (a === '--max-files') opts.maxFiles = Math.max(1, Number(argv[++i]) || 20000)
  else if (a === '--queries') opts.queries = argv[++i]
  else if (a.startsWith('--')) fail(`unknown option: ${a}`)
  else if (!opts.target) opts.target = a
  else fail(`unexpected argument: ${a}`)
}

function fail(msg) {
  console.error(`bench: ${msg}`)
  console.error('usage: node scripts/bench.mjs [projectPath] [--json] [--samples N] [--no-pdf] [--keep] [--max-files N] [--queries file.json]')
  process.exit(2)
}

if (opts.help) {
  console.log('usage: node scripts/bench.mjs [projectPath] [--json] [--samples N] [--no-pdf] [--keep] [--max-files N] [--queries file.json]')
  process.exit(0)
}

const root = path.resolve(opts.target || process.cwd())
if (!existsSync(root) || !statSync(root).isDirectory()) fail(`not a directory: ${root}`)

// ---------- helpers ----------
const now = () => performance.now()
const round = (n, d = 2) => Number(n.toFixed(d))

function timeSync(fn) {
  const t0 = now()
  const value = fn()
  return { ms: now() - t0, value }
}

async function timeAsync(fn) {
  const t0 = now()
  const value = await fn()
  return { ms: now() - t0, value }
}

function stats(xs) {
  if (!xs.length) return { n: 0, p50: 0, p95: 0, max: 0, avg: 0 }
  const s = [...xs].sort((a, b) => a - b)
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))]
  return {
    n: s.length,
    p50: round(at(0.5), 3),
    p95: round(at(0.95), 3),
    max: round(s[s.length - 1], 3),
    avg: round(s.reduce((a, b) => a + b, 0) / s.length, 3),
  }
}

function dirSize(dir) {
  let bytes = 0
  let files = 0
  const stack = [dir]
  while (stack.length) {
    let entries
    try {
      entries = readdirSync(stack.pop(), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(e.parentPath || e.path, e.name)
      if (e.isDirectory()) stack.push(p)
      else {
        try {
          bytes += statSync(p).size
          files++
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { bytes, files }
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`

// ---------- 1. 扫描 ----------
const all = walkDir(root)
const targets = []
let skippedPdf = 0
for (const abs of all) {
  const ext = path.extname(abs).toLowerCase()
  const code = isSupportedCode(ext)
  const doc = isSupportedDoc(ext)
  if (!code && !doc) continue
  if (ext === '.pdf' && !opts.pdf) {
    skippedPdf++
    continue
  }
  targets.push({ abs, rel: relativePath(root, abs), code, doc, size: statSync(abs).size })
}
const truncated = targets.length > opts.maxFiles
const files = truncated ? targets.slice(0, opts.maxFiles) : targets

// ---------- 2. 冷索引（读+哈希 / 抽取 / 落盘 三段分开计时）----------
const tmpStore = mkdtempSync(path.join(os.tmpdir(), 'pm-bench-'))
const store = new ProjectMemoryStore(tmpStore).load()

const readTimes = []
const extractTimes = []
const perFileTimes = []
const updates = []
let dumps = 0
let errors = 0
const errorsList = []

const indexStart = now()
for (const f of files) {
  let read
  try {
    read = timeSync(() => readFileForIndex(f.abs))
  } catch (err) {
    errors++
    if (errorsList.length < 5) errorsList.push(`${f.rel}: ${err.message}`)
    continue
  }
  readTimes.push(read.ms)

  const ex = await timeAsync(async () => {
    if (f.code) return scanSymbols(f.rel, f.abs, read.value.buffer.toString('utf8'))
    return buildDocEntries(f.rel, f.abs, {
      chunkChars: 3000,
      maxChunks: 40,
      maxFileSizeMb: 50,
      maxPdfPages: 1000,
    })
  })
  extractTimes.push(ex.ms)
  perFileTimes.push(read.ms + ex.ms)
  if (ex.value === null) {
    dumps++
    continue
  }
  updates.push({
    rel: f.rel,
    record: { sha256: read.value.hash, size: read.value.size, type: f.code ? 'code' : 'doc', indexedAt: new Date().toISOString() },
    entries: ex.value,
    extractMs: ex.ms,
  })
}

const commit = timeSync(() => {
  store.commit((s) => {
    for (const u of updates) {
      s.markFile(u.rel, u.record)
      s.setEntries(u.rel, u.entries)
    }
  })
})
const indexMs = now() - indexStart

const entries = store.allEntries()
const fileCount = Object.keys(store.files).length

// ---------- 3. 存储体积 + 冷加载 ----------
const onDisk = dirSize(tmpStore)
// 真冷加载：store 有进程内缓存（同目录第二次 load() 直接命中），复制到新目录才是一次真正的冷启动
const coldDir = `${tmpStore}-cold`
cpSync(tmpStore, coldDir, { recursive: true })
const coldLoad = timeSync(() => new ProjectMemoryStore(coldDir).load())

// ---------- 4. 热查询 / 冷查询 ----------
const queryPool = entries.filter((e) => typeof e.title === 'string' && e.title.trim().length >= 4)
const step = Math.max(1, Math.floor(queryPool.length / opts.samples))
const queries = []
for (let i = 0; i < queryPool.length && queries.length < opts.samples; i += step) queries.push(queryPool[i].title.trim())

const idfCold = timeSync(() => store.getIdfCache())
const idf = idfCold.value
const hotTimes = []
let firstQueryHits = []
for (const q of queries) {
  const t = timeSync(() => rankEntriesStreaming(entries, [q], idf, 8))
  hotTimes.push(t.ms)
  if (!firstQueryHits.length) firstQueryHits = t.value
}
const coldQuery = timeSync(() => {
  store._idfCache = null // 强制走「写入后首次查询」的重建路径
  const rebuilt = store.getIdfCache()
  return rankEntriesStreaming(entries, [queries[0] || 'memory'], rebuilt, 8)
})

// ---------- 5. 单文件热重索引（watch 那条路径）----------
const codeRels = Object.keys(store.files).filter((rel) => store.files[rel].type === 'code')
  .sort((a, b) => store.files[a].size - store.files[b].size)
// 按体积均匀取样，别只取最小的那几个（否则「热重索引」会好看得离谱）
const want = Math.min(20, codeRels.length)
const sampleRels = []
for (let i = 0; i < want; i++) sampleRels.push(codeRels[Math.floor((i + 0.5) * codeRels.length / want)])
const reindexTimes = []
for (const rel of sampleRels) {
  const abs = path.join(root, rel)
  try {
    const t = await timeAsync(async () => {
      const r = readFileForIndex(abs)
      const ents = scanSymbols(rel, abs, r.buffer.toString('utf8'))
      store.commit((s) => {
        s.markFile(rel, { sha256: r.hash, size: r.size, type: 'code', indexedAt: new Date().toISOString() })
        s.setEntries(rel, ents)
      })
    })
    reindexTimes.push(t.ms)
  } catch {
    /* 跳过读不到的文件 */
  }
}

// ---------- 6. 整 chunk 词项 vs ≤300 字摘要的覆盖 ----------
const docEntries = entries.filter((e) => e.type === 'doc' && typeof e.terms === 'string' && e.terms)
let coverageSum = 0
for (const e of docEntries) {
  const terms = new Set(e.terms.split(/\s+/).filter(Boolean))
  if (!terms.size) continue
  const summary = String(e.summary || '').toLowerCase()
  let hit = 0
  for (const t of terms) if (summary.includes(t)) hit++
  coverageSum += hit / terms.size
}
const coverage = docEntries.length ? coverageSum / docEntries.length : null

// ---------- 7. 可选：带标注查询集 ----------
let quality = null
if (opts.queries) {
  const qs = JSON.parse(await readFileSafe(path.resolve(opts.queries)))
  if (!Array.isArray(qs) || !qs.length) fail('--queries file must be a non-empty JSON array')
  let hit5 = 0
  let hit10 = 0
  let mrr = 0
  const detail = []
  for (const item of qs) {
    const expect = String(item.expect || '').toLowerCase()
    const results = rankEntriesStreaming(entries, [String(item.query)], idf, 10)
    const rank = results.findIndex((r) => {
      const hay = `${r.entry.sourcePath || ''} ${r.entry.title || ''} ${r.entry.id || ''}`.toLowerCase()
      return expect && hay.includes(expect)
    })
    if (rank === 0 || (rank >= 0 && rank < 5)) hit5++
    if (rank >= 0 && rank < 10) hit10++
    if (rank >= 0) mrr += 1 / (rank + 1)
    detail.push({ query: item.query, expect: item.expect, rank: rank < 0 ? null : rank + 1 })
  }
  quality = {
    queries: qs.length,
    hit5: round((hit5 / qs.length) * 100, 1),
    hit10: round((hit10 / qs.length) * 100, 1),
    mrr: round(mrr / qs.length, 3),
    detail,
  }
}

// ---------- 8. 输出 ----------
const result = {
  env: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpus: os.cpus().length,
    ranAt: new Date().toISOString(),
  },
  project: {
    path: root,
    filesScanned: all.length,
    supported: targets.length,
    indexed: fileCount,
    code: updates.filter((u) => u.record.type === 'code').length,
    doc: updates.filter((u) => u.record.type === 'doc').length,
    dumps: dumps,
    pdfSkipped: skippedPdf,
    truncated,
    errors,
    errorsList,
  },
  index: {
    totalMs: round(indexMs),
    readHashMs: round(readTimes.reduce((a, b) => a + b, 0)),
    extractMs: round(extractTimes.reduce((a, b) => a + b, 0)),
    commitMs: round(commit.ms),
    perFileMs: stats(perFileTimes),
    entries: entries.length,
  },
  store: {
    dir: tmpStore,
    bytes: onDisk.bytes,
    files: onDisk.files,
    bytesPerEntry: entries.length ? Math.round(onDisk.bytes / entries.length) : 0,
  },
  coldLoadMs: round(coldLoad.ms),
  query: {
    samples: queries.length,
    idfRebuildMs: round(idfCold.ms),
    coldMs: round(coldQuery.ms),
    hot: stats(hotTimes),
  },
  hotReindex: stats(reindexTimes),
  termsCoverage: {
    docEntries: docEntries.length,
    meanSummaryCoverage: coverage === null ? null : round(coverage * 100, 1),
  },
  quality,
}

if (opts.json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  const p = result.project
  console.log(`\n=== dsh-project-memory bench ===`)
  console.log(`project   ${root}`)
  console.log(`env       ${result.env.node} ${result.env.platform} · ${result.env.cpus} CPU`)
  console.log(`scanned   ${p.filesScanned} files → ${p.supported} supported (${p.code} code / ${p.doc} doc)`)
  if (p.dumps) console.log(`skipped   ${p.dumps} dump-like files`)
  if (p.pdfSkipped) console.log(`skipped   ${p.pdfSkipped} PDFs (--no-pdf)`)
  if (p.truncated) console.log(`truncated to --max-files ${opts.maxFiles}`)
  if (p.errors) console.log(`errors    ${p.errors}  ${p.errorsList.join(' | ')}`)
  console.log(`\n-- cold index --`)
  console.log(`total     ${result.index.totalMs} ms   →   ${result.index.entries} entries in ${p.indexed} files`)
  console.log(`  read+hash ${result.index.readHashMs} ms · extract ${result.index.extractMs} ms · commit ${result.index.commitMs} ms`)
  console.log(`  per file  p50 ${result.index.perFileMs.p50} ms · p95 ${result.index.perFileMs.p95} ms`)
  console.log(`  note: read+hash depends on the OS page cache — run it twice and say which run you quote`)
  console.log(`store     ${mb(result.store.bytes)} · ${result.store.bytesPerEntry} bytes/entry · cold load ${result.coldLoadMs} ms`)
  console.log(`\n-- query (shipped scorer: IDF cache + streaming BM25 + CJK phrase boost) --`)
  console.log(`idf rebuild (first query after write)  ${result.query.idfRebuildMs} ms`)
  console.log(`cold query (rebuild + rank)            ${result.query.coldMs} ms`)
  console.log(`hot query  n=${result.query.hot.n}  p50 ${result.query.hot.p50} ms · p95 ${result.query.hot.p95} ms · max ${result.query.hot.max} ms`)
  console.log(`\n-- hot single-file re-index (watch path) --`)
  console.log(`n=${result.hotReindex.n}  p50 ${result.hotReindex.p50} ms · p95 ${result.hotReindex.p95} ms · max ${result.hotReindex.max} ms`)
  if (result.termsCoverage.docEntries) {
    console.log(`\n-- whole-chunk terms (corpus-dependent; NOT a retrieval-quality metric) --`)
    console.log(`${result.termsCoverage.docEntries} doc chunks · a ≤300-char summary alone already contains ${result.termsCoverage.meanSummaryCoverage}% of each chunk's own literal terms`)
    console.log(`(short chunks inflate this; terms exist for the tail that the summary prefix cannot hold)`)
  }
  if (quality) {
    console.log(`\n-- labeled queries (${quality.queries}) --`)
    console.log(`hit@5 ${quality.hit5}% · hit@10 ${quality.hit10}% · MRR ${quality.mrr}`)
  }
  if (firstQueryHits.length) {
    console.log(`\nsample top-1 for "${queries[0]}" → ${firstQueryHits[0].entry.sourcePath || firstQueryHits[0].entry.id}`)
  }
  console.log(opts.keep ? `\ntemp stores kept at ${tmpStore}` : `\ntemp stores removed (${tmpStore})`)
}

if (!opts.keep) {
  rmSync(tmpStore, { recursive: true, force: true })
  rmSync(coldDir, { recursive: true, force: true })
}

async function readFileSafe(p) {
  const { readFile } = await import('node:fs/promises')
  return readFile(p, 'utf8')
}
