// 会话级限流测试（PLAN S3）：node test/injection-budget.test.mjs
// 验收：冷却步数真的会拦住条目；会话额度真的是上限而不是目标；注入次数随步数增长被压住。
// 观测口用审计文件（`injection-audit.jsonl`），它同时记录 budget 快照与本轮为什么沉默。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { installAutoInject } from '../src/auto-inject.js'
import { GlobalStore } from '../src/insight-store.js'
import { auditFileFor } from '../src/audit.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const lesson = (id, intent) => ({
  id,
  kind: 'lesson',
  scope: 'global',
  title: `${intent} 相关的经验`,
  fix: `${intent} 的做法`,
  trigger: { when: { intents: [intent] } },
  confidence: 1,
  archived: false,
})

/** 每一步用一句人类消息驱动；返回本条 pre-step 是否追加了注入块。 */
function harness(items, autoContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'budget-'))
  const globalFile = path.join(mkdtempSync(path.join(tmpdir(), 'budgetg-')), 'global.json')
  const gs = new GlobalStore(globalFile).load()
  gs.doc.items.push(...items)
  gs.commit(() => 0)

  let handler
  const ctx = { on: (event, fn) => { if (event === 'agent/pre-step') handler = fn } }
  installAutoInject(ctx, { memoryDir: '.dsh-project-memory', autoContext, insight: { globalFile } })

  const step = async (human, sessionId = 'sessBudget') => {
    const payload = {
      agent: { session: { id: sessionId, header: { cwd: root } } },
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: human }] }],
    }
    const decision = await handler(payload, async () => ({ kind: 'enter', messages: payload.messages }))
    const last = decision.messages[decision.messages.length - 1]
    return Boolean(last && last.source && last.source.plugin === 'dsh-project-memory')
  }
  const audit = () => {
    const file = auditFileFor(path.join(root, '.dsh-project-memory'))
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  }
  return { step, audit }
}

// --- 1. 冷却步数：条目通道每一步只允许出声一次 ---
{
  const h = harness([lesson('a', '阈值'), lesson('b', '预算')], { enabled: true, maxTokens: 400, gateCooldownSteps: 2 })
  assert.equal(await h.step('阈值要改'), true, '第 1 步应注入')
  assert.equal(await h.step('预算要改'), false, '第 2 步在冷却窗口内，条目通道必须沉默')
  assert.equal(await h.step('预算要改'), true, '第 3 步冷却结束，新条目应注入')
  const recs = h.audit()
  assert.equal(recs.length, 2, `只该有两次注入：${recs.length}`)
  assert.deepEqual(recs.map((r) => r.injected[0].id), ['a', 'b'])
  assert.equal(recs[0].budget.items, 1)
  assert.equal(recs[1].budget.items, 2)
  ok('冷却步数：第 2 步沉默、第 3 步放行；审计记录 budget 快照')
}

// --- 2. 会话条数上限是上限，不是目标 ---
{
  const h = harness([lesson('a', '阈值'), lesson('b', '预算')], { enabled: true, maxTokens: 400, gateCooldownSteps: 0, maxItemsPerSession: 1 })
  assert.equal(await h.step('阈值要改'), true)
  assert.equal(await h.step('预算要改'), false, '会话条数额度用尽后必须沉默')
  assert.equal(await h.step('预算要改'), false, '额度用尽不是暂时的：后续步骤同样沉默')
  assert.equal(h.audit().length, 1)
  ok('会话条数上限：额度用尽后持续沉默（不做静默补发）')
}

// --- 3. 会话字符上限同样生效 ---
{
  const big = lesson('big', '阈值')
  big.fix = 'x'.repeat(400)
  const h = harness([big, lesson('b', '预算')], { enabled: true, maxTokens: 400, gateCooldownSteps: 0, maxItemCharsPerSession: 100 })
  assert.equal(await h.step('阈值要改'), true, '第一条仍应进（额度只约束后续）')
  assert.equal(await h.step('预算要改'), false, '字符额度用尽后沉默')
  ok('会话字符上限：超限后沉默')
}

// --- 4. 频率曲线：6 步 6 个新条目，冷却 2 → 最多 3 次注入 ---
{
  const intents = ['阈值', '预算', '去重', '召回', '日志', '噪音']
  const h = harness(intents.map((w, i) => lesson(`i${i}`, w)), { enabled: true, maxTokens: 400, gateCooldownSteps: 2 })
  let injected = 0
  for (const w of intents) if (await h.step(`${w} 要改`)) injected++
  assert.equal(injected, 3, `6 步冷却 2 应恰好 3 次注入，实得 ${injected}`)
  const chars = h.audit().reduce((n, r) => n + r.chars, 0)
  assert.ok(chars < 600, `总字符应被限流压住，实得 ${chars}`)
  ok(`频率曲线：6 步 / 6 个新条目 → 3 次注入 / ${chars} 字符（无冷却时是 6 次）`)
}

// --- 5. 冷却只约束条目，不约束常驻任务卡 ---
{
  const h = harness([lesson('a', '阈值')], { enabled: true, maxTokens: 400, gateCooldownSteps: 5 })
  assert.equal(await h.step('阈值要改'), true)
  // 同一会话里任务卡变化不属于条目通道；这里用"没有新条目"来验证第 2 步确实零注入，
  // 任务卡由 host-contract 的用例单独覆盖（它要求任务卡变了就更新）。
  assert.equal(await h.step('阈值要改'), false)
  ok('冷却窗口内即便还有候选，也保持沉默')
}

console.log(`\ninjection-budget tests: ${passed} passed`)
