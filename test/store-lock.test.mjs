// 跨进程数据安全回归：node test/store-lock.test.mjs
//
// 三条都来自 2026-10-25 的审计（/tmp 复现脚本 → 这里变成可判定失败的回归）：
//   1. 锁可被"抢"，且 release 无所有权校验 → 三个进程同时"持锁"；
//   2. 崩溃残留锁 + 3 次重试(≈8.3s) < staleMs(10s) → save 静默跳过，工具却报成功；
//   3. 另一进程真删的条目，被本进程下一次 save 当"本地新增"写回（forget 的"真删"承诺失效）。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { acquireDirLock, inspectDirLock } from '../src/util/fs.js'
import { ProjectMemoryStore } from '../src/store.js'
import { GlobalStore } from '../src/insight-store.js'
import { _pendingDirtyCountForTest, flushDirtyStores } from '../src/util/flush.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const dir = () => mkdtempSync(path.join(tmpdir(), 'lock-'))
const lockFile = (d) => path.join(d, '.write.lock')
const writeLock = (d, meta, ageMs = 0) => {
  mkdirSync(d, { recursive: true })
  writeFileSync(lockFile(d), JSON.stringify(meta))
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs)
    utimesSync(lockFile(d), t, t)
  }
}
const readLock = (d) => JSON.parse(readFileSync(lockFile(d), 'utf8'))
const storeUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'store.js')).href
const insightUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'insight-store.js')).href

/** 起一个立刻退出的子进程，拿到一个**确定已死**的 pid（用于"崩溃残留锁"）。 */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
  const pid = child.pid
  await new Promise((resolve) => child.on('exit', resolve))
  return pid
}

// --- 1. 所有权：活着的持有者不该被抢；release 不能删别人的锁 ---
{
  const d = dir()
  const release = acquireDirLock(d, { timeoutMs: 100 })
  assert.ok(release, '空目录应能拿到锁')
  const mine = inspectDirLock(d)
  assert.ok(mine.token && mine.pid === process.pid && mine.host === hostname(), '锁内容要有 pid/host/token')
  assert.equal(mine.stale, false)

  // 模拟"另一个活着的进程"重写了锁（比如它在我们持锁期间接手）：同机 + pid 活着 + mtime 很老
  writeLock(d, { pid: process.pid, host: hostname(), token: 'foreign', at: new Date().toISOString() }, 3_600_000)
  const again = acquireDirLock(d, { timeoutMs: 80 })
  assert.equal(again, null, '同机 pid 活着时，mtime 再老也不能抢')
  assert.equal(readLock(d).token, 'foreign', '抢锁失败不得删掉对方的锁')

  release() // 我们是旧持有者，token 已不匹配
  assert.ok(existsSync(lockFile(d)), 'release 必须校验 token：不得 unlink 别人的锁')
  assert.equal(readLock(d).token, 'foreign')
  ok('锁所有权：活着的持有者不被抢，release 不删别人的锁')
}

// --- 2. 崩溃残留锁：同机 pid 已死 → 立即回收（旧实现要等 10s，重试预算永远不够）---
{
  const d = dir()
  const dead = await deadPid()
  writeLock(d, { pid: dead, host: hostname(), token: 'dead', at: new Date().toISOString() })
  const started = Date.now()
  const release = acquireDirLock(d, { timeoutMs: 800 })
  const elapsed = Date.now() - started
  assert.ok(release, '已死进程的锁必须能立即回收')
  assert.ok(elapsed < 400, `回收应当是立即的，实际 ${elapsed}ms`)
  assert.notEqual(readLock(d).token, 'dead', '抢到后锁内容应换成我们自己的')
  release()
  ok(`崩溃残留锁立即回收（${elapsed}ms）`)
}

// --- 3. 崩溃锁不再让 save 静默跳过：一次写必须真的落盘 ---
{
  const d = dir()
  const dead = await deadPid()
  writeLock(d, { pid: dead, host: hostname(), token: 'dead' })
  const store = new ProjectMemoryStore(d).load()
  store.replaceInsightItems([{ id: 'kept', kind: 'lesson', scope: 'project', title: 'kept' }])
  const saved = store.save()
  assert.equal(saved, true, '死锁存在时 save 必须成功（旧实现返回 undefined 且没写盘）')
  assert.equal(store.lastSaveOk, true)
  const doc = JSON.parse(readFileSync(path.join(d, 'insights.json'), 'utf8'))
  assert.deepEqual(doc.items.map((it) => it.id), ['kept'])
  ok('崩溃残留锁下 save 真的落盘')
}

