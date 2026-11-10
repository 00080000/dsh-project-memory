// 回归：手工 promote/demote 不去重，产生重复 id（审计缺陷 #20）
//
// 四条手工移动路径原本都直接 push：task→project / project→global / project→task / global→project。
// 落点已有同 id（审计复现：global 和 project 各有一条 ins_dup）或近重复条目时，移动后池里出现
// 两条同题条目。修复后：同 id 或 overlap ≥ cfg.dedupOverlap 一律合并进落点既有条目，来源条目删除；
// 不相似才按原逻辑移动。
//
// 运行：node test/fix-2026-11-10-manual-promote-dedup.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { ProjectMemoryStore } from '../src/store.js'
import { GlobalStore, cfgInsight, normalizeInsight } from '../src/insight-store.js'
import { actInsight } from '../src/commands/insight-actions.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'fix-dedup-'))
  const store = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
  const gs = new GlobalStore(path.join(root, 'global.json')).load()
  const now = new Date().toISOString()
  for (const id of ['tsk_a', 'tsk_b']) {
    store.addTask({ id, title: `任务${id.slice(-1).toUpperCase()}`, projectRoot: root, steps: null, files: [], archived: false, createdAt: now, updatedAt: now, lastActiveAt: now })
  }
  return { root, store, gs, cfg: cfgInsight({}), taskA: store.getTask('tsk_a') }
}

/** 造一条 lesson；id 显式指定（normalizeInsight 生成的 id 无法预测）。 */
function lesson(id, scope, extra = {}) {
  const ins = normalizeInsight(
    {
      title: '手工移动落点去重',
      kind: 'lesson',
      pattern: '手工移动产生重复 id',
      fix: '落点先查同 id 与近重复再合并',
      ...extra,
    },
    { scope, source: 'agent' },
  )
  ins.id = id
  return ins
}

const ids = (pool) => pool.map((i) => i.id)

// --- 1. 审计复现：global 已有 ins_dup，project 的手工提升不再造第二条 ---
{
  const { store, gs, cfg } = fixture()
  const p = lesson('ins_dup', 'project')
  const g = lesson('ins_dup', 'global')
  // normalizeInsight 只复制白名单字段，使用痕迹要在归一化之后显式写回。
  p.hitCount = 2
  g.hitCount = 5
  store.replaceInsightItems([p])
  gs.items().push(g)
  gs.markDirty()

  const res = actInsight({ store, gs, action: 'promote', scope: 'project', id: 'ins_dup', cfg })
  assert.equal(res.ok, true)
  assert.match(res.text, /合并到 global 既有条目/, '返回文案要说明是合并而不是移动')
  assert.deepEqual(ids(gs.items()), ['ins_dup'], 'global 只剩一条 ins_dup')
  assert.equal(new Set(ids(gs.items())).size, 1, '没有重复 id')
  assert.equal(store.insightItems().length, 0, '来源 project 条目已删除')
  assert.equal(gs.items()[0].hitCount, 6, '合并记一次命中（保留 hitCount 逻辑）')
  ok('审计复现：project→global 同 id 合并，global 只有 1 条')
}

// --- 2. 不同 id 但近重复（同 title/pattern）→ 合并成 1 条，保留落点 id ---
{
  const { store, gs, cfg } = fixture()
  const p = lesson('ins_near_p', 'project', { fix: '本次移动带的修法' })
  const g = lesson('ins_near_g', 'global', { fix: 'global 原有修法' })
  store.replaceInsightItems([p])
  gs.items().push(g)
  gs.markDirty()

  const res = actInsight({ store, gs, action: 'promote', scope: 'project', id: 'ins_near_p', cfg })
  assert.equal(res.ok, true)
  assert.match(res.text, /合并到 global 既有条目/)
  assert.deepEqual(ids(gs.items()), ['ins_near_g'], '合并进既有条目，不是新增 ins_near_p')
  assert.equal(gs.items()[0].fix, '本次移动带的修法', '用户明确的移动版本胜出（正文取新值）')
  assert.equal(gs.items()[0].prev.fix, 'global 原有修法', '被挤掉的旧正文进 prev 单槽')
  assert.equal(store.insightItems().length, 0)
  ok('project→global 近重复（不同 id）合并为 1 条')
}

// --- 3. 无关条目 → 仍按原逻辑移动：global 2 条、来源被删、使用痕迹保留 ---
{
  const { store, gs, cfg } = fixture()
  const p = normalizeInsight(
    { title: 'Docker build cache mismatch', kind: 'lesson', pattern: 'stale image layer cache', fix: 'rebuild with --no-cache' },
    { scope: 'project', source: 'agent' },
  )
  p.id = 'ins_move'
  p.hitCount = 3
  p.createdAt = '2025-01-01T00:00:00.000Z'
  const g = normalizeInsight(
    { title: 'Release publish checklist', kind: 'procedure', steps: ['npm publish'] },
    { scope: 'global', source: 'agent' },
  )
  g.id = 'ins_gl_keep'
  store.replaceInsightItems([p])
  gs.items().push(g)
  gs.markDirty()

  const res = actInsight({ store, gs, action: 'promote', scope: 'project', id: 'ins_move', cfg })
  assert.equal(res.ok, true)
  assert.doesNotMatch(res.text, /合并/, '不相似时是移动，文案不能误报合并')
  assert.deepEqual(ids(gs.items()).sort(), ['ins_gl_keep', 'ins_move'])
  const moved = gs.items().find((i) => i.id === 'ins_move')
  assert.deepEqual(moved.movedFrom.scope, 'project', 'movedFrom 记录来源')
  assert.equal(moved.hitCount, 3, 'hitCount 原样带回')
  assert.equal(moved.createdAt, p.createdAt, 'createdAt 原样带回')
  assert.equal(store.insightItems().length, 0, '来源 project 条目已删除')
  ok('project→global 无关条目：照旧移动（2 条，来源删除）')
}

