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
assert.equal(JSON.parse(readFileSync(path.join(shardRoot, 'shards', createHash('sha256').update('a.js').digest('hex') + '.json'), 'utf8')).record.sha256, 'remote')
parent.markFile('a.js', { sha256: 'local-new', size: 1, type: 'code', indexedAt: '2026-07-01T00:00:00.000Z' })
parent.save()
assert.equal(parent.files['a.js'].sha256, 'local-new', '本地版本更新时必须写入')
assert.equal(JSON.parse(readFileSync(path.join(shardRoot, 'shards', createHash('sha256').update('a.js').digest('hex') + '.json'), 'utf8')).record.sha256, 'local-new')
console.log('  ok concurrent shard conflict converges by indexedAt')
console.log('ALL CHECKS PASSED (2 passed)')
