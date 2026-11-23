// 团队任务作记忆作用域：node test/team-task.test.mjs
//
// 背景（ROADMAP §4.15）：任务级记忆挂在 tasks.json 某条任务的 insights[] 上，只有"会话绑定"
// 才看得见；绑定原本只认本地 tsk_ 任务。团队模式下 lead 与队友是两个会话，唯一公共的任务身份
// 是宿主的团队任务板（task-<n>）。这里钉住四件事：
//   1. select_task 接受 task-<n> → 映射成同一条本地记忆记录（team:task-2）并绑定本会话；
//   2. lead 写的 scope=task 经验，队友绑定同一 id 后 recall 能读到；记录落盘带 teamTaskId；
//   3. 团队锚点不推宿主 todo（队友自己的清单不该被空锚点清掉）；
//   4. 软依赖：没有 agentTeams 服务 / 别的团队 / 软删任务 / 改名 → 行为与错误文案可判定。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProjectMemoryStore } from '../src/store.js'
import { saveInsight } from '../src/insight-store.js'
import { recallItems } from '../src/recall.js'
import { listTasksTool, selectTaskTool } from '../src/tools/task-tools.js'
import { tasksCommandDefinition } from '../src/commands/tasks.js'
import { onSessionEvent } from '../src/setup/taskbridge.js'
import { isTeamTaskId, teamMemoryTaskId } from '../src/setup/team-task.js'

const config = { memoryDir: '.dsh-project-memory', tasklist: { enabled: true } }
let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }

/** 新建项目根（带 package.json 标记），返回落盘路径。 */
function newProject() {
  const root = mkdtempSync(path.join(tmpdir(), 'pm-team-'))
  writeFileSync(path.join(root, 'package.json'), '{"name":"demo"}')
  const dir = path.join(root, '.dsh-project-memory')
  return { root, dir, tasksFile: path.join(dir, 'tasks.json') }
}

/** 假 agentTeams 服务：同一棵树的 lead/队友读同一块板；未知 id 按宿主契约抛 TEAM_TASK_NOT_FOUND。 */
function teamService(views, { fail } = {}) {
  return {
    getTask(_caller, id) {
      if (fail) throw fail
      const view = views[id]
      if (!view) {
        const err = new Error(`team task "${id}" not found`)
        err.code = 'TEAM_TASK_NOT_FOUND'
        throw err
      }
      return view
    },
  }
}

function teamView(id, subject, extra = {}) {
  return {
    id, revision: 1, subject, description: '', status: 'in_progress',
    blockedBy: [], writeScopes: [], ownerId: 's_mate', ownerName: 'mate',
    ready: true, writeScopeWarnings: [], ...extra,
  }
}

/** 工具执行上下文：agent 是调用者（getTask 的 caller），ctx 只提供 agentTeams。 */
function makeExec(root, id, team) {
  const appended = []
  const agent = {
    id,
    session: { id, header: { cwd: root }, append: (...args) => appended.push(args) },
  }
  if (team) agent.ctx = { get: (name) => (name === 'agentTeams' ? team : undefined) }
  return { exec: { agent }, appended }
}

const loadStore = (dir) => new ProjectMemoryStore(dir).load()
const readTasks = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [])

// ---- 1. id 形状与映射 ----
{
  assert.equal(isTeamTaskId('task-2'), true)
  assert.equal(isTeamTaskId('task-0'), true)
  assert.equal(isTeamTaskId('task-abc'), false, '只认数字后缀')
  assert.equal(isTeamTaskId('tsk_x'), false, '本地任务不是团队任务')
  assert.equal(isTeamTaskId('task-2-1'), false)
  assert.equal(isTeamTaskId(42), false)
  assert.equal(teamMemoryTaskId('task-2'), 'team:task-2')
  ok('团队任务 id 形状与本地记忆键映射')
}

