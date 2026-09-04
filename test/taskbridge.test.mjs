// TaskBridge 单元测试：node test/taskbridge.test.mjs
// 覆盖：store 任务持久化/容量裁剪、路径归一化、todo/write 自动建任务+绑定+快照覆盖、tool/call 文件跟踪、工具契约不在此测（需宿主 exec）。
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { ProjectMemoryStore } from '../src/store.js'
import { normalizeRelFile, genTaskId, onSessionEvent, adoptStepsToSession, shouldAdoptToHost } from '../src/setup/taskbridge.js'

const config = { memoryDir: '.dsh-project-memory', tasklist: { enabled: true } }
const configNoAdopt = { memoryDir: '.dsh-project-memory', tasklist: { enabled: true, syncHostOnAdopt: false } }
let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }

function newProject() {
  const root = mkdtempSync(path.join(tmpdir(), 'tbridge-'))
  const store = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
  return { root, store }
}

const sess = (id, cwd) => ({ id, header: { cwd } })
const ev = (type, data) => ({ type, data })

// --- 1. store: load/save/tasks CRUD ---
{
  const { root, store } = newProject()
  const t0 = { id: genTaskId(root, '支付重试'), title: '支付重试', projectRoot: root, steps: null, files: [], archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() }
  store.addTask(t0)
  store.setBinding('s1', t0.id)
  store.save()
  const store2 = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
  assert.equal(store2.getTasks().length, 1)
  assert.equal(store2.getBoundTaskId('s1'), t0.id)
  ok('tasks + binding 持久化往返')
}

// --- 2. 容量裁剪：fileCount=0 → 上限 5，6 个任务超限归档最旧 ---
{
  const { root, store } = newProject()
  for (let i = 0; i < 6; i++) {
    store.addTask({ id: `tsk_x_${i}`, title: `T${i}`, projectRoot: root, steps: null, files: [], archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastActiveAt: new Date(Date.now() + i).toISOString() })
  }
  store.commit(() => 0)
  assert.equal(store.getTasks().filter((t) => t.archived).length, 1)
  assert.equal(store.getTasks().filter((t) => !t.archived).length, 5)
  assert.equal(store.getTasks()[0].archived, true) // 最旧被归档
  ok('容量裁剪：超限归档最旧（fileCount=0 → max 5）')
}

// --- 3. normalizeRelFile ---
{
  const root = '/proj'
  assert.equal(normalizeRelFile(root, '/proj/src/a.ts'), 'src/a.ts')
  assert.equal(normalizeRelFile(root, 'src/a.ts'), 'src/a.ts')
  assert.equal(normalizeRelFile(root, '/etc/passwd'), null) // 项目外
  assert.equal(normalizeRelFile(root, '../x.ts'), null)
  ok('路径归一化：绝对/相对 → 项目相对；项目外拒绝')
}

// --- 4. onSessionEvent：user/message → todo/write 自动建任务+绑定+快照覆盖 ---
{
  const { root, store } = newProject()
  const meta = new Map()
  const session = sess('sessA', root)
  onSessionEvent(config, session, ev('user/message', { source: { kind: 'user' }, content: '实现支付重试指数退避，继续上次的活' }), meta)
  onSessionEvent(config, session, ev('todo/write', { todos: [{ content: '读现状', status: 'in_progress' }, { content: '实现退避', status: 'pending' }] }), meta)
  let tasks = store.getTasks()
  assert.equal(tasks.length, 1)
  const t1 = tasks[0]
  assert.equal(t1.archived, false)
  assert.equal(store.getBoundTaskId('sessA'), t1.id)
  assert.equal(t1.steps.length, 2)
  assert.ok(t1.title.includes('支付重试'), `title 取自首条真人消息: ${t1.title}`)
  // 第二次 todo/write → 同一任务快照覆盖
  onSessionEvent(config, session, ev('todo/write', { todos: [{ content: '读现状', status: 'completed' }, { content: '实现退避', status: 'in_progress' }] }), meta)
  tasks = store.getTasks()
  assert.equal(tasks.length, 1, '不重复建任务')
  assert.equal(tasks[0].steps[1].status, 'in_progress')
  ok('todo/write：未绑定自动新建并绑定；再次写入快照覆盖不重复建')
}

