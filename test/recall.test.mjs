// 统一召回（pull 侧）：insight 层接入 query_memory + 规范段加权 —— PR1
//   node test/recall.test.mjs
//
// 设计口径：一个记忆、一个检索契约、按层分桶 + 层先验；insight 不再只有"注入"一条出口。
// 本文件是 PR1 的验收面：修前 1/2/3/4/5/6/7 条必须红。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ProjectMemoryStore } from '../src/store.js'
import { cfgInsight, GlobalStore, saveInsight } from '../src/insight-store.js'
import { memoryRootFor } from '../src/util/fs.js'
import { indexRepository } from '../src/tools/index-repo.js'
import { queryMemoryTool } from '../src/tools/query-memory.js'
import { rankEntriesMergedScored } from '../src/util/search.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const CONFIG = {
  memoryDir: '.dsh-project-memory',
  chunkChars: 3000,
  maxChunksPerFile: 40,
  maxFileSizeMb: 50,
  maxPdfPages: 10,
  maxOutputChars: 8000,
  llmQueryExpansion: false,
}

// PR1 新增的统一召回模块：修前不存在 → 依赖它的断言必须红（而不是静默通过）。
let recall = null
try {
  recall = await import('../src/recall.js')
} catch {
  recall = null
}

const INSIGHT = {
  kind: 'lesson',
  title: '公开作品仓库的「公开面」不止文件清单：src 注释、CHANGELOG 与提交历史都会一起暴露',
  pattern: '把内部文档从 .gitignore 里排除，却忘了 src 注释、CHANGELOG 与提交历史同样公开',
  fix: '内部文档一律写进 .gitignore；公开前扫描 src/ test/ CHANGELOG 的内部引用与代号；注意 npm pack 的 files 白名单；旧提交快照里的措辞也算公开',
  confidence: 0.88,
}
const QUERY = '提交前检查公开面，别把内部文档带进公开仓库'

function newProject() {
  const root = mkdtempSync(path.join(tmpdir(), 'pm-recall-'))
  const store = new ProjectMemoryStore(memoryRootFor(root, CONFIG.memoryDir)).load()
  const gs = new GlobalStore(path.join(root, 'global.json')).load()
  return { root, store, gs, cfg: cfgInsight(CONFIG) }
}

function exec0(root, sessionId = 'sess_unbound') {
  return { agent: { session: { id: sessionId, header: { cwd: root } } } }
}

// ---- 1. 适配器：insight 映射到统一检索条目契约 ----
{
  assert.ok(recall, 'src/recall.js 不存在：insight 层还没有接入统一召回')
  const e = recall.insightToEntry({ id: 'ins_x', scope: 'project', ...INSIGHT, files: ['README.md'], symbols: ['publish'] })
  assert.equal(e.type, 'insight')
  assert.equal(e.id, 'insight:ins_x')
  assert.equal(e.insightId, 'ins_x')
  assert.match(e.title, /公开面/)
  assert.ok(e.summary.includes('gitignore'), 'summary 必须带上 fix，供展示与注入复用')
  const kw = (e.keywords || []).join(' ')
  assert.ok(kw.includes('lesson'), 'kind 进关键词，便于按类型检索')
  assert.ok(kw.includes('README.md') && kw.includes('publish'), 'files / symbols 进关键词')
  ok('insightToEntry：insight 映射到统一检索条目契约')
}

// ---- 2. 规范段先验 ----
{
  assert.ok(recall, 'src/recall.js 不存在')
  assert.ok(recall.normativePrior({ title: '必须遵守' }) > 1, '中文规范段标题要提权')
  assert.ok(recall.normativePrior({ title: '禁止 git add -A' }) > 1)
  assert.ok(recall.normativePrior({ title: 'Rules' }) > 1, '英文规范段同样提权')
  assert.equal(recall.normativePrior({ title: 'Firebase 配置' }), 1, '普通标题不得提权')
  assert.equal(recall.normativePrior({}), 1)
  ok('normativePrior：规范段标题提权，普通标题不提权')
}

// ---- 3. query_memory 新增 insight 层（自然语言查询） ----
{
  const { root, store, gs, cfg } = newProject()
  store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: INSIGHT, scope: 'project', cfg }))
  const tool = queryMemoryTool({}, CONFIG)
  const out = await tool.execute({ query: QUERY, root, type: 'insight' }, exec0(root))
  assert.match(out, /ins_/, 'type=insight 必须返回 project insight（现在 enum 里没有 insight）')
  assert.match(out, /公开面/)
  ok('query_memory type=insight 能召回 lesson（自然语言查询）')
}

