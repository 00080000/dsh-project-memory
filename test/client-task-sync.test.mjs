// 跨标签页任务广播的项目作用域：node test/client-task-scope.test.mjs
//
// 回归：同步频道名固定，消息体曾只带 tasks/archivedCount —— 两个项目各开一个标签页时，
// A 刷新一下就把 B 的面板贴成 A 的任务（B 还保留自己的 boundTaskId，看起来像绑定丢了）。
import assert from 'node:assert/strict'
import { broadcastAppliesTo, payloadRoot } from '../src/client/task-scope.js'
import { readFileSync } from 'node:fs'

let passed = 0
function ok(name) { passed++; console.log('  ok', name) }

// 1) 同项目才接受；跨项目 / 无根 / 本页未知根一律丢弃
assert.equal(broadcastAppliesTo('/repo/a', '/repo/a'), true)
assert.equal(broadcastAppliesTo('/repo/a', '/repo/b'), false)
assert.equal(broadcastAppliesTo('/repo/a', null), false, '老宿主载荷无根：不猜')
assert.equal(broadcastAppliesTo('/repo/a', ''), false)
assert.equal(broadcastAppliesTo(null, '/repo/a'), false, '本页还没同步过：不先借别人的数据')
assert.equal(broadcastAppliesTo(null, null), false)
assert.equal(broadcastAppliesTo(undefined, undefined), false)
assert.equal(broadcastAppliesTo(123, '/repo/a'), false, '非字符串根不当判据')
ok('广播作用域：同项目接受，跨项目 / 无根 / 本页未知根一律丢弃')

// 2) 载荷取根：只有非空字符串才算
assert.equal(payloadRoot('/repo/a'), '/repo/a')
assert.equal(payloadRoot(''), null)
assert.equal(payloadRoot(null), null)
assert.equal(payloadRoot(undefined), null)
assert.equal(payloadRoot(0), null)
ok('载荷取根：非空字符串才算，其余归一为 null')

// 3) 静态守卫：频道消息必须经过作用域判定，不能直接 setDataState
{
  const src = readFileSync(new URL('../src/client/task-data-store.ts', import.meta.url), 'utf8')
  const onmessage = src.slice(src.indexOf('SYNC_CHANNEL.onmessage'))
  assert.ok(onmessage.includes('broadcastAppliesTo'), 'onmessage 必须做作用域判定')
  const before = onmessage.indexOf('setDataState')
  const gate = onmessage.indexOf('broadcastAppliesTo')
  assert.ok(gate > -1 && gate < before, '判定必须在写入之前（先拦后写）')
  assert.ok(src.includes('root: nextRoot'), '广播必须带上本页的根')
  assert.ok(src.includes('sessionId: nextSession'), '广播必须带会话：绑定只在同一会话内同步')
  assert.ok(src.includes('sentAt'), '广播必须带时序，乱序快照不能覆盖新状态')
  assert.ok(src.includes('boundTaskId'), '广播必须带绑定，否则另一标签页永远看不到切换')
  ok('静态守卫：onmessage 先判定后写入，且广播载荷带根')
}

// 4) 面板刷新只取数据，不写会话历史（旧实现会补一次 /tasks switch → session.append）
{
  const src = readFileSync(new URL('../src/client/TaskPanel.tsx', import.meta.url), 'utf8')
  const start = src.indexOf('const refresh = async')
  const body = start === -1 ? '' : src.slice(start, src.indexOf('const handleAction', start))
  assert.ok(body.length > 0, 'refresh 必须存在')
  assert.ok(!body.includes('/tasks switch'), 'refresh 不得自动 switch（那会往会话历史里 append todo/write）')
  ok('面板刷新不写会话历史：refresh 只发 /tasks')
}

// 5) 记忆页也要取 /tasks（boundTaskId/root）；列表型命令节点不再渲染
{
  const panel = readFileSync(new URL('../src/client/TaskPanel.tsx', import.meta.url), 'utf8')
  assert.ok(!panel.includes("ui.view !== 'task'"), '记忆页也要补 /tasks，否则降级按钮永远禁用')
  assert.ok(panel.includes('if (ui.closed || !sessionId) return'), '打开面板即补一次数据')
  assert.ok(panel.includes('}, [ui.closed, ui.view, sessionId])'), '切页要能刷新')
  const node = readFileSync(new URL('../src/client/TaskCommandNode.tsx', import.meta.url), 'utf8')
  assert.match(node, /isTasks && verb === 'insight'/, '必须识别合并后的 /tasks insight …')
  assert.match(node, /sub === 'list'/, '必须识别 /tasks insight list')
  assert.match(node, /if \(isList && \(isInsight \? parsedInsights : parsedTasks\)\) return null/, '列表命令成功时不再渲染节点')
  ok('只有切回任务页才补数据；列表型命令节点不渲染')
}

console.log(`\nclient-task-sync tests: ${passed} passed`)
