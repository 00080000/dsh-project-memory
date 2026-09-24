/**
 * dsh-project-memory — 微基准测试（micro-benchmark）
 *
 * 直接驱动内核热路径（不经过 defineTool / HTTP / LLM）：
 *   - store.js       : load / commit / addExperience(findSupersede) / removeExperience
 *   - util/search.js : buildBm25 / rankEntriesStreaming / rankExperienceScored
 *   - symbols.js     : scanSymbols（零 token 符号抽取，无 LLM）
 *   - link.js        : linkEntries（doc↔symbol 交叉链接）
 *   - insight-store.js: GlobalStore read/write + saveInsight（归一化去重）
 *   - similarity.js  : normalizedTokenOverlap（去重阈值判定）
 *
 * 用法: node scripts/bench-synthetic.mjs [files]
 *   files 可选，默认 5000（生成的代码文件数；每个文件约 4~5 条符号）。
 * 数据全部在 OS 临时目录生成，不会写入项目本身。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { ProjectMemoryStore } from '../src/store.js'
import { walkDir, readFileForIndex, relativePath, storeKey, isSupportedCode } from '../src/util/fs.js'
import { scanSymbols } from '../src/symbols.js'
import { linkEntries } from '../src/link.js'
import { rankEntriesStreaming, rankExperienceScored, makeSearchText } from '../src/util/search.js'
import { GlobalStore, saveInsight, normalizeInsight } from '../src/insight-store.js'
import { normalizedTokenOverlap } from '../src/similarity.js'

const FILES = Number(process.argv[2] || 5000)

// 记录所有临时目录，结束时统一清理
const createdDirs = []
function tmpd(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix))
  createdDirs.push(d)
  return d
}
function cleanup() {
  for (const d of createdDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// ---- 统计 ----
function stats(name, times) {
  times.sort((a, b) => a - b)
  const avg = times.reduce((s, t) => s + t, 0) / times.length
  const p50 = times[Math.floor(times.length * 0.5)]
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]
  const max = times[times.length - 1]
  return { name, avg, p50, p95, max, n: times.length }
}
function show(label, s) {
  const f = (x) => x.toFixed(2)
  console.log(`${label.padEnd(46)} avg=${f(s.avg).padStart(8)}ms  p50=${f(s.p50).padStart(8)}ms  p95=${f(s.p95).padStart(8)}ms  max=${f(s.max).padStart(8)}ms  (n=${s.n})`)
  return s
}

// ---- 生成合成代码语料 ----
function generateCorpus(root, files) {
  const src = path.join(root, 'src')
  mkdirSync(src, { recursive: true })
  const writes = []
  for (let i = 0; i < files; i++) {
    const name = `mod_${i}`
    const body = [
      `import { dep${i} } from './dep'`,
      `/** doc for ${name} */`,
      `export class ${cap(name)} {`,
      `  methodA$${i}(a${i}, b${i}) { if (a${i}) return b${i}; return null }`,
      `  methodB$${i}(c${i}) { return c${i} ?? dep${i} }`,
      `}`,
      `export function helper$${i}(arg${i}) { return arg${i} * 2 }`,
      `export function util$${i}(p${i}, q${i}) { return p${i} + q${i} - dep${i} }`,
    ].join('\n')
    writes.push({ p: path.join(src, `${name}.js`), body })
  }
  // 写盘（大量小文件）
  for (const w of writes) writeFileSync(w.p, w.body)
  return src
}

function cap(s) {
  return s.replace(/^\w/, (c) => c.toUpperCase())
}

// ---- 与 indexRepository 相同的内核索引路径（去掉 LLM/doc 分支，纯 code symbol） ----
async function coldIndex(root, config) {
  const storeDir = path.join(root, config.memoryDir)
  const store = new ProjectMemoryStore(storeDir)
  // 首次 load 会读盘（若已存在），这里传入一个全新实例以贴近真实冷启动
  store.load()
  const { files } = walkDir(root)
  const seen = new Set()
  let updated = 0
  const fileUpdates = []
  for (const filePath of files) {
    const rel = storeKey(relativePath(root, filePath))
    seen.add(rel)
    const ext = path.extname(filePath).toLowerCase()
    if (!isSupportedCode(ext)) continue
    const existing = store.fileRecord(rel)
    const { hash, size, buffer } = readFileForIndex(filePath)
    const entries = scanSymbols(rel, filePath, buffer.toString('utf8'))
    fileUpdates.push({ rel, expectedHash: existing?.sha256, hash, size, entries, type: 'code' })
    updated++
  }
  const report = store.commit((s) => {
    for (const u of fileUpdates) s.applyFileUpdate(u.rel, u)
    for (const rel of Object.keys(s.files)) if (!seen.has(rel)) s.removeFile(rel)
    linkEntries(s)
    return s.stats()
  })
  return { report, store }
}

// ---- 热环境查询：读盘一次后用内存 store + IDF 缓存反复检索 ----
function warmStoreFrom(root, config) {
  const store = new ProjectMemoryStore(path.join(root, config.memoryDir)).load()
  return store
}

async function main() {
  const config = {
    memoryDir: '.dsh-project-memory',
    chunkChars: 3000,
    maxChunksPerFile: 40,
    maxFileSizeMb: 50,
    maxOutputChars: 8000,
    maxPdfPages: 1000,
    llmQueryExpansion: false,
    expansionCount: 6,
  }

  console.log('='.repeat(78))
  console.log('dsh-project-memory 内核微基准测试')
  console.log(`  node ${process.version} · ${process.platform}/${process.arch} · ${process.cwd()}`)
  console.log(`  synched corpus: ${FILES} 代码文件（每文件约 4~5 条符号）`)
  console.log('='.repeat(78))

  // 生成语料
  const targetRoot = tmpd('pm-bench-')
  const genT0 = performance.now()
  generateCorpus(targetRoot, FILES)
  const genMs = performance.now() - genT0
  console.log(`\n[语料生成] ${FILES} 文件写盘耗时 ${genMs.toFixed(0)} ms`)

  // ---------- 1. 冷索引（完整内核管线，无 LLM）----------
  console.log('\n--- 1. 冷索引 index_repo 内核管线（walk + sha256 + scanSymbols + linkEntries + commit）---')
  const idxTimes = []
  let entriesCount = 0
  for (let r = 0; r < 3; r++) {
    const root = tmpd('pm-idx-')
    generateCorpus(root, FILES)
    const t0 = performance.now()
    const { report } = await coldIndex(root, config)
    const dt = performance.now() - t0
    idxTimes.push(dt)
    entriesCount = report.entries
  }
  show('cold index (full pipeline)', stats('idx', idxTimes))
  console.log(`       -> ${FILES} files, ${entriesCount} entries in store`)

  // ---------- 2. 冷加载（首次 load 读盘 shards）----------
  console.log('\n--- 2. 冷加载 store.load()（首次读盘，sharded 布局）---')
  {
    const root = tmpd('pm-cld-')
    generateCorpus(root, FILES)
    await coldIndex(root, config)
    const times = []
    for (let r = 0; r < 5; r++) {
      // 拷贝到新路径，绕开进程内 storeCache，测真实读盘
      const copy = tmpd('pm-cldcp-')
      const srcDir = path.join(root, config.memoryDir)
      const dstDir = path.join(copy, config.memoryDir)
      mkdirSync(dstDir, { recursive: true })
      for (const f of readdirSync(srcDir)) {
        if (f === 'shards') {
          mkdirSync(path.join(dstDir, 'shards'), { recursive: true })
          for (const sf of readdirSync(path.join(srcDir, 'shards'))) {
            writeFileSync(path.join(dstDir, 'shards', sf), readFileSync(path.join(srcDir, 'shards', sf)))
          }
        } else {
          writeFileSync(path.join(dstDir, f), readFileSync(path.join(srcDir, f)))
        }
      }
      const t0 = performance.now()
      const s = new ProjectMemoryStore(dstDir).load()
      times.push(performance.now() - t0)
      s.stats()
    }
    show('cold load store (first read)', stats('coldload', times))
  }

  // ---------- 3. 热环境查询（IDF 缓存 + 单遍流式打分）----------
  console.log('\n--- 3. query_memory 热路径（getIdfCache + rankEntriesStreaming + CJK phrase boost）---')
  {
    const root = tmpd('pm-q-')
    generateCorpus(root, FILES)
    const { store } = await coldIndex(root, config)
    // 预取一次 IDF（首次查询需要重建，后续命中缓存）
    store.getIdfCache()
    const all = store.allEntries()
    const queries = ['methodA return', 'helper util dep', 'export class', 'sum addition', 'null coalesce']
    const times = []
    const n = Math.min(200, FILES)
    for (let r = 0; r < n; r++) {
      const q = queries[r % queries.length]
      const idf = store.getIdfCache()
      const t0 = performance.now()
      rankEntriesStreaming(all, [q], idf, 8)
      times.push(performance.now() - t0)
    }
    show(`query_memory cached (${all.length} entries)`, stats('q', times))
  }

  // ---------- 4. ID F 重建（写库后首次查询 / version bump 后失效）----------
  console.log('\n--- 4. query_memory 冷查询（IDF 重建 + 检索，首次命中前）---')
  {
    const root = tmpd('pm-qc-')
    generateCorpus(root, FILES)
    const { store } = await coldIndex(root, config)
    const all = store.allEntries()
    store._idfCache = null // 模拟缓存失效（写库后 version bump）
    const t0 = performance.now()
    const idf = store.getIdfCache()
    rankEntriesStreaming(all, ['methodA'], idf, 8)
    const dt = performance.now() - t0
    console.log(`  cold query (IDF rebuild + rank) avg=${dt.toFixed(2)}ms  (${all.length} entries)`)
  }

  // ---------- 5. symbol 抽取吞吐（单一文件）----------
  console.log('\n--- 5. scanSymbols 符号抽取吞吐（零 token，无 LLM）---')
  {
    const root = tmpd('pm-sym-')
    generateCorpus(root, FILES)
    const files = walkDir(root).files.filter((f) => f.endsWith(".js"))
    const times = []
    const n = Math.min(files.length, 500)
    for (let i = 0; i < n; i++) {
      const f = files[i]
      const content = readFileSync(f, 'utf8')
      const t0 = performance.now()
      scanSymbols(relativePath(root, f), f, content)
      times.push(performance.now() - t0)
    }
    const a = times.reduce((s, t) => s + t, 0) / times.length
    show(`scanSymbols per file (${n} files)`, stats('sym', times))
    console.log(`       -> ${(a * 1000).toFixed(1)} µs/file`)
  }

  // ---------- 6. 热惰性重索引（改一个文件 → 重新抽取 + commit）----------
  console.log('\n--- 6. 热惰性重索引：单文件变更（lazyIndexing 常规路径，已加载 store）---')
  {
    const root = tmpd('pm-hot-')
    generateCorpus(root, FILES)
    const { store, report } = await coldIndex(root, config)
    void report
    const files = walkDir(root).files.filter((f) => f.endsWith(".js"))
    const times = []
    const n = Math.min(files.length, 50)
    for (let i = 0; i < n; i++) {
      const f = files[i]
      const rel = storeKey(relativePath(root, f))
      const { hash, size, buffer } = readFileForIndex(f)
      const entries = scanSymbols(rel, f, buffer.toString('utf8'))
      const t0 = performance.now()
      store.commit((s) => s.applyFileUpdate(rel, { expectedHash: hash, hash, size, entries, type: 'code' }))
      times.push(performance.now() - t0)
    }
    show(`hot re-index single file (${n} files)`, stats('hot', times))
  }

  // ---------- 7. insight 存储：写入 + 读取 ----------
  console.log('\n--- 7. insight-store：GlobalStore 读写 + saveInsight 去重 ---')
  {
    const root = tmpd('pm-ins-')
    const globalFile = path.join(root, 'global.json')
    const cfg = { insight: { dedupOverlap: 0.7, reinforceBand: 0.65 } }

    const wTimes = []
    for (let r = 0; r < 5; r++) {
      const gs = new GlobalStore(globalFile).load()
      const t0 = performance.now()
      for (let i = 0; i < 100; i++) {
        const raw = normalizeInsight({ kind: 'lesson', title: `Lesson ${i}`, pattern: `JWT token validation error ${i}`, fix: `Use jose ${i}` }, { scope: 'global' })
        const res = saveInsight({ store: { insightItems: () => [], replaceInsightItems: () => {} }, globalStore: gs, raw, scope: 'global', cfg })
      }
      gs.commit()
      wTimes.push(performance.now() - t0)
    }
    show('saveInsight 100 条 (含去重)', stats('ins-w', wTimes))

    const rTimes = []
    const gs = new GlobalStore(globalFile).load()
    for (let r = 0; r < 10; r++) {
      const t0 = performance.now()
      const items = gs.items()
      void items.length
      rTimes.push(performance.now() - t0)
    }
    show('globalStore items() 读取', stats('ins-r', rTimes))
  }

  // ---------- 7. 去重/相似度（save_lesson 命中判断）----------
  console.log('\n--- 8. normalizedTokenOverlap 去重判定（候选池）---')
  {
    const items = []
    for (let i = 0; i < 1000; i++) {
      items.push({ id: `ins_${i}`, title: `Lesson ${i}`, pattern: `JWT token validation error ${i}`, fix: `Use jose library ${i}`, scope: 'global', kind: 'lesson', archived: false })
    }
    // 镜像 findBestOverlapMatch：全量扫描 1000 候选，找最高 overlap（无早退）
    const times = []
    let bestSeen = 0
    const warmQ = `${items[123].title} ${items[123].pattern} ${items[123].fix}`
    normalizedTokenOverlap(warmQ, `${items[123].pattern} ${items[123].fix}`) // JIT 预热
    for (let r = 0; r < 200; r++) {
      const t0 = performance.now()
      let bestScore = 0
      for (const it of items) {
        const sc = normalizedTokenOverlap(warmQ, `${it.title} ${it.pattern} ${it.fix}`)
        if (sc > bestScore) bestScore = sc
      }
      if (bestScore > bestSeen) bestSeen = bestScore
      times.push(performance.now() - t0)
    }
    show('dedupe full scan over 1000 candidates', stats('dedupe', times))
    console.log(`       -> 候选池 1000，最高 overlap ≈ ${Math.round(bestSeen * 100)}%`)
  }

  // ---------- 8. remember（addExperience + findSupersede）----------
  console.log('\n--- 9. remember / addExperience（problem→solution，双向 0.7 去重）---')
  {
    const root = tmpd('pm-exp-')
    const store = new ProjectMemoryStore(path.join(root, config.memoryDir)).load()
    // 用互异的 problem（含随机 token）让经验池真实增长，避免互相 supersede 合并成一条
    const times = []
    const total = []
    for (let i = 0; i < 1000; i++) {
      // 每个 problem 含两个高熵 token，使公共词只占 <0.7，池真实增长而非互相 supersede
      const uniq = Math.floor(Math.random() * 1e9).toString(36)
      const rand = Math.random().toString(36).slice(2, 10)
      const t0 = performance.now()
      store.addExperience({ problem: `payment gateway timeout ${uniq} ${rand}`, solution: `add exponential backoff ${uniq}` })
      const dt = performance.now() - t0
      times.push(dt)
      total.push(dt)
    }
    show('addExperience 单条 (含去重扫描,池增长)', stats('exp', times))
    console.log(`       -> 池增长到 ${store.experience.length} 条；1000 次累计 ${total.reduce((s, t) => s + t, 0).toFixed(1)} ms`)
  }

  // 清理
  cleanup()

  console.log('\n' + '='.repeat(78))
  console.log('完成。以上均为纯内核路径，不含 LLM 摘要 / PDF 解析 / defineTool 包装。')
  console.log('='.repeat(78))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
