// 注入审计测试：node test/injection-audit.test.mjs
// 覆盖：记录形状 / JSONL 追加 / 超限轮转 / 显式关闭 / 目录不可写时静默失败。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { appendInjectionAudit, appendShadowAudit, auditFileFor, auditRecordFrom, cfgAudit, cfgShadow, shadowFileFor, shadowRecordFrom } from '../src/audit.js'
import { installAutoInject, isOwnInjection, buildInjection, cfgEngine } from '../src/auto-inject.js'
import { GlobalStore } from '../src/insight-store.js'
import { ProjectMemoryStore } from '../src/store.js'

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

// --- 1b. budget 掉落的量纲必须穿过审计面落盘（修前必失败） ---
// `buildInjection` 早已给 budget 掉落带出 remaining / need，两处各自有测试，但**接缝**没人测：
// 审计投影只留 {id, channel, reason}，于是"还剩 30 字符、这条最少要 120"在日志里永远看不到。
{
  const d = dir()
  const gs = new GlobalStore(path.join(d, 'global.json')).load()
  gs.doc.items.push({ id: 'h1', kind: 'lesson', scope: 'global', title: '阈值 要改 的经验', fix: '阈值 要改 的做法', confidence: 1, archived: false })
  gs.commit(() => 0)
  const built = buildInjection({ query: '阈值 要改', task: null, store: null, globalStore: gs, projectTagsList: [], cfg: cfgEngine({}), maxChars: 30 })
  const budget = built.dropped.find((x) => x.reason === 'budget')
  assert.ok(budget && budget.remaining === 30 && budget.need === 120, '夹具应产出带量纲的 budget 掉落')
  const memDir = path.join(d, '.dsh-project-memory')
  assert.equal(appendInjectionAudit(memDir, auditRecordFrom({ sessionId: 's', step: 1, text: 'x'.repeat(50), reasons: [], dropped: built.dropped }), cfgAudit({ autoContext: {} }), d), true)
  const line = JSON.parse(readFileSync(auditFileFor(memDir), 'utf8').trim().split('\n').pop())
  const rd = line.dropped.find((x) => x.reason === 'budget')
  assert.equal(rd.remaining, 30, '落盘的 budget 掉落必须带 remaining')
  assert.equal(rd.need, 120, '落盘的 budget 掉落必须带 need')
  // 无纲的掉落（coverage 等占绝大多数）不该为此多长出两个 null。
  assert.deepEqual(
    auditRecordFrom({ dropped: [{ id: 'c', channel: 'hint', reason: 'coverage:0.20' }] }).dropped[0],
    { id: 'c', channel: 'hint', reason: 'coverage:0.20' },
  )
  ok('budget 掉落的 remaining / need 穿过审计面落盘；无纲掉落不长出 null')
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
  // 查询级支持度提到行级（同步内逐条恒定，实测 139/139 步）：单候选省 ~25 B。
  assert.equal(rec.support, 4, 'support 提到行级')
  assert.equal(rec.terms, 19, 'terms 提到行级')
  assert.equal('support' in rec.candidates[0], false, '候选上不再重复携带 support')
  assert.equal('channel' in rec.candidates[0], false, '候选只可能来自提示通道，不再逐条记 channel')
  assert.equal(rec.candidatesTotal, 1)
  assert.deepEqual(rec.ops, ['git-commit'])
  assert.equal(rec.silence, 'cooldown')
  const d = dir()
  assert.equal(appendShadowAudit(d, rec, { enabled: false }), false)
  assert.ok(!existsSync(shadowFileFor(d)), 'shadowLog:false → 零写入')
  assert.equal(appendShadowAudit(d, rec, cfgShadow({})), true)
  assert.ok(existsSync(shadowFileFor(d)), '默认开启 → 一行 JSONL')
  ok('影子记录：每步一行（候选特征 + query + ops/writes），可显式关闭')
}

