// PR 3 服务器侧记忆动作测试：node test/insight-actions.test.mjs
// 覆盖：list 三 scope / confirm 草稿 / task→project 提升 / project→global 提升 /
//       global→project 降级 / project→task 降级 / archive/restore/delete
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { ProjectMemoryStore } from '../src/store.js'
import { GlobalStore, cfgInsight } from '../src/insight-store.js'
import { listInsights, actInsight, editMemoryItem } from '../src/commands/insight-actions.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'iact-'))
  const store = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
  const gs = new GlobalStore(path.join(root, 'global.json')).load()
  const cfg = cfgInsight({ insight: { globalFile: path.join(root, 'global.json') } })
  const now = new Date().toISOString()
  store.addTask({ id: 'tsk_a', title: 'A', projectRoot: root, steps: null, files: [], archived: false, createdAt: now, updatedAt: now, lastActiveAt: now })
  const task = store.getTask('tsk_a')
  task.insights = [
    { id: 'ins_draft', kind: 'lesson', scope: 'task', title: '草稿教训', pattern: '草稿教训', draft: true, source: 'reflect', confidence: 0.6, sourceTaskIds: ['tsk_a'], createdAt: now, updatedAt: now },
  ]
  store.replaceInsightItems([{ id: 'ins_pj', kind: 'decision', scope: 'project', title: '选型 jose', choice: 'jose', reason: '零依赖', confidence: 0.9, sourceTaskIds: ['tsk_a'], createdAt: now, updatedAt: now }])
  gs.doc.items.push({ id: 'ins_gl', kind: 'procedure', scope: 'global', title: '发包流程', steps: ['a'], confidence: 1, createdAt: now, updatedAt: now })
  return { store, gs, cfg, root }
}

// --- 1. list 三 scope ---
{
  const { store, gs } = fixture()
  const taskList = listInsights(store, gs, 'task')
  assert.equal(taskList.count, 1)
  assert.equal(taskList.items[0].draft, true)
  const pj = listInsights(store, gs, 'project')
  assert.equal(pj.count, 1)
  const gl = listInsights(store, gs, 'global')
  assert.equal(gl.count, 1)
  ok('list：task 草稿 / project / global 三 scope')
}

// --- 2. confirm 草稿 ---
{
  const { store, gs } = fixture()
  const res = actInsight({ store, gs, action: 'confirm', scope: 'task', id: 'ins_draft' })
  assert.equal(res.ok, true)
  assert.equal(store.getTask('tsk_a').insights[0].draft, false)
  ok('confirm：task 草稿转正式')
}

// --- 3. task → project 提升（手动） ---
{
  const { store, gs } = fixture()
  const res = actInsight({ store, gs, action: 'promote', scope: 'task', id: 'ins_draft' })
  assert.equal(res.ok, true)
  assert.equal((store.getTask('tsk_a').insights || []).length, 0, 'task 副本移除')
  assert.equal(store.insightItems().length, 2, 'project 现有 + 提升')
  assert.ok(store.insightItems().some((i) => i.id === 'ins_draft' && i.draft === false))
  ok('task→project 手动提升')
}

// --- 4. project → global / 降级往返 ---
{
  const { store, gs } = fixture()
  const up = actInsight({ store, gs, action: 'promote', scope: 'project', id: 'ins_pj' })
  assert.equal(up.ok, true)
  assert.equal(store.insightItems().length, 0)
  assert.equal(gs.items().length, 2)
  const down = actInsight({ store, gs, action: 'demote', scope: 'global', id: 'ins_pj' })
  assert.equal(down.ok, true)
  assert.equal(gs.items().length, 1)
  assert.equal(store.insightItems().length, 1)
  ok('project→global 提升 与 global→project 降级')
}

// --- 5. project → task 降级（指定任务） ---
{
  const { store, gs } = fixture()
  const res = actInsight({ store, gs, action: 'demote', scope: 'project', id: 'ins_pj', taskId: 'tsk_a' })
  assert.equal(res.ok, true)
  assert.equal(store.insightItems().length, 0)
  assert.equal(store.getTask('tsk_a').insights.length, 2)
  ok('project→task 降级')
}