// --- 4. 活锁 → save 返回失败、数据不落盘（工具层据此如实回报）---
{
  const d = dir()
  const store = new ProjectMemoryStore(d).load()
  store.replaceInsightItems([{ id: 'pending', kind: 'lesson', scope: 'project', title: 'pending' }])
  writeLock(d, { pid: process.pid, host: hostname(), token: 'held-by-other' })
  const saved = store.save({ timeoutMs: 100 })
  assert.equal(saved, false, '活锁未释放时 save 必须返回 false')
  assert.equal(store.lastSaveOk, false, '内部标志必须能看见失败（但默认不打扰用户）')
  assert.ok(!existsSync(path.join(d, 'insights.json')), '没拿到锁就不能写盘')
  assert.ok(existsSync(lockFile(d)), '失败时不得删掉别人的锁')

  // 锁释放后同一份脏数据仍能写进去（失败不该把脏状态清掉）
  // 用死 pid 模拟持有者退出（同机判活会立刻回收）
  const dead = await deadPid()
  writeLock(d, { pid: dead, host: hostname(), token: 'held-by-other' })
  assert.equal(store.save({ timeoutMs: 500 }), true, '锁消失后重试必须成功')
  const doc = JSON.parse(readFileSync(path.join(d, 'insights.json'), 'utf8'))
  assert.deepEqual(doc.items.map((it) => it.id), ['pending'])
  ok('活锁时 save 失败且不落盘；锁消失后重试成功')
}

// --- 4b. 正确性靠同步等待，不靠后台重试：另一个进程持锁 250ms，save 必须等到并写成功 ---
// 注意：不能用 setTimeout 在这里释放锁——save() 是同步阻塞的（Atomics.wait），同进程的定时器
// 根本跑不到。必须由**另一个进程**在等待期间释放。
{
  const d = dir()
  const store = new ProjectMemoryStore(d).load()
  store.replaceInsightItems([{ id: 'waited', kind: 'lesson', scope: 'project', title: 'waited' }])
  const fsUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'util', 'fs.js')).href
  const childScript = `
import { acquireDirLock } from ${JSON.stringify(fsUrl)}
const release = acquireDirLock(process.argv[1])
await new Promise((resolve) => setTimeout(resolve, 250))
release()
`
  const holder = spawn(process.execPath, ['--input-type=module', '-e', childScript, d], { stdio: 'inherit' })
  // 等子进程真的持上锁（同步忙等，不能用 await——父进程随后要阻塞在 save 里）
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + 3000
  while (!existsSync(lockFile(d)) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 5)
  assert.ok(existsSync(lockFile(d)), '子进程应已持锁')

  const started = Date.now()
  assert.equal(store.save({ timeoutMs: 3000 }), true, '短时持锁应在一次同步等待里完成')
  assert.ok(Date.now() - started >= 100, '必须真的等过锁，而不是立刻放弃')
  await new Promise((resolve) => holder.on('exit', resolve))
  assert.ok(existsSync(path.join(d, 'insights.json')))
  ok('同步等待另一个进程释放锁后写入成功（不依赖 20s 重试）')
}

// --- 5. 跨进程删除不被复活：insights ---
{
  const d = dir()
  const first = new ProjectMemoryStore(d).load()
  first.replaceInsightItems([
    { id: 'keep', kind: 'lesson', scope: 'project', title: 'keep', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'gone', kind: 'lesson', scope: 'project', title: 'gone', updatedAt: '2026-01-01T00:00:00.000Z' },
  ])
  assert.equal(first.save(), true)

  const child = `
import { ProjectMemoryStore } from ${JSON.stringify(storeUrl)}
const store = new ProjectMemoryStore(process.argv[1]).load()
store.replaceInsightItems(store.insightItems().filter((it) => it.id !== 'gone'))
store.save()
`
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', child, d], { stdio: 'inherit' })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))))
  })
  assert.deepEqual(JSON.parse(readFileSync(path.join(d, 'insights.json'), 'utf8')).items.map((it) => it.id), ['keep'], '子进程真的删掉了')

  // 父进程还拿着删前的内存快照，下一次 save 不得把 gone 写回
  first.replaceInsightItems(first.insightItems()) // 只标脏，不改内容
  assert.equal(first.save(), true)
  assert.deepEqual(JSON.parse(readFileSync(path.join(d, 'insights.json'), 'utf8')).items.map((it) => it.id), ['keep'], '已删条目不得复活')
  assert.deepEqual(first.insightItems().map((it) => it.id), ['keep'], '内存里也要丢掉对方已删的条目')
  ok('跨进程删除不复活（insights）')
}

