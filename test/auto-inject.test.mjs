// PR 2 静默注入引擎测试：node test/auto-inject.test.mjs
// 覆盖：无命中零注入 / procedure trigger 命中 + scope tags 过滤 / 预算截断 /
//       wrapper 禁用与无 root 完全透传 / 命中时追加 [Memory Inject] / 指纹去重不重复追加
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { GlobalStore, cfgInsight } from '../src/insight-store.js'
import { buildInjection, cfgEngine } from '../src/auto-inject.js'
import { projectTags } from '../src/project-profile.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

function globalWith(items) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'inject-')), 'global.json')
  const gs = new GlobalStore(file).load()
  gs.doc.items.push(...items)
  return gs
}

const PROCEDURE = {
  id: 'proc_1', kind: 'procedure', scope: 'global', title: 'WSL npm publish 官方源',
  steps: ['uname -r', 'npm config set registry', 'npm publish'],
  trigger: { keywords: ['npm publish', '发包', 'publish'], scope: ['npm'] },
  confidence: 1, archived: false,
}
const LESSON = { id: 'les_1', kind: 'lesson', scope: 'global', title: 'npm 发包要过官方源', fix: '设置 registry 为官方源', confidence: 1, archived: false }

const BASE_CFG = cfgEngine({ insight: {}, autoContext: { maxTokens: 400 } })

// --- 1. 无命中 → 零注入 ---
{
  const gs = globalWith([PROCEDURE, LESSON])
  const out = buildInjection({ query: 'zzz 完全不相关', globalStore: gs, cfg: BASE_CFG })
  assert.equal(out.text, '')
  assert.equal(out.labels.length, 0)
  ok('无命中 → 零注入')
}

// --- 2. trigger 命中 → 注入全步骤 ---
{
  const gs = globalWith([PROCEDURE, LESSON])
  const out = buildInjection({ query: '我要发包到官方源', globalStore: gs, cfg: BASE_CFG, projectTagsList: ['npm'] })
  assert.ok(out.text.includes('npm config set registry'))
  assert.ok(out.text.includes('proc_1') || out.text.includes('WSL npm publish'))
  assert.ok(out.labels.includes('procedure'))
  ok('trigger 命中 → procedure 全步骤注入')
}

// --- 3. legacy `trigger.scope`：默认**忽略**，显式 filter 才当收窄条件 ---
// 旧默认是 filter，等于把作者手写的 scope 值拿去和自动派生的画像 tag 求交集 —— 实测
// 唯一带 scope 的条目（npm 包发布流程）因此永远不命中。现在默认忽略；要收窄必须显式配。
{
  const gs = globalWith([PROCEDURE])
  const ignored = buildInjection({ query: '发包到官方源', globalStore: gs, cfg: BASE_CFG, projectTagsList: ['vue'] })
  assert.ok(ignored.text.includes('WSL npm publish'), '默认忽略 scope：画像无交集也应注入该 procedure')
  ok('legacy scope 默认忽略 → 不过滤')

  const gs2 = globalWith([PROCEDURE])
  const filtered = buildInjection({
    query: '发包到官方源', globalStore: gs2, projectTagsList: ['vue'],
    cfg: cfgEngine({ insight: {}, autoContext: { maxTokens: 400, legacyScope: 'filter' } }),
  })
  assert.ok(!filtered.text.includes('WSL npm publish'), '显式 filter 且 tags 无交集 → 不注入该 procedure')
  ok('legacy scope 显式 filter → 收窄生效')
}

// --- 4. 预算截断 ---
{
  const many = []
  for (let i = 0; i < 30; i++) many.push({ id: `les_${i}`, kind: 'lesson', title: `npm 发包相关经验第 ${i} 条`, fix: 'x'.repeat(120), confidence: 1, archived: false })
  const gs = globalWith([...many, LESSON])
  const out = buildInjection({ query: '发包', globalStore: gs, cfg: cfgEngine({ insight: {}, autoContext: { maxTokens: 40 } }) })
  assert.ok(out.text.length <= 40 * 3 + 20, `超限截断: ${out.text.length}`)
  ok('预算截断生效')
}

