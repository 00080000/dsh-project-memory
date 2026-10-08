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
import { WatchManager } from '../src/watch.js'

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

console.log(`\nwatch-idle tests: ${passed} passed`)
