// 注入审计测试（PLAN S0）：node test/injection-audit.test.mjs
// 覆盖：记录形状 / JSONL 追加 / 超限轮转 / 显式关闭 / 目录不可写时静默失败。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { appendInjectionAudit, appendShadowAudit, auditFileFor, auditRecordFrom, cfgAudit, cfgShadow, shadowFileFor, shadowRecordFrom } from '../src/audit.js'
import { installAutoInject, isOwnInjection } from '../src/auto-inject.js'
import { GlobalStore } from '../src/insight-store.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

// 夹具根都写成"真项目"（带 package.json）：本文件断言的是审计形状与静默步，
// 不该被"记忆根是推定的"那条一次性通告干扰（它有自己的用例）。
const dir = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'audit-'))
  writeFileSync(path.join(d, 'package.json'), '{}')
  return d
}

// --- 1. 记录形状：能直接回答「注入了什么」和「为什么没注入别的」 ---
{
  const rec = auditRecordFrom({
    sessionId: 's1',
    root: '/repo',
    step: 7,
    text: 'x'.repeat(120),
    labels: ['trigger', 'hint'],
    reasons: [{ id: 'a', channel: 'trigger', why: 'keyword:pptx', hash: 'h', chars: 80 }],
    dropped: [{ id: 'b', channel: 'hint', reason: 'budget' }],
  })
  assert.equal(rec.session, 's1')
  assert.equal(rec.step, 7)
  assert.equal(rec.chars, 120)
  assert.deepEqual(rec.injected, [{ id: 'a', channel: 'trigger', why: 'keyword:pptx', chars: 80 }])
  assert.deepEqual(rec.dropped, [{ id: 'b', channel: 'hint', reason: 'budget' }])
  assert.ok(!Number.isNaN(Date.parse(rec.at)), 'at 必须是可解析的 ISO 时间')
  ok('记录形状：injected / dropped / chars / at 齐备')
}

// --- 2. 追加写：两次注入 → 两行可解析 JSON ---
{
  const d = dir()
  const cfg = cfgAudit({ autoContext: {} })
  assert.equal(cfg.enabled, true, '默认开（观测是这个插件唯一的仪表盘）')
  appendInjectionAudit(d, auditRecordFrom({ sessionId: 's', step: 1, text: 'aa', reasons: [], dropped: [] }), cfg)
  appendInjectionAudit(d, auditRecordFrom({ sessionId: 's', step: 2, text: 'bb', reasons: [], dropped: [] }), cfg)
  const lines = readFileSync(auditFileFor(d), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).step, 1)
  assert.equal(JSON.parse(lines[1]).chars, 2)
  ok('JSONL 追加：每次注入一行，字段可解析')
}

// --- 3. 超限轮转：只留一份 .1，不引入清理线程 ---
{
  const d = dir()
  const cfg = cfgAudit({ autoContext: { auditMaxBytes: 120 } })
  for (let i = 0; i < 6; i++) {
    appendInjectionAudit(d, auditRecordFrom({ sessionId: 's', step: i, text: 'z'.repeat(40), reasons: [], dropped: [] }), cfg)
  }
  assert.ok(existsSync(`${auditFileFor(d)}.1`), '超限必须轮转出 .1')
  ok('超限轮转：injection-audit.jsonl.1 存在')
}

// --- 4. 显式关闭：一行都不写 ---
{
  const d = dir()
  const cfg = cfgAudit({ autoContext: { auditLog: false } })
  assert.equal(cfg.enabled, false)
  assert.equal(appendInjectionAudit(d, auditRecordFrom({ text: 'x' }), cfg), false)
  assert.ok(!existsSync(auditFileFor(d)), '关闭后不应创建文件')
  ok('auditLog:false → 零写入')
}

// --- 5. 旁路契约：目标路径不可写（这里用「文件占位当目录」）也不许抛 ---
{
  const d = dir()
  const blocked = path.join(d, 'blocked')
  writeFileSync(blocked, 'not a dir')
  const cfg = cfgAudit({ autoContext: {} })
  assert.equal(appendInjectionAudit(path.join(blocked, 'sub'), auditRecordFrom({ text: 'x' }), cfg), false)
  ok('不可写时静默返回 false，绝不抛错影响宿主请求')
}

// --- 6. 端到端接线：真的注入一次 → 审计文件里就有这一条（宿主 pre-step 桩）---
{
  const root = dir()
  const globalFile = path.join(dir(), 'global.json')
  const gs = new GlobalStore(globalFile).load()
  gs.doc.items.push({
    id: 'ins_audit_e2e', kind: 'lesson', scope: 'global',
    title: '端到端审计条目', fix: 'x'.repeat(10), trigger: { keywords: ['重构'] }, confidence: 1, archived: false,
  })
  gs.commit(() => 0)

  let handler
  const ctx = { on: (event, fn) => { if (event === 'agent/pre-step') handler = fn } }
  installAutoInject(ctx, { memoryDir: '.dsh-project-memory', autoContext: { enabled: true }, insight: { globalFile } })

  const payload = {
    agent: { session: { id: 'sessAudit', header: { cwd: root } } },
    messages: [{ role: 'user', content: [{ type: 'text', text: '继续重构注入逻辑' }] }],
  }
  const decision = await handler(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  const last = decision.messages[decision.messages.length - 1]
  assert.ok(last && isOwnInjection(last.source), '应追加一条 [Memory Inject] 消息')

  const file = auditFileFor(path.join(root, '.dsh-project-memory'))
  assert.ok(existsSync(file), `注入之后必须留下审计文件：${file}`)
  const rec = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1))
  assert.equal(rec.session, 'sessAudit')
  assert.equal(rec.root, root)
  assert.ok(rec.injected.some((i) => i.id === 'ins_audit_e2e'), `审计应记录注入的条目：${JSON.stringify(rec.injected)}`)
  assert.ok(/^(op|write|intent|relative):/.test(rec.injected[0].why), `审计应记录命中原因：${rec.injected[0].why}`)
  assert.ok(rec.chars > 0, '审计应记录本次注入字符数')
  ok('端到端：pre-step 注入 → injection-audit.jsonl 落一行（含 why / chars）')
}

