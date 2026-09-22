// 会话 id 解析的版本兼容回归测试：node test/client-session-id.test.mjs
//
// 背景：宿主 0.1.7 改了会话列表快照的结构——
//   ≤0.1.6：{ current?, items: [{ sessionId, blank, retainedBy? }] }
//   0.1.7+：{ ids: string[], byId: Record<id, SessionSummary>, phase, projectionsBySession }
// 两件事必须同时成立，否则面板都不对：
//   ① 解析出**非 null** 的会话 id（旧写法在 0.1.7 上永远返回 null → 「还没有会话」+ 记忆视图
//      报 `no session / commands service`，而任务视图因为读缓存看起来正常）；
//   ② 解析出**用户正在看的那个**会话（兜底取"列表第一个非 blank"不跟随切换对话，
//      面板会一直停在同一会话、显示错项目的任务）。
// 0.1.7 的权威判据是 `SessionSummary.retainedBy.mainView > 0`（第一方 ui-layout/DocumentTitle.tsx
// 同款），它在列表快照内，所以订阅 list 的组件会在切换时重渲染。
import assert from 'node:assert/strict'
import { pickSessionId, sessionRows } from '../src/client/session-id.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

/** 造一个 0.1.7 形状的快照；`mainView` 是哪条会话正被主视图持有。 */
const snap017 = (ids, byId, mainView) => ({
  ids,
  byId: Object.fromEntries(ids.map((id) => [id, {
    blank: byId[id]?.blank === true,
    ...(id === mainView ? { retainedBy: { mainView: 1 } } : {}),
  }])),
  phase: 'ready',
  projectionsBySession: {},
})

// ---- 1. 0.1.7 形状：必须解析出非 null（旧写法在这里返回 null） ----
{
  const snap = snap017(['s_a', 's_b'], { s_a: { blank: false }, s_b: { blank: false } })
  assert.equal(pickSessionId(snap), 's_a',
    '0.1.7 形状必须解析出会话 id（旧写法返回 null，正是面板报"还没有会话"的原因）')
  assert.deepEqual(sessionRows(snap), [
    { id: 's_a', blank: false, mainView: 0 },
    { id: 's_b', blank: false, mainView: 0 },
  ], '行顺序保持宿主给的顺序，并带上 mainView 事实')
  ok('0.1.7 形状 { ids, byId }：解析出非 null')
}

// ---- 2. 跟随切换：mainView 指向谁就用谁，与列表顺序无关 ----
{
  // 用户正在看 s_b（列表里排第二）
  const onB = snap017(['s_a', 's_b', 's_c'], { s_a: { blank: false }, s_b: { blank: false }, s_c: { blank: false } }, 's_b')
  assert.equal(pickSessionId(onB), 's_b', 'mainView 必须压过"列表第一个非 blank"')

  // 切到 s_c 后，retain 计数变化会重新发布列表快照 → 同一个函数必须给出新会话
  const onC = snap017(['s_a', 's_b', 's_c'], { s_a: { blank: false }, s_b: { blank: false }, s_c: { blank: false } }, 's_c')
  assert.equal(pickSessionId(onC), 's_c', '切换会话后必须跟随（面板不能停在上一个会话上）')
  assert.notEqual(pickSessionId(onB), pickSessionId(onC), '两次快照必须给出不同会话')
  ok('跟随会话切换：mainView > 列表顺序')
}

// ---- 3. mainView 指向 blank 会话时也要用它 ----
{
  // 新建的 blank 会话正被主视图持有：面板应该跟着它（而不是跳到别的非 blank 会话）
  const snap = snap017(['s_old', 's_new_blank'], { s_old: { blank: false }, s_new_blank: { blank: true } }, 's_new_blank')
  assert.equal(pickSessionId(snap), 's_new_blank', '主视图持有的 blank 会话优先于其它非 blank 会话')
  ok('mainView 指向 blank 会话时仍然选它')
}

