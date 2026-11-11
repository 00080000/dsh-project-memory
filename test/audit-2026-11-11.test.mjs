// 2026-11-11 第二轮审计回归：
//  - 客户端会话切换/缓存/表单清空/错误保留（静态守卫 + 纯函数）
//  - 注入回滚账（recordHit 负 delta）
//  - 命令/索引/服务的关键守卫不再被静默绕过
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProjectMemoryStore } from '../src/store.js'
import { recordHit } from '../src/insight-store.js'

let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
const tmp = (p) => path.join(mkdtempSync(path.join(tmpdir(), p)), 'mem')

// 1. 客户端的四个已修缺陷各有静态锚点（React 替身覆盖不到这些分支）
{
  const panel = src('client/TaskPanel.tsx')
  assert.ok(panel.includes('syncedSessionRef'), '切会话必须强制刷新，不能被 5s 节流吞掉')
  assert.ok(panel.includes('dataActions.reset()'), '切会话先清掉上一个会话的数据')
  assert.ok(panel.includes('if (!ok) return'), '任务卡动作失败后不得用 /tasks 成功清错')
  const memory = src('client/MemoryView.tsx')
  assert.ok(memory.includes('totalRef.current = cached.total'), '缓存命中要恢复 totalRef，否则翻页被打回第一页')
  assert.ok(memory.includes('invalidateInsightCache'), '动作后要失效目标 scope 的缓存')
  assert.ok(memory.includes('loadPrefix'), '动作后要连续翻页重载前缀，而不是截回 200 条')
  assert.ok(memory.includes('editingId || form.body.trim()'), '编辑时清空正文必须作为显式空值提交')
  ok('客户端守卫：切会话/缓存/分页/清空正文/动作错误')
}

// 2. 服务与命令的关键护栏
{
  assert.ok(src('project-memory-service.js').includes('assertIndexRoot'), '服务四动词必须拒绝不存在的 root')
  assert.ok(src('commands/insight-actions.js').includes('写盘失败'), '/insight 写命令不能在未落盘时报 success')
  assert.ok(src('tools/index-doc.js').includes('dropStale'), 'index_doc 超大/排除时要摘旧索引')
  ok('服务/命令/索引：根校验、落盘失败、旧索引清理')
}

// 3. 命中回滚：delta=-1 只减计数，不改 lastHitAt，且不会减成负数
{
  const dir = tmp('audit-hit-')
  const store = new ProjectMemoryStore(dir).load()
  const now = new Date().toISOString()
  store.replaceInsightItems([{ id: 'h1', kind: 'lesson', scope: 'project', title: 'h', hitCount: 1, lastHitAt: '2026-01-01T00:00:00.000Z' }])
  recordHit({ store, ids: ['h1'], delta: -1 })
  const item = store.insightItems()[0]
  assert.equal(item.hitCount, 0)
  assert.equal(item.lastHitAt, '2026-01-01T00:00:00.000Z', '回滚不能把 lastHitAt 改成 now')
  recordHit({ store, ids: ['h1'], delta: -1 })
  assert.equal(item.hitCount, 0, '不能减成负数')

  // 真实回滚序列：+1 把 lastHitAt 写成 now，-1 必须恢复到注入前的值。
  store.replaceInsightItems([{ id: 'h2', kind: 'lesson', scope: 'project', title: 'h2', hitCount: 0, lastHitAt: '2020-01-01T00:00:00.000Z' }])
  const prev = new Map([['h2', '2020-01-01T00:00:00.000Z']])
  recordHit({ store, ids: ['h2'], nowIso: '2026-11-11T00:00:00.000Z' })
  recordHit({ store, ids: ['h2'], delta: -1, restore: prev })
  const rolled = store.insightItems()[0]
  assert.equal(rolled.hitCount, 0)
  assert.equal(rolled.lastHitAt, '2020-01-01T00:00:00.000Z', '+1 后 -1 必须恢复注入前的活跃时间')
  ok('recordHit 负 delta：回滚命中且恢复 lastHitAt')
}

// 4. 旧宿主等长替换兜底常量仍在（行为测试见 inject-visible #9）
{
  const visible = src('inject-visible.js')
  assert.ok(visible.includes('fallbackScans >= 32'), '无 replaceGeneration 时要周期全量重建')
  assert.ok(visible.includes('export function isEntryVisible'), '任务卡要有独立可见性')
  assert.ok(visible.includes('export function takeRollback'), '被宿主丢弃的注入要能回滚额度')
  ok('注入对账：旧宿主兜底、任务卡指纹、回滚账')
}

console.log(`\naudit-2026-11-11 tests: ${passed} passed`)
