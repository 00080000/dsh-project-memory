// 团队任务作记忆作用域：node test/team-task.test.mjs
//
// 背景（ROADMAP §4.15）：任务级记忆挂在 tasks.json 某条任务的 insights[] 上，只有"会话绑定"
// 才看得见；绑定原本只认本地 tsk_ 任务。团队模式下 lead 与队友是两个会话，唯一公共的任务身份
// 是宿主的团队任务板（task-<n>）。这里钉住四件事：
//   1. select_task 接受 task-<n> → 映射成同一条本地记忆记录（team:team-root:task-2）并绑定本会话；
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
import { taskCommandDefinition } from '../src/commands/task-actions.js'
import { buildEntryContent } from '../src/auto-inject.js'
import { archiveTaskTool } from '../src/tools/task-tools.js'
import { lessonTool } from '../src/tools/lesson-tools.js'
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
function makeExec(root, id, team, teamRoot = 'team-root') {
  const appended = []
  const agent = {
    id,
    session: { id, header: { cwd: root }, append: (...args) => appended.push(args) },
  }
  if (team) {
    agent.ctx = {
      get: (name) => {
        if (name === 'agentTeams') return team
        // TeamService 依赖 subagents；团队树根会话 id 就是宿主 TeamId。
        if (name === 'subagents') return { rootOf: () => ({ session: { id: teamRoot } }) }
        return undefined
      },
    }
  }
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
  assert.equal(teamMemoryTaskId('team-root', 'task-2'), 'team:team-root:task-2')
  ok('团队任务 id 形状与本地记忆键映射')
}

// ---- 2. lead 绑定 task-2：映射成本地记录 + 绑定 + 落盘 + 不推宿主清单 ----
{
  const { root, dir, tasksFile } = newProject()
  const views = { 'task-2': teamView('task-2', '迁移鉴权') }
  const lead = makeExec(root, 's_lead', teamService(views))
  const card = JSON.parse(await selectTaskTool(config, {}).execute({ taskId: 'task-2' }, lead.exec))

  assert.equal(card.taskId, 'team:team-root:task-2')
  assert.equal(card.team.id, 'task-2')
  assert.equal(card.team.status, 'in_progress')
  assert.deepEqual(card.team.writeScopes, [])
  assert.equal(card.title, '迁移鉴权', '标题取团队任务 subject')
  assert.match(card.hint, /团队任务/)
  assert.doesNotMatch(card.hint, /todo_write/, '团队锚点不吸收步骤，不能再让模型用 todo_write 重建清单')

  const store = loadStore(dir)
  const rec = store.getTask('team:team-root:task-2')
  assert.ok(rec, '团队任务映射成本地记忆任务记录')
  assert.equal(rec.teamTaskId, 'task-2', '记录带 teamTaskId，供再次绑定复用')
  assert.equal(store.getBoundTaskId('s_lead'), 'team:team-root:task-2')

  const disk = readTasks(tasksFile)
  assert.equal(disk.length, 1)
  assert.equal(disk[0].teamTaskId, 'task-2', 'teamTaskId 必须落进 tasks.json（自定义字段不丢）')
  assert.equal(disk[0].id, 'team:team-root:task-2')

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
    taskId: 'team:team-root:task-2',
  })
  assert.equal(saved.ok, true)
  store.save()

  const mate = makeExec(root, 's_mate', team)
  const card = JSON.parse(await tool.execute({ taskId: 'task-2' }, mate.exec))
  assert.equal(card.taskId, 'team:team-root:task-2', '队友绑定到同一条记忆记录')
  assert.ok(card.insights.some((i) => i.title === 'JWT 迁移先双写'), '任务卡带回共享的任务级经验')

  const store2 = loadStore(dir)
  assert.equal(store2.getBoundTaskId('s_mate'), 'team:team-root:task-2')
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
  store.updateTask('team:team-root:task-2', { archived: true })
  store.save()
  const restored = JSON.parse(await tool.execute({ taskId: 'task-2' }, lead.exec))
  assert.equal(restored.taskId, 'team:team-root:task-2')
  assert.equal(loadStore(dir).getTask('team:team-root:task-2').archived, false)
  assert.match(restored.hint, /团队任务/, '解归档不能把"已关联团队任务"的提示冲掉')
  assert.match(restored.hint, /已解归档/)
  ok('幂等复用 + 人工改名保留 + 解归档（提示不丢）')
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
  const boundRecord = loadStore(dir).getTask('team:team-root:task-4')
  assert.equal(boundRecord.teamWriteScopes[0], 'src/auth/', '写作用域落盘，后续 list_tasks 也能看到')
  assert.equal('teamWriteScopeWarnings' in boundRecord, false,
    '冲突告警是视图值：快照里没有它，落盘只会在下一次任务变更后过期')

  const session = { id: 's_lead', header: { cwd: root } }
  const meta = new Map()
  onSessionEvent(config, session, {
    type: 'team/task',
    data: { version: 2, teamId: 'team-root', task: { ...views['task-4'], revision: 2, status: 'completed' } },
  }, meta)
  const done = loadStore(dir).getTask('team:team-root:task-4')
  assert.equal(done.teamTaskStatus, 'completed', '宿主快照同步任务状态')
  assert.equal(done.archived, false, '完成不等于归档：任务做完，任务级记忆仍然有用')
  assert.equal(loadStore(dir).getBoundTaskId('s_lead'), 'team:team-root:task-4', '完成不解绑')

  onSessionEvent(config, session, {
    type: 'team/task',
    data: { version: 2, teamId: 'team-root', task: { ...views['task-4'], revision: 3, status: 'deleted' } },
  }, meta)
  const gone = loadStore(dir).getTask('team:team-root:task-4')
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