// --- 7. 影子记录：形状（query 截断 / 候选特征）+ 可显式关闭 ---
{
  const rec = shadowRecordFrom({
    sessionId: 's2',
    root: '/repo',
    step: 3,
    query: 'q'.repeat(400),
    ops: ['git-commit'],
    writes: ['a.ts'],
    reasons: [{ id: 'a', channel: 'trigger', why: 'op:git-commit' }],
    candidates: [{ id: 'b', channel: 'hint', rel: 1, coverage: 0.32, matched: 2, support: 4, terms: 19, decision: 'coverage' }],
    silence: 'cooldown',
  })
  assert.equal(rec.query.length, 300, 'query 截断到 300 字')
  assert.equal(rec.candidates[0].decision, 'coverage')
  assert.deepEqual(rec.ops, ['git-commit'])
  assert.equal(rec.silence, 'cooldown')
  const d = dir()
  assert.equal(appendShadowAudit(d, rec, { enabled: false }), false)
  assert.ok(!existsSync(shadowFileFor(d)), 'shadowLog:false → 零写入')
  assert.equal(appendShadowAudit(d, rec, cfgShadow({})), true)
  assert.ok(existsSync(shadowFileFor(d)), '默认开启 → 一行 JSONL')
  ok('影子记录：每步一行（候选特征 + query + ops/writes），可显式关闭')
}

// --- 8. 端到端：**零注入的静默步**也留下影子行（主审计此时零写入）---
// 这是影子记录存在的唯一理由：主审计只在真的注入时写，静默步（含"本该零注入"的对照步）
// 零痕迹，于是"换个阈值会怎样"永远无法离线回答。
{
  const root = dir()
  const globalFile = path.join(dir(), 'global.json')
  const gs = new GlobalStore(globalFile).load()
  gs.doc.items.push({
    id: 'ins_shadow', kind: 'lesson', scope: 'global',
    title: '影子条目', fix: 'y'.repeat(10), trigger: { keywords: ['重构'] }, confidence: 1, archived: false,
  })
  // 第二个条目没有 authored trigger：它只能走提示通道。trigger 通道命中不走 scoreHints，
  // 只用它一条会让 candidates 恒为空——那样就测不到影子记录真正要记的那批。
  gs.doc.items.push({
    id: 'ins_shadow_hint', kind: 'lesson', scope: 'global',
    title: '重构注入逻辑时先看影子记录', fix: '先看影子记录再改阈值', confidence: 1, archived: false,
  })
  gs.commit(() => 0)

  let handler
  const ctx = { on: (event, fn) => { if (event === 'agent/pre-step') handler = fn } }
  installAutoInject(ctx, { memoryDir: '.dsh-project-memory', autoContext: { enabled: true }, insight: { globalFile } })
  const step = async (sid, text) => {
    const payload = {
      agent: { session: { id: sid, header: { cwd: root } } },
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    }
    return handler(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  }
  const lines = (f) => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)

  await step('sessShadow', '继续重构注入逻辑') // 这一步会注入（trigger 一条 + 提示通道一条）
  const file = shadowFileFor(path.join(root, '.dsh-project-memory'))
  const first = JSON.parse(lines(file).at(-1))
  assert.ok(first.candidates.length > 0, '注入步必须带全部候选的特征')
  assert.ok(first.candidates.every((c) => c.decision && typeof c.coverage === 'number'), '每个候选都要有判据结果')
  assert.ok(first.candidates.some((c) => c.decision === 'cand'), '过了全部门槛的候选标为 cand')
  const before = lines(file).length
  const auditFile = auditFileFor(path.join(root, '.dsh-project-memory'))
  assert.ok(existsSync(auditFile), '注入的那一步必须写主审计（作为对照）')
  const auditBefore = lines(auditFile).length

  // 无关消息：零注入（宿主拿回原决策，只是没追加任何消息），但影子记录必须仍然落一行
  const silent = await step('sessSilent', '数据库迁移怎么做')
  assert.equal(silent.kind, 'enter')
  assert.equal(silent.messages.length, 1, '无关消息不得追加注入消息')
  assert.ok(!silent.messages.some((m) => isOwnInjection(m.source)), '不得有 plugin 注入消息')
  const after = lines(file)
  assert.equal(after.length, before + 1, '静默步也必须留下影子行')
  const lastRec = JSON.parse(after.at(-1))
  assert.equal(lastRec.session, 'sessSilent')
  assert.equal(lastRec.injected.length, 0, '静默步 injected 为空')
  assert.equal(lines(auditFile).length, auditBefore, '静默步主审计不新增行（影子记录的差别就在这里）')
  ok('影子记录：零注入的静默步也落一行（主审计零新增）')
}

console.log(`\ninjection-audit tests: ${passed} passed`)