// --- 6. 跨进程删除不被复活：tasks ---
{
  const d = dir()
  const first = new ProjectMemoryStore(d).load()
  first.addTask({ id: 't_keep', title: 'keep', files: [], steps: [] })
  first.addTask({ id: 't_gone', title: 'gone', files: [], steps: [] })
  assert.equal(first.save(), true)

  const child = `
import { ProjectMemoryStore } from ${JSON.stringify(storeUrl)}
const store = new ProjectMemoryStore(process.argv[1]).load()
store.removeTask('t_gone')
store.save()
`
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', child, d], { stdio: 'inherit' })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))))
  })
  first.markTasksDirty()
  assert.equal(first.save(), true)
  assert.deepEqual(JSON.parse(readFileSync(path.join(d, 'tasks.json'), 'utf8')).map((t) => t.id), ['t_keep'], '已删任务不得复活')
  assert.deepEqual(first.getTasks().map((t) => t.id), ['t_keep'])
  ok('跨进程删除不复活（tasks）')
}

// --- 7. 跨进程删除不被复活：global store ---
{
  const file = path.join(dir(), 'global.json')
  const a = new GlobalStore(file).load()
  a.doc.items.push({ id: 'g_keep', kind: 'lesson', scope: 'global', title: 'keep', updatedAt: '2026-01-01T00:00:00.000Z' })
  a.doc.items.push({ id: 'g_gone', kind: 'lesson', scope: 'global', title: 'gone', updatedAt: '2026-01-01T00:00:00.000Z' })
  a.markDirty()
  a.commit()

  const child = `
import { GlobalStore } from ${JSON.stringify(insightUrl)}
const store = new GlobalStore(process.argv[1]).load()
store.doc.items = store.doc.items.filter((it) => it.id !== 'g_gone')
store.markDirty()
store.commit()
`
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', child, file], { stdio: 'inherit' })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))))
  })
  a.markDirty()
  a.commit()
  const items = JSON.parse(readFileSync(file, 'utf8')).items.map((it) => it.id)
  assert.deepEqual(items, ['g_keep'], 'global 层同样不得复活已删条目')
  ok('跨进程删除不复活（global）')
}

// --- 8. global 锁失败也要可见（旧实现只 console.error，调用方一无所知）---
{
  const d = dir()
  const file = path.join(d, 'global.json')
  const store = new GlobalStore(file).load()
  writeLock(d, { pid: process.pid, host: hostname(), token: 'held' })
  store.doc.items.push({ id: 'g1', kind: 'lesson', scope: 'global', title: 'x' })
  store.markDirty()
  store.commit(undefined, { timeoutMs: 100 })
  assert.equal(store.lastCommitOk, false, 'global commit 失败必须留下内部状态（默认不打印）')
  assert.ok(!existsSync(file), '没拿到锁就不该写 global 文件')
  // 释放锁后同步补写：退出 flush 走的就是这条
  unlinkSync(lockFile(d))
  assert.equal(store.commit(undefined, { timeoutMs: 500 }), undefined)
  assert.equal(store.lastCommitOk, true)
  ok('global 写锁失败留下内部状态（默认静默），释放后可补写')
}

// --- 9. 退出兜底：脏 store 会被 flushDirtyStores 同步写掉 ---
{
  const d = dir()
  const store = new ProjectMemoryStore(d).load()
  store.replaceInsightItems([{ id: 'on-exit', kind: 'lesson', scope: 'project', title: 'on-exit' }])
  writeLock(d, { pid: process.pid, host: hostname(), token: 'held' })
  assert.equal(store.save({ timeoutMs: 50 }), false)
  assert.ok(_pendingDirtyCountForTest() >= 1, '失败的写必须登记为待 flush')
  unlinkSync(lockFile(d))
  const saved = flushDirtyStores({ timeoutMs: 1000 })
  assert.ok(saved >= 1, '退出 flush 必须真的写掉脏 store')
  assert.ok(existsSync(path.join(d, 'insights.json')))
  assert.deepEqual(JSON.parse(readFileSync(path.join(d, 'insights.json'), 'utf8')).items.map((it) => it.id), ['on-exit'])
  assert.equal(_pendingDirtyCountForTest(), 0, '落盘成功后不再挂起')
  ok('退出/卸载 flush：脏 store 同步补写')
}

