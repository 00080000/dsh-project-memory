// 2026-11-02 仓库审计的回归：每条都对应一个“修前会失败”的行为契约。
// node test/audit-2026-11-02.test.mjs
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ProjectMemoryStore } from '../src/store.js'
import { GlobalStore, cfgInsight } from '../src/insight-store.js'
import { lessonTool } from '../src/tools/lesson-tools.js'
import { archiveTaskTool } from '../src/tools/task-tools.js'
import { watchRepoTool } from '../src/tools/watch-repo.js'
import { WatchManager } from '../src/watch.js'
import { indexObservedBatch } from '../src/lazy.js'
import { normalizeCitationFiles, memoryRootFor } from '../src/util/fs.js'
import { buildInjection, cfgEngine, installAutoInject } from '../src/auto-inject.js'
import { visibleInsights } from '../src/recall.js'
import { renderTaskSnapshot } from '../src/commands/tasks.js'
import { actInsight } from '../src/commands/insight-actions.js'
import { classifyToolCall } from '../src/ops.js'
import { onSessionEvent } from '../src/setup/taskbridge.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}
const dir = (p = 'audit-') => mkdtempSync(path.join(tmpdir(), p))
const storeAt = (root) => new ProjectMemoryStore(memoryRootFor(root, '.dsh-project-memory')).load()
const configFor = (root, extra = {}) => ({
  memoryDir: '.dsh-project-memory',
  maxOutputChars: 8000,
  maxFileSizeMb: 50,
  insight: { globalFile: path.join(root, 'global.json') },
  ...extra,
})

// 1. save_lesson 带 id 只改传了的字段：kind 不能被默认值覆盖
{
  const root = dir()
  const cfg = configFor(root)
  const s = storeAt(root)
  const now = new Date().toISOString()
  s.replaceInsightItems([{
    id: 'ins_decision', kind: 'decision', scope: 'project', title: '选 B',
    choice: 'B', reason: '旧理由', createdAt: now, updatedAt: now,
  }])
  s.commit(() => 0)

  const out = await lessonTool(cfg).execute({ id: 'ins_decision', reason: '新理由', root }, {})
  assert.match(out, /action=updated/)
  const saved = storeAt(root).insightItems().find((it) => it.id === 'ins_decision')
  assert.equal(saved.kind, 'decision', '不传 kind 时不能把 decision 改成 lesson')
  assert.equal(saved.reason, '新理由')
  assert.equal(saved.prev.kind, undefined, 'kind 没被改，就不该出现在 prev 里')
  ok('save_lesson 带 id 更新不覆盖未传的 kind')
}

// 2. 超限文件：watch 与 lazy 都必须摘掉旧条目，而不是只跳过
{
  const root = dir()
  const file = path.join(root, 'a.md')
  writeFileSync(file, '# T\n\nsmall\n')
  const cfg = { ...configFor(root), maxFileSizeMb: 0.001, maxScanFiles: 100, maxScanDepth: 5 }
  const wm = new WatchManager({}, cfg)
  wm.addRoot(root)
  await wm.pollRoot(root, wm.roots.get(root))
  assert.ok(storeAt(root).entries['a.md']?.length, '先建立一条旧条目')
  appendFileSync(file, 'x'.repeat(5000))
  await new Promise((resolve) => setTimeout(resolve, 10))
  await wm.pollRoot(root, wm.roots.get(root))
  assert.equal(storeAt(root).entries['a.md'], undefined, 'watch 必须移除超限文件的旧条目')
  wm.stop()
  ok('watch：文件涨过 maxFileSizeMb 后移除旧条目')

  const root2 = dir()
  writeFileSync(path.join(root2, 'package.json'), '{}')
  const file2 = path.join(root2, 'a.md')
  writeFileSync(file2, '# T\n\nsmall\n')
  const cfg2 = { ...configFor(root2), maxFileSizeMb: 0.001 }
  await indexObservedBatch(cfg2, [{ filePath: file2, sessionRoot: root2 }])
  assert.ok(storeAt(root2).entries['a.md']?.length, '先建立一条旧条目')
  appendFileSync(file2, 'x'.repeat(5000))
  await new Promise((resolve) => setTimeout(resolve, 10))
  await indexObservedBatch(cfg2, [{ filePath: file2, sessionRoot: root2 }])
  assert.equal(storeAt(root2).entries['a.md'], undefined, 'lazy 必须移除超限文件的旧条目')
  ok('lazy：文件涨过 maxFileSizeMb 后移除旧条目')
}

