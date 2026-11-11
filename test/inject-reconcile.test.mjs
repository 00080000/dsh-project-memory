// D3-2 注入对账集成测试：node test/inject-reconcile.test.mjs
// 覆盖：未压缩不重复 / 压缩后重发一次 / 重启不重复 / 老宿主回退缓存。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GlobalStore } from '../src/insight-store.js'
import { installAutoInject } from '../src/auto-inject.js'
import { ProjectMemoryStore } from '../src/store.js'
import { memoryRootFor } from '../src/util/fs.js'

let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }

const HUMAN = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我发包到官方源' }] }

const ITEM = {
  id: 'proc_1', kind: 'procedure', scope: 'global', title: '发包流程',
  steps: ['先跑测试', '再发包'],
  trigger: { keywords: ['发包', 'npm publish'] },
  confidence: 1, archived: false,
}

function fixture({ surface = true, autoContext = {}, item = ITEM, items = null, withTask = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'inject-reconcile-'))
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}')
  const globalFile = path.join(root, 'global.json')
  const gs = new GlobalStore(globalFile).load()
  gs.doc.items.push(...(items || [item]).map((it) => ({ ...it })))
  gs.commit()
  if (withTask) {
    const st = new ProjectMemoryStore(memoryRootFor(root, '.dsh-project-memory')).load()
    const now = new Date().toISOString()
    st.addTask({
      id: 'tsk_1', projectHash: 'x', projectRoot: root, title: '发包任务',
      steps: [{ content: '先跑测试', status: 'pending' }],
      files: [], fileMeta: {}, archived: false, insights: [],
      createdAt: now, updatedAt: now, lastActiveAt: now,
    })
    st.setBinding('s1', 'tsk_1')
    st.save()
  }

  const events = new Map()
  let seq = 0
  const session = { id: 's1', header: { cwd: root } }
  if (surface) {
    session.surface = { nodes: [], replaceGeneration: 0 }
    session.eventAt = (s) => events.get(s)
  }
  const append = (message, type = 'user/message') => {
    seq++
    events.set(seq, { seq, type, data: message })
    if (surface) session.surface.nodes.push(seq)
  }
  const compact = (summary) => {
    seq++
    events.set(seq, { seq, type: 'user/message', data: summary })
    session.surface.nodes = [seq]
    session.surface.replaceGeneration++
  }

  const handlers = {}
  const ctx = {
    on: (event, fn) => { (handlers[event] ||= []).push(fn) },
    effect: (fn) => { fn(); return () => {} },
  }
  installAutoInject(ctx, {
    memoryDir: '.dsh-project-memory',
    autoContext: { enabled: true, maxTokens: 400, auditLog: false, shadowLog: false, ...autoContext },
    insight: { globalFile },
  })
  const run = async (messages = [], signal = undefined) => handlers['agent/pre-step'][0](
    { agent: { session }, messages, ...(signal ? { signal } : {}) },
    () => ({ kind: 'enter', messages }),
  )
  const injected = (out) => out.messages.filter((m) => String(m?.source?.kind || '').startsWith('plugin:dsh-project-memory')).length
  return { root, session, append, compact, run, injected }
}

// 1. 注入 → 写回 surface → 下一步不重复
{
  const f = fixture()
  const first = await f.run([HUMAN])
  assert.equal(f.injected(first), 1, '第一次应注入')
  const msg = first.messages.find((m) => String(m?.source?.kind || '').startsWith('plugin:dsh-project-memory'))
  assert.equal(msg.source.memory?.v, 1, '注入消息带 provenance')
  assert.ok(Array.isArray(msg.source.memory.i) && msg.source.memory.i.length >= 1)
  f.append(msg)
  const second = await f.run([HUMAN])
  assert.equal(f.injected(second), 0, '未压缩时不得重复注入')
  ok('未压缩：注入一次后不重复')
}

