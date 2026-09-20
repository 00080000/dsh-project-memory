// v0.5.7 缺陷回归：每条都对应一个审计发现（修前必失败）。
// node test/bugfix-0.5.7.test.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ProjectMemoryStore } from '../src/store.js'
import { GlobalStore, applyDecay, cfgInsight, promoteProjectToGlobal } from '../src/insight-store.js'
import { recallItems, visibleInsights } from '../src/recall.js'
import { buildInjection, cfgEngine, fitBody } from '../src/auto-inject.js'
import { buildReadinessContext, matchTrigger } from '../src/readiness.js'
import { projectTags } from '../src/project-profile.js'
import { touchTaskFile } from '../src/setup/taskbridge.js'
import { chunkText } from '../src/chunker.js'
import { scanSymbols } from '../src/symbols.js'
import { queryMemoryTool } from '../src/tools/query-memory.js'
import { editMemoryItem } from '../src/commands/insight-actions.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}
const dir = (p = 'fix-') => mkdtempSync(path.join(tmpdir(), p))

/** 负路径场景会打 console.error：测试里静音，避免正常输出看起来像失败。 */
function quiet(fn) {
  const orig = console.error
  console.error = () => {}
  try {
    return fn()
  } finally {
    console.error = orig
  }
}

const CONFIG = { memoryDir: '.dsh-project-memory', maxOutputChars: 8000, chunkChars: 3000, maxChunksPerFile: 40, maxFileSizeMb: 50, maxPdfPages: 1000 }

// --- 1. 旧库迁移：index.json 损坏时必须保住 entries.json（不能静默清空） ---
{
  const d = dir('mig-')
  writeFileSync(path.join(d, 'index.json'), '{ broken')
  writeFileSync(path.join(d, 'entries.json'), JSON.stringify({ 'a.md': [{ type: 'doc', title: 'A' }] }))
  quiet(() => new ProjectMemoryStore(d).load())
  assert.ok(existsSync(path.join(d, 'entries.json')), 'entries.json 必须保留')
  assert.ok(!existsSync(path.join(d, 'format.json')), '不可读 index 时不得打 v2 标记')
  assert.equal(readdirSync(d).filter((n) => n.startsWith('index.json.') && n.endsWith('.corrupt')).length, 1)
  ok('旧库迁移：index.json 损坏不删 entries.json')
}

// --- 2. load() 幂等：第二次调用不能吞掉未落盘的变更 ---
{
  const d = dir('load-')
  const s = new ProjectMemoryStore(d).load()
  s.addExperience({ problem: 'p', solution: 'q' })
  s.replaceInsightItems([{ id: 'ins_x', title: 'x' }])
  s.load()
  assert.equal(s.experience.length, 1, '未落盘 experience 必须还在')
  assert.equal(s.insightItems().length, 1, '未落盘 insights 必须还在')
  ok('load() 幂等：重复调用不丢未保存变更')
}

// --- 3. 畸形数据不拖垮读取 ---
{
  const d = dir('bad-')
  mkdirSync(path.join(d, 'shards'), { recursive: true })
  writeFileSync(path.join(d, 'shards', 'x.json'), JSON.stringify({ relPath: 'a.md', record: { sha256: 'h', type: 'doc' }, entries: {} }))
  writeFileSync(path.join(d, 'insights.json'), JSON.stringify({ version: 2, migratedAt: 'now', items: [null, { id: 'ok' }] }))
  const s = new ProjectMemoryStore(d).load()
  assert.deepEqual(s.allEntries(), [], 'entries 非数组时按空处理，不抛')
  assert.equal(s.insightItems().length, 1, 'null 条目被过滤')
  ok('畸形 shard / insight 条目：读取不抛错')
}

// --- 4. 衰减：从未命中但久置的条目也要归档（decayDays 不再是死开关） ---
{
  const now = new Date().toISOString()
  const old = new Date(Date.now() - 200 * 86400000).toISOString()
  const items = [{ id: 'a', hitCount: 0, createdAt: old, updatedAt: old }]
  assert.equal(applyDecay(items, cfgInsight({ insight: { decayDays: 90 } }), now), 1)
  assert.equal(items[0].archived, true)
  ok('衰减：久置零命中条目被软归档')
}