// --- 5. 任务级 entry（常驻块）---
{
  const root = mkdtempSync(path.join(tmpdir(), 'inject-task-'))
  const dir = path.join(root, '.dsh-project-memory')
  const { ProjectMemoryStore } = await import('../src/store.js')
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'inject-task-g-')), 'global.json')
  const store = new ProjectMemoryStore(dir).load()
  const now = new Date().toISOString()
  store.addTask({ id: 'tsk_t', title: '重构 auth JWT', projectRoot: root, steps: [{ content: '接 jose', status: 'in_progress' }], files: [], archived: false, createdAt: now, updatedAt: now, lastActiveAt: now })
  const task = store.getTask('tsk_t')
  task.insights = [{ id: 'ins_t', kind: 'lesson', scope: 'task', title: 'JWT 校验 exp', pattern: 'JWT 校验 exp', fix: '用 jose', draft: false, confidence: 0.8, sourceTaskIds: ['tsk_t'], createdAt: now, updatedAt: now }]
  store.setBinding('s1', 'tsk_t')
  store.commit(() => 0)
  const cfg = { memoryDir: '.dsh-project-memory', autoContext: { enabled: true, maxTokens: 300 }, insight: { globalFile: file } }
  const out = buildInjection({ query: '继续重构', task, store, globalStore: new GlobalStore(file).load(), projectTagsList: [], cfg: cfgEngine(cfg) })
  assert.ok(out.text.includes('重构 auth JWT'), '注入任务卡（常驻块）')
  assert.ok(out.text.includes('JWT 校验 exp'), '注入任务级 insight')
  ok('buildInjection → 任务级 entry（常驻块）')
}

// --- 6. 热点文件变化不改变去重指纹（不触发重新注入）---
{
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'inject-hot-')), 'global.json')
  const cfg = cfgEngine({})
  const mkTask = () => ({
    id: 'tsk_h', title: '重构 auth JWT', steps: [{ content: '接 jose' }], insights: [],
    files: ['a.js'], fileMeta: { 'a.js': { lastWriteAt: '2024-01-01T00:00:00.000Z', lastReadAt: '2024-01-01T00:00:00.000Z' } },
  })
  const build = (task) => buildInjection({ query: '继续重构', task, globalStore: new GlobalStore(file).load(), projectTagsList: [], cfg })
  const before = build(mkTask())
  const after = build({ ...mkTask(), files: ['b.js', 'a.js'], fileMeta: { 'a.js': { lastWriteAt: '2024-01-01T00:00:00.000Z', lastReadAt: '2024-01-01T00:00:00.000Z' }, 'b.js': { lastWriteAt: '2024-02-02T00:00:00.000Z', lastReadAt: '2024-02-02T00:00:00.000Z' } } })
  assert.notEqual(before.text, after.text, '热点文件变化后注入文本确实变了')
  assert.equal(before.dedupeText, after.dedupeText, '但去重指纹文本保持稳定')
  ok('热点文件变化不触发重新注入（dedupeText 稳定）')
}

// --- 7. project-profile：tags 解析与缓存 ---
{
  const root = mkdtempSync(path.join(tmpdir(), 'profile-'))
  const { writeFileSync } = await import('node:fs')
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', keywords: ['vue'], dependencies: { vue: '^3', '@vue/compiler': '1' } }))
  const tags = projectTags(root)
  assert.ok(tags.includes('vue'))
  assert.ok(tags.includes('@vue/compiler'.split('/')[1]) || tags.includes('@vue/compiler'))
  assert.equal(projectTags(root).length, tags.length)
  ok('project-profile：package.json tags 解析')
}

// --- 影子记录：rel 必须是**词法**相对分（分母取词法 top，不是融合 top）---
// 事故形状：融合后 `scored[0]` 已经是融合分，旧实现拿它当分母，于是 `rel` 可以 >1（实测 5.925），
// 而离线重放正是按 `rel` 重算 signalMinRatio 的。这里造一个"词法第一但语义最低"的对照：
// 若分母仍取融合 top，BM25 原分 / 融合 top 必然 ≠ 1。
{
  const A = { id: 'sh_a', kind: 'lesson', scope: 'project', title: 'alpha beta gamma delta epsilon 词法强', fix: 'fa', confidence: 0.8 }
  const B = { id: 'sh_b', kind: 'lesson', scope: 'project', title: 'alpha beta gamma 词法略弱', fix: 'fb', confidence: 0.8 }
  const out = buildInjection({
    query: 'alpha beta gamma delta epsilon',
    globalStore: globalWith([A, B]),
    cfg: BASE_CFG,
    rerank: { alpha: 0.5, score: () => new Map([['sh_a', 0.05], ['sh_b', 0.95]]) },
  })
  const cands = out.candidates.filter((c) => c.channel === 'hint')
  assert.equal(cands.length, 2, `两个候选都要进影子记录：${JSON.stringify(out.candidates)}`)
  for (const c of cands) assert.ok(c.rel <= 1.001, `rel 是词法相对分，不得 >1：${JSON.stringify(c)}`)
  const a = cands.find((c) => c.id === 'sh_a')
  assert.equal(a.rel, 1, `词法最强那条的 rel 必须是 1（旧实现 = BM25/融合top = ${a.rel}）`)
  assert.ok(a.vector < 0.5 && a.fused < 1, '融合分与词法相对分必须是两个数')
  ok('影子记录：rel 用词法 top 归一（≤1），与 fused 分开')
}

console.log(`\nauto-inject tests: ${passed} passed`)