// --- 10. store 目录被外部删掉：下一次 save 自愈目录 / 分片 / format / .gitignore ---
{
  const d = dir()
  const store = new ProjectMemoryStore(d).load()
  store.replaceInsightItems([{ id: 'recovered', kind: 'lesson', scope: 'project', title: 'recovered' }])
  assert.equal(store.save({ timeoutMs: 500 }), true)
  assert.ok(existsSync(path.join(d, '.gitignore')), '首次 save 应写自我忽略')
  assert.ok(existsSync(path.join(d, 'format.json')), '首次 save 应写格式标记')

  // 模拟用户清理 / git clean -fdx：整个 store 目录消失，进程还活着。
  rmSync(d, { recursive: true, force: true })
  assert.equal(existsSync(d), false, '前置条件：目录已不存在')

  store.replaceInsightItems(store.insightItems()) // 标脏，不清空内存
  assert.equal(store.save({ timeoutMs: 500 }), true, '目录被外部删掉后 save 必须自愈，而不是永久失败')
  assert.ok(existsSync(path.join(d, 'insights.json')), '目录重建后脏数据要真的落盘')
  assert.ok(existsSync(path.join(d, '.gitignore')), '重建后必须重新自我忽略，否则 store 可能被误提交')
  assert.ok(existsSync(path.join(d, 'format.json')), '重建后必须补回格式标记（嵌套根判定要用它）')
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(d, 'insights.json'), 'utf8')).items.map((it) => it.id),
    ['recovered'],
  )
  ok('外部删除 store 目录后：目录 / 数据 / format / .gitignore 全部自愈')
}

// --- 11. 跨进程任务条目：两边新增都保留，本地删除不复活 ---
{
  const d = dir()
  const seed = new ProjectMemoryStore(d).load()
  seed.addTask({
    id: 't_merge',
    title: 'merge test',
    files: [],
    steps: [],
    insights: [{ id: 'ins_x', title: 'X', updatedAt: '2026-01-01T00:00:00.000Z' }],
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
  })
  assert.equal(seed.save(), true)

  const ready = path.join(d, 'child-ready')
  const go = path.join(d, 'child-go')
  const childScript = `
import { existsSync, writeFileSync } from 'node:fs'
import { ProjectMemoryStore } from ${JSON.stringify(storeUrl)}
const [dir, ready, go] = process.argv.slice(1)
const store = new ProjectMemoryStore(dir).load()
const task = store.getTask('t_merge')
task.insights = (task.insights || []).filter((it) => it.id !== 'ins_x')
task.insights.push({ id: 'ins_b', title: 'B', updatedAt: '2026-01-02T00:00:00.000Z' })
store.markTasksDirty()
writeFileSync(ready, '')
const sleeper = new Int32Array(new SharedArrayBuffer(4))
while (!existsSync(go)) Atomics.wait(sleeper, 0, 0, 5)
if (!store.save()) process.exitCode = 1
`
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, d, ready, go], { stdio: 'inherit' })
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + 3000
  while (!existsSync(ready) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 5)
  assert.ok(existsSync(ready), '子进程应先完成加载（拿到旧快照）再等信号')

  // 父进程仍持有旧快照（含 ins_x），在子进程等待期间新增 ins_a 并落盘。
  const parentTask = seed.getTask('t_merge')
  parentTask.insights.push({ id: 'ins_a', title: 'A', updatedAt: '2026-01-03T00:00:00.000Z' })
  seed.markTasksDirty()
  assert.equal(seed.save(), true)
  writeFileSync(go, '')

  const code = await new Promise((resolve) => child.on('exit', resolve))
  assert.equal(code, 0, '子进程保存应成功')
  const diskTask = JSON.parse(readFileSync(path.join(d, 'tasks.json'), 'utf8')).find((t) => t.id === 't_merge')
  assert.deepEqual(
    diskTask.insights.map((it) => it.id).sort(),
    ['ins_a', 'ins_b'],
    '两边新增都应保留；子进程本地删除的 ins_x 不得被父进程的旧副本复活',
  )
  ok('跨进程任务条目合并：新增不丢、删除不复活')
}

console.log(`\nstore-lock tests: ${passed} passed`)
