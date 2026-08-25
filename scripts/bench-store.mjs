#!/usr/bin/env node
// Benchmark the sharded store: cold-load time and hot-path (single lazy re-index) blocking time
// at a synthetic project scale. Usage: node scripts/bench-store.mjs [files=2000] [--keep] [--cold <dir>]
import { readdirSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { ProjectMemoryStore } from '../src/store.js'
import { scanSymbols } from '../src/symbols.js'

const args = process.argv.slice(2)
const mode = args.includes('--cold') ? 'cold' : 'full'
const keep = args.includes('--keep')
const fileCount = Number(args.find((a) => /^\d+$/.test(a))) || 2000

function synthFile(i) {
  return [
    `// module ${i}`,
    `export const id${i} = ${i}`,
    `export function compute${i}(a, b) {`,
    `  const mid = a * ${i} + b`,
    `  if (mid > 0) return mid - 1`,
    `  return fallback${i}(mid)`,
    `}`,
    `function fallback${i}(v) {`,
    `  return v ?? ${i}`,
    `}`,
    `export class Service${i} {`,
    `  handle(input) {`,
    `    return input + id${i}`,
    `  }`,
    `}`,
  ].join('\n')
}

function buildTree(root, n) {
  const files = []
  const perDir = 50
  for (let i = 0; i < n; i++) {
    const dir = path.join(root, 'src', 'mod' + Math.floor(i / perDir))
    mkdirSync(dir, { recursive: true })
    const p = path.join(dir, `file${i}.js`)
    writeFileSync(p, synthFile(i))
    files.push(p)
  }
  return files
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

if (mode === 'cold') {
  const dir = args[args.indexOf('--cold') + 1]
  const t0 = performance.now()
  const store = new ProjectMemoryStore(path.join(dir, '.dsh-project-memory')).load()
  const stats = store.stats()
  const ms = performance.now() - t0
  console.log(JSON.stringify({ coldLoadMs: Number(ms.toFixed(1)), ...stats }))
  process.exit(0)
}

const root = mkdtempSync(path.join(tmpdir(), 'pm-bench-'))
process.stdout.write(`generating ${fileCount} files… `)
const tGen = performance.now()
const files = buildTree(root, fileCount)
console.log(`${(performance.now() - tGen).toFixed(0)}ms`)

const memDir = path.join(root, '.dsh-project-memory')
const store = new ProjectMemoryStore(memDir)

process.stdout.write('bulk cold index (scan + insert all, one save)… ')
const tBulk = performance.now()
for (const p of files) {
  const entries = scanSymbols(p, readFileSync(p, 'utf8'))
  const rel = path.relative(root, p)
  store.markFile(rel, { sha256: `hash-${rel}`, size: 1, type: 'code', indexedAt: new Date().toISOString() })
  store.setEntries(rel, entries)
}
store.save()
console.log(`${(performance.now() - tBulk).toFixed(0)}ms`)

let shardCount = 0
try {
  shardCount = readdirSync(path.join(memDir, 'shards')).length
} catch {}

// 热路径：模拟单次懒索引（改内容 → 重扫描 → 脏分片落盘），全程同步阻塞
const samples = []
for (let round = 0; round < 30; round++) {
  const p = files[round % files.length]
  writeFileSync(p, synthFile(round % files.length) + `\n// touch ${round}\n`)
  const rel = path.relative(root, p)
  const t = performance.now()
  const entries = scanSymbols(p, readFileSync(p, 'utf8'))
  store.markFile(rel, { sha256: `hash-${rel}-${round}`, size: 1, type: 'code', indexedAt: new Date().toISOString() })
  store.setEntries(rel, entries)
  store.save()
  samples.push(performance.now() - t)
}
console.log(`files indexed : ${store.stats().files}`)
console.log(`shard files   : ${shardCount}`)
console.log(`hot lazy-index block: median ${median(samples).toFixed(2)}ms | max ${Math.max(...samples).toFixed(2)}ms (${samples.length} runs)`)

const { spawnSync } = await import('node:child_process')
const selfPath = fileURLToPath(import.meta.url)
const cold = spawnSync(process.execPath, [selfPath, '--cold', root], { encoding: 'utf8' })
console.log(`cold load     : ${(cold.stdout.trim().split('\n').pop() || '').trim()}`)

if (!keep) rmSync(root, { recursive: true, force: true })
else console.log(`kept: ${root}`)