// ---- 9. 团队锚点不吸收成员的步骤：共享记忆键不是某个人的 todo 清单 ----
{
  const { root, dir } = newProject()
  const views = { 'task-2': teamView('task-2', '迁移鉴权') }
  const team = teamService(views)
  const lead = makeExec(root, 's_lead', team)
  const mate = makeExec(root, 's_mate', team)
  const tool = selectTaskTool(config, {})
  await tool.execute({ taskId: 'task-2' }, lead.exec)
  await tool.execute({ taskId: 'task-2' }, mate.exec)

  const session = { id: 's_mate', header: { cwd: root } }
  onSessionEvent(config, session, {
    type: 'todo/write',
    data: { todos: [{ content: '队友自己的步骤', status: 'in_progress' }] },
  }, new Map())

  const anchor = loadStore(dir).getTask('team:team-root:task-2')
  assert.equal(anchor.steps, null, '队友写 todo 不改共享锚点的步骤（否则会覆盖 lead 的清单）')
  assert.equal(anchor.lastTodoAt, undefined, 'lastTodoAt 属于单个会话：写进共享锚点会让任务卡回声判据失效')
  assert.equal(loadStore(dir).getBoundTaskId('s_lead'), 'team:team-root:task-2', '绑定关系不受影响')
  ok('团队锚点不吸收成员步骤 / 自维护时刻')
}

// ---- 10. 没有本地锚点时，team/task 事件不碰 store（纯团队项目不留 .dsh-project-memory） ----
{
  const { root } = newProject()
  const dir = path.join(root, '.dsh-project-memory')
  onSessionEvent(config, { id: 's_x', header: { cwd: root } }, {
    type: 'team/task',
    data: { version: 2, teamId: 'team-root', task: teamView('task-7', '与我无关') },
  }, new Map())
  assert.equal(existsSync(dir), false, '没有锚点就不该为一次团队任务变更触发 store.commit / 建目录')
  ok('无锚点的 team/task 事件不碰磁盘')
}

// ---- 11. 非团队任务不带团队标注（标注必须是条件式的，不能污染普通项目输出） ----
{
  const { root } = newProject()
  const plain = makeExec(root, 's_plain')
  const plainCard = JSON.parse(await selectTaskTool(config, {}).execute({ title: '普通任务' }, plain.exec))
  assert.match(plainCard.hint, /todo_write/, '本地任务的清单接管提示保持不变')
  const listed = await listTasksTool(config).execute({}, plain.exec)
  assert.doesNotMatch(listed, /团队任务/, '普通任务不该出现团队标注')
  const invocation = (rawInput) => ({
    agent: { id: 's_plain', session: { id: 's_plain', header: { cwd: root }, append() {} } },
    rawInput,
  })
  const snapshot = tasksCommandDefinition(config, {}).handler(invocation('/tasks'))
  assert.doesNotMatch(snapshot.text, /团队任务/, '/tasks 对普通项目输出保持原样')
  assert.doesNotMatch(snapshot.text, /含团队任务/, '/tasks 总览不为 0 套团队任务加噪音')
  ok('普通任务的输出与团队标注互不污染')
}