// --- 5. 提升保留使用痕迹与派生 trigger ---
{
  const d = dir('prom-')
  const s = new ProjectMemoryStore(d).load()
  const item = { id: 'ins_p', kind: 'lesson', scope: 'project', title: 'p', confidence: 0.9, hitCount: 4, createdAt: '2020-01-01T00:00:00.000Z', triggerDerived: { keywords: ['k'], actions: [], paths: [] }, sourceTaskIds: ['t1', 't2', 't3'] }
  s.replaceInsightItems([item])
  const gs = new GlobalStore(path.join(d, 'global.json')).load()
  promoteProjectToGlobal(s, gs, cfgInsight({ insight: { globalPromoteTasks: 3 } }), new Date().toISOString())
  const moved = gs.items()[0]
  assert.equal(moved.hitCount, 4, 'hitCount 必须带过去')
  assert.equal(moved.createdAt, '2020-01-01T00:00:00.000Z', 'createdAt 必须带过去')
  assert.ok(moved.triggerDerived && moved.triggerDerived.keywords.includes('k'), 'triggerDerived 必须带过去')
  ok('提升 global：保留 hitCount/createdAt/triggerDerived')
}

// --- 6. 提升到 global 也要收口 maxGlobalProcedures ---
{
  const d = dir('cap-')
  const s = new ProjectMemoryStore(d).load()
  const items = []
  for (let i = 0; i < 4; i++) {
    items.push({ id: `ins_${i}`, kind: 'lesson', scope: 'project', title: `t${i}`, confidence: 0.9, sourceTaskIds: ['a', 'b', 'c'] })
  }
  s.replaceInsightItems(items)
  const gs = new GlobalStore(path.join(d, 'global.json')).load()
  promoteProjectToGlobal(s, gs, cfgInsight({ insight: { globalPromoteTasks: 3, maxGlobalProcedures: 2 } }), new Date().toISOString())
  assert.ok(gs.items().length <= 2, `global 容量必须收口，实得 ${gs.items().length}`)
  ok('提升 global：maxGlobalProcedures 生效')
}

// --- 7. 召回：文档再多也不能把符号层挤出结果 ---
{
  const entries = []
  for (let i = 0; i < 20; i++) entries.push({ id: `d${i}`, type: 'doc', title: 'widget', summary: 'widget thing', terms: 'widget', sourcePath: `d${i}.md` })
  entries.push({ id: 's1', type: 'symbol', title: 'widget (function)', summary: '', terms: 'widget', sourcePath: 'a.ts' })
  const out = recallItems({ entries, queries: ['widget'], layers: ['doc', 'symbol'], limit: 8 })
  assert.ok(out.layers.some((l) => l.layer === 'symbol'), '符号层必须有分桶')
  ok('召回：每层各自 top-k（符号不被文档挤出）')
}

// --- 8. 任务级草稿不进召回 ---
{
  const store = { insightItems: () => [], getTask: () => ({ insights: [{ id: 'draft1', draft: true }, { id: 'keep1' }] }) }
  const ids = visibleInsights({ store, boundTaskId: 't1' }).map((i) => i.id)
  assert.deepEqual(ids, ['keep1'])
  ok('召回：任务级 draft 被过滤')
}

// --- 9. 提示通道：只在 fix 里有匹配的查询词不再让整条通道沉默 ---
{
  const item = { id: 'ins_fix', kind: 'lesson', scope: 'global', title: '发布前检查', fix: '设置 registry 为官方源', archived: false }
  const out = buildInjection({ query: '官方源', globalStore: { items: () => [item] }, cfg: cfgEngine({}) })
  assert.ok(out.text.includes('registry'), `只在 fix 里匹配也应注入：${JSON.stringify(out.dropped)}`)
  ok('提示通道：覆盖率语料与排序同源（fix-only 仍注入）')
}

// --- 10. CJK 文件名不再是意图词；ASCII 裸名保持原语义 ---
{
  const cjk = buildReadinessContext({ humanText: '把这个 石啸天-记忆方向调研.pptx 的时间改一下' })
  assert.equal(matchTrigger({ when: { intents: ['调研'] } }, cjk), null, 'CJK 文件名不得触发意图')
  const ascii = buildReadinessContext({ humanText: '我好像把 de-TODO.md 删了，还能找回吗' })
  assert.equal(matchTrigger({ when: { intents: ['de-TODO'] } }, ascii), 'intent:de-TODO', 'ASCII 裸名保持原语义')
  ok('意图剥离：CJK 文件名不触发，ASCII 裸名照旧')
}

