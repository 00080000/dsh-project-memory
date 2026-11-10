// 跨进程写：两个独立 node 进程各自 load → 改 → commit，锁 + 合并后两条都不能丢。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { ProjectMemoryStore } from '../src/store.js'
import { shardItem } from './shard-format.mjs'

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

// 同一分片被另一进程改过：按 indexedAt 收敛，不能让本地写静默覆盖更新的一方，
// 也不能让本地更新被旧磁盘版本永久压住。
const shardRoot = mkdtempSync(path.join(tmpdir(), 'pm-concurrent-shard-'))
const base = new ProjectMemoryStore(shardRoot).load()
base.markFile('a.js', { sha256: 'base', size: 1, type: 'code', indexedAt: '2026-01-01T00:00:00.000Z' })
base.save()
const parent = new ProjectMemoryStore(shardRoot).load()
const shardChild = `
import { ProjectMemoryStore } from ${JSON.stringify(storeUrl)}
const [dir, sha, at] = process.argv.slice(1)
const store = new ProjectMemoryStore(dir).load()
store.markFile('a.js', { sha256: sha, size: 1, type: 'code', indexedAt: at })
store.save()
`
await run(process.execPath, ['--input-type=module', '-e', shardChild, shardRoot, 'remote', '2026-06-01T00:00:00.000Z'], { timeout: 30000 })
parent.markFile('a.js', { sha256: 'local-old', size: 1, type: 'code', indexedAt: '2026-05-01T00:00:00.000Z' })
parent.save()
assert.equal(parent.files['a.js'].sha256, 'remote', '磁盘版本更新时必须采用对方，而不是本地静默覆盖')
assert.equal(shardItem(shardRoot, 'a.js').record.sha256, 'remote')
parent.markFile('a.js', { sha256: 'local-new', size: 1, type: 'code', indexedAt: '2026-07-01T00:00:00.000Z' })
parent.save()
assert.equal(parent.files['a.js'].sha256, 'local-new', '本地版本更新时必须写入')
assert.equal(shardItem(shardRoot, 'a.js').record.sha256, 'local-new')
console.log('  ok concurrent shard conflict converges by indexedAt')

// 任务级：一侧只更新文件热点（lastActiveAt），另一侧更新步骤（updatedAt）。
// 整条任务二选一会把热点/步骤其中一边静默回滚；这里按字段合并。
const taskRoot = mkdtempSync(path.join(tmpdir(), 'pm-concurrent-task-'))
const t0 = { id: 'tsk_c', title: '并发任务', projectRoot: taskRoot, steps: [{ content: 'old', status: 'pending' }], files: [], fileMeta: {}, archived: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: '2026-01-01T00:00:00.000Z' }
const a = new ProjectMemoryStore(taskRoot).load()
a.addTask({ ...t0 }); a.save()
const b = new ProjectMemoryStore(taskRoot).load()
const a2 = new ProjectMemoryStore(taskRoot).load()
b.commit((st) => { const t = st.getTask('tsk_c'); t.steps = [{ content: 'remote', status: 'completed' }]; t.updatedAt = '2026-02-01T00:00:00.000Z'; t.lastActiveAt = '2026-02-01T00:00:00.000Z'; st.markTasksDirty() })
a2.commit((st) => {
  const t = st.getTask('tsk_c')
  t.files = ['src/hot.ts']
  t.fileMeta = { 'src/hot.ts': { n: 1, writes: 1, lastWriteAt: '2026-03-01T00:00:00.000Z' } }
  t.lastActiveAt = '2026-03-01T00:00:00.000Z'
  st.markTasksDirty()
})
await Promise.all([b.flushPending(), a2.flushPending()].map((p) => p))
const merged = new ProjectMemoryStore(taskRoot).load().getTask('tsk_c')
assert.deepEqual(merged.steps, [{ content: 'remote', status: 'completed' }], '另一进程的新步骤不能被热点回滚')
assert.ok(merged.files.includes('src/hot.ts'), '另一进程新增的文件热点不能被步骤合并丢掉')
console.log('  ok concurrent task merge keeps both steps and file hotspots')
console.log('ALL CHECKS PASSED (2 passed)')