// 2. 压缩把注入消息替换掉 → 重发一次，再下一步不重复
{
  const f = fixture()
  const first = await f.run([HUMAN])
  f.append(first.messages.find((m) => String(m?.source?.kind || '').startsWith('plugin:dsh-project-memory')))
  f.compact({ role: 'user', content: [{ type: 'text', text: 'summary' }], source: { kind: 'compaction' } })
  const after = await f.run([HUMAN])
  assert.equal(f.injected(after), 1, '压缩后应重新注入一次')
  f.append(after.messages.find((m) => String(m?.source?.kind || '').startsWith('plugin:dsh-project-memory')))
  const again = await f.run([HUMAN])
  assert.equal(f.injected(again), 0, '重发后不得连续重复')
  ok('压缩：注入消息不可见后重发一次')
}

// 3. 重启（新进程缓存为空）但历史仍可见 → 不重复
{
  const f = fixture()
  const first = await f.run([HUMAN])
  f.append(first.messages.find((m) => String(m?.source?.kind || '').startsWith('plugin:dsh-project-memory')))
  const handlers = {}
  const ctx = { on: (e, fn) => { (handlers[e] ||= []).push(fn) }, effect: (fn) => { fn() } }
  installAutoInject(ctx, {
    memoryDir: '.dsh-project-memory',
    autoContext: { enabled: true, maxTokens: 400, auditLog: false, shadowLog: false },
    insight: { globalFile: path.join(f.root, 'global.json') },
  })
  const restarted = await handlers['agent/pre-step'][0](
    { agent: { session: f.session }, messages: [HUMAN] },
    () => ({ kind: 'enter', messages: [HUMAN] }),
  )
  assert.equal(restarted.messages.filter((m) => String(m?.source?.kind || '').startsWith('plugin:dsh-project-memory')).length, 0, '重启后应靠历史去重')
  ok('重启：历史仍可见时不重复')
}

// 4. 老宿主（无 surface）→ 退回进程缓存，行为不变
{
  const f = fixture({ surface: false })
  const first = await f.run([HUMAN])
  assert.equal(f.injected(first), 1)
  const second = await f.run([HUMAN])
  assert.equal(f.injected(second), 0, '老宿主仍靠缓存去重')
  ok('老宿主：无 surface 时退回缓存')
}

// 5. 会话条目额度打满后压缩：额度必须归零，否则压缩后永久失明
{
  const f = fixture({ autoContext: { maxItemsPerSession: 1 } })
  const first = await f.run([HUMAN])
  assert.equal(first.messages.some((m) => m?.source?.memory?.i?.length > 0), true)
  f.append(first.messages.find((m) => String(m?.source?.kind || '').startsWith('plugin:dsh-project-memory')))
  f.compact({ role: 'user', content: [{ type: 'text', text: 'summary' }], source: { kind: 'compaction' } })
  const after = await f.run([HUMAN])
  assert.equal(f.injected(after), 1, '压缩后条目额度归零，应重新注入')
  ok('压缩：会话条目额度随历史重建归零')
}

// 6. 旧消息（无 provenance）按整行文本对账：正文改了要重发，没改不重发
{
  const f = fixture({ item: { ...ITEM, id: 'ins_legacy1', kind: 'lesson', steps: undefined, fix: '先跑测试' } })
  const first = await f.run([HUMAN])
  const msg = first.messages.find((m) => String(m?.source?.kind || '').startsWith('plugin:dsh-project-memory'))
  assert.ok(msg, '第一次应注入')
  const legacy = { ...msg, source: { ...msg.source } }
  delete legacy.source.memory // 模拟 D3-2 之前写入的历史消息
  f.append(legacy)
  const same = await f.run([HUMAN])
  assert.equal(f.injected(same), 0, '正文没变时不重复')
  const gs = new GlobalStore(path.join(f.root, 'global.json')).load()
  gs.items()[0].fix = '先跑完整测试再发包'
  gs.markDirty()
  gs.commit()
  const edited = await f.run([HUMAN])
  assert.equal(f.injected(edited), 1, '正文改了必须重发（旧 hash=null 会永久压制）')
  ok('旧消息按整行文本对账：编辑后重发')
}

