// watch 空闲调度回归测试：node test/watch-idle.test.mjs
//
// 背景：轮询是插件里唯一"用户没在等、却仍在花机器"的地方，而旧实现只按"有没有改动"退避
// （30s 起、无变化翻倍、封顶 2 分钟）——**有人在跑回合时照样按节拍扫**，扫描时机正好撞上
// 用户打字 / 模型跑工具的那一刻。本版把"有没有人在用"变成调度信号：
//   会话进行中 → 节拍压到最低（默认 5 分钟，且 ≥ base×10）作为外部改动的兜底；
//   回合结束   → **立刻合并扫一次**，然后回到常规节拍（有改动回 base，没改动继续退避）。
//
// 本用例不打真实定时器：替换掉 poll() 计数，直接断言调度决策（确定性、毫秒级）。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WatchManager, applyWatchSettings } from '../src/watch.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

/** 造一个不会真的扫描的 WatchManager：poll() 只计数并回报固定结果。 */
function make(changed = false) {
  const wm = new WatchManager({}, { memoryDir: '.dsh-project-memory' })
  let polls = 0
  wm.poll = async () => { polls++; return changed }
  return { wm, polls: () => polls }
}

/** 让进行中的 _tick() 走完（它在 await poll 之后才更新间隔）。 */
const settle = () => new Promise((resolve) => setImmediate(resolve))

// ---- 1. 间隔口径：base / 退避封顶 / 活跃兜底 ----
{
  const { wm } = make()
  wm.start(30000)
  assert.equal(wm._baseInterval, 30000, 'base = watchInterval')
  assert.equal(wm._maxInterval, 120000, '空闲退避封顶 2 分钟（不变）')
  assert.equal(wm._activeInterval, 300000, '活跃兜底 = max(base×10, 5 分钟)')
  assert.equal(wm._interval, 30000, '起步用 base')
  assert.ok(wm.timer, 'start() 必须排上定时器')
  wm.stop()
  ok('间隔口径：base / 退避封顶 / 活跃兜底（5 分钟）')
}

// ---- 2. 会话进行中：不扫描，只留兜底节拍 ----
{
  const { wm, polls } = make()
  wm.start(30000)
  wm.setSessionActive('s1', true)
  assert.equal(wm._active, true, '有会话在跑 → 活跃')
  assert.equal(wm._interval, 300000, '活跃期间节拍压到兜底值')
  assert.equal(polls(), 0, '进入活跃不该顺手扫描')
  assert.ok(wm.timer, '活跃 ≠ 停摆：兜底定时器仍然排着（外部编辑器改动仍会自愈）')
  wm.stop()
  ok('会话进行中：节拍降到兜底值，不抢 I/O')
}

// ---- 3. 多会话：任一在跑就算活跃 ----
{
  const { wm, polls } = make()
  wm.start(30000)
  wm.setSessionActive('s1', true)
  wm.setSessionActive('s2', true)
  wm.setSessionActive('s1', false)
  assert.equal(wm._active, true, 's2 还在跑 → 仍然活跃')
  assert.equal(polls(), 0, '不能因为一个会话结束就开扫')
  wm.setSessionActive('s2', false)
  assert.equal(wm._active, false, '最后一个会话结束才回到空闲')
  assert.equal(polls(), 1, '回合结束立刻合并扫一次')
  wm.stop()
  ok('多会话：任一在跑即活跃，全部结束才补扫一次')
}

// ---- 4. 回合结束的节拍恢复：有改动回 base，没改动继续退避 ----
{
  const dirty = make(true)
  dirty.wm.start(30000)
  dirty.wm.setSessionActive('s1', true)
  dirty.wm.setSessionActive('s1', false)
  await settle()
  assert.equal(dirty.wm._interval, 30000, '补扫到改动 → 立刻回到 base')
  dirty.wm.stop()

  const clean = make(false)
  clean.wm.start(30000)
  clean.wm.setSessionActive('s1', true)
  clean.wm.setSessionActive('s1', false)
  await settle()
  assert.equal(clean.wm._interval, 120000, '补扫无改动 → 继续退避（不空转）')
  clean.wm.stop()
  ok('回合结束：有改动回 base，没改动继续退避')
}

// ---- 5. 边界：没 start()（watch: false）与 stop() 之后，活跃信号不得抛错/复活定时器 ----
{
  const off = make()
  off.wm.setSessionActive('s1', true)
  assert.equal(off.wm.timer, null, 'watch 关着时只记状态，不排定时器')
  assert.equal(off.wm._active, true)

  const stopped = make()
  stopped.wm.start(30000)
  stopped.wm.stop()
  stopped.wm.setSessionActive('s1', true)
  assert.equal(stopped.wm.timer, null, 'stop() 之后不得被活跃信号复活')
  ok('边界：watch: false / stop() 之后，活跃信号不抛错也不复活定时器')
}

