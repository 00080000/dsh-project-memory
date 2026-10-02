// 会话级限流测试（PLAN S3）：node test/injection-budget.test.mjs
// 验收：冷却步数真的会拦住条目；会话额度真的是上限而不是目标；注入次数随步数增长被压住。
// 观测口用审计文件（`injection-audit.jsonl`）与影子记录（`admission-shadow.jsonl`）：
// 前者记 budget 快照与沉默原因，后者记**每一步**的候选与其门槛/预算两层结局。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { installAutoInject, isOwnInjection, buildInjection, cfgEngine } from '../src/auto-inject.js'
import { GlobalStore } from '../src/insight-store.js'
import { auditFileFor, shadowFileFor } from '../src/audit.js'

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
  // 夹具是"真项目"（带 package.json）：本文件量的是条目通道的预算，
  // 不该被"记忆根是推定的"那条一次性通告计入。
  writeFileSync(path.join(root, 'package.json'), '{}')
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
    return Boolean(last && isOwnInjection(last.source))
  }
  const audit = () => {
    const file = auditFileFor(path.join(root, '.dsh-project-memory'))
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  }
  const shadow = () => {
    const file = shadowFileFor(path.join(root, '.dsh-project-memory'))
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  }
  return { step, audit, shadow }
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

// --- 6. 静默步的影子记录必须留下候选（只算不注入） ---
// 改进前 `skipItems` 直接把候选池置空，实测 1420 个静默步一个候选都没落盘 ——
// 于是"如果不限流这步会注入什么"用日志答不出来，而那正是限流期间最该答的问题。
{
  // 无 trigger → 走统计提示通道；静默步的候选只可能来自这条通道。
  const hint = (id, intent) => ({ id, kind: 'lesson', scope: 'global', title: `${intent}要改的经验`, fix: `${intent}要改的做法`, confidence: 1, archived: false })
  const h = harness([hint('h1', '阈值'), hint('h2', '预算')], { enabled: true, maxTokens: 400, gateCooldownSteps: 0, maxItemsPerSession: 1 })
  assert.equal(await h.step('阈值要改'), true)
  assert.equal(await h.step('预算要改'), false, '额度用尽 → 条目通道沉默')
  const silenced = h.shadow().filter((l) => l.silence === 'session-items')
  assert.ok(silenced.length >= 1, `应有 session-items 静默步，实得 ${silenced.length}`)
  const last = silenced[silenced.length - 1]
  assert.ok(last.candidates.length > 0, `静默步也必须记录候选，实得 ${last.candidates.length}`)
  assert.ok(last.candidates.every((c) => c.outcome === 'idle'), '静默步候选的 outcome 恒为 idle')
  assert.ok(last.scoreQuery.length > 0, '影子记录必须留下实际评分查询')
  ok(`静默步影子记录：候选 ${last.candidates.length} 条、outcome=idle（此前为 0 条）`)
}

// --- 7. 预算结局可归因：过了全部门槛却被预算拿走，必须写清是谁拿的 ---
// 这一条同时覆盖两处：① `outcome` 与 `decision` 正交；② 空块早退路径不再丢 candidates
//（此处无绑定任务 → 常驻块为空；maxItems=0 → 全部候选进不了块 → 走的正是早退分支）。
{
  const globalFile = path.join(mkdtempSync(path.join(tmpdir(), 'budgetg-')), 'global.json')
  const gs = new GlobalStore(globalFile).load()
  // 无 trigger：走的是统计提示通道，才可能"过了门槛却被预算挤掉"。
  gs.doc.items.push({ id: 'h1', kind: 'lesson', scope: 'global', title: '阈值 要改 的经验', fix: '阈值 要改 的做法', confidence: 1, archived: false })
  gs.commit(() => 0)
  const cfg = cfgEngine({ autoContext: { maxTokens: 400, gateCooldownSteps: 0 } })
  const built = buildInjection({ query: '阈值 要改', task: null, store: null, globalStore: gs, projectTagsList: [], cfg, maxItems: 0 })
  assert.equal(built.text, '', '没有常驻块、条目又全被拿掉 → 本轮无内容')
  assert.ok(built.candidates.length > 0, `空块早退也必须带 candidates，实得 ${built.candidates.length}`)
  const passed = built.candidates.filter((c) => c.decision === 'cand')
  assert.ok(passed.length > 0, '夹具应产生至少一条过了全部门槛的候选')
  assert.deepEqual([...new Set(passed.map((c) => c.outcome))], ['quota'], 'maxItems=0 → 全部归因 quota')
  assert.ok(typeof built.scoreQuery === 'string' && built.scoreQuery.length > 0, '必须带出实际评分查询')
  ok('预算结局归因：decision=cand 的候选带 outcome=quota；空块早退不丢候选')
}

console.log(`\ninjection-budget tests: ${passed} passed`)
