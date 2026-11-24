// 任务列表的展示顺序：node test/task-order.test.mjs
//
// 顺序是展示契约：面板、`/tasks`、`list_tasks` 必须用同一份（最近活跃在前），
// 否则同一批任务在三处排序不同，用户会以为数据不一致。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProjectMemoryStore } from '../src/store.js'
import { sortTasksByRecency } from '../src/util/task-view.js'
import { listTasksTool } from '../src/tools/task-tools.js'
import { tasksCommandDefinition } from '../src/commands/tasks.js'

let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }

// ---- 1. 纯函数：最近活跃在前；lastActiveAt → updatedAt → createdAt 兜底；并列按 id ----
{
  const tasks = [
    { id: 'b', lastActiveAt: '2026-01-01T00:00:00.000Z' },
    { id: 'a', lastActiveAt: '2026-03-01T00:00:00.000Z' },
    { id: 'c', updatedAt: '2026-02-01T00:00:00.000Z' },
    { id: 'd' },
    { id: 'e', createdAt: '2026-01-15T00:00:00.000Z' },
    { id: 'a2', lastActiveAt: '2026-03-01T00:00:00.000Z' },
  ]
  const sorted = sortTasksByRecency(tasks)
  assert.deepEqual(sorted.map((t) => t.id), ['a', 'a2', 'c', 'e', 'b', 'd'],
    '最近活跃在前；lastActiveAt 缺失用 updatedAt/createdAt；并列按 id 升序')
  assert.equal(tasks[0].id, 'b', '不改入参顺序')
  assert.deepEqual(sortTasksByRecency(null), [], '非数组按空处理')
  assert.deepEqual(sortTasksByRecency([{ id: 'x', lastActiveAt: 'not-a-date' }]).map((t) => t.id), ['x'],
    '非法时间有兜底，不抛错')
  ok('sortTasksByRecency：最近活跃在前，非法值不崩')
}

// ---- 2. 集成：list_tasks 与 /tasks 输出同一顺序（新的在前） ----
{
  const root = mkdtempSync(path.join(tmpdir(), 'pm-order-'))
  writeFileSync(path.join(root, 'package.json'), '{"name":"demo"}')
  const config = { memoryDir: '.dsh-project-memory', tasklist: { enabled: true, syncHostOnAdopt: false } }
  const store = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
  const task = (id, title, at) => ({
    id, title, projectRoot: root, steps: [{ content: '一步', status: 'pending' }], files: [], fileMeta: {},
    archived: false, createdAt: at, updatedAt: at, lastActiveAt: at,
  })
  store.addTask(task('tsk_old', '旧任务', '2026-01-01T00:00:00.000Z'))
  store.addTask(task('tsk_new', '新任务', '2026-03-01T00:00:00.000Z'))
  store.addTask(task('tsk_mid', '中间任务', '2026-02-01T00:00:00.000Z'))
  store.save()

  const exec = { agent: { id: 's_order', session: { id: 's_order', header: { cwd: root }, append() {} } } }
  const listed = await listTasksTool(config).execute({}, exec)
  assert.ok(listed.indexOf('新任务') < listed.indexOf('中间任务') && listed.indexOf('中间任务') < listed.indexOf('旧任务'),
    'list_tasks 最近活跃在前')

  const snapshot = tasksCommandDefinition(config, {}).handler({
    agent: exec.agent,
    rawInput: '/tasks',
  })
  assert.ok(snapshot.text.indexOf('新任务') < snapshot.text.indexOf('中间任务')
    && snapshot.text.indexOf('中间任务') < snapshot.text.indexOf('旧任务'),
  '/tasks 与 list_tasks 同序')
  ok('list_tasks / /tasks：同一份最近活跃在前的顺序')
}

console.log(`\ntask-order: ${passed} 项通过`)
