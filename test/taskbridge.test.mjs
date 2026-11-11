// TaskBridge 单元测试：node test/taskbridge.test.mjs
// 覆盖：store 任务持久化/容量裁剪、路径归一化、todo/write 自动建任务+绑定+快照覆盖（子代理不建档、标题取清单首条）、tool/call 文件跟踪、工具契约不在此测（需宿主 exec）。
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { ProjectMemoryStore, _estimateResidentBytes as estimate } from '../src/store.js'
import { saveInsight } from '../src/insight-store.js'
import { normalizeRelFile, genTaskId, onSessionEvent, adoptStepsToSession, shouldAdoptToHost, isSubagentSession, flushTaskStore } from '../src/setup/taskbridge.js'
import { taskCommandDefinition } from '../src/commands/task-actions.js'
import { selectTaskTool, archiveTaskTool } from '../src/tools/task-tools.js'

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

// --- 2b. 容量裁剪不得碰"仍被会话绑定"的任务 ---
// 回归：绑定 = 这个任务还没结束，某会话随时会回来接着干。旧实现按 lastActiveAt 一刀切，
// 长期挂着的绑定任务会被更新的任务挤成最旧、被静默归档；会话回来写 todo 时 taskbridge
// 把"归档"按"停止同步"处理 → 另建一条新任务，同一会话的历史被静默拆成两条。
{
  const { root, store } = newProject()
  const now = Date.now()
  const old = new Date(now - 30 * 864e5).toISOString()
  store.addTask({ id: 'tsk_bound_old', title: '长期挂着的活', projectRoot: root, steps: null, files: [], archived: false, createdAt: old, updatedAt: old, lastActiveAt: old })
  for (let i = 0; i < 8; i++) {
    store.addTask({ id: `tsk_new_${i}`, title: `T${i}`, projectRoot: root, steps: null, files: [], archived: false, createdAt: new Date(now + i).toISOString(), updatedAt: new Date(now + i).toISOString(), lastActiveAt: new Date(now + i).toISOString() })
  }
  store.setBinding('sess_old', 'tsk_bound_old')
  store.commit(() => 0) // commit 触发 pruneTasks
  assert.equal(store.getTask('tsk_bound_old').archived, false, '被绑定的最旧任务不得被自动归档')
  assert.equal(store.getTasks().filter((t) => !t.archived).length, 6, '上限 5 + 1 条绑定豁免')
  assert.equal(store.getTasks().filter((t) => t.archived).length, 3, '其余按最旧补齐裁剪')
  ok('容量裁剪：仍被绑定的任务豁免（不静默拆掉会话正在用的任务）')
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
  assert.equal(t1.title, '读现状', '标题反转后优先取清单首条（而非真人消息）')
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
  // 读/写分计数（只采集，不消费）；n 保留为读+写总数
  onSessionEvent(config, session, ev('tool/call', { name: 'write', arguments: JSON.stringify({ file_path: 'src/payment.ts' }) }), meta)
  onSessionEvent(config, session, ev('tool/call', { name: 'read', arguments: JSON.stringify({ file_path: 'src/payment.ts' }) }), meta)
  const fm = store.getTask(taskId).fileMeta['src/payment.ts']
  assert.equal(fm.reads, 2, 'read 计数')
  assert.equal(fm.writes, 1, 'write 计数')
  assert.equal(fm.n, 3, 'n 仍为读+写总数（旧字段兼容）')
  assert.ok(fm.lastWriteAt && fm.lastReadAt)
  ok('tool/call：reads/writes 分计数，n 保留兼容')
  // 未绑定会话读文件 → 无任务不跟踪不报错
  onSessionEvent(config, sess('sessC', root), ev('tool/call', { name: 'read', arguments: JSON.stringify({ file_path: 'a.ts' }) }), meta)
  assert.equal(store.getTasks().length, 1)
  ok('tool/call：绑定后 files 并集；项目外/非文件工具/未绑定均忽略')
}