// --- 11. entryOn:false 关掉常驻任务卡 ---
{
  const task = { id: 'tsk_x', title: '常驻任务卡', steps: [{ content: 'a' }], insights: [] }
  const on = buildInjection({ query: '', task, cfg: cfgEngine({}), globalStore: { items: () => [] } })
  const off = buildInjection({ query: '', task, cfg: cfgEngine({ autoContext: { entryOn: false } }), globalStore: { items: () => [] } })
  assert.ok(on.text.includes('常驻任务卡'))
  assert.ok(!off.text.includes('常驻任务卡'), 'entryOn:false 必须不回声')
  ok('entryOn:false 关闭常驻任务卡')
}

// --- 12. fitBody 边界：恰好等于最小长度应当可放 ---
{
  assert.notEqual(fitBody('x'.repeat(300), 120, 120), null)
  assert.equal(fitBody('x'.repeat(300), 119, 120), null)
  ok('fitBody：remaining === min 时可放')
}

// --- 13. 任务文件超限丢最冷的 ---
{
  const task = { files: [], fileMeta: {} }
  for (let i = 0; i < 101; i++) touchTaskFile(task, `f${String(i).padStart(3, '0')}.js`, 'write', new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString())
  assert.ok(task.files.includes('f100.js'), '刚写的文件必须保留')
  assert.ok(!task.files.includes('f000.js'), '最冷的文件应被淘汰')
  assert.ok(task.files.length <= 100)
  ok('TaskBridge：超限淘汰最冷文件')
}

// --- 14. scoped 依赖给出 scope tag；畸形依赖不清空全部 tags ---
{
  const d = dir('tags-')
  writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'demo', keywords: ['wanted'], dependencies: { vue: '^3', '@vue/compiler-sfc': '^3', '@malformed': '1' } }))
  const tags = projectTags(d)
  assert.ok(tags.includes('vue'), `scoped 依赖应给出 vue：${tags}`)
  assert.ok(tags.includes('wanted'), 'keywords 不能因一个畸形依赖被清空')
  ok('项目画像：scoped 依赖 → scope tag；畸形依赖不拖垮全部')
}

// --- 15. chunk 行号：跨行切分后不再累加偏移 ---
{
  const tokens = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')
  const chunks = chunkText(`# H\n\n${tokens}`, 20, 40)
  assert.ok(chunks.length >= 2, '应切成多块')
  for (const c of chunks.slice(1)) assert.equal(c.line, 3, `正文所在行应为 3，实得 ${c.line}`)
  ok('chunker：切分后的 sourceLine 不漂移')
}

// --- 16. 符号扫描：export interface / export type 与多行形态 ---
{
  const src = 'export interface User {\n  name: string\n}\nexport type Cfg = { a: string }\n'
  const syms = scanSymbols('a.ts', 'a.ts', src)
  const names = syms.map((s) => s.title)
  assert.ok(names.some((t) => t === 'User (interface)'), `应有 User (interface)：${names}`)
  assert.ok(names.some((t) => t === 'Cfg (type)'), `应有 Cfg (type)：${names}`)
  assert.equal(syms.find((s) => s.title === 'User (interface)').sourceLine, 1)
  ok('符号扫描：export/多行 interface 与 type 别名')
}

// --- 17. 空查询返回明确错误，而不是任意条目 ---
{
  const d = dir('q-')
  const tool = queryMemoryTool({ llm: null }, CONFIG)
  const out = await tool.execute({ root: d, query: '   ' })
  assert.match(out, /must not be empty/)
  ok('query_memory：空查询被拒绝')
}

// --- 18. /insight edit 不破坏 authored trigger ---
{
  const d = dir('edit-')
  const s = new ProjectMemoryStore(d).load()
  s.replaceInsightItems([{ id: 'ins_e', kind: 'lesson', scope: 'project', title: 't', trigger: { when: { ops: ['npm-publish'] }, prevents: 'x' } }])
  const res = editMemoryItem({ store: s, gs: null, scope: 'project', id: 'ins_e', fields: { trigger: { keywords: ['发包'] } } })
  assert.equal(res.ok, true)
  const it = s.insightItems()[0]
  assert.deepEqual(it.trigger.when, { ops: ['npm-publish'] }, 'when 必须保留')
  assert.equal(it.trigger.prevents, 'x', 'prevents 必须保留')
  assert.deepEqual(it.trigger.keywords, ['发包'])
  ok('/insight edit：合并 trigger 而非重建')
}

console.log(`\nbugfix-0.5.7 tests: ${passed} passed`)
