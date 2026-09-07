// PR 2 静默注入引擎测试：node test/auto-inject.test.mjs
// 覆盖：无命中零注入 / procedure trigger 命中 + scope tags 过滤 / 预算截断 /
//       wrapper 禁用与无 root 完全透传 / 命中时追加 [Memory Inject] / 指纹去重不重复追加
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { GlobalStore, cfgInsight } from '../src/insight-store.js'
import { buildInjection, wrapLlmStream, cfgEngine, INJECT_MARK } from '../src/auto-inject.js'
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

// --- 3. scope tags 过滤：画像无交集 → 跳过 procedure ---
{
  const gs = globalWith([PROCEDURE])
  const out = buildInjection({ query: '发包到官方源', globalStore: gs, cfg: BASE_CFG, projectTagsList: ['vue'] })
  assert.ok(!out.text.includes('WSL npm publish'), 'tags 无交集不注入该 procedure')
  ok('scope tags 过滤生效')
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

// --- 5. wrapper 禁用 → 原样透传 ---
{
  let captured = null
  async function* orig(p) { captured = p; yield { type: 'finish' } }
  const wrapped = wrapLlmStream(orig, { autoContext: { enabled: false } }, {})
  assert.equal(wrapped, orig, '禁用时直接返回原函数')
  const params = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  for await (const c of wrapped(params)) void c
  assert.equal(captured.messages[0].content[0].text, 'hi')
  ok('wrapper 禁用 → 透传原函数/原参数')
}

// --- 6. wrapper 无 root resolver → 零副作用 ---
{
  let captured = null
  async function* orig(p) { captured = p; yield { type: 'finish' } }
  const wrapped = wrapLlmStream(orig, {}, { resolveRoot: () => null })
  const params = { messages: [{ role: 'user', content: [{ type: 'text', text: '发包' }] }] }
  for await (const c of wrapped(params)) void c
  assert.ok(!JSON.stringify(captured).includes(INJECT_MARK))
  ok('无 root → 完全透传（零副作用）')
}

// --- 7. wrapper 命中 → 追加 [Memory Inject]，指纹去重不重复 ---
{
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'inject-w-')), 'global.json')
  const gs = new GlobalStore(file).load()
  gs.doc.items.push({ ...PROCEDURE, id: 'proc_w', trigger: { keywords: ['发包', 'publish'] } }) // 无 scope → 不受画像过滤
  gs.markDirty()
  gs.commit()
  let captured = []
  async function* orig(p) { captured.push(p); yield { type: 'finish' } }
  const state = {}
  const cfg = { memoryDir: '.dsh-project-memory', autoContext: { enabled: true, maxTokens: 200 }, insight: { globalFile: file } }
  const wrapped = wrapLlmStream(orig, cfg, { resolveRoot: () => file === file && process.cwd(), state })
  // resolver 返回项目 root；global.json 的 procedure 与 query 匹配
  const mkParams = () => ({ messages: [{ role: 'system', content: [{ type: 'text', text: 's' }] }, { role: 'user', content: [{ type: 'text', text: '请帮我发包到官方源' }] }] })
  const p1 = mkParams()
  for await (const c of wrapped(p1)) void c
  const last1 = captured[0].messages[captured[0].messages.length - 1]
  assert.ok(last1.content.some((b) => b.text.includes(INJECT_MARK)), '命中后注入 [Memory Inject]')
  assert.ok(last1.content.some((b) => b.text.includes('npm config set registry')))
  // 第二次同 query：内容未变 → 不再追加
  const p2 = mkParams()
  for await (const c of wrapped(p2)) void c
  const last2 = captured[1].messages[captured[1].messages.length - 1]
  const markers = last2.content.filter((b) => b.text.includes(INJECT_MARK)).length
  assert.equal(markers, 0, '内容未变不重复追加')
  ok('wrapper 命中注入 + 指纹去重')
}

// --- 9. wrapper 带 {root, sessionId} → 注入任务级 entry（常驻块） ---
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
  let captured = null
  async function* orig(p) { captured = p; yield { type: 'finish' } }
  const cfg = { memoryDir: '.dsh-project-memory', autoContext: { enabled: true, maxTokens: 300 }, insight: { globalFile: file } }
  const wrapped = wrapLlmStream(orig, cfg, { resolveRoot: () => ({ root, sessionId: 's1' }), state: {} })
  const params = { messages: [{ role: 'user', content: [{ type: 'text', text: '继续重构' }] }] }
  for await (const c of wrapped(params)) void c
  const last = captured.messages[captured.messages.length - 1]
  assert.ok(last.content.some((b) => b.text.includes('重构 auth JWT')), '注入任务卡（常驻块）')
  ok('wrapper {root, sessionId} → 注入任务级 entry')
}

// --- 10. project-profile：tags 解析与缓存 ---
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

console.log(`\nauto-inject tests: ${passed} passed`)