// ---- 12. 稀疏视图不冲掉已有字段（老宿主/局部视图不能把 owner 写成 null） ----
{
  const { root, dir } = newProject()
  const view = teamView('task-2', '迁移鉴权', { ownerName: 'mate' })
  const views = { 'task-2': view }
  const lead = makeExec(root, 's_lead', teamService(views))
  const tool = selectTaskTool(config, {})
  await tool.execute({ taskId: 'task-2' }, lead.exec)
  delete view.ownerName
  delete view.writeScopes
  await tool.execute({ taskId: 'task-2' }, lead.exec)
  const anchor = loadStore(dir).getTask('team:team-root:task-2')
  assert.equal(anchor.teamOwnerName, 'mate', '视图没给 ownerName 时保留已有值')
  assert.deepEqual(anchor.teamWriteScopes, [], '首次视图给了空作用域；这次没给就保持原值')
  ok('稀疏视图不冲掉团队任务字段')
}

// ---- 13. 缺少 agent 上下文与"没装团队插件"是两种错误 ----
{
  const { root } = newProject()
  const views = { 'task-2': teamView('task-2', '迁移鉴权') }
  const noCaller = { ctx: { get: () => teamService(views) } }
  const res = JSON.parse(await selectTaskTool(config, {}).execute({ taskId: 'task-2', root }, noCaller))
  assert.equal(res.success, false)
  assert.match(res.error, /没有 agent 上下文/)
  assert.doesNotMatch(res.error, /没有团队服务/, '有团队服务、只是没有 caller，不能归错因')
  ok('no-caller 与 no-service 的错误可区分')
}

// ---- 14. 已归档但仍有绑定时，删除事件也要解绑 ----
{
  const { root, dir } = newProject()
  const views = { 'task-2': teamView('task-2', '迁移鉴权') }
  const lead = makeExec(root, 's_lead', teamService(views))
  await selectTaskTool(config, {}).execute({ taskId: 'task-2' }, lead.exec)
  const store = loadStore(dir)
  store.updateTask('team:team-root:task-2', { archived: true })
  store.save()
  assert.equal(store.getBoundTaskId('s_lead'), 'team:team-root:task-2', '手改归档不会自动解绑')

  onSessionEvent(config, { id: 's_lead', header: { cwd: root } }, {
    type: 'team/task',
    data: { version: 2, teamId: 'team-root', task: { ...views['task-2'], status: 'deleted' } },
  }, new Map())
  assert.equal(loadStore(dir).getBoundTaskId('s_lead'), undefined, '删除事件即使已归档也必须解绑')
  ok('删除事件：已归档仍解绑')
}

// ---- 15. save_lesson/archive_task 接受宿主 id（锚点存在时），无锚点给可执行错误 ----
{
  const { root, dir } = newProject()
  const views = { 'task-2': teamView('task-2', '迁移鉴权') }
  const lead = makeExec(root, 's_lead', teamService(views))
  await selectTaskTool(config, {}).execute({ taskId: 'task-2' }, lead.exec)
  const cfg = { memoryDir: '.dsh-project-memory', insight: { globalFile: path.join(root, 'global.json') } }

  const saved = await lessonTool(cfg).execute({ title: '宿主 id 也能写', fix: '先映射到锚点', task_id: 'task-2' }, lead.exec)
  assert.match(saved, /^Saved insight/, '显式传宿主 task-<n> 的写入要成功')
  assert.ok(loadStore(dir).getTask('team:team-root:task-2').insights.some((i) => i.title === '宿主 id 也能写'),
    '写入落到共享锚点，而不是静默改写成 project scope')

  await archiveTaskTool(cfg, {}).execute({ taskId: 'task-2' }, lead.exec)
  assert.equal(loadStore(dir).getTask('team:team-root:task-2').archived, true, 'archive_task 同样接受宿主 id')
  ok('save_lesson / archive_task 接受宿主团队 id')

  const bare = newProject()
  const bareCfg = { memoryDir: '.dsh-project-memory', insight: { globalFile: path.join(bare.root, 'global.json') } }
  const missing = await lessonTool(bareCfg).execute({ title: 'x', task_id: 'task-9' }, makeExec(bare.root, 's_bare').exec)
  assert.match(missing, /还没有记忆锚点/)
  assert.match(missing, /select_task task-9/)
  ok('未绑定的团队 id：错误可执行，不静默丢作用域')
}

