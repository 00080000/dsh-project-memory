// 跨进程写：两个独立 node 进程各自 load → 改 → commit，锁 + 合并后两条都不能丢。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { ProjectMemoryStore, _clearStoreCacheForTest } from '../src/store.js'
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

// 会话绑定：B 只改 s2，A 改 s1。整份本地快照覆盖会把 B 的 s2 回退，也会让 A 的旧内存
// 把 B 刚改的绑定写回去。合并必须只回写“相对基线有变化”的项。
const bindRoot = mkdtempSync(path.join(tmpdir(), 'pm-concurrent-bind-'))
const nowIso = '2026-01-01T00:00:00.000Z'
const mkTask = (id) => ({ id, title: id, projectRoot: bindRoot, steps: [], files: [], archived: false, createdAt: nowIso, updatedAt: nowIso, lastActiveAt: nowIso })
const seed = new ProjectMemoryStore(bindRoot).load()
for (const id of ['tsk_old', 'tsk_a', 'tsk_b']) seed.addTask(mkTask(id))
seed.setBinding('s1', 'tsk_old')
seed.setBinding('s2', 'tsk_old')
seed.save()
_clearStoreCacheForTest()
const A = new ProjectMemoryStore(bindRoot).load()
_clearStoreCacheForTest()
const B = new ProjectMemoryStore(bindRoot).load()
B.setBinding('s2', 'tsk_b')
B.save()
A.setBinding('s1', 'tsk_a')
A.save()
_clearStoreCacheForTest()
assert.deepEqual(new ProjectMemoryStore(bindRoot).load().binding, { s1: 'tsk_a', s2: 'tsk_b' }, '未改动的绑定不能被本地旧快照回退')
console.log('  ok concurrent binding merge only writes locally changed sessions')

// tombstone 不能越过一次成功落盘：A 解绑后 B 重新绑定，A 之后的写不能把 B 的新绑定删掉。
const tombRoot = mkdtempSync(path.join(tmpdir(), 'pm-concurrent-tomb-'))
const seed2 = new ProjectMemoryStore(tombRoot).load()
for (const id of ['tsk_old', 'tsk_new', 'tsk_other']) {
  seed2.addTask({ id, title: id, projectRoot: tombRoot, steps: [], files: [], archived: false, createdAt: nowIso, updatedAt: nowIso, lastActiveAt: nowIso })
}
seed2.setBinding('s1', 'tsk_old')
seed2.save()
_clearStoreCacheForTest()
const A2 = new ProjectMemoryStore(tombRoot).load()
_clearStoreCacheForTest()
const B2 = new ProjectMemoryStore(tombRoot).load()
A2.removeBinding('s1')
A2.save()
B2.setBinding('s1', 'tsk_new')
B2.save()
A2.setBinding('s9', 'tsk_other')
A2.save()
_clearStoreCacheForTest()
assert.deepEqual(new ProjectMemoryStore(tombRoot).load().binding, { s1: 'tsk_new', s9: 'tsk_other' }, '旧 tombstone 不能误杀后续合法绑定')
console.log('  ok binding tombstone clears after a successful save')

// 归档状态不能用 updatedAt 猜：普通步骤写也会刷新它。B 持有旧 archived=false 时
// 只改步骤，不能把 A 的归档回滚；反向也不能把 A 的解归档回滚。
const archRoot = mkdtempSync(path.join(tmpdir(), 'pm-concurrent-arch-'))
const archSeed = new ProjectMemoryStore(archRoot).load()
archSeed.addTask({ id: 'tsk_arch', title: '归档并发', projectRoot: archRoot, steps: [{ content: 'a', status: 'pending' }], files: [], fileMeta: {}, archived: false, createdAt: nowIso, updatedAt: nowIso, lastActiveAt: nowIso })
archSeed.save()
_clearStoreCacheForTest()
const AA = new ProjectMemoryStore(archRoot).load()
_clearStoreCacheForTest()
const BB = new ProjectMemoryStore(archRoot).load()
AA.commit((st) => { const t = st.getTask('tsk_arch'); t.archived = true; t.updatedAt = '2026-02-01T00:00:00.000Z'; st.markTasksDirty() })
AA.save()
BB.commit((st) => { const t = st.getTask('tsk_arch'); t.steps = [{ content: 'b', status: 'completed' }]; t.updatedAt = '2026-03-01T00:00:00.000Z'; st.markTasksDirty() })
BB.save()
_clearStoreCacheForTest()
assert.equal(new ProjectMemoryStore(archRoot).load().getTask('tsk_arch').archived, true, '普通更新不能回滚另一进程的归档')
console.log('  ok concurrent task archive is not rolled back by a plain update')
console.log('ALL CHECKS PASSED (5 passed)')