// ---- 2. lead 绑定 task-2：映射成本地记录 + 绑定 + 落盘 + 不推宿主清单 ----
{
  const { root, dir, tasksFile } = newProject()
  const views = { 'task-2': teamView('task-2', '迁移鉴权') }
  const lead = makeExec(root, 's_lead', teamService(views))
  const card = JSON.parse(await selectTaskTool(config, {}).execute({ taskId: 'task-2' }, lead.exec))

  assert.equal(card.taskId, 'team:task-2')
  assert.equal(card.team.id, 'task-2')
  assert.equal(card.team.status, 'in_progress')
  assert.deepEqual(card.team.writeScopes, [])
  assert.equal(card.title, '迁移鉴权', '标题取团队任务 subject')
  assert.match(card.hint, /团队任务/)

  const store = loadStore(dir)
  const rec = store.getTask('team:task-2')
  assert.ok(rec, '团队任务映射成本地记忆任务记录')
  assert.equal(rec.teamTaskId, 'task-2', '记录带 teamTaskId，供再次绑定复用')
  assert.equal(store.getBoundTaskId('s_lead'), 'team:task-2')

  const disk = readTasks(tasksFile)
  assert.equal(disk.length, 1)
  assert.equal(disk[0].teamTaskId, 'task-2', 'teamTaskId 必须落进 tasks.json（自定义字段不丢）')
  assert.equal(disk[0].id, 'team:task-2')

  assert.equal(lead.appended.filter((a) => a[0] === 'todo/write').length, 0,
    '团队锚点只做记忆作用域：不把空清单推成宿主 todo（否则会清掉队友自己的清单）')
  ok('lead 绑定 task-2：本地记录 + 绑定 + 落盘，且不动宿主 todo')
}

// ---- 3. lead 写 scope=task → 队友绑定同一 id 后 recall 能读到 ----
{
  const { root, dir } = newProject()
  const views = { 'task-2': teamView('task-2', '迁移鉴权') }
  const team = teamService(views)
  const lead = makeExec(root, 's_lead', team)
  const tool = selectTaskTool(config, {})
  await tool.execute({ taskId: 'task-2' }, lead.exec)

  const store = loadStore(dir)
  const saved = saveInsight({
    store,
    raw: { kind: 'lesson', title: 'JWT 迁移先双写', fix: '先双写再切读，回滚只切 flag' },
    scope: 'task',
    taskId: 'team:task-2',
  })
  assert.equal(saved.ok, true)
  store.save()

  const mate = makeExec(root, 's_mate', team)
  const card = JSON.parse(await tool.execute({ taskId: 'task-2' }, mate.exec))
  assert.equal(card.taskId, 'team:task-2', '队友绑定到同一条记忆记录')
  assert.ok(card.insights.some((i) => i.title === 'JWT 迁移先双写'), '任务卡带回共享的任务级经验')

  const store2 = loadStore(dir)
  assert.equal(store2.getBoundTaskId('s_mate'), 'team:task-2')
  const { flat } = recallItems({
    store: store2,
    queries: ['JWT 双写 回滚'],
    boundTaskId: store2.getBoundTaskId('s_mate'),
    layers: ['insight'],
  })
  assert.ok(flat.some((hit) => hit.item.title === 'JWT 迁移先双写'),
    '队友按绑定任务 recall 能看到 lead 写的任务级经验（不需要 promote 到 project）')
  ok('lead 写任务级经验 → 队友 claim 后绑定同一任务即可召回')
}

// ---- 4. 幂等：再次 select 复用记录、不重建；改名不被 subject 覆盖 ----
{
  const { root, dir } = newProject()
  const views = { 'task-2': teamView('task-2', '迁移鉴权') }
  const lead = makeExec(root, 's_lead', teamService(views))
  const tool = selectTaskTool(config, {})
  await tool.execute({ taskId: 'task-2' }, lead.exec)
  await tool.execute({ taskId: 'task-2', title: '鉴权迁移（人工名）' }, lead.exec)
  const card = JSON.parse(await tool.execute({ taskId: 'task-2' }, lead.exec))

  assert.equal(card.title, '鉴权迁移（人工名）', '再次 select 不把标题覆写回 host subject')
  assert.match(card.hint, /沿用已有任务记忆/, '复用时说明沿用了已有记忆')
  const store = loadStore(dir)
  assert.equal(store.getTasks().filter((t) => t.teamTaskId === 'task-2').length, 1, '同一个团队任务只有一条记录')

  // 本地归档过的锚点再 select 要解归档（与本地任务同一语义）
  store.updateTask('team:task-2', { archived: true })
  store.save()
  const restored = JSON.parse(await tool.execute({ taskId: 'task-2' }, lead.exec))
  assert.equal(restored.taskId, 'team:task-2')
  assert.equal(loadStore(dir).getTask('team:task-2').archived, false)
  ok('幂等复用 + 人工改名保留 + 解归档')
}

// ---- 5. 软依赖：没有团队服务 → 与"找不到任务"一致，且不建记录 ----
{
  const { root, dir } = newProject()
  const plain = makeExec(root, 's_plain')
  const res = JSON.parse(await selectTaskTool(config, {}).execute({ taskId: 'task-2' }, plain.exec))
  assert.equal(res.success, false)
  assert.match(res.error, /Task not found: task-2/)
  assert.match(res.error, /团队服务/)
  assert.equal(loadStore(dir).getTasks().length, 0, '无团队服务时不留下空锚点')
  ok('无 agentTeams 服务：按找不到处理，不建记录')
}

