// 注入审计测试（PLAN S0）：node test/injection-audit.test.mjs
// 覆盖：记录形状 / JSONL 追加 / 超限轮转 / 显式关闭 / 目录不可写时静默失败。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { appendInjectionAudit, auditFileFor, auditRecordFrom, cfgAudit } from '../src/audit.js'
import { installAutoInject } from '../src/auto-inject.js'
import { GlobalStore } from '../src/insight-store.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const dir = () => mkdtempSync(path.join(tmpdir(), 'audit-'))

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
  assert.ok(last && last.source && last.source.plugin === 'dsh-project-memory', '应追加一条 [Memory Inject] 消息')

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

console.log(`\ninjection-audit tests: ${passed} passed`)
