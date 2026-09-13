// PR3：派生 trigger（只进提示通道）+ insights.json v1→v2 懒回填 + degraded 观测
//   node test/insight-derive.test.mjs
//
// 交付契约：**authored trigger = 确定性注入；derived trigger = 统计提示**。
// 派生信号可以提升召回，但永远不能强制注入——否则"自动学出来的东西"会污染上下文。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ProjectMemoryStore } from '../src/store.js'
import { GlobalStore, cfgInsight, normalizeInsight } from '../src/insight-store.js'
import { insightToEntry } from '../src/recall.js'
import { rankEntriesMergedScored } from '../src/util/search.js'
import { buildInjection, cfgEngine } from '../src/auto-inject.js'
import { memoryRootFor } from '../src/util/fs.js'
import { installAutoInject } from '../src/auto-inject.js'
import { lessonTool } from '../src/tools/lesson-tools.js'

const readiness = await import('../src/readiness.js')

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const PUBLIC_FACE = {
  id: 'ins_pub',
  kind: 'lesson',
  scope: 'project',
  title: '公开作品仓库的「公开面」不止文件清单：src 注释、CHANGELOG 与提交历史都会一起暴露',
  fix: '内部文档一律写进 .gitignore；公开前扫描 src/ test/ CHANGELOG 的内部引用；注意 npm pack 的 files 白名单',
  confidence: 0.88,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const CFG = cfgEngine({ insight: {}, autoContext: { maxTokens: 400 } })

// ---- 1. deriveTrigger：从正文确定性地抽出动作 / 词 / 路径 ----
{
  assert.equal(typeof readiness.deriveTrigger, 'function', 'src/readiness.js 还没有 deriveTrigger')
  const d = readiness.deriveTrigger(PUBLIC_FACE)
  assert.ok(d.actions.includes('git-commit'), `动作要抽到 git-commit：${JSON.stringify(d)}`)
  assert.ok(d.actions.includes('go-public'), '动作要抽到 go-public（"公开"）')
  assert.ok(d.paths.includes('.gitignore'), `路径要抽到 .gitignore：${JSON.stringify(d.paths)}`)
  assert.ok(d.keywords.includes('CHANGELOG'), `裸文件名进关键词：${JSON.stringify(d.keywords)}`)
  assert.ok(d.keywords.includes('公开') && d.keywords.includes('提交'), `意图词：${JSON.stringify(d.keywords)}`)
  assert.ok(d.keywords.length <= 6, '有界：关键词 ≤ 6')
  assert.ok(d.actions.length <= 4, '有界：动作 ≤ 4')
  assert.ok(d.paths.length <= 6, '有界：路径 ≤ 6')
  assert.deepEqual(readiness.deriveTrigger(PUBLIC_FACE), d, '确定性：两次派生结果一致')
  ok('deriveTrigger：确定性、有界，抽出动作/意图词/路径')
}

// ---- 2. 派生信号永不强制注入 ----
{
  const derivedOnly = { ...PUBLIC_FACE, id: 'ins_derived', triggerDerived: readiness.deriveTrigger(PUBLIC_FACE) }
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'derive-')), 'global.json')
  const gs = new GlobalStore(file).load()
  gs.doc.items.push(derivedOnly)
  const out = buildInjection({
    query: '把收尾做掉',
    readiness: { humanText: '把收尾做掉', actionText: 'git commit -m x' },
    globalStore: gs,
    cfg: CFG,
  })
  assert.ok(!out.reasons.some((r) => r.channel === 'trigger'), 'triggerDerived 绝不能走确定性通道')
  ok('派生信号只进提示通道：没有 authored trigger 就不强制注入')
}

// ---- 3. 派生词项参与召回（正文里没有那个词也能被检索到）----
{
  const ins = { id: 'ins_x', kind: 'lesson', scope: 'project', title: 'npm 发布前先核对 registry', fix: '设置官方源后重试', triggerDerived: { keywords: ['发包'], actions: ['npm-publish'], paths: [] } }
  const entry = insightToEntry(ins)
  assert.ok(JSON.stringify(entry).includes('npm-publish'), '派生动作要进检索文本')
  const hit = rankEntriesMergedScored([entry], ['发包'], 1)
  assert.equal(hit.length, 1, '正文没有"发包"，靠派生关键词也能命中')
  const miss = rankEntriesMergedScored([insightToEntry({ ...ins, triggerDerived: undefined })], ['发包'], 1)
  assert.equal(miss.length, 0, '没有派生词项时该查询不命中（证明增益来自派生信号）')
  ok('派生词项参与召回：正文没有的意图词也能命中')
}