// --- 5d. apply_patch：目标文件从补丁正文取（Add/Update/Move/Delete） ---
// 0.2.2 的 tool-fs 可挂载 apply_patch：参数只有 input（整段补丁），没有 file_path/path。
// 只按 file_path/path 取路径时，跨文件补丁改过的文件全部漏出任务热点。
{
  const { root, store } = newProject()
  const meta = new Map()
  const session = sess('sessP', root)
  onSessionEvent(config, session, ev('todo/write', { todos: [{ content: '跨文件改动', status: 'in_progress' }] }), meta)
  const taskId = store.getBoundTaskId('sessP')
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/a.ts',
    '@@',
    '-old',
    '+new',
    '*** Move to: src/moved/a.ts',
    '*** Add File: src/b.ts',
    '+export {}',
    '+*** Add File: not-a-header.ts',
    '*** Delete File: docs/old.md',
    '*** Update File: ../outside.ts',
    '*** End Patch',
  ].join('\n')
  onSessionEvent(config, session, ev('tool/call', { name: 'apply_patch', arguments: JSON.stringify({ input: patch }) }), meta)
  const task = store.getTask(taskId)
  assert.deepEqual(task.files.slice().sort(), ['docs/old.md', 'src/a.ts', 'src/b.ts', 'src/moved/a.ts'])
  assert.equal(task.fileMeta['src/b.ts'].writes, 1, '补丁写过的文件记为写')
  // 同一文件同时出现在 Update 与 Move 目标里也只记一次（files 是并集）
  onSessionEvent(config, session, ev('tool/call', { name: 'apply_patch', arguments: JSON.stringify({ input: patch }) }), meta)
  assert.equal(store.getTask(taskId).files.length, 4, '重复补丁不重复登记')
  // 同名工具若用 path/file_path（非 dsh 形状），仍按写记录，不能因为专门分支而丢
  onSessionEvent(config, session, ev('tool/call', { name: 'apply_patch', arguments: JSON.stringify({ path: 'src/legacy.ts' }) }), meta)
  assert.ok(store.getTask(taskId).files.includes('src/legacy.ts'))
  ok('tool/call：apply_patch 记录 Add/Update/Move/Delete 目标，正文假文件头与项目外路径被忽略')
}

