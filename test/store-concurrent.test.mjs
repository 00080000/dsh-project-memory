// 跨进程写：两个独立 node 进程各自 load → 改 → commit，锁 + 合并后两条都不能丢。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { ProjectMemoryStore } from '../src/store.js'

const run = promisify(execFile)
const root = mkdtempSync(path.join(tmpdir(), 'pm-concurrent-'))
const storeUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'store.js')).href

const child = `
import { ProjectMemoryStore } from ${JSON.stringify(storeUrl)}
const [dir, id] = process.argv.slice(1)
const store = new ProjectMemoryStore(dir).load()
await new Promise((resolve) => setTimeout(resolve, 120))
store.commit((s) => s.replaceInsightItems([...s.insightItems(), { id, kind: 'lesson', scope: 'project', title: id }]))
`
await Promise.all([
  run(process.execPath, ['--input-type=module', '-e', child, root, 'a'], { timeout: 30000 }),
  run(process.execPath, ['--input-type=module', '-e', child, root, 'b'], { timeout: 30000 }),
])
const finalStore = new ProjectMemoryStore(root).load()
assert.deepEqual(finalStore.insightItems().map((it) => it.id).sort(), ['a', 'b'])
console.log('  ok two processes append without losing an entry')
console.log('ALL CHECKS PASSED (1 passed)')
