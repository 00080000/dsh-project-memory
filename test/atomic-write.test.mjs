// writeJsonAtomic 的原子性与失败清理语义
//   node test/atomic-write.test.mjs
//
// 这个函数原本在 store.js 与 insight-store.js 各有一份副本，且已经漂移（一份失败时删 .tmp、
// 一份重试 rename；父目录契约也不同）。这里的用例钉住合并后的统一语义，最后一条同时钉住
// store.js 里那两句已冗余的 mkdirSync(shards) 删除是安全的。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeJsonAtomic } from '../src/util/fs.js'
import { ProjectMemoryStore } from '../src/store.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

/** 目录里残留的 .tmp（任何 pid 的）。 */
const leftoverTmps = (dir) => readdirSync(dir).filter((name) => name.endsWith('.tmp'))

const base = mkdtempSync(path.join(tmpdir(), 'pm-atomic-'))

// ---- 1. 父目录不存在时自建（global.json 首次写入的真实形状）----
{
  const nested = path.join(base, 'a', 'b', 'global.json')
  assert.equal(existsSync(path.dirname(nested)), false)
  writeJsonAtomic(nested, { version: 1, items: [] })
  assert.deepEqual(JSON.parse(readFileSync(nested, 'utf8')), { version: 1, items: [] })
  assert.equal(leftoverTmps(path.dirname(nested)).length, 0)
  ok('父目录不存在时自建目录、写入成功且不留 .tmp')
}

// ---- 2. 覆盖写替换完整内容 ----
{
  const file = path.join(base, 'overwrite.json')
  writeJsonAtomic(file, { v: 1, keep: 'x' })
  writeJsonAtomic(file, { v: 2 })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 2 })
  assert.equal(leftoverTmps(base).length, 0)
  ok('覆盖写替换完整内容（旧字段不残留）')
}

// ---- 3. rename 失败：清掉自己的 .tmp 并把错误抛出去 ----
// 目标是个目录 → rename(tmp, dir) 必然失败。这是不用改权限位就能稳定复现的失败路径。
{
  const dirTarget = path.join(base, 'target-as-dir')
  mkdirSync(dirTarget)
  assert.throws(() => writeJsonAtomic(dirTarget, { a: 1 }))
  assert.equal(leftoverTmps(base).length, 0, `失败后残留: ${leftoverTmps(base).join(', ')}`)
  ok('写/rename 失败时清掉自己的 .tmp，不留给清扫兜底')
}

// ---- 4. 序列化失败：不产生 .tmp，也不破坏已存在的文件 ----
{
  const file = path.join(base, 'keep.json')
  writeJsonAtomic(file, { ok: true })
  const circular = {}
  circular.self = circular
  assert.throws(() => writeJsonAtomic(file, circular), TypeError)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ok: true })
  assert.equal(leftoverTmps(base).length, 0)
  ok('序列化失败时原文件完好、无 .tmp 产生')
}

// ---- 5. 只删自己的 .tmp，不动别的进程/别的原因留下的 ----
// 别人的残留按 mtime 交给 cleanStaleTmp() 处理，这个函数不许越权删。
{
  const file = path.join(base, 'foreign.json')
  const foreign = `${file}.999999.tmp`
  writeFileSync(foreign, 'not mine')
  writeJsonAtomic(file, { mine: true })
  assert.equal(existsSync(foreign), true, '别的 .tmp 不该被本函数删除')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mine: true })
  ok('只清理自己 pid 的 .tmp，别的残留留给 cleanStaleTmp()')
}

// ---- 6. 集成：shards/ 不存在时 store 仍写得进去 ----
// store.save() 与迁移路径里原来的 mkdirSync(shards) 已由本函数接管，这里钉住那次删除是安全的。
// 回归面很具体：谁要是把函数里的 mkdirSync 拿掉，这里立刻红灯，而不是等某个用户
// 重新克隆仓库（store 里没有 shards/）才炸。
{
  const memoryDir = path.join(mkdtempSync(path.join(tmpdir(), 'pm-shard-')), '.dsh-project-memory')
  const shardsDir = path.join(memoryDir, 'shards')
  const entry = (title) => ({
    id: 'a.js#0', type: 'symbol', sourcePath: 'a.js', sourceLine: 1, title, text: 'function a() {}', keywords: ['a'],
  })

  const store = new ProjectMemoryStore(memoryDir).load()
  store.commit((s) => {
    s.markFile('a.js', { sha256: 'h1', size: 1, type: 'code', indexedAt: new Date().toISOString() })
    s.setEntries('a.js', [entry('first')])
  })
  assert.equal(existsSync(shardsDir), true, '首次写入应建出 shards/')

  // 真实场景：全新克隆的仓库里没有 shards/，或用户手删过
  rmSync(shardsDir, { recursive: true, force: true })
  assert.equal(existsSync(shardsDir), false, '前置条件：shards/ 已不存在')

  store.commit((s) => {
    s.markFile('a.js', { sha256: 'h2', size: 2, type: 'code', indexedAt: new Date().toISOString() })
    s.setEntries('a.js', [entry('second')])
  })
  assert.equal(existsSync(shardsDir), true, 'shards/ 被删后 save 仍应重建并写入')

  const reloaded = new ProjectMemoryStore(memoryDir).load()
  assert.equal(reloaded.entries['a.js'][0].title, 'second', '重载后应读到新内容')
  assert.equal(leftoverTmps(shardsDir).length, 0)
  ok('shards/ 不存在时 store 仍能写入（父目录由 writeJsonAtomic 保证）')
}

console.log(`\natomic-write tests: ${passed} passed`)