// 3. archive_task 清绑定；归档任务不再进入注入/任务级召回
{
  const root = dir()
  writeFileSync(path.join(root, 'package.json'), '{}')
  const cfg = configFor(root)
  const s = storeAt(root)
  const task = {
    id: 'tsk_1', title: '归档我', steps: [], files: [], archived: false,
    insights: [{ id: 'ins_task', kind: 'lesson', scope: 'task', title: '任务私有教训', fix: 'x' }],
  }
  s.addTask(task)
  s.setBinding('s1', task.id)
  s.save()

  await archiveTaskTool(cfg, {}).execute({ taskId: task.id, root }, {})
  const after = storeAt(root)
  assert.equal(after.getTask(task.id).archived, true)
  assert.equal(after.getBoundTaskId('s1'), undefined, '归档必须清掉所有绑定')
  const injected = buildInjection({
    query: '', task: after.getTask(task.id), store: after,
    globalStore: { items: () => [] }, cfg: cfgEngine(cfg),
  })
  assert.ok(!injected.text.includes('归档我'), '归档任务不能回声任务卡')
  assert.ok(!visibleInsights({ store: after, globalStore: { items: () => [] }, boundTaskId: task.id })
    .some((it) => it.id === 'ins_task'), '归档任务的任务级记忆不能继续被召回')
  ok('archive_task：解绑 + 归档任务不再注入/召回')
}

// 4. maxTokens: 0 连 root notice 也不能发
{
  const root = dir()
  const handlers = {}
  const ctx = {
    on: (event, fn) => { handlers[event] = fn },
    effect: (fn) => { fn(); return () => {} },
  }
  installAutoInject(ctx, {
    memoryDir: '.dsh-project-memory',
    autoContext: { maxTokens: 0 },
    insight: { globalFile: path.join(root, 'global.json') },
  })
  const session = { id: 's1', header: { cwd: root } }
  const decision = {
    kind: 'enter',
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }],
  }
  const out = await handlers['agent/pre-step']({ agent: { session }, messages: decision.messages }, () => decision)
  assert.equal(out.messages.length, 1, 'maxTokens: 0 时不能追加任何消息（包括 root notice）')
  ok('maxTokens: 0 真正零注入（含 root notice）')
}

// 5. watch_repo({watch:false}) 不创建已不存在的根
{
  const base = dir()
  const missing = path.join(base, 'gone')
  const wm = { removeRoot: () => false, addRoot: () => false, start: () => {} }
  const out = await watchRepoTool(wm, configFor(base)).execute(
    { root: missing, watch: false },
    { agent: { session: { id: 's1', header: { cwd: missing } } } },
  )
  assert.match(out, /Stopped watching/)
  assert.equal(existsSync(missing), false, '停止监视不能把已删除的根重新 mkdir 出来')
  ok('watch_repo stop 不重建已删除的根')
}

// 6. watch 轮询发现根消失时不得通过 save() 重建
{
  const root = dir()
  writeFileSync(path.join(root, 'package.json'), '{}')
  const wm = new WatchManager({}, configFor(root))
  wm.addRoot(root)
  await wm.pollRoot(root, wm.roots.get(root))
  rmSync(root, { recursive: true, force: true })
  await wm.pollRoot(root, wm.roots.get(root))
  assert.equal(existsSync(root), false, '消失的根不能被 poll → save 重建')
  wm.stop()
  ok('watch poll 不重建已删除的根')
}

// 7. 宿主的 str_replace_editor 必须产 file-write / 写目标
{
  const write = classifyToolCall('str_replace_editor', JSON.stringify({
    command: 'str_replace', path: '/repo/src/a.ts', old_str: 'a', new_str: 'b',
  }))
  assert.deepEqual(write.ops, ['file-write'])
  assert.ok(write.targets.includes('/repo/src/a.ts'))
  const view = classifyToolCall('str_replace_editor', JSON.stringify({ command: 'view', path: '/repo/src/a.ts' }))
  assert.deepEqual(view.ops, [], 'view 是读，不是 file-write')
  ok('str_replace_editor：写命令产 file-write，view 不产')
}