// --- 5. tool/call 文件跟踪（绑定后） + 未绑定不跟踪 ---
{
  const { root, store } = newProject()
  const meta = new Map()
  const session = sess('sessB', root)
  onSessionEvent(config, session, ev('todo/write', { todos: [{ content: '改支付', status: 'in_progress' }] }), meta)
  const taskId = store.getBoundTaskId('sessB')
  onSessionEvent(config, session, ev('tool/call', { name: 'read', arguments: JSON.stringify({ file_path: 'src/payment.ts' }) }), meta)
  onSessionEvent(config, session, ev('tool/call', { name: 'read', arguments: JSON.stringify({ file_path: '/etc/passwd' }) }), meta) // 项目外忽略
  onSessionEvent(config, session, ev('tool/call', { name: 'grep', arguments: JSON.stringify({ pattern: 'x' }) }), meta) // 非文件工具忽略
  const files = store.getTask(taskId).files
  assert.deepEqual(files, ['src/payment.ts'])
  // 未绑定会话读文件 → 无任务不跟踪不报错
  onSessionEvent(config, sess('sessC', root), ev('tool/call', { name: 'read', arguments: JSON.stringify({ file_path: 'a.ts' }) }), meta)
  assert.equal(store.getTasks().length, 1)
  ok('tool/call：绑定后 files 并集；项目外/非文件工具/未绑定均忽略')
}

// --- 6. 反向接管 adoptStepsToSession：有步骤→推宿主 todo/write；无步骤/关开关→不推 ---
{
  const calls = []
  const session = { id: 'sessD', header: { cwd: '/tmp' }, append: (type, data) => calls.push([type, data]) }
  const task = {
    id: 'tsk_1', title: 'T',
    steps: [
      { content: '读现状', status: 'in_progress' },
      { content: '实现退避', status: 'pending' },
      { content: '收敛验证', status: 'completed' },
    ],
  }
  assert.equal(adoptStepsToSession(session, task), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'todo/write')
  assert.deepEqual(calls[0][1].todos, [
    { content: '读现状', status: 'in_progress' },
    { content: '实现退避', status: 'pending' },
    { content: '收敛验证', status: 'completed' },
  ])
  ok('adopt：有步骤 → append 一次 todo/write（内容/状态透传）')

  const calls2 = []
  const session2 = { id: 'sessE', header: { cwd: '/tmp' }, append: (type, data) => calls2.push([type, data]) }
  assert.equal(adoptStepsToSession(session2, { id: 'tsk_2', steps: null }), false)
  assert.equal(calls2.length, 0)
  ok('adopt：任务无步骤 → 不推送（不清空宿主清单）')

  assert.equal(adoptStepsToSession({ id: 'sessF', header: { cwd: '/tmp' } }, task), false)
  assert.equal(shouldAdoptToHost(config), true)
  assert.equal(shouldAdoptToHost(configNoAdopt), false)
  assert.equal(shouldAdoptToHost({}), true)
  ok('adopt：缺 append 句柄 → 安全跳过；开关默认开、可关')

  // 字符串形态步骤归一化
  const calls3 = []
  const session3 = { id: 'sessG', header: { cwd: '/tmp' }, append: (type, data) => calls3.push([type, data]) }
  adoptStepsToSession(session3, { id: 'tsk_3', steps: ['只写文案'] })
  assert.deepEqual(calls3[0][1].todos, [{ content: '只写文案', status: 'pending' }])
  ok('adopt：字符串步骤归一化为 pending TodoItem')
}

// --- 7. 空 todo/write = 清空：未绑定不建档；绑定则清空 steps ---
{
  const { root, store } = newProject()
  const meta = new Map()
  onSessionEvent(config, sess('sessH', root), ev('todo/write', { todos: [] }), meta)
  assert.equal(store.getTasks().length, 0)
  ok('空 todo/write 且未绑定 → 不自动建档（unbind 清清单不会产生垃圾任务）')

  const s2 = sess('sessI', root)
  onSessionEvent(config, s2, ev('todo/write', { todos: [{ content: '做一步', status: 'pending' }, { content: '再做一步', status: 'pending' }] }), meta)
  const tid = store.getBoundTaskId('sessI')
  assert.ok(tid)
  onSessionEvent(config, s2, ev('todo/write', { todos: [] }), meta)
  assert.equal(store.getTask(tid).steps.length, 0)
  ok('绑定会话收到空 todo/write → steps 清空、任务保留')
}

console.log(`\nTaskBridge tests: ${passed} passed`)