// --- 6. archive/restore/delete ---
{
  const { store, gs } = fixture()
  const a = actInsight({ store, gs, action: 'archive', scope: 'project', id: 'ins_pj' })
  assert.equal(a.ok, true)
  assert.equal(store.insightItems()[0].archived, true)
  const r = actInsight({ store, gs, action: 'restore', scope: 'project', id: 'ins_pj' })
  assert.equal(store.insightItems()[0].archived, false)
  const d = actInsight({ store, gs, action: 'delete', scope: 'global', id: 'ins_gl' })
  assert.equal(d.ok, true)
  assert.equal(gs.items().length, 0)
  // 不存在条目 → ok:false 且不崩
  const miss = actInsight({ store, gs, action: 'delete', scope: 'global', id: 'nope' })
  assert.equal(miss.ok, false)
  ok('archive/restore/delete + 缺失条目安全')
}

// --- 7. edit：正文/trigger/标题 白名单更新（task / project / global） ---
{
  const { store, gs } = fixture()
  const r1 = editMemoryItem({ store, gs, scope: 'project', id: 'ins_pj', fields: { reason: '理由更新了', trigger: { keywords: ['选型'] } } })
  assert.equal(r1.ok, true)
  const pj = store.insightItems()[0]
  assert.equal(pj.reason, '理由更新了')
  assert.deepEqual(pj.trigger.keywords, ['选型'])
  const r2 = editMemoryItem({ store, gs, scope: 'task', id: 'ins_draft', fields: { fix: '新修法', confidence: 0.95 } })
  assert.equal(r2.ok, true)
  const draft = store.getTask('tsk_a').insights[0]
  assert.equal(draft.fix, '新修法')
  assert.equal(draft.confidence, 0.95)
  const r3 = editMemoryItem({ store, gs, scope: 'global', id: 'ins_gl', fields: { title: '' } })
  assert.equal(r3.ok, false, '空标题拒绝')
  assert.equal(gs.items()[0].title, '发包流程')
  const bad = editMemoryItem({ store, gs, scope: 'project', id: 'nope', fields: { title: 'x' } })
  assert.equal(bad.ok, false)
  ok('edit：正文/trigger 更新、空标题拒绝、缺失条目安全')
}

// --- 8. list 摘要 body 预填：避开与 title 相同的字段（编辑表单不判空） ---
{
  const { store, gs } = fixture()
  store.replaceInsightItems([
    { id: 'exp_1', kind: 'experience', scope: 'project', title: '问题X', problem: '问题X', solution: '解法S', confidence: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  ])
  const t = store.getTask('tsk_a')
  t.insights = [{ id: 'les_1', kind: 'lesson', scope: 'task', title: '坑P', pattern: '坑P', fix: '修法F', draft: false, confidence: 0.8, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]
  const pj = listInsights(store, gs, 'project').items.find((i) => i.id === 'exp_1')
  assert.equal(pj.body, '解法S', 'experience：body= solution（≠ title）')
  const les = listInsights(store, gs, 'task').items.find((i) => i.id === 'les_1')
  assert.equal(les.body, '修法F', 'lesson：body= fix（≠ pattern/title）')
  ok('list body 预填：experience/lesson 取非标题正文')
}

// --- 9. 编辑切 kind：kind 真正生效并清理旧 kind 的内容字段 ---
{
  const { store, gs } = fixture()
  const now = '2026-01-01T00:00:00.000Z'
  store.replaceInsightItems([{ id: 'k1', kind: 'experience', scope: 'project', title: '发包', problem: '发包', solution: '旧解法', confidence: 0.8, createdAt: now, updatedAt: now }])
  const r = editMemoryItem({ store, gs, scope: 'project', id: 'k1', fields: { kind: 'procedure', title: '发包', steps: ['改名配置文件', '指定官方网址'], trigger: { keywords: ['发包'] } } })
  assert.equal(r.ok, true)
  const item = store.insightItems()[0]
  assert.equal(item.kind, 'procedure', 'kind 被更新')
  assert.equal(item.solution, undefined, '旧 experience 字段(solution)被清理')
  assert.equal(item.problem, undefined)
  assert.deepEqual(item.steps, ['改名配置文件', '指定官方网址'])
  const back = editMemoryItem({ store, gs, scope: 'project', id: 'k1', fields: { kind: 'experience', title: '发包', problem: '发包', solution: '新解法' } })
  assert.equal(back.ok, true)
  const backItem = store.insightItems()[0]
  assert.equal(backItem.kind, 'experience')
  assert.equal(backItem.steps, undefined, 'procedure 字段被清理')
  assert.equal(backItem.solution, '新解法')
  const badKind = editMemoryItem({ store, gs, scope: 'project', id: 'k1', fields: { kind: 'nope' } })
  assert.equal(badKind.ok, false, '非法 kind 不产生变更')
  ok('编辑切 kind：kind 更新 + 旧字段清理 + 非法 kind 拒绝')
}

console.log(`\ninsight-actions tests: ${passed} passed`)