// ---- 4. 0.1.7 形状的退化情况 ----
{
  assert.equal(pickSessionId(snap017(['a', 'b'], { a: { blank: true }, b: { blank: true } })), 'a',
    '没有 mainView 时退回第一个非 blank → 第一个（全 blank 则第一个）')
  assert.equal(pickSessionId(snap017(['a'], { a: { blank: true } }, 'a')), 'a', '只有一条时选它')
  assert.equal(pickSessionId({ ids: [], byId: {} }), null, '真的没有会话才返回 null')
  assert.equal(pickSessionId({ ids: ['a'] }), 'a', 'byId 缺失（半成品形状）时不崩')
  assert.equal(pickSessionId({ byId: { s_only: { blank: false, retainedBy: { mainView: 1 } } } }), 's_only',
    '只有 byId、没有 ids 时仍能按 mainView 选中')
  assert.equal(pickSessionId({ ids: ['a'], byId: { a: { retainedBy: { mainView: 0 } } } }), 'a',
    'mainView 为 0 不算持有')
  ok('0.1.7 形状的退化：无 mainView / 全 blank / 空列表 / 缺 byId / mainView=0')
}

// ---- 5. 旧形状（≤0.1.6）：语义与合并前一致 ----
{
  const withCurrent = { current: 's_cur', items: [{ sessionId: 's_x', blank: false }] }
  assert.equal(pickSessionId(withCurrent), 's_cur', '有显式 current 时以它为准（旧版语义优先）')

  const noCurrent = { items: [{ sessionId: 's_blank', blank: true }, { sessionId: 's_live', blank: false }] }
  assert.equal(pickSessionId(noCurrent), 's_live', '无 current 时挑第一个非 blank')

  const allBlank = { items: [{ sessionId: 's_a', blank: true }, { sessionId: 's_b', blank: true }] }
  assert.equal(pickSessionId(allBlank), 's_a', '全 blank 时退回第一个')

  const emptyCurrent = { current: '', items: [{ sessionId: 's_a', blank: false }] }
  assert.equal(pickSessionId(emptyCurrent), 's_a', 'current 是空串时按没有处理，不能返回空串')

  // 旧形状里也带 retainedBy 时同样按 mainView 跟随
  const oldMainView = {
    items: [
      { sessionId: 's_a', blank: false },
      { sessionId: 's_b', blank: false, retainedBy: { mainView: 1 } },
    ],
  }
  assert.equal(pickSessionId(oldMainView), 's_b', '旧形状若带 retainedBy.mainView，同样按它跟随')
  ok('旧形状 { current, items }：语义与合并前一致')
}

// ---- 6. 认不出的形状一律返回 null，绝不抛 ----
{
  const junk = [null, undefined, 0, 'x', {}, { items: 'nope' }, { ids: 'nope' }, { current: 42 }]
  for (const snap of junk) {
    assert.equal(pickSessionId(snap), null, `畸形快照不得抛错也不得瞎猜：${JSON.stringify(snap)}`)
    assert.deepEqual(sessionRows(snap), [], `sessionRows 对畸形输入返回空数组：${JSON.stringify(snap)}`)
  }
  assert.equal(pickSessionId({ items: [{}, { sessionId: 'ok' }] }), 'ok', '缺 sessionId 的行被跳过，不产生 undefined 行')
  assert.equal(pickSessionId({ ids: [null, 'ok'] }), 'ok', 'ids 里的空值被跳过')
  assert.equal(pickSessionId({ ids: ['a'], byId: { a: { retainedBy: { mainView: 'yes' } } } }), 'a',
    'mainView 不是数字时当没有处理（不崩、不误判）')
  ok('畸形/未知快照：返回 null 且不抛错')
}

// ---- 7. 两种形状同时存在时以旧形状的 current 为准（升级过渡期的混合快照） ----
{
  const both = {
    current: 's_cur',
    items: [{ sessionId: 's_items', blank: false }],
    ids: ['s_ids'],
    byId: { s_ids: { blank: false } },
  }
  assert.equal(pickSessionId(both), 's_cur', '显式 current 优先级最高')
  ok('混合快照：current > mainView > 第一个非 blank > 第一个')
}

console.log(`\nclient-session-id tests: ${passed} passed`)