// 7. 任务卡不会在“条目全被跳过”的下一步/重启后重发
{
  const f = fixture({ withTask: true })
  const first = await f.run([HUMAN])
  assert.equal(f.injected(first), 1, '第一次应有卡 + 条目')
  const firstInjected = first.messages.find((m) => String(m?.source?.kind || '').startsWith('plugin:dsh-project-memory'))
  assert.match(firstInjected.content[0].text, /发包任务/, '含任务卡')
  f.append(first.messages.find((m) => String(m?.source?.kind || '').startsWith('plugin:dsh-project-memory')))
  const second = await f.run([HUMAN])
  assert.equal(f.injected(second), 0, '条目因可见被跳过时，卡也不该再发一遍')

  // 重启：新进程缓存为空，靠 surface 里的 e 指纹去重。
  const handlers = {}
  const ctx = { on: (e, fn) => { (handlers[e] ||= []).push(fn) }, effect: (fn) => { fn() } }
  installAutoInject(ctx, {
    memoryDir: '.dsh-project-memory',
    autoContext: { enabled: true, maxTokens: 400, auditLog: false, shadowLog: false },
    insight: { globalFile: path.join(f.root, 'global.json') },
  })
  const restarted = await handlers['agent/pre-step'][0](
    { agent: { session: f.session }, messages: [HUMAN] },
    () => ({ kind: 'enter', messages: [HUMAN] }),
  )
  assert.equal(restarted.messages.filter((m) => String(m?.source?.kind || '').startsWith('plugin:dsh-project-memory')).length, 0, '重启后卡也不该重复')
  ok('任务卡：条目跳过后不重复，重启靠 e 指纹去重')
}

// 8. 已 abort 的 pre-step 不注入、不记账
{
  const f = fixture({ autoContext: { maxItemsPerSession: 1 } })
  const signal = { aborted: true }
  const aborted = await f.run([HUMAN], signal)
  assert.equal(aborted.messages.filter((m) => String(m?.source?.kind || '').startsWith('plugin:dsh-project-memory')).length, 0, 'abort 后不得注入')
  const next = await f.run([HUMAN])
  assert.equal(f.injected(next), 1, 'abort 不消耗额度，下一步仍能正常注入')
  ok('abort：不注入也不消耗会话额度')
}

// 9. 宿主丢弃注入后：额度/冷却/命中回滚，下一步仍能重发
{
  const two = [
    { ...ITEM, id: 'ins_drop_a', title: '发包流程 A' },
    { ...ITEM, id: 'ins_drop_b', title: '发包流程 B' },
  ]
  const f = fixture({ items: two, autoContext: { maxItemsPerSession: 2 } })
  // 先放一条已确认的旧注入，保证 historyLost=false，额度不会因“历史为空”被重置。
  f.append({
    role: 'user',
    content: [{ type: 'text', text: '- [ins_old] lesson: old' }],
    source: { kind: 'plugin:dsh-project-memory', memory: { v: 1, b: 'old-block', i: [['ins_old', 'h']] } },
  })
  const first = await f.run([HUMAN])
  assert.ok(first.messages.some((m) => m?.source?.memory?.i?.length === 2), '第一次注入两条，额度打满')
  // 不 append：模拟宿主在 pre-step 之后 abort，消息没进 surface。
  const second = await f.run([HUMAN])
  assert.ok(second.messages.some((m) => m?.source?.memory?.i?.length === 2), '额度必须回滚，下一步仍能重发')
  ok('宿主丢弃注入：额度/冷却/命中回滚后仍能重发')
}

console.log(`\ninject-reconcile tests: ${passed} passed`)