// ---- 6. 异步 poll 期间切活跃 / stop：定时器不重复，stop 后不再扫描 ----
{
  const origSetTimeout = globalThis.setTimeout
  const origClearTimeout = globalThis.clearTimeout
  const pending = new Set()
  globalThis.setTimeout = (fn, ms, ...args) => {
    const h = origSetTimeout(fn, ms, ...args)
    pending.add(h)
    return h
  }
  globalThis.clearTimeout = (h) => {
    pending.delete(h)
    return origClearTimeout(h)
  }
  try {
    const wm = new WatchManager({}, { memoryDir: '.dsh-project-memory' })
    let polls = 0
    wm.poll = async () => {
      polls++
      await new Promise((resolve) => origSetTimeout(resolve, 20))
      return false
    }
    wm.start(1000)
    assert.equal(pending.size, 1, 'start() 后只有一个定时器')

    // 取走第一个定时器并手动跑一轮，模拟它“已经触发”。
    const first = wm.timer
    pending.delete(first)
    origClearTimeout(first)
    wm.timer = null
    const tick = wm._tick()
    await new Promise((resolve) => origSetTimeout(resolve, 5))
    wm.setSessionActive('s1', true) // poll 还在 await，期间切到活跃
    await tick

    assert.equal(pending.size, 1, 'poll 期间切活跃不得再排第二个定时器（旧实现会留下两个）')
    wm.stop()
    assert.equal(pending.size, 0, 'stop() 必须清掉唯一待触发的定时器')
    await new Promise((resolve) => origSetTimeout(resolve, 30))
    assert.equal(polls, 1, 'stop() 后不得再跑一轮扫描')
  } finally {
    globalThis.setTimeout = origSetTimeout
    globalThis.clearTimeout = origClearTimeout
    for (const h of pending) origClearTimeout(h)
  }
  ok('异步 poll 期间切活跃/stop：定时器不重复，stop 后不再扫描')
}

// ---- 7. poll 进行中保存设置（stop → start）：watch 不得永久停摆 ----
//
// 回归：applyWatchSettings() 先 stop()（_stopped=true、清 timer）再 start()；旧 start() 的
// `if (timer || _polling) return` 在轮询期间直接返回，于是 _stopped 留在 true，在飞那轮
// _tick() 收尾时看到"已停止"就 return，watch 再也不排下一轮——设置页保存一次就可能静默停掉监视。
{
  const wm = new WatchManager({}, { memoryDir: '.dsh-project-memory' })
  wm.poll = async () => false
  wm.start(30000)
  wm.timer?.unref?.()

  wm._polling = true // 模拟一轮 poll 正在 await
  const watching = applyWatchSettings(wm, { watch: { get: () => true }, watchInterval: { get: () => 45 } })
  assert.equal(watching, true)
  assert.equal(wm.timer, null, '轮询中不排第二个定时器')

  wm._polling = false // 在飞那轮结束，_tick() 走收尾
  await wm._tick()
  assert.equal(wm._stopped, false, 'start() 必须复位 _stopped（否则 watch 永久停摆）')
  assert.ok(wm.timer, '在飞 poll 结束后必须续上定时器')
  assert.equal(wm._baseInterval, 45000, '新间隔生效')
  wm.stop()
  ok('poll 进行中保存设置：watch 不停摆，新间隔生效')
}

// ---- 8. poll 进行中回合结束：不要把它当成"本轮无变化"而翻倍退避 ----
{
  const wm = new WatchManager({}, { memoryDir: '.dsh-project-memory' })
  let polls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  wm.poll = async () => {
    polls++
    wm._polling = true
    await gate
    wm._polling = false
    return true // 这一轮真的有改动
  }
  wm.start(30000)
  wm.setSessionActive('s1', true) // 活跃：节拍压到兜底
  wm.timer?.unref?.()

  const first = wm.timer
  clearTimeout(first)
  wm.timer = null
  const tick = wm._tick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(polls, 1, '先有一轮 poll 在跑')

  wm.setSessionActive('s1', false) // 回合结束，但 poll 还在跑
  release()
  await tick
  assert.equal(polls, 1, '不得在在飞 poll 上再叠一轮（那会被当成无变化）')
  assert.equal(wm._interval, 30000, '有改动 → 回到 base，而不是翻倍退避')
  wm.stop()
  ok('poll 进行中回合结束：不叠轮、不误入退避')
}

// ---- 真实 pollRoot：删掉的文件要从 mtime 快照里清掉（否则同名同尺寸回来时会被当成未变）----
{
  const root = mkdtempSync(path.join(tmpdir(), 'watch-snapshot-'))
  try {
    writeFileSync(path.join(root, 'keep.md'), 'k\n')
    writeFileSync(path.join(root, 'gone.md'), 'g\n')
    const wm = new WatchManager({}, { memoryDir: '.dsh-project-memory' })
    wm.addRoot(root)
    const state = wm.roots.get(root)
    await wm.pollRoot(root, state)
    assert.deepEqual(Object.keys(state.snapshot).sort(), ['gone.md', 'keep.md'], '首轮两篇都要进快照')

    rmSync(path.join(root, 'gone.md'))
    await wm.pollRoot(root, state)
    assert.deepEqual(Object.keys(state.snapshot), ['keep.md'], '已删除的文件必须从快照里清掉')
    assert.deepEqual(Object.keys(wm.storeFor(root).files), ['keep.md'], 'store 里也应只剩它')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  ok('真实 pollRoot：删掉的文件从快照里清掉')
}

console.log(`\nwatch-idle tests: ${passed} passed`)