// ---- 4. type=all 也要带上 insight 段 ----
{
  const { root, store, gs, cfg } = newProject()
  store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: INSIGHT, scope: 'project', cfg }))
  const tool = queryMemoryTool({}, CONFIG)
  const out = await tool.execute({ query: QUERY, root }, exec0(root))
  assert.match(out, /## Insights/, "type=all 应包含 '## Insights' 段")
  assert.match(out, /公开面/)
  ok("type=all 输出包含 '## Insights' 段")
}

// ---- 5. 作用域可见性：task 级只对绑定它的会话可见 ----
{
  const { root, store, gs, cfg } = newProject()
  const now = new Date().toISOString()
  store.addTask({ id: 'tsk_a', title: 'A', projectRoot: root, steps: null, files: [], archived: false, createdAt: now, updatedAt: now, lastActiveAt: now })
  store.commit((s) => saveInsight({
    store: s,
    globalStore: gs,
    raw: { kind: 'lesson', title: '任务私有：内部文档外泄检查清单', fix: '提交前扫描公开面' },
    scope: 'task',
    taskId: 'tsk_a',
    cfg,
  }))
  const tool = queryMemoryTool({}, CONFIG)
  const unbound = await tool.execute({ query: '内部文档 外泄 检查清单', root, type: 'insight' }, exec0(root, 'sess_unbound'))
  assert.ok(!/任务私有/.test(unbound), '未绑定会话不得看到 task 作用域条目')
  store.setBinding('sess_bound', 'tsk_a')
  const bound = await tool.execute({ query: '内部文档 外泄 检查清单', root, type: 'insight' }, exec0(root, 'sess_bound'))
  assert.match(bound, /任务私有/, '绑定该任务的会话应能看到')
  ok('作用域可见性：task 级 insight 只对绑定它的会话可见')
}

// ---- 6. 规范段提权：同样词频下「必须遵守」chunk 必须胜出 ----
{
  const entries = [
    { id: 'a#0', type: 'doc', sourcePath: 'a.md', sourceLine: 1, title: '项目手册', summary: '不要 提交 私密 文件 公开 仓库 提交 说明', keywords: ['提交', '不要', '公开'], terms: '' },
    { id: 'a#1', type: 'doc', sourcePath: 'a.md', sourceLine: 90, title: '必须遵守', summary: '不要提交私密文件', keywords: ['提交'], terms: '' },
  ]
  // 前置：现状就是"普通 chunk 靠词频压过规范段"（本 PR 要修的现象）
  const baseline = rankEntriesMergedScored(entries, ['提交前不要做什么'], 2).map((r) => r.entry.id)
  assert.equal(baseline[0], 'a#0', '前置事实：未提权时 a#0 胜出')
  assert.ok(recall, 'src/recall.js 不存在')
  const ranked = recall.recallItems({ entries, queries: ['提交前不要做什么'], layers: ['doc'] })
  assert.equal(ranked.layers[0].hits[0].item.id, 'a#1', '规范段提权后必须排第一')
  ok('规范段提权：同样词频下「必须遵守」chunk 胜出')
}

// ---- 7. 真实文件端到端：规范段必须出现在召回里 ----
{
  const { root, store } = newProject()
  const filler = `${'这是无关的项目说明，用于填充体积。'.repeat(60)}\n\n`
  writeFileSync(path.join(root, 'HANDBOOK.md'), `# 项目手册\n\n${filler}## 必须遵守\n\n- 不要提交私密文件，禁止 git add -A\n- 提交前扫描 src/ 与 CHANGELOG 的内部引用\n`)
  await indexRepository({}, CONFIG, root, {})
  const tool = queryMemoryTool({}, CONFIG)
  const out = await tool.execute({ query: '提交前不要做什么', root, type: 'doc' }, exec0(root))
  assert.match(out, /必须遵守/, '规范段所在 chunk 必须出现在召回结果里')
  ok('端到端：长文档里的规范段 chunk 可被召回')
}

// ---- 8. recallItems：按层分桶 + 层先验 ----
{
  assert.ok(recall, 'src/recall.js 不存在')
  const { store, gs, cfg } = newProject()
  store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: INSIGHT, scope: 'project', cfg }))
  const r = recall.recallItems({ store, globalStore: gs, queries: [QUERY], layers: ['doc', 'insight'] })
  const bucket = r.layers.find((l) => l.layer === 'insight')
  assert.ok(bucket, 'layers 里必须有 insight 桶')
  assert.equal(bucket.prior, recall.LAYER_PRIORS.insight, '层先验必须暴露出来（可审计）')
  assert.ok(bucket.hits.length >= 1, 'insight 桶必须有命中')
  assert.equal(bucket.hits[0].item.type, 'insight')
  ok('recallItems：按层分桶 + 层先验，insight 层可检索')
}

console.log(`\nrecall tests: ${passed} passed`)
