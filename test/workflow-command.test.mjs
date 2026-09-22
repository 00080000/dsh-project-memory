// 合并后唯一用户命令 /tasks 的分派测试：node test/workflow-command.test.mjs
//
// 合并前的三条宿主命令（/tasks、/task、/insight）会把同一批能力在 `/` 菜单里显示两遍
// —— 宿主命令只要注册就会出现在「指令」组，插件无法隐藏。现在宿主只注册 /tasks，
// 其余动作作为子动词由面板按钮经 remote.commands.execute 驱动。
//
// 这个文件把「路由」本身固化下来：合并最容易出的错是某条子动词走错处理器，
// 而它会以「命令还能跑、只是结果不对」的形式出现，看菜单是看不出来的。
import { mkdtempSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { ProjectMemoryStore } from '../src/store.js'
import { GlobalStore } from '../src/insight-store.js'
import { workflowCommandDefinition } from '../src/commands/workflow.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

/** 临时项目：两套任务 + 一条 project insight + 一条 global insight。 */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'wfcmd-'))
  const globalFile = path.join(root, 'global.json')
  const memoryDir = '.dsh-project-memory'
  const store = new ProjectMemoryStore(path.join(root, memoryDir)).load()
  const now = new Date().toISOString()
  for (const [id, title] of [['tsk_a', '任务甲'], ['tsk_b', '任务乙']]) {
    store.addTask({ id, title, projectRoot: root, steps: [{ content: '第一步', status: 'in_progress' }], files: [], archived: false, createdAt: now, updatedAt: now, lastActiveAt: now })
  }
  store.replaceInsightItems([{
    id: 'ins_pj', kind: 'decision', scope: 'project', title: '选型 jose', choice: 'jose', reason: '零依赖',
    confidence: 0.9, sourceTaskIds: ['tsk_a'], createdAt: now, updatedAt: now,
  }])
  store.commit(() => 0)
  const gs = new GlobalStore(globalFile).load()
  gs.doc.items.push({ id: 'ins_gl', kind: 'procedure', scope: 'global', title: '发包流程', steps: ['a'], confidence: 1, createdAt: now, updatedAt: now })
  gs.commit(() => 0)

  const config = {
    memoryDir,
    insight: { globalFile },
    // 关掉宿主 todo 接管：这里只测分派，不测 TaskBridge 的写盘
    tasklist: { enabled: true, syncHostOnAdopt: false },
  }
  const invocation = (rawInput) => ({
    commandId: 'cmd-test',
    agent: { id: 'sess_wf', session: { id: 'sess_wf', header: { cwd: root } } },
    rawInput,
    attachments: [],
  })
  return { root, config, invocation, definition: workflowCommandDefinition(config, {}) }
}

// ---- 1. 定义面：名字是 tasks，且**不声明 input** ----
{
  const { definition } = fixture()
  assert.equal(definition.name, 'tasks', '唯一命令名就是 tasks')
  assert.equal(typeof definition.handler, 'function')
  assert.equal(definition.input, undefined,
    '绝不能声明 input：声明了就变成 leadingInput，手敲 /tasks 回车会被回填成 claim 并要求再按一次回车')
  assert.ok(definition.description.trim().length > 0, 'description 非空（宿主 commands 会校验）')
  ok('定义：name=tasks、无 input（裸 /tasks 仍是一次回车）')
}

// ---- 2. 裸 /tasks：任务清单快照（合并前 /tasks 的行为与文案） ----
{
  const { definition, invocation } = fixture()
  const res = definition.handler(invocation(''))
  assert.equal(res.kind, 'success')
  assert.ok(res.text.includes('任务甲'), '裸 /tasks 必须仍然输出任务清单')
  assert.ok(res.text.includes('```json'), '仍然带面板需要的 JSON 载荷围栏')
  ok('裸 /tasks → 任务清单快照（行为与合并前一致）')
}

// ---- 3. /tasks insight …：路由到记忆动作处理器 ----
{
  const { definition, invocation } = fixture()
  const res = definition.handler(invocation(' insight list project'))
  assert.equal(res.kind, 'success', `期望 success，实得 ${JSON.stringify(res).slice(0, 200)}`)
  assert.ok(res.text.includes('选型 jose'), '前缀剥掉后交给记忆处理器，认出 project scope')
  assert.ok(!res.text.includes('发包流程'), 'scope=project 不得混入 global 条目')

  const gl = definition.handler(invocation(' insight list global'))
  assert.equal(gl.kind, 'success')
  assert.ok(gl.text.includes('发包流程'), 'global scope 正确')

  const bad = definition.handler(invocation(' insight nonexistent'))
  assert.equal(bad.kind, 'error', '记忆处理器的用法错误必须原样透出来，不能被当成任务动作')
  ok('/tasks insight … → 记忆动作处理器（前缀剥净、scope 正确）')
}

// ---- 4. /tasks <任务动作>：路由到任务动作处理器 ----
{
  const { definition, invocation, config, root } = fixture()
  const switched = definition.handler(invocation(' switch tsk_b'))
  assert.equal(switched.kind, 'success', `期望 success，实得 ${JSON.stringify(switched).slice(0, 200)}`)
  assert.ok(switched.text.includes('已切换绑定'), '返回任务快照 + 动作说明')

  const reread = new ProjectMemoryStore(path.join(root, config.memoryDir)).load()
  assert.equal(reread.getBoundTaskId('sess_wf'), 'tsk_b', '绑定真的落盘了（不只是返回文案对）')

  const unbound = definition.handler(invocation(' unbind'))
  assert.equal(unbound.kind, 'success')
  assert.ok(!new ProjectMemoryStore(path.join(root, config.memoryDir)).load().getBoundTaskId('sess_wf'),
    'unbind 生效（读回后不再有绑定）')

  const unknown = definition.handler(invocation(' 这不是动词'))
  assert.equal(unknown.kind, 'error')
  assert.ok(unknown.text.startsWith('[task]'), `未知动词必须落在任务处理器里（拿到 ${unknown.text}）`)
  ok('/tasks <switch|unbind|…> → 任务动作处理器，且副作用真的落盘')
}

// ---- 5. 唯一注册点：index.js 只能注册一条命令 ----
{
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const registrations = source.match(/\.commands\.register\(/g) ?? []
  assert.equal(registrations.length, 1,
    'index.js 只能有一条 commands.register：每多注册一条宿主命令，`/` 菜单的「指令」组里就多一行去不掉的原始行')
  assert.ok(source.includes('workflowCommandDefinition'), '注册的是合并后的定义')
  ok('index.js 只有一个 commands.register（重复行不会偷偷长回来）')
}

console.log(`\nworkflow-command tests: ${passed} passed`)
