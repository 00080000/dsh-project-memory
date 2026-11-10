// D3-2 可见性索引单元测试：node test/inject-visible.test.mjs
// 覆盖：surface 扫描 / 增量事件 / 压缩后重建 / 旧消息正文回退 / 无 surface 降级 / provenance 紧凑格式。
import assert from 'node:assert/strict'
import { createVisibleState, ensureVisible, isAvailable, isBlockVisible, isItemVisible, onSessionEvent, provenanceOf, recordInjected } from '../src/inject-visible.js'

let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }

function fakeSession() {
  const events = new Map()
  let seq = 0
  const session = {
    id: 's',
    surface: { nodes: [], replaceGeneration: 0 },
    eventAt: (s) => events.get(s),
  }
  const append = (data, type = 'user/message') => {
    seq++
    events.set(seq, { seq, type, data })
    session.surface.nodes.push(seq)
    return seq
  }
  const inject = (block, items) => append({
    role: 'user',
    content: [{ type: 'text', text: '- [ins_a] lesson: A' }],
    source: { kind: 'plugin:dsh-project-memory', form: 'notice', summary: 'x', memory: { v: 1, b: block, i: items } },
  })
  return { session, append, inject, events }
}

// 1. 扫描 + 可见判断
{
  const { session, inject } = fakeSession()
  inject('blk1', [['ins_a', 'h1']])
  const state = createVisibleState()
  assert.equal(isAvailable(session), true)
  assert.equal(ensureVisible(session, state), true)
  assert.equal(isItemVisible(state, 'ins_a', 'h1'), true)
  assert.equal(isItemVisible(state, 'ins_a', 'h2'), false, '正文变了不算可见')
  assert.equal(isBlockVisible(state, 'blk1'), true)
  assert.equal(isBlockVisible(state, 'nope'), false)
  ok('扫描可见 surface：条目按 id+hash、块按指纹判断')
}

// 2. 事件驱动增量 + 压缩重建
{
  const { session, inject } = fakeSession()
  const state = createVisibleState()
  ensureVisible(session, state)
  inject('blk2', [['ins_b', 'h2']])
  onSessionEvent(state, { type: 'user/message', seq: 1, data: null })
  assert.equal(isItemVisible(state, 'ins_b', 'h2'), false, '事件没有 data 时不应误记')
  const msg = session.eventAt(1).data
  onSessionEvent(state, { type: 'user/message', seq: 1, data: msg })
  assert.equal(isItemVisible(state, 'ins_b', 'h2'), true)
  onSessionEvent(state, { type: 'compaction/end', seq: 2 })
  assert.equal(state.dirty, true)
  session.surface.nodes = []
  session.surface.replaceGeneration = 1
  ensureVisible(session, state)
  assert.equal(isItemVisible(state, 'ins_b', 'h2'), false, '压缩后旧条目不再可见')
  ok('事件增量 + compaction 失效重建')
}

// 3. 旧消息没有 metadata：从正文解析 id，按“可见但 hash 未知”处理
{
  const { session, append } = fakeSession()
  append({ role: 'user', content: [{ type: 'text', text: '- [ins_old] lesson: old' }], source: { kind: 'plugin:dsh-project-memory' } })
  const state = createVisibleState()
  ensureVisible(session, state)
  assert.equal(isItemVisible(state, 'ins_old', 'whatever'), true)
  ok('旧注入消息从正文解析 id（hash 未知仍算可见）')
}

// 4. 无 surface / 注入即登记
{
  const state = createVisibleState()
  assert.equal(isAvailable({ id: 's' }), false)
  assert.equal(ensureVisible({ id: 's' }, state), false)
  recordInjected(state, { source: { kind: 'plugin:dsh-project-memory', memory: { v: 1, b: 'b', i: [['ins_c', 'h3']] } } })
  assert.equal(isItemVisible(state, 'ins_c', 'h3'), true)
  ok('无 surface 时降级；注入当下可立即登记')
}

// 5. provenance 紧凑格式：只有 id+hash，上限 40
{
  const p = provenanceOf('blk', [{ id: 'a', hash: '1' }, { id: 'b', hash: '2' }, { id: 'c' }])
  assert.deepEqual(p, { v: 1, b: 'blk', i: [['a', '1'], ['b', '2']] })
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, hash: `h${i}` }))
  assert.equal(provenanceOf('b', many).i.length, 40)
  ok('provenance：id+hash 数组、无正文、上限 40')
}

// 6. 畸形 provenance 上限 + eventAt 抛错降级
{
  const state = createVisibleState()
  const many = Array.from({ length: 100 }, (_, i) => [`i${i}`, 'h'])
  recordInjected(state, { source: { kind: 'plugin:dsh-project-memory', memory: { v: 1, b: 'b', i: many } } })
  assert.equal(state.items.size, 40, '单条消息的 provenance 最多收 40 条')

  const bad = { id: 'bad', surface: { nodes: [1], replaceGeneration: 0 }, eventAt() { throw new Error('boom') } }
  const s2 = createVisibleState()
  assert.equal(ensureVisible(bad, s2), false)
  assert.equal(s2.degraded, true, '宿主读取抛错后该会话降级回缓存')
  ok('畸形 provenance 截断；eventAt 抛错时降级')
}

console.log(`\ninject-visible tests: ${passed} passed`)
