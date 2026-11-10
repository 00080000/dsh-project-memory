// D3-2 注入对账集成测试：node test/inject-reconcile.test.mjs
// 覆盖：未压缩不重复 / 压缩后重发一次 / 重启不重复 / 老宿主回退缓存。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GlobalStore } from '../src/insight-store.js'
import { installAutoInject } from '../src/auto-inject.js'

let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }

const HUMAN = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我发包到官方源' }] }

const ITEM = {
  id: 'proc_1', kind: 'procedure', scope: 'global', title: '发包流程',
  steps: ['先跑测试', '再发包'],
  trigger: { keywords: ['发包', 'npm publish'] },
  confidence: 1, archived: false,
}

function fixture({ surface = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'inject-reconcile-'))
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}')
  const globalFile = path.join(root, 'global.json')
  const gs = new GlobalStore(globalFile).load()
  gs.doc.items.push({ ...ITEM })
  gs.commit()

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
    autoContext: { enabled: true, maxTokens: 400, auditLog: false, shadowLog: false },
    insight: { globalFile },
  })
  const run = async (messages = []) => handlers['agent/pre-step'][0](
    { agent: { session }, messages },
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
  f.append(first.messages[0])
  const handlers = {}
  const ctx = { on: (e, fn) => { (handlers[e] ||= []).push(fn) }, effect: (fn) => { fn() } }
  installAutoInject(ctx, {
    memoryDir: '.dsh-project-memory',
    autoContext: { enabled: true, maxTokens: 400, auditLog: false, shadowLog: false },
    insight: { globalFile: path.join(f.root, 'global.json') },
  })
  const restarted = await handlers['agent/pre-step'][0](
    { agent: { session: f.session }, messages: [HUMAN] },
    () => ({ kind: 'enter', messages: [] }),
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

console.log(`\ninject-reconcile tests: ${passed} passed`)