// ---- 4. insights.json v1 → v2：懒回填派生 trigger，幂等 ----
{
  const root = mkdtempSync(path.join(tmpdir(), 'derive-mig-'))
  const dir = memoryRootFor(root, '.dsh-project-memory')
  mkdirSync(dir, { recursive: true })
  const v1 = { version: 1, migratedAt: '2020-01-01T00:00:00.000Z', items: [{ ...PUBLIC_FACE, triggerDerived: undefined }] }
  writeFileSync(path.join(dir, 'insights.json'), JSON.stringify(v1))
  const store = new ProjectMemoryStore(dir).load()
  assert.ok(store.insightItems()[0].triggerDerived, 'v1 条目加载后应被懒回填')
  store.commit(() => 0)
  const saved = JSON.parse(readFileSync(path.join(dir, 'insights.json'), 'utf8'))
  assert.equal(saved.version, 2, '下一次落盘把格式标记推到 v2')
  assert.ok(saved.items[0].triggerDerived)
  assert.equal(readiness.backfillDerivedTriggers(saved), false, '幂等：已回填的文档不再变更')
  ok('迁移：v1 懒回填 + 落盘 v2 + 幂等')
}

// ---- 5. save_lesson / normalizeInsight 接受 actions / paths ----
{
  const norm = normalizeInsight({ title: 't', kind: 'lesson', trigger: { keywords: ['k'], symbols: ['s'], actions: ['git-commit'], paths: ['README*'], scope: ['npm'] } })
  assert.deepEqual(norm.trigger.actions, ['git-commit'], 'normalizeInsight 不能丢 actions')
  assert.deepEqual(norm.trigger.paths, ['README*'], 'normalizeInsight 不能丢 paths')

  const root = mkdtempSync(path.join(tmpdir(), 'derive-tool-'))
  const config = { memoryDir: '.dsh-project-memory', insight: { globalFile: path.join(root, 'global.json') } }
  const tool = lessonTool(config)
  const exec = { agent: { session: { id: 's_derive', header: { cwd: root } } } }
  await tool.execute({ title: '发布前检查公开面', kind: 'lesson', fix: '写进 .gitignore', trigger: { actions: ['npm-publish'], paths: ['CHANGELOG*'] } }, exec)
  const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
  const item = store.insightItems()[0]
  assert.ok(item, 'insight 已写入')
  assert.deepEqual(item.trigger?.actions, ['npm-publish'], '工具层必须把 actions 落盘')
  assert.deepEqual(item.trigger?.paths, ['CHANGELOG*'])
  ok('写入路径：normalizeInsight 与 save_lesson schema 都接受 actions / paths')
}

// ---- 6. degraded：因预算丢弃注入必须可见，而不是静默 ----
{
  const root = mkdtempSync(path.join(tmpdir(), 'derive-deg-'))
  const file = path.join(root, 'global.json')
  const gs = new GlobalStore(file).load()
  for (let i = 0; i < 30; i++) {
    gs.doc.items.push({
      id: `ins_deg_${i}`,
      kind: 'lesson',
      scope: 'global',
      title: `发布前检查第 ${i} 条`,
      fix: 'x'.repeat(300),
      trigger: { actions: ['git-commit'] },
      confidence: 1,
      archived: false,
    })
  }
  gs.commit(() => 0)

  let handler
  const ctx = { on: (event, fn) => { if (event === 'agent/pre-step') handler = fn } }
  installAutoInject(ctx, { memoryDir: '.dsh-project-memory', autoContext: { enabled: true, maxTokens: 40 }, insight: { globalFile: file } })
  const payload = { agent: { session: { id: 's_deg', header: { cwd: root } } }, messages: [{ role: 'user', content: [{ type: 'text', text: '你顺便提交一下' }] }] }
  const logs = []
  const orig = console.error
  console.error = (...a) => logs.push(a.join(' '))
  try {
    const decision = await handler(payload, async () => ({ kind: 'enter', messages: payload.messages }))
    assert.equal(decision.kind, 'enter')
  } finally {
    console.error = orig
  }
  assert.ok(logs.some((l) => /degraded/.test(l) && /budget/.test(l)), `预算丢弃必须留下 degraded 记录：${JSON.stringify(logs)}`)
  ok('degraded：预算丢弃注入时留下可见记录（不静默）')
}

console.log(`\ninsight-derive tests: ${passed} passed`)