// --- 7b. 影子候选有上限，但**过了全部门槛的候选一个都不能丢** ---
// 影子日志 90.6% 的体积是 candidates（实测 210 行 / 965KB，候选占 875KB），而真实 store
// 单步就能产生 40~60 条（中位 42）。截断规则：全部 `decision === 'cand'` + 按排名补足到 16；
// 截断前的总数记在 `candidatesTotal`，不静默。
{
  const many = []
  for (let i = 0; i < 40; i++) {
    many.push({
      id: `c${i}`, channel: 'hint', rel: Math.max(0, 1 - i / 100), coverage: 0.1, matched: 1,
      support: 9, terms: 20, decision: i === 39 ? 'cand' : 'coverage',
    })
  }
  const rec = shadowRecordFrom({ sessionId: 's', step: 1, candidates: many })
  assert.equal(rec.candidates.length, 16, '候选截断到 16 条')
  assert.equal(rec.candidatesTotal, 40, '截断前的总数必须留下')
  assert.ok(rec.candidates.some((c) => c.id === 'c39'), '排名第 40 但过了门槛的候选必须被保住')
  const keep = shadowRecordFrom({ sessionId: 's', step: 2, candidates: many.slice(0, 16) })
  assert.equal(keep.candidates.length, 16, '未超限时不截断')
  assert.equal(keep.candidatesTotal, 16)
  ok('影子候选上限 16：过门槛的全部保住，candidatesTotal 记录截断量')
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


// --- 10. 审计不为"推定的空根"创建 store 目录（容器目录不该被审计造出一个 store）---
// 全插件里会在什么都没索引过的目录里造出 .dsh-project-memory 的就是审计那句 mkdirSync；
// 于是一次"在容器目录里开会话"就会留下一个只装审计日志的空 store，随后还会被
// resolveProjectMemoryRoot 当成项目根。
{
  const container = mkdtempSync(path.join(tmpdir(), 'audit-bare-'))
  const memDir = path.join(container, '.dsh-project-memory')
  // auto-inject 每个 pre-step 都先 `new ProjectMemoryStore(memDir).load()`。load() 必须保持
  // 零副作用，否则它建出的目录会让下面两条审计判据（"目录已存在"）全部失效——这正是
  // 0.6.1 引入的回归：修前这条断言就会失败。
  new ProjectMemoryStore(memDir).load()
  assert.ok(!existsSync(memDir), 'load() 不得为空根建目录，否则审计闸门失效')
  assert.equal(appendShadowAudit(memDir, shadowRecordFrom({ sessionId: 's', step: 1 }), cfgShadow({})), false)
  assert.equal(appendInjectionAudit(memDir, auditRecordFrom({ sessionId: 's', step: 1, text: 'x' }), cfgAudit({})), false)
  assert.ok(!existsSync(memDir), '无标记、无内容的根：审计不创建 store 目录')
  ok('容器目录：审计不创建 store 目录')

  // 声明过的项目（有标记）即便还没落过盘，也该留下第一步的记录 —— 判据与 rootNotice 一致。
  const declared = mkdtempSync(path.join(tmpdir(), 'audit-decl-'))
  writeFileSync(path.join(declared, 'package.json'), '{}')
  const dMem = path.join(declared, '.dsh-project-memory')
  assert.equal(appendShadowAudit(dMem, shadowRecordFrom({ sessionId: 's', step: 1 }), cfgShadow({}), declared), true)
  assert.ok(existsSync(shadowFileFor(dMem)), '有项目标记的根：照常建目录并落一行')
  ok('有标记的根：审计照常工作（口径与 rootNotice 一致）')

  // 无标记但已经有内容（纯 md 笔记目录被懒索引过）→ 目录已存在，照写。
  const notes = mkdtempSync(path.join(tmpdir(), 'audit-notes-'))
  const nMem = path.join(notes, '.dsh-project-memory')
  const s = new ProjectMemoryStore(nMem)
  s.setEntries('a.md', [{ id: 'a', relPath: 'a.md', title: 'a', summary: 'a' }])
  s.save()
  assert.equal(appendShadowAudit(nMem, shadowRecordFrom({ sessionId: 's', step: 1 }), cfgShadow({}), notes), true)
  ok('无标记但已有内容的根：审计照常工作')
}

// --- 11. 两份旁路日志共用同一个写入器：边缘口径写成刻意的行为决定 ---
// 影子记录与主审计的「配置归一 + JSONL 追加」此前是两份复制品（谁补了护栏另一份就可能漏）。
// 合并后这里钉住每条语义，避免以后当成笔误再改回去：
//  - 上限只认「正数 number」：0 / 负数 / NaN / 字符串一律退回**该日志自己的**默认上限，
//    不是禁用、也不是 0（0 会让 rotateIfOversized 每次 append 都轮转）；
//  - 关闭开关只认显式 `false`：未配置 = 开（观测是这个插件唯一的仪表盘）；
//  - 缺 memoryDir / record → 静默 false，绝不抛（旁路契约）。
{
  for (const bad of [0, -1, Number.NaN, '1024', null, undefined]) {
    assert.deepEqual(cfgAudit({ autoContext: { auditMaxBytes: bad } }), { enabled: true, maxBytes: 256 * 1024 }, `auditMaxBytes=${String(bad)} 应退回默认`)
    assert.deepEqual(cfgShadow({ autoContext: { shadowMaxBytes: bad } }), { enabled: true, maxBytes: 512 * 1024 }, `shadowMaxBytes=${String(bad)} 应退回默认`)
  }
  assert.equal(cfgAudit({ autoContext: { auditMaxBytes: 123 } }).maxBytes, 123, '显式数值必须被采纳')
  assert.equal(cfgShadow({ autoContext: { shadowMaxBytes: 456 } }).maxBytes, 456, '两份配置不得串台')
  assert.equal(cfgAudit({ autoContext: { auditLog: false } }).enabled, false)
  assert.equal(cfgAudit({}).enabled, true, '未配置 = 开')
  assert.equal(cfgShadow({}).enabled, true, '未配置 = 开')
  ok('配置归一：非法上限退回各自默认；关闭只认显式 false')
}

// --- 11b. 写入器的边缘输入：缺参数静默失败；空 cfg 走默认路径 ---
{
  const d = dir()
  assert.equal(appendShadowAudit(null, shadowRecordFrom({}), cfgShadow({})), false)
  assert.equal(appendInjectionAudit(null, auditRecordFrom({}), cfgAudit({})), false)
  assert.equal(appendShadowAudit(d, null, cfgShadow({})), false)
  assert.equal(appendInjectionAudit(d, null, cfgAudit({})), false)
  assert.equal(appendShadowAudit(undefined, undefined, undefined), false)
  assert.equal(appendInjectionAudit(undefined, undefined, undefined), false)
  // 空 cfg：enabled 默认开、maxBytes 退回默认上限——与 cfgAudit()/cfgShadow() 的产物等价。
  assert.equal(appendShadowAudit(d, shadowRecordFrom({ sessionId: 's', step: 1 }), {}), true)
  assert.equal(appendInjectionAudit(d, auditRecordFrom({ sessionId: 's', step: 1, text: 'x' }), {}), true)
  assert.equal(readFileSync(shadowFileFor(d), 'utf8').trim().split('\n').length, 1)
  assert.equal(readFileSync(auditFileFor(d), 'utf8').trim().split('\n').length, 1)
  ok('缺 memoryDir/record → false 不抛；空 cfg = 默认开')
}

// --- 11c. 轮转与默认上限各自独立，不共用一份实现细节 ---
// 一份 300KB 的记录：审计默认 256KB → 第二次追加必轮转；影子默认 512KB → 不轮转。
// 若两处把默认值/常量抄串了（或共用了一个 maxBytes），这条会立刻翻脸。
{
  const big = (marker) => ({ at: new Date().toISOString(), marker, pad: 'x'.repeat(300 * 1024) })
  const dShadow = dir()
  appendShadowAudit(dShadow, big('a'), {})
  appendShadowAudit(dShadow, big('b'), {})
  assert.ok(!existsSync(`${shadowFileFor(dShadow)}.1`), '影子默认 512KB：300KB 不轮转')
  const dAudit = dir()
  appendInjectionAudit(dAudit, big('a'), {})
  appendInjectionAudit(dAudit, big('b'), {})
  assert.ok(existsSync(`${auditFileFor(dAudit)}.1`), '审计默认 256KB：300KB 必轮转')
  ok('默认上限各自独立（影子 512KB / 审计 256KB），轮转只留一份 .1')
}

console.log(`\ninjection-audit tests: ${passed} passed`)