// --- 5c. 畸形任务缺 files / fileMeta：load 归一，tool/call 仍能记热点 ---
// 回归：`touchTaskFile()` 直接 `task.files.includes(...)`，手改或旧版 tasks.json 缺集合时
// 每次文件工具调用都抛错（外层 catch 只打日志），该任务的热点追踪永久失效。
{
  const root = mkdtempSync(path.join(tmpdir(), 'tbridge-bad-'))
  const dir = path.join(root, '.dsh-project-memory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify([{ id: 'tsk_bad', title: '坏任务', steps: null, archived: false }]))
  writeFileSync(path.join(dir, 'binding.json'), JSON.stringify({ sB: 'tsk_bad' }))
  const store = new ProjectMemoryStore(dir).load()
  assert.deepEqual(store.getTask('tsk_bad').files, [], 'load 应把缺失的 files 归一成空数组')
  assert.deepEqual(store.getTask('tsk_bad').fileMeta, {}, 'load 应把缺失的 fileMeta 归一成空对象')
  onSessionEvent(config, sess('sB', root), ev('tool/call', { name: 'read', arguments: JSON.stringify({ file_path: 'src/x.ts' }) }), new Map())
  assert.deepEqual(store.getTask('tsk_bad').files, ['src/x.ts'], '归一后热点仍能记录')
  ok('畸形任务缺 files / fileMeta：load 归一，tool/call 不再抛')
}

// --- 5b. 文件热点延迟落盘：回合结束才写 tasks.json ---
{
  const { root, store } = newProject()
  const meta = new Map()
  const session = sess('sessLazy', root)
  onSessionEvent(config, session, ev('todo/write', { todos: [{ content: '改支付', status: 'in_progress' }] }), meta)
  const taskId = store.getBoundTaskId('sessLazy')
  onSessionEvent(config, session, ev('tool/call', { name: 'read', arguments: JSON.stringify({ file_path: 'src/lazy.ts' }) }), meta)
  const tasksFile = path.join(root, '.dsh-project-memory', 'tasks.json')
  const before = JSON.parse(readFileSync(tasksFile, 'utf8'))
  assert.deepEqual(before.find((t) => t.id === taskId).files, [], '工具调用不得逐次写 tasks.json')
  flushTaskStore(root, config)
  const after = JSON.parse(readFileSync(tasksFile, 'utf8'))
  assert.deepEqual(after.find((t) => t.id === taskId).files, ['src/lazy.ts'], '回合结束 flush 后落盘')
  ok('tool/call 延迟落盘：flush 前不写，flush 后写入')
}

// --- 5b2. 相对 file_path 以会话 cwd 为基准（不是项目根） ---
{
  const { root, store } = newProject()
  writeFileSync(path.join(root, 'package.json'), '{}')
  mkdirSync(path.join(root, 'packages', 'foo'), { recursive: true })
  const meta = new Map()
  const session = sess('sessNested', path.join(root, 'packages', 'foo'))
  onSessionEvent(config, session, ev('todo/write', { todos: [{ content: '嵌套 cwd', status: 'pending' }] }), meta)
  const taskId = store.getBoundTaskId('sessNested')
  onSessionEvent(config, session, ev('tool/call', { name: 'read', arguments: JSON.stringify({ file_path: 'src/a.ts' }) }), meta)
  assert.deepEqual(store.getTask(taskId).files, ['packages/foo/src/a.ts'], '相对路径要按会话 cwd 解析')
  onSessionEvent(config, session, ev('tool/call', { name: 'read', arguments: JSON.stringify({ file_path: path.join(root, 'src', 'b.ts') }) }), meta)
  assert.ok(store.getTask(taskId).files.includes('src/b.ts'), '绝对路径仍按项目根归一')
  ok('tool/call：相对 file_path 按会话 cwd 解析，绝对路径按项目根')
}

// --- 5c. 归档/加载清理绑定：binding.json 不再永久指向已归档任务 ---
{
  const { root, store } = newProject()
  const now = new Date().toISOString()
  store.addTask({ id: 'tsk_arch', title: '要归档的', projectRoot: root, steps: null, files: [], archived: false, createdAt: now, updatedAt: now, lastActiveAt: now })
  store.setBinding('s_arch', 'tsk_arch')
  store.save()
  const def = taskCommandDefinition(config, {})
  def.handler({ agent: { id: 's_arch', session: sess('s_arch', root) }, rawInput: 'archive tsk_arch' })
  assert.equal(store.getTask('tsk_arch').archived, true)
  assert.equal(store.getBoundTaskId('s_arch'), undefined, '归档动作要清掉指向它的绑定')
  // 加载时也清理历史遗留的“绑定到已归档任务”：手工造一个旧 store，避免进程内缓存命中。
  const legacyRoot = mkdtempSync(path.join(tmpdir(), 'tbridge-legacy-'))
  const legacyDir = path.join(legacyRoot, '.dsh-project-memory')
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(path.join(legacyDir, 'tasks.json'), JSON.stringify([{ id: 'tsk_old_arch', title: '旧归档', archived: true }]))
  writeFileSync(path.join(legacyDir, 'binding.json'), JSON.stringify({ s_legacy: 'tsk_old_arch' }))
  const reloaded = new ProjectMemoryStore(legacyDir).load()
  assert.equal(reloaded.getBoundTaskId('s_legacy'), undefined, '加载时清理指向归档任务的绑定')
  ok('任务绑定生命周期：归档清绑定 + 加载清理孤儿绑定')
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

// --- 8. 标题优先级反转：清单首条 > 真人消息；清单无文本才回退 ---
{
  const { root, store } = newProject()
  const meta = new Map()
  const session = sess('sessJ', root)
  onSessionEvent(config, session, ev('user/message', { source: { kind: 'user' }, content: '刚刚你卡死了，注意点' }), meta)
  onSessionEvent(config, session, ev('todo/write', { todos: [{ content: '盘点插件 API 依赖面', status: 'in_progress' }] }), meta)
  assert.equal(store.getTasks()[0].title, '盘点插件 API 依赖面')
  ok('标题反转：清单首条优先于首条真人消息')

  const { root: root2, store: store2 } = newProject()
  const meta2 = new Map()
  const s2 = sess('sessK', root2)
  onSessionEvent(config, s2, ev('user/message', { source: { kind: 'user' }, content: '用 todo_write 规划：实现支付重试' }), meta2)
  onSessionEvent(config, s2, ev('todo/write', { todos: [{ status: 'pending' }] }), meta2)
  assert.equal(store2.getTasks()[0].title, '实现支付重试')
  ok('标题兜底：清单首条无文本 → 取真人消息冒号后的任务段')
}

// --- 9. 子代理会话不自动建档（origin / delegationDepth）；普通会话与 fork 不受影响 ---
{
  for (const [label, header] of [
    ['origin:subagent', { origin: 'subagent' }],
    ['delegationDepth=1', { delegationDepth: 1 }],
  ]) {
    const { root, store } = newProject()
    const s = { id: `sub-${label}`, header: { cwd: root, ...header } }
    onSessionEvent(config, s, ev('todo/write', { todos: [{ content: '审计插件 API', status: 'in_progress' }] }), new Map())
    assert.equal(store.getTasks().length, 0, `${label} 不应建档`)
    assert.equal(store.getBoundTaskId(s.id) ?? null, null, `${label} 不应绑定`)
  }
  ok('子代理会话（origin:subagent / delegationDepth>0）不建档、不绑定')

  // parentSession 只是 fork/seed 血缘：顶层 fork 会话仍应建档
  const { root, store } = newProject()
  const forked = { id: 'fork-1', header: { cwd: root, parentSession: 'session-parent' } }
  assert.equal(isSubagentSession(forked), false)
  onSessionEvent(config, forked, ev('todo/write', { todos: [{ content: 'fork 后继续', status: 'pending' }] }), new Map())
  assert.equal(store.getTasks().length, 1)
  assert.ok(store.getBoundTaskId('fork-1'))
  ok('parentSession 的顶层 fork 会话仍正常建档')
}

// --- 10. 直接改 task 内容必须经 markTasksDirty 标脏（0.6.1） ---
// 钉住的是**接线**而非 store 自身：`_auxVersion` 只在 markTasksDirty() 里 bump，而 save() 在
// 没有任何脏标记时会早退 —— 「直接改 task + save()」于是既不落盘、驻留账也停在旧水位。
{
  // a) taskbridge 的写口：覆盖已有任务的 todo/write
  const { root, store } = newProject()
  const meta = new Map()
  const s = sess('sessWire', root)
  onSessionEvent(config, s, ev('user/message', { source: { kind: 'user' }, content: '接线用例' }), meta)
  onSessionEvent(config, s, ev('todo/write', { todos: [{ content: 'a', status: 'pending' }] }), meta)
  const before = estimate(store)
  const stamp0 = store._residentStamp
  onSessionEvent(config, s, ev('todo/write', { todos: [{ content: 'b'.repeat(4000), status: 'pending' }] }), meta)
  const after = estimate(store)
  assert.notEqual(store._residentStamp, stamp0, 'todo/write 覆盖已有任务后版本戳必须变化（否则上界停在旧水位）')
  assert.ok(after > before, '估算应随新增步骤内容增长')
  const diskTodo = JSON.parse(readFileSync(path.join(root, '.dsh-project-memory', 'tasks.json'), 'utf8'))
  assert.equal(diskTodo[0].steps[0].content.length, 4000, '覆盖后的步骤要落盘')
  ok('todo/write 覆盖已有任务：落盘 + 驻留估算失效')

  // b) 命令写口：/tasks rename|archive 只改内存再 save()，必须真的写进 tasks.json
  const cmd = newProject()
  cmd.store.addTask({ id: 'tsk_wire_cmd', title: '旧名', steps: [], files: [], archived: false, projectRoot: cmd.root, createdAt: 'x', updatedAt: 'x', lastActiveAt: 'x' })
  cmd.store.save()
  const def = taskCommandDefinition(config, {})
  const invocation = (rawInput) => ({ agent: { id: 'sessCmd', session: { header: { cwd: cmd.root }, append() {} } }, rawInput })
  def.handler(invocation('rename tsk_wire_cmd "新名"'))
  const diskRename = JSON.parse(readFileSync(path.join(cmd.root, '.dsh-project-memory', 'tasks.json'), 'utf8'))
  assert.equal(diskRename[0].title, '新名')
  def.handler(invocation('archive tsk_wire_cmd'))
  const diskArchive = JSON.parse(readFileSync(path.join(cmd.root, '.dsh-project-memory', 'tasks.json'), 'utf8'))
  assert.equal(diskArchive[0].archived, true)
  ok('/tasks rename|archive 落盘（内存改了，tasks.json 也要改）')

  // c) 工具写口：select_task 改名/解归档、archive_task 归档
  const tool = newProject()
  tool.store.addTask({ id: 'tsk_wire_tool', title: '旧名', steps: [], files: [], archived: true, projectRoot: tool.root, createdAt: 'x', updatedAt: 'x', lastActiveAt: 'x' })
  tool.store.save()
  const exec = { agent: { session: { id: 'sessTool', header: { cwd: tool.root }, append() {} } } }
  await selectTaskTool(config, {}).execute({ taskId: 'tsk_wire_tool', title: '新名' }, exec)
  const diskSelect = JSON.parse(readFileSync(path.join(tool.root, '.dsh-project-memory', 'tasks.json'), 'utf8'))
  assert.equal(diskSelect[0].title, '新名')
  assert.equal(diskSelect[0].archived, false)
  await archiveTaskTool(config, {}).execute({ taskId: 'tsk_wire_tool' }, exec)
  const diskTool = JSON.parse(readFileSync(path.join(tool.root, '.dsh-project-memory', 'tasks.json'), 'utf8'))
  assert.equal(diskTool[0].archived, true)
  ok('select_task / archive_task 落盘')
}

// --- 12. 已归档任务不能写入 task 级记忆（写进去也永远召回不到） ---
{
  const { root, store } = newProject()
  const now = new Date().toISOString()
  store.addTask({ id: 'tsk_archived', title: '已归档', projectRoot: root, steps: null, files: [], archived: true, insights: [], createdAt: now, updatedAt: now, lastActiveAt: now })
  store.save()
  const res = saveInsight({ store, raw: { kind: 'lesson', title: '不该写进去' }, scope: 'task', taskId: 'tsk_archived' })
  assert.equal(res.ok, false)
  assert.match(res.error, /已归档/)
  ok('已归档任务拒绝 task 级写入（不再假报 Saved）')
}

// --- 13. 已删除的会话根不得被 todo/write 重新创建 ---
{
  const { root } = newProject()
  rmSync(root, { recursive: true, force: true })
  onSessionEvent(
    config,
    sess('sess-deleted', root),
    ev('todo/write', { todos: [{ content: '写点什么', status: 'in_progress' }] }),
    new Map(),
  )
  assert.equal(existsSync(root), false, '根已删除：不能靠 save() 的 mkdir 把它重新造出来')
  ok('已删除的会话根：todo/write 不重建目录、不写盘')
}

console.log(`\nTaskBridge tests: ${passed} passed`)