// ---- 17. 同一项目的两个团队：task-<n> 编号会重复，记忆与状态必须按团队树隔离 ----
{
  const { root, dir } = newProject()
  const views = { 'task-2': teamView('task-2', '同名任务') }
  const service = teamService(views)
  const teamA = makeExec(root, 's_a', service, 'team-a')
  const teamB = makeExec(root, 's_b', service, 'team-b')
  const tool = selectTaskTool(config, {})
  await tool.execute({ taskId: 'task-2' }, teamA.exec)
  await tool.execute({ taskId: 'task-2' }, teamB.exec)

  const store = loadStore(dir)
  assert.deepEqual(store.getTasks().map((t) => t.id).sort(),
    ['team:team-a:task-2', 'team:team-b:task-2'], '同一任务编号在两个团队里是两条锚点')

  saveInsight({ store, raw: { kind: 'lesson', title: 'A 队的任务经验' }, scope: 'task', taskId: 'team:team-a:task-2' })
  store.save()
  const bCard = JSON.parse(await tool.execute({ taskId: 'task-2' }, teamB.exec))
  assert.equal(bCard.insights.length, 0, '两个团队的 task-2 不共享任务级记忆')

  onSessionEvent(config, { id: 's_a', header: { cwd: root } }, {
    type: 'team/task',
    data: { version: 2, teamId: 'team-a', task: { ...views['task-2'], status: 'completed' } },
  }, new Map())
  const after = loadStore(dir)
  assert.equal(after.getTask('team:team-a:task-2').teamTaskStatus, 'completed', 'A 的状态事件只同步 A')
  assert.notEqual(after.getTask('team:team-b:task-2').teamTaskStatus, 'completed', 'B 的同名任务不受影响')
  ok('同一项目的两个团队：同名 task-<n> 的记忆与状态互不串台')
}

// ---- 18. 缺少 subagents（推导不出团队树）：拒绝绑定，不建可能跨团队歧义的锚点 ----
{
  const { root, dir } = newProject()
  const views = { 'task-2': teamView('task-2', '迁移鉴权') }
  const agent = {
    id: 's_nosub',
    session: { id: 's_nosub', header: { cwd: root }, append() {} },
    ctx: { get: (name) => (name === 'agentTeams' ? teamService(views) : undefined) },
  }
  const res = JSON.parse(await selectTaskTool(config, {}).execute({ taskId: 'task-2', root }, { agent }))
  assert.equal(res.success, false)
  assert.match(res.error, /无法确定所属团队树/)
  assert.equal(loadStore(dir).getTasks().length, 0, '不建跨团队歧义的锚点')
  ok('缺少 subagents：拒绝绑定而不是猜团队')
}

// ---- 19. 面板动作（/tasks switch|todos|step|rename|archive）与注入卡：团队锚点不接受步骤 ----
{
  const { root, dir } = newProject()
  const views = { 'task-2': teamView('task-2', '迁移鉴权') }
  const lead = makeExec(root, 's_lead', teamService(views))
  await selectTaskTool(config, {}).execute({ taskId: 'task-2' }, lead.exec)
  const anchorId = 'team:team-root:task-2'

  const appended = []
  const invocation = (rawInput) => ({
    agent: { id: 's_lead', session: { id: 's_lead', header: { cwd: root }, append: (...args) => appended.push(args) } },
    rawInput,
  })
  const handler = taskCommandDefinition(config, {}).handler

  const switched = handler(invocation(`switch ${anchorId}`))
  assert.equal(switched.kind, 'success')
  assert.equal(appended.filter((a) => a[0] === 'todo/write').length, 0,
    '面板 switch 团队锚点也不能推空清单（否则清掉成员自己的 todo）')
  assert.match(switched.text, /团队任务只共享任务级记忆/)

  const todos = handler(invocation('todos [{"content":"成员清单","status":"pending"}]'))
  assert.equal(todos.kind, 'error')
  assert.match(todos.text, /团队任务/)
  assert.deepEqual(loadStore(dir).getTask(anchorId).steps || [], [], '整份回写被拒绝，锚点不存步骤')

  assert.equal(handler(invocation(`step ${anchorId} 0 completed`)).kind, 'error')
  assert.equal(handler(invocation(`step-text ${anchorId} 0 "x"`)).kind, 'error')

  const renamed = handler(invocation(`rename ${anchorId} "新名"`))
  assert.match(renamed.text, /宿主团队任务未变/)
  const listed = await listTasksTool(config).execute({}, lead.exec)
  assert.match(listed, /进度: 见宿主团队任务板/, 'list_tasks 不显示 0/0 的空进度')
  const snapshot = tasksCommandDefinition(config, {}).handler(invocation('/tasks'))
  assert.match(snapshot.text, /步骤 见宿主团队任务板/, '/tasks 也不显示“无步骤”')
  const card = buildEntryContent(loadStore(dir).getTask(anchorId), {})
  assert.match(card, /进度: 见宿主团队任务板/, '注入卡也不留空的“进度:”')

  const archived = handler(invocation(`archive ${anchorId}`))
  assert.match(archived.text, /仅本地记忆锚点，宿主团队任务未变/)
  ok('面板动作与注入卡：团队锚点不接受步骤编辑，宿主任务说明清楚')
}

console.log(`\nteam-task tests: ${passed} passed`)
