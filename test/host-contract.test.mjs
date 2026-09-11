// 宿主契约 / 轮询健壮性回归测试：node test/host-contract.test.mjs
// 覆盖两类曾导致「dsh 无法回复 / 启动刷屏」的问题：
//   1. agent/pre-step 监听器在宿主契约漂移（next 缺失 / 返回 undefined）时绝不能
//      reject 或返回 undefined —— 宿主 agent.ts 直接读 decision.kind，undefined 会崩掉整步。
//   2. WatchManager 的非法轮询间隔（NaN → 1ms 轮询风暴）与轮询重入（慢轮询叠加）。
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { installAutoInject } from '../src/auto-inject.js'
import { WatchManager } from '../src/watch.js'
import { ProjectMemoryStore } from '../src/store.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

// ---- 1. agent/pre-step 契约健壮性 ----
{
  let handler
  const ctx = { on: (event, fn) => { if (event === 'agent/pre-step') handler = fn } }
  installAutoInject(ctx, { memoryDir: '.dsh-project-memory', autoContext: { enabled: true } })
  assert.equal(typeof handler, 'function')

  const payload = {
    agent: { session: { id: 's1', header: { cwd: process.cwd() } } },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }

  // 正常契约：透传宿主决策
  const normal = await handler(payload, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(normal.kind, 'enter')
  ok('pre-step 正常契约透传宿主决策')

  // next 缺失（历史事故：next is not a function）→ 必须降级为合法决策，不能 reject
  const missing = await handler(payload, undefined)
  assert.equal(missing.kind, 'enter')
  assert.ok(Array.isArray(missing.messages))
  ok('pre-step next 缺失时降级为合法 enter 决策（不 reject）')

  // next 返回 undefined（下游监听器异常）→ 不能把 undefined 交给宿主
  const undef = await handler(payload, async () => undefined)
  assert.ok(undef && undef.kind === 'enter')
  ok('pre-step next 返回 undefined 时兜底（不把 undefined 交给宿主）')

  // 下游真实错误应照常上抛，不能被本插件吞掉
  await assert.rejects(() => handler(payload, async () => { throw new Error('downstream boom') }), /downstream boom/)
  ok('pre-step 下游错误照常上抛（不吞）')
}

// ---- 2. WatchManager 轮询健壮性 ----
{
  const wm = new WatchManager({}, { memoryDir: '.dsh-project-memory' })

  // 非法间隔 → 回退到 15s，绝不退化成 1ms
  wm.start(NaN)
  assert.ok(wm.timer && wm.timer._idleTimeout >= 1000, `interval=${wm.timer?._idleTimeout}`)
  wm.stop()
  wm.start(undefined)
  assert.equal(wm.timer._idleTimeout, 15000)
  wm.stop()
  ok('start(NaN/undefined) 回退到 15s（不再 1ms 轮询风暴）')

  // 轮询重入：慢轮询期间再次 poll 应直接跳过，不叠加
  let concurrent = 0
  let maxConcurrent = 0
  let calls = 0
  let release
  const gate = new Promise((r) => { release = r })
  wm.roots.set('/fake', { store: {}, snapshot: {} })
  wm.pollRoot = async () => {
    calls++
    concurrent++
    maxConcurrent = Math.max(maxConcurrent, concurrent)
    await gate
    concurrent--
  }
  const first = wm.poll()
  const second = wm.poll()
  await second // 重入的第二次应立即返回
  assert.equal(calls, 1)
  release()
  await first
  assert.equal(maxConcurrent, 1)
  ok('慢轮询期间再次 poll 被跳过（不叠加并发索引）')
}

// ---- 3. 注入消息的 source 语义：snapshot + sections ----
{
  const root = mkdtempSync(path.join(tmpdir(), 'inject-form-'))
  const globalFile = path.join(mkdtempSync(path.join(tmpdir(), 'inject-form-g-')), 'global.json')
  const store = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
  const now = new Date().toISOString()
  store.addTask({
    id: 'tsk_f', title: '注入语义验证', projectRoot: root,
    steps: [{ content: '改 form', status: 'in_progress' }], files: [], archived: false,
    createdAt: now, updatedAt: now, lastActiveAt: now,
  })
  store.setBinding('sessForm', 'tsk_f')
  store.commit(() => 0)

  let handler
  const ctx = { on: (event, fn) => { if (event === 'agent/pre-step') handler = fn } }
  installAutoInject(ctx, {
    memoryDir: '.dsh-project-memory',
    autoContext: { enabled: true, maxTokens: 300 },
    insight: { globalFile },
  })
  const payload = {
    agent: { session: { id: 'sessForm', header: { cwd: root } } },
    messages: [{ role: 'user', content: [{ type: 'text', text: '继续改 form' }] }],
  }
  const decision = await handler(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  assert.equal(decision.kind, 'enter')
  assert.ok(decision.messages.length > payload.messages.length, '应当追加了一条注入消息')
  const injected = decision.messages[decision.messages.length - 1]
  assert.ok(injected && injected.source, '注入消息必须带 source（宿主会读 message.source.kind）')
  assert.equal(injected.source.kind, 'plugin')
  assert.equal(injected.source.plugin, 'dsh-project-memory')
  assert.equal(injected.source.form, 'snapshot', '这是会被后续快照取代的当前状态，不是 notice')
  assert.equal(injected.source.summary, undefined, 'snapshot 不得携带 notice 的 summary（宿主判别联合）')
  assert.ok(Array.isArray(injected.source.sections) && injected.source.sections.length === 1)
  assert.equal(injected.source.sections[0].name, 'project-memory')
  assert.ok(injected.source.sections[0].text.includes('注入语义验证'), 'sections.text 是模型看到的那份贡献')
  ok('注入 source 声明为 snapshot + sections（通道不变）')
}

console.log(`\nhost-contract tests: ${passed} passed`)
