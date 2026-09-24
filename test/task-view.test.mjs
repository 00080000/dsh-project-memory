// 任务步骤读取/展示的共用纯函数回归测试：node test/task-view.test.mjs
//
// 背景：这套读法（取文本 / 归一状态 / 数完成度 / 相对时间 / 取 exec 会话 id）原先在
// commands/、tools/、setup/、auto-inject、reflection 里各抄了一份，且漂移成
// `content ?? text` 与 `content || text` 两种语义。本用例把收敛后的**唯一语义**钉住，
// 其中两条是刻意的行为决定（不是笔误）：
//   1. content 为空串时不再回退 text —— 显式清空的步骤不该顶出旧文本；
//   2. 非法状态归一到 pending —— 宿主 todo 只认三个值，脏数据不该穿透到注入/投影。
import assert from 'node:assert/strict'
import { STEP_STATUSES, sessionIdOf, stepContent, stepProgress, stepStatus, timeAgo } from '../src/util/task-view.js'
import { adoptStepsToSession } from '../src/setup/taskbridge.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

// ---- stepContent：三种历史形状 ----
assert.equal(stepContent('裸字符串步骤'), '裸字符串步骤')
assert.equal(stepContent({ content: '新形状' }), '新形状')
assert.equal(stepContent({ text: 'text 时代' }), 'text 时代')
assert.equal(stepContent({ content: 'content 优先', text: '旧 text' }), 'content 优先')
assert.equal(stepContent({ content: '', text: '不该被顶出来' }), '', 'content 为空串时不回退 text')
assert.equal(stepContent({ content: 'c', text: 't' }), 'c')
assert.equal(stepContent(null), '')
assert.equal(stepContent(undefined), '')
assert.equal(stepContent({}), '')
ok('stepContent：字符串 / content / text / 空内容不回退 / 缺失值')

// ---- stepStatus：唯一合法值集合 ----
assert.deepEqual([...STEP_STATUSES].sort(), ['completed', 'in_progress', 'pending'])
assert.equal(stepStatus({ status: 'in_progress' }), 'in_progress')
assert.equal(stepStatus({ status: 'completed' }), 'completed')
assert.equal(stepStatus({ status: 'done' }), 'pending', '非法状态归一为 pending')
assert.equal(stepStatus({ status: 1 }), 'pending')
assert.equal(stepStatus({}), 'pending')
assert.equal(stepStatus('裸字符串步骤'), 'pending')
assert.equal(stepStatus(null), 'pending')
ok('stepStatus：合法值透传 / 非法与缺失归一 pending / 裸字符串 pending')

// ---- stepProgress：混合形状也要数得对 ----
const mixed = { steps: ['字符串步骤', { content: 'a', status: 'completed' }, { text: 'b', status: 'completed' }, { content: 'c', status: 'done' }] }
assert.deepEqual(stepProgress(mixed), { done: 2, total: 4 })
assert.deepEqual(stepProgress({ steps: [] }), { done: 0, total: 0 })
assert.deepEqual(stepProgress({}), { done: 0, total: 0 })
assert.deepEqual(stepProgress(null), { done: 0, total: 0 })
ok('stepProgress：混合形状计数 / 空与缺失任务')

// ---- timeAgo：四档阈值 ----
const ago = (ms) => new Date(Date.now() - ms).toISOString()
assert.equal(timeAgo(ago(30 * 1000)), '刚刚')
assert.equal(timeAgo(ago(5 * 60 * 1000)), '5分钟前')
assert.equal(timeAgo(ago(3 * 60 * 60 * 1000)), '3小时前')
assert.equal(timeAgo(ago(2 * 24 * 60 * 60 * 1000)), '2天前')
ok('timeAgo：刚刚 / 分钟 / 小时 / 天')

// ---- sessionIdOf：agent.session 优先，退化到 ctx.session ----
assert.equal(sessionIdOf({ agent: { session: { id: 's-agent' } }, ctx: { session: { id: 's-ctx' } } }), 's-agent')
assert.equal(sessionIdOf({ ctx: { session: { id: 's-ctx' } } }), 's-ctx')
assert.equal(sessionIdOf({}), undefined)
assert.equal(sessionIdOf(undefined), undefined)
ok('sessionIdOf：优先 agent.session，退化 ctx.session')

// ---- 接管宿主清单时同样只用这一套语义（原先这里是第三份状态白名单）----
{
  const appended = []
  const session = { append: (event, payload) => appended.push({ event, payload }) }
  assert.equal(adoptStepsToSession(session, { steps: ['老字符串', { text: '旧 text', status: 'in_progress' }, { content: 'c', status: '乱值' }] }), true)
  assert.equal(appended.length, 1)
  assert.equal(appended[0].event, 'todo/write')
  assert.deepEqual(appended[0].payload.todos, [
    { content: '老字符串', status: 'pending' },
    { content: '旧 text', status: 'in_progress' },
    { content: 'c', status: 'pending' },
  ])
  assert.equal(adoptStepsToSession(session, { steps: [] }), false)
  assert.equal(adoptStepsToSession(session, {}), false)
  ok('adoptStepsToSession：用同一套 stepContent/stepStatus 归一，空步骤不推')
}

console.log(`\ntask-view tests: ${passed} passed`)
