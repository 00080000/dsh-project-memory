#!/usr/bin/env node
/**
 * 在**独立进程**里量一次 store 冷加载的耗时与常驻内存，输出一行 JSON。
 *
 * 为什么要单独一个进程：`scripts/bench.mjs` 在同一个进程里已经有一个 store（索引用的那个），
 * 再 load 第二个副本量出来的堆是两份的。这里从空进程冷加载，数字才是「一个 store 常驻多少」。
 * 必须带 `--expose-gc` 运行（bench.mjs 会自己加），否则量不到稳定值。
 *
 * 用法：node --expose-gc scripts/bench-load.mjs <storeDir>
 */
import { performance } from 'node:perf_hooks'

import { ProjectMemoryStore } from '../src/store.js'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: node --expose-gc scripts/bench-load.mjs <storeDir>')
  process.exit(2)
}

const gc = typeof global.gc === 'function' ? global.gc : () => {}
const mb = (n) => Math.round((n / 1048576) * 10) / 10
const snap = () => {
  const m = process.memoryUsage()
  return { heapMb: mb(m.heapUsed), rssMb: mb(m.rss) }
}

gc()
const t0 = performance.now()
const store = new ProjectMemoryStore(dir).load()
const loadMs = performance.now() - t0
gc()
const afterLoad = snap()

// allEntries() 会在内存里物化 searchText（派生字段不落盘），这一步才是查询前的水位
const entries = store.allEntries()
gc()
const afterEntries = snap()

console.log(
  JSON.stringify({
    loadMs: Number(loadMs.toFixed(2)),
    entries: entries.length,
    afterLoad,
    afterEntries,
  }),
)
