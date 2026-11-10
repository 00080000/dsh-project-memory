// 目标尺寸哈希桶（32KB）回归：node test/shard-bucket.test.mjs
// 覆盖：v3 format / 一文件只属于一个桶 / 桶数随体积 / 单文件更新只重写一个桶 / 删除保留同桶其它文件 / v2 迁移。
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProjectMemoryStore } from '../src/store.js'
import { shardItem, shardItems } from './shard-format.mjs'

let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }

const rel = (i) => `src/f${String(i).padStart(3, '0')}.js`
const entry = (i, pad = 0) => ({
  id: `${rel(i)}#1`, type: 'code', sourcePath: rel(i), sourceLine: 1,
  title: `fn${i}`, text: `export function fn${i}() { return ${i} }`, keywords: ['fn'], pad: 'x'.repeat(pad),
})

function buckets(dir) {
  return readdirSync(path.join(dir, 'shards'))
    .filter((n) => n.startsWith('bucket-') && n.endsWith('.json'))
    .sort()
    .map((name) => ({ name, doc: JSON.parse(readFileSync(path.join(dir, 'shards', name), 'utf8')) }))
}

// 1. 一文件一桶 + 桶数随体积增长
{
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'pm-bucket-')), 'mem')
  const store = new ProjectMemoryStore(dir).load()
  for (let i = 0; i < 60; i++) {
    store.markFile(rel(i), { sha256: `h${i}`, size: 1, type: 'code', indexedAt: new Date().toISOString() })
    store.setEntries(rel(i), [entry(i, 1200)])
  }
  store.save()

  const format = JSON.parse(readFileSync(path.join(dir, 'format.json'), 'utf8'))
  assert.equal(format.version, 3)
  assert.equal(format.layout, 'bucket')
  assert.equal(format.bucketSize, 32 * 1024)
  assert.ok(format.bucketCount >= 2, `桶数应随内容增长：${format.bucketCount}`)

  const list = buckets(dir)
  const seen = new Map()
  for (const { name, doc } of list) {
    assert.equal(doc.version, 3)
    for (const item of doc.items) {
      assert.ok(!seen.has(item.relPath), `${item.relPath} 不能同时出现在两个桶`)
      seen.set(item.relPath, name)
    }
  }
  assert.equal(seen.size, 60, '所有文件都要落盘')
  assert.equal(list.length, format.bucketCount)
  ok('v3 format：一文件一桶、桶数随体积、文件不重复')
}

// 2. 单文件更新只重写一个桶；删除保留同桶其它文件
{
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'pm-bucket-update-')), 'mem')
  const store = new ProjectMemoryStore(dir).load()
  for (let i = 0; i < 80; i++) {
    store.markFile(rel(i), { sha256: `h${i}`, size: 1, type: 'code', indexedAt: new Date().toISOString() })
    store.setEntries(rel(i), [entry(i, 800)])
  }
  store.save()
  const before = buckets(dir)
  const target = before.flatMap(({ name, doc }) => doc.items.map((item) => ({ name, rel: item.relPath }))).find((x) => x.rel === rel(7))
  assert.ok(target, '目标文件应已落盘')

  store.setEntries(rel(7), [entry(7, 900)])
  store.markFile(rel(7), { sha256: 'h7b', size: 2, type: 'code', indexedAt: new Date().toISOString() })
  store.save()
  const after = buckets(dir)
  const changed = after.filter(({ name, doc }) => {
    const old = before.find((b) => b.name === name)
    return JSON.stringify(doc) !== JSON.stringify(old?.doc)
  })
  assert.equal(changed.length, 1, '只应重写目标文件所属的那一个桶')
  assert.equal(changed[0].name, target.name)
  assert.equal(shardItem(dir, rel(7)).record.sha256, 'h7b')

  // 删除：同桶其它文件保留
  const sameBucket = before.find((b) => b.name === target.name).doc.items.map((x) => x.relPath).filter((r) => r !== rel(7))
  store.removeFile(rel(7))
  store.save()
  assert.equal(shardItem(dir, rel(7)), undefined)
  for (const r of sameBucket) assert.ok(shardItem(dir, r), `${r} 不能被误删`)
  ok('单文件更新只重写一个桶；删除不影响同桶其它文件')
}

// 3. v2 一文件一 shard → v3 迁移：旧文件名消失、内容保留
{
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'pm-bucket-mig-')), 'mem')
  mkdirSync(path.join(dir, 'shards'), { recursive: true })
  writeFileSync(path.join(dir, 'format.json'), JSON.stringify({ version: 2, layout: 'sharded' }))
  writeFileSync(path.join(dir, 'shards', 'legacy.json'), JSON.stringify({
    relPath: 'docs/a.md',
    record: { sha256: 'aa', size: 1, type: 'doc', indexedAt: new Date().toISOString() },
    entries: [{ id: 'a1', type: 'doc', sourcePath: 'docs/a.md', sourceLine: 1, title: 'A' }],
  }))
  const store = new ProjectMemoryStore(dir).load()
  store.save()
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'format.json'), 'utf8')).version, 3)
  assert.equal(readdirSync(path.join(dir, 'shards')).filter((n) => n === 'legacy.json').length, 0, '旧分片必须删除')
  assert.equal(shardItem(dir, 'docs/a.md').record.sha256, 'aa')
  ok('v2 → v3 迁移：旧分片删除、内容保留')
}

// 4. 逐文件增长也会扩桶（不能等一次大 batch 才重排）
{
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'pm-bucket-grow-')), 'mem')
  const store = new ProjectMemoryStore(dir).load()
  for (let i = 0; i < 120; i++) {
    store.markFile(rel(i), { sha256: `g${i}`, size: 1, type: 'code', indexedAt: new Date().toISOString() })
    store.setEntries(rel(i), [entry(i, 900)])
    store.save()
  }
  const format = JSON.parse(readFileSync(path.join(dir, 'format.json'), 'utf8'))
  assert.ok(format.bucketCount > 1, `逐文件增长后桶数应 >1：${format.bucketCount}`)
  assert.ok(format.bucketCount < 120, '也不该一文件一桶')
  ok('逐文件增长：桶数随内容扩展')
}

console.log(`\nshard-bucket tests: ${passed} passed`)
