#!/usr/bin/env node
// 大量小文件的性能基准（不需要 dsh、不联网、不碰你自己的 store）。
//
//   node scripts/bench-edits.mjs [--files 400] [--edits 30] [--dir <空目录>] [--keep]
//
// 量两件事：
//   1. 首次索引 N 个小文件（每个文件写一个分片）；
//   2. 之后 M 次"单文件修改 → 懒索引"（每次一个 save：锁 + 分片 + 目录元数据）。
//
// 为什么单独有这个脚本：Windows/NTFS 上每次文件操作都要过过滤驱动，单文件更新的成本
// 由**文件操作次数**决定，而不是 CPU。Linux 上 p50 1ms 的路径到 NTFS 上可以是几十毫秒；
// 这个脚本用同一份代码量出差异，也用来守住"别在每次 save 里加 O(N) 扫描"。
//
// 用法示例（Windows 原生 / WSL 挂载盘）：
//   node scripts/bench-edits.mjs --dir C:\\Temp\\pm-bench
//   node scripts/bench-edits.mjs --dir /mnt/c/Users/Public/pm-bench --files 400
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { indexRepository } from '../src/tools/index-repo.js'
import { indexFile } from '../src/lazy.js'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const files = Number(arg('files', 400))
const edits = Number(arg('edits', 30))
const keep = process.argv.includes('--keep')
const parent = arg('dir', null)
const base = parent ? path.resolve(parent) : mkdtempSync(path.join(tmpdir(), 'pm-bench-'))
const root = path.join(base, `many-small-${Date.now().toString(36)}`)
if (parent) mkdirSync(base, { recursive: true })

const config = {
  memoryDir: '.dsh-project-memory',
  chunkChars: 3000,
  maxChunksPerFile: 40,
  maxFileSizeMb: 10,
  maxPdfPages: 1000,
  enableTypeScript: false,
}
const mb = (bytes) => (bytes / 1048576).toFixed(1)

mkdirSync(root, { recursive: true })
for (let i = 0; i < files; i++) {
  writeFileSync(path.join(root, `m${i}.js`), `export function f${i}(a) {\n  return a + ${i}\n}\n\nexport const v${i} = ${i}\n`)
}

const t0 = Date.now()
await indexRepository(null, config, root, {})
const indexMs = Date.now() - t0

const storeDir = path.join(root, config.memoryDir)
const shards = readdirSync(path.join(storeDir, 'shards'))
let contentBytes = 0
for (const name of readdirSync(storeDir)) {
  const p = path.join(storeDir, name)
  try {
    const st = statSync(p)
    if (st.isFile()) contentBytes += st.size
  } catch {
    /* 统计期间消失的临时文件 */
  }
}

const samples = []
for (let i = 0; i < edits; i++) {
  const file = path.join(root, `m${i % files}.js`)
  writeFileSync(file, `export function f${i % files}(a) {\n  return a + ${i} // edit ${i}\n}\n`)
  const started = Date.now()
  await indexFile(null, config, file, null, root)
  samples.push(Date.now() - started)
}
samples.sort((a, b) => a - b)
const pick = (r) => samples[Math.min(samples.length - 1, Math.floor(r * samples.length))]

console.log(JSON.stringify({
  files,
  edits,
  root: keep ? root : '(deleted)',
  index: { ms: indexMs, perFileMs: Number((indexMs / files).toFixed(2)), shards: shards.length, contentKB: Number((contentBytes / 1024).toFixed(1)) },
  singleFileEditMs: { p50: pick(0.5), p90: pick(0.9), max: samples.at(-1) },
  peakRssMB: Number(mb(process.resourceUsage().maxRSS * 1024)),
}, null, 2))

if (!keep) rmSync(root, { recursive: true, force: true })