// --- 4. task→project 同 id → 合并，task 副本删除 ---
{
  const { store, gs, cfg, taskA } = fixture()
  const t = lesson('ins_t_dup', 'task', { fix: '任务里的修法' })
  const p = lesson('ins_t_dup', 'project', { fix: '项目里的修法' })
  taskA.insights = [t]
  store.replaceInsightItems([p])

  const res = actInsight({ store, gs, action: 'promote', scope: 'task', id: 'ins_t_dup', cfg })
  assert.equal(res.ok, true)
  assert.match(res.text, /合并到 project 既有条目/)
  assert.deepEqual(ids(store.insightItems()), ['ins_t_dup'])
  assert.equal(store.insightItems()[0].fix, '任务里的修法')
  assert.deepEqual(taskA.insights, [], 'task 源副本已删除')
  ok('task→project 同 id 合并，project 1 条、task 副本删除')
}

// --- 5. global→project 近重复 → 合并，落点 project 条目不产生 _d 副本 ---
{
  const { store, gs, cfg } = fixture()
  const p = lesson('ins_p_near', 'project')
  const g = lesson('ins_g_near', 'global')
  store.replaceInsightItems([p])
  gs.items().push(g)
  gs.markDirty()

  const res = actInsight({ store, gs, action: 'demote', scope: 'global', id: 'ins_g_near', cfg })
  assert.equal(res.ok, true)
  assert.match(res.text, /合并到 project 既有条目/)
  assert.deepEqual(ids(store.insightItems()), ['ins_p_near'], '合并进 project 既有条目')
  assert.ok(!store.insightItems().some((i) => String(i.id).startsWith('ins_g_near')), '不生成带 _d 后缀的副本')
  assert.equal(gs.items().length, 0, '来源 global 条目已删除')
  ok('global→project 近重复合并，不产生 _d 副本')
}

// --- 6. global→project 无关条目 → 照旧移动（id 仍带 _d 后缀） ---
{
  const { store, gs, cfg } = fixture()
  const g = normalizeInsight(
    { title: 'Release publish checklist', kind: 'procedure', steps: ['npm publish'] },
    { scope: 'global', source: 'agent' },
  )
  g.id = 'ins_g_move'
  gs.items().push(g)
  gs.markDirty()

  const res = actInsight({ store, gs, action: 'demote', scope: 'global', id: 'ins_g_move', cfg })
  assert.equal(res.ok, true)
  assert.doesNotMatch(res.text, /合并/)
  assert.equal(store.insightItems().length, 1)
  assert.match(store.insightItems()[0].id, /^ins_g_move_d[a-z0-9]+$/, '无关条目仍按原逻辑降级（_d 后缀防撞）')
  assert.equal(gs.items().length, 0, '来源 global 条目已删除')
  ok('global→project 无关条目：照旧移动（_d 后缀）')
}

// --- 7. project→task 近重复 → 合并进目标任务既有条目 ---
{
  const { store, gs, cfg, taskA } = fixture()
  const p = lesson('ins_p_down', 'project')
  store.replaceInsightItems([p])
  taskA.insights = [lesson('ins_t_old', 'task')]

  const res = actInsight({ store, gs, action: 'demote', scope: 'project', id: 'ins_p_down', taskId: 'tsk_a', cfg })
  assert.equal(res.ok, true)
  assert.match(res.text, /合并到任务 .* 的既有条目/)
  assert.deepEqual(ids(taskA.insights), ['ins_t_old'], '合并进任务既有条目')
  assert.equal(store.insightItems().length, 0, '来源 project 条目已删除')
  ok('project→task 近重复合并，任务池 1 条')
}

// --- 8. 合并路径仍执行容量收口（maxGlobalProcedures） ---
{
  const { store, gs } = fixture()
  const old = normalizeInsight(
    { title: 'Release publish checklist', kind: 'procedure', steps: ['npm publish'] },
    { scope: 'global', source: 'agent' },
  )
  old.id = 'ins_gl_old'
  old.createdAt = old.updatedAt = '2025-01-01T00:00:00.000Z'
  const g = lesson('ins_dup', 'global')
  gs.items().push(old, g)
  gs.markDirty()
  store.replaceInsightItems([lesson('ins_dup', 'project')])

  const res = actInsight({ store, gs, action: 'promote', scope: 'project', id: 'ins_dup', cfg: { maxGlobalProcedures: 1 } })
  assert.equal(res.ok, true)
  assert.match(res.text, /合并到 global 既有条目/)
  assert.equal(gs.items().length, 1, '合并后仍按 maxGlobalProcedures 收口')
  assert.equal(gs.items()[0].id, 'ins_dup', '刚被合并的活跃条目不被收口掉')
  assert.equal(store.insightItems().length, 0)
  ok('合并路径仍执行 pruneItems 容量收口')
}

console.log(`\nmanual promote/demote dedup tests: ${passed} passed`)
