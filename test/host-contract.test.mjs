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
import { GlobalStore } from '../src/insight-store.js'
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

// ---- 4. 条目级去重：同一份 procedure 不得因"整块指纹变了"被重复注入 ----
// 实测背景：一次 66 步的真实会话注入了 20 次，其中同一份 1732 字 procedure 重发 3 次、
// 另一份 1008 字的重发 6 次。原因是去重指纹只认"整块文本"，而整块会因为任务卡推进、
// 滑动工具窗口、预算截断边界变化而改变 —— 尾巴一变，老条目就跟着重发一遍。
{
  const root = mkdtempSync(path.join(tmpdir(), 'inject-dedupe-'))
  const globalFile = path.join(mkdtempSync(path.join(tmpdir(), 'inject-dedupe-g-')), 'global.json')
  const gs = new GlobalStore(globalFile).load()
  gs.doc.items.push({
    id: 'ins_big_procedure',
    kind: 'procedure',
    scope: 'global',
    title: '大 procedure（只该注入一次）',
    steps: ['第一步', '第二步', '第三步'],
    trigger: { keywords: ['重构'] },
    confidence: 1,
    archived: false,
  })
  gs.commit(() => 0)

  const store = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
  const now = new Date().toISOString()
  store.addTask({
    id: 'tsk_dedupe', title: '去重验证', projectRoot: root,
    steps: [{ content: '第一步', status: 'in_progress' }], files: [], archived: false,
    createdAt: now, updatedAt: now, lastActiveAt: now,
  })
  store.setBinding('sessDedupe', 'tsk_dedupe')
  store.commit(() => 0)

  const mount = (autoContext) => {
    let handler
    const ctx = { on: (event, fn) => { if (event === 'agent/pre-step') handler = fn } }
    installAutoInject(ctx, { memoryDir: '.dsh-project-memory', autoContext, insight: { globalFile } })
    return async (sessionId) => {
      const payload = {
        agent: { session: { id: sessionId, header: { cwd: root } } },
        messages: [{ role: 'user', content: [{ type: 'text', text: '继续重构' }] }],
      }
      const decision = await handler(payload, async () => ({ kind: 'enter', messages: payload.messages }))
      const last = decision.messages[decision.messages.length - 1]
      return last && last.source && last.source.plugin === 'dsh-project-memory'
        ? last.content.map((b) => b.text).join('\n')
        : null
    }
  }

  const step = mount({ enabled: true, maxTokens: 400 })
  const first = await step('sessDedupe')
  assert.ok(first && first.includes('大 procedure'), '首次应注入 procedure')
  assert.ok(first.includes('去重验证'), '首次应带常驻任务卡')

  // 推进任务卡 → 整块指纹必然变化；旧行为会把同一份 procedure 整块重发
  store.updateTask('tsk_dedupe', { steps: [{ content: '第一步', status: 'done' }, { content: '第二步', status: 'in_progress' }] })
  store.commit(() => 0)
  const second = await step('sessDedupe')
  assert.ok(second && second.includes('去重验证'), '任务卡变了仍要注入（常驻块是快照）')
  assert.ok(!second.includes('大 procedure'), '同一份 procedure 不得因整块指纹变化而重发')

  // 任务卡与条目都没变 → 整步零注入（历史里已经有这两块）
  assert.equal(await step('sessDedupe'), null, '内容全未变时必须零注入')
  ok('条目级去重：同一份 procedure 只注入一次（整块指纹变化不再重发）')

  // 冷却档：>0 时允许 N 步后再注入一次（留给"历史可能被外部裁剪"的场景）
  gs.doc.items.push({
    id: 'ins_cooled', kind: 'lesson', scope: 'global',
    title: '冷却条目', fix: 'x'.repeat(10), trigger: { keywords: ['重构'] }, confidence: 1, archived: false,
  })
  gs.commit(() => 0)
  // 同样绑定任务卡：冷却重发只有在"整块与上次注入的不同"时才可见（块完全一致＝历史里已有，
  // 再发一遍仍是重复；这正是最后一层指纹要拦的东西）。
  store.setBinding('sessCooldown', 'tsk_dedupe')
  store.commit(() => 0)
  const cd = mount({ enabled: true, maxTokens: 400, reinjectItemsAfter: 2 })
  const c1 = await cd('sessCooldown')
  assert.ok(c1 && c1.includes('大 procedure'), '冷却档首次照常注入')
  const c2 = await cd('sessCooldown') // 第 2 步：未到冷却，procedure 不重发
  assert.ok(c2 && c2.includes('去重验证'), '第 2 步只发任务卡')
  assert.ok(!c2.includes('大 procedure'), '冷却未到不重发 procedure')
  const c3 = await cd('sessCooldown') // 第 3 步：差 2 步，允许重发一次
  assert.ok(c3 && c3.includes('大 procedure'), 'reinjectItemsAfter=2 时第 3 步应重发一次')
  ok('reinjectItemsAfter：>0 时按步数冷却重发（0 为默认，本会话只注入一次）')
}

console.log(`\nhost-contract tests: ${passed} passed`)