// ---- 6. 别的团队 / 软删任务 / 服务异常 的错误可判定 ----
{
  const { root, dir } = newProject()
  const tool = selectTaskTool(config, {})
  const noSuch = makeExec(root, 's_x', teamService({}))
  const missing = JSON.parse(await tool.execute({ taskId: 'task-9' }, noSuch.exec))
  assert.match(missing.error, /不存在或不属于本团队/)

  const deleted = makeExec(root, 's_y', teamService({ 'task-3': teamView('task-3', '已删除', { status: 'deleted' }) }))
  const gone = JSON.parse(await tool.execute({ taskId: 'task-3' }, deleted.exec))
  assert.match(gone.error, /不存在或不属于本团队/)

  const broken = makeExec(root, 's_z', teamService({}, { fail: new Error('journal unavailable') }))
  const failed = JSON.parse(await tool.execute({ taskId: 'task-2' }, broken.exec))
  assert.match(failed.error, /读取团队任务失败: journal unavailable/)

  assert.equal(loadStore(dir).getTasks().length, 0)
  ok('未知 / 软删 / 服务异常：错误文案可判定，且不建记录')
}

// ---- 7. writeScopes / warnings 带进任务卡；宿主快照变化同步到锚点（完成不归档、删除才归档解绑） ----
{
  const { root, dir } = newProject()
  const views = {
    'task-4': teamView('task-4', '鉴权中间件', {
      writeScopes: ['src/auth/'],
      writeScopeWarnings: ['overlaps task-1: src/auth/'],
    }),
  }
  const lead = makeExec(root, 's_lead', teamService(views))
  const tool = selectTaskTool(config, {})
  const card = JSON.parse(await tool.execute({ taskId: 'task-4' }, lead.exec))
  assert.deepEqual(card.team.writeScopes, ['src/auth/'], 'advisory 写作用域随卡片带给模型')
  assert.deepEqual(card.team.warnings, ['overlaps task-1: src/auth/'], '宿主算好的作用域冲突告警一并带上')
  assert.equal(loadStore(dir).getTask('team:task-4').teamWriteScopes[0], 'src/auth/', '写作用域落盘，后续 list_tasks 也能看到')

  const session = { id: 's_lead', header: { cwd: root } }
  const meta = new Map()
  onSessionEvent(config, session, {
    type: 'team/task',
    data: { version: 2, teamId: 'team-x', task: { ...views['task-4'], revision: 2, status: 'completed' } },
  }, meta)
  const done = loadStore(dir).getTask('team:task-4')
  assert.equal(done.teamTaskStatus, 'completed', '宿主快照同步任务状态')
  assert.equal(done.archived, false, '完成不等于归档：任务做完，任务级记忆仍然有用')
  assert.equal(loadStore(dir).getBoundTaskId('s_lead'), 'team:task-4', '完成不解绑')

  onSessionEvent(config, session, {
    type: 'team/task',
    data: { version: 2, teamId: 'team-x', task: { ...views['task-4'], revision: 3, status: 'deleted' } },
  }, meta)
  const gone = loadStore(dir).getTask('team:task-4')
  assert.equal(gone.archived, true, '团队任务被删（tombstone）→ 本地锚点归档')
  assert.equal(loadStore(dir).getBoundTaskId('s_lead'), undefined, '删除时解绑所有会话（与 archive_task 同语义）')
  ok('写作用域进卡片；团队快照同步状态，删除才归档 + 解绑')
}

// ---- 8. 面板文案：`/tasks` 与 list_tasks 都标出团队任务，不和自建任务混为一谈 ----
{
  const { root } = newProject()
  const views = { 'task-2': teamView('task-2', '迁移鉴权') }
  const lead = makeExec(root, 's_lead', teamService(views))
  await selectTaskTool(config, {}).execute({ taskId: 'task-2' }, lead.exec)

  const invocation = (rawInput) => ({
    agent: { id: 's_lead', session: { id: 's_lead', header: { cwd: root }, append() {} } },
    rawInput,
  })
  const snapshot = tasksCommandDefinition(config, {}).handler(invocation('/tasks'))
  assert.equal(snapshot.kind, 'success')
  assert.match(snapshot.text, /含团队任务 1 套/, '/tasks 总览标出团队任务数量')
  assert.match(snapshot.text, /团队任务 task-2/, '/tasks 每行标出团队任务 id')

  const listed = await listTasksTool(config).execute({}, lead.exec)
  assert.match(listed, /团队任务 task-2/, 'list_tasks 同样标出团队任务（不会误认成自建任务）')
  ok('/tasks 与 list_tasks 的团队任务标注')
}

console.log(`\nteam-task tests: ${passed} passed`)