// 8. TaskBridge 用 str_replace_editor 的 path 记录热点文件
{
  const root = dir()
  writeFileSync(path.join(root, 'package.json'), '{}')
  const cfg = configFor(root)
  const s = storeAt(root)
  const task = { id: 'tsk_1', title: 'T', steps: [], files: [], fileMeta: {}, archived: false }
  s.addTask(task)
  s.setBinding('s1', task.id)
  s.save()
  const session = { id: 's1', header: { cwd: root } }
  onSessionEvent(cfg, session, {
    type: 'tool/call',
    data: { name: 'str_replace_editor', arguments: JSON.stringify({ command: 'str_replace', path: 'src/a.ts' }) },
  }, new Map(), undefined)
  const saved = storeAt(root).getTask(task.id)
  assert.ok(saved.files.includes('src/a.ts'), 'str_replace_editor 的写入必须进任务热点文件')
  assert.equal(saved.fileMeta['src/a.ts'].writes, 1)
  ok('TaskBridge：str_replace_editor 写路径进入 files/fileMeta')
}

// 9. 手工 promote 保留使用痕迹并收口 global 容量
{
  const root = dir()
  const s = storeAt(root)
  const gs = new GlobalStore(path.join(root, 'global.json')).load()
  const now = new Date().toISOString()
  s.replaceInsightItems([{
    id: 'ins_move', kind: 'decision', scope: 'project', title: '带痕迹', choice: 'A',
    triggerDerived: { keywords: ['k'], actions: [], paths: [] },
    prev: { reason: 'old' }, lastHitAt: '2026-01-01T00:00:00.000Z', hitCount: 3,
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: now,
  }])
  const cfg = cfgInsight({ insight: { maxGlobalProcedures: 1 } })
  actInsight({ store: s, gs, action: 'promote', scope: 'project', id: 'ins_move', cfg })
  const moved = gs.items().find((it) => it.id === 'ins_move')
  assert.ok(moved, '手工提升到 global')
  assert.deepEqual(moved.triggerDerived, { keywords: ['k'], actions: [], paths: [] })
  assert.deepEqual(moved.prev, { reason: 'old' })
  assert.equal(moved.lastHitAt, '2026-01-01T00:00:00.000Z')
  assert.ok(gs.items().length <= 1, '手工提升也要遵守 maxGlobalProcedures')
  ok('手工 promote：保留 triggerDerived/prev/lastHitAt + 容量收口')
}

// 10. 空任务列表的 /tasks payload 仍然带 root（跨标签页作用域）
{
  const root = dir()
  const out = renderTaskSnapshot(configFor(root), root, 's1')
  const payload = JSON.parse(out.text.match(/```json\n([\s\S]*?)\n```/)[1])
  assert.equal(payload.root, root)
  assert.deepEqual(payload.tasks, [])
  ok('空任务列表 payload 仍带 root')
}

// 11. 空 memoryDir 归一为默认目录，不能把 .gitignore/* 写到项目根
{
  const root = dir()
  assert.equal(memoryRootFor(root, ''), path.join(root, '.dsh-project-memory'))
  assert.equal(memoryRootFor(root, '   '), path.join(root, '.dsh-project-memory'))
  const s = new ProjectMemoryStore(memoryRootFor(root, '')).load()
  s.markFile('a.md', { sha256: 'x', size: 1, type: 'doc', indexedAt: new Date().toISOString() })
  s.save()
  assert.equal(existsSync(path.join(root, '.gitignore')), false, '项目根 .gitignore 不能被写成 *')
  const selfIgnore = path.join(root, '.dsh-project-memory', '.gitignore')
  assert.ok(existsSync(selfIgnore))
  assert.match(readFileSync(selfIgnore, 'utf8'), /^\*$/m, 'store 的隐私自我忽略（*）必须保留')
  ok('memoryDir 为空/空白时回落到默认 store 目录')
}

// 12. POSIX 上 Windows 盘符路径不能落成项目内相对引用
{
  const root = dir()
  const out = normalizeCitationFiles(['C:\\proj\\a.ts', 'src/a.ts'], root)
  assert.deepEqual(out.files, ['src/a.ts'])
  assert.deepEqual(out.dropped, ['C:\\proj\\a.ts'])
  ok('normalizeCitationFiles：POSIX 上丢弃 Windows 盘符绝对路径')
}

console.log(`\naudit-2026-11-02 tests: ${passed} passed`)
