// /task <verb> <taskId> 用户命令：Task Panel 卡片动作（不经模型）。
//   switch  <taskId>  — 绑定当前会话到该任务（自动解归档），等价 select_task(taskId)
//   archive <taskId>  — 归档该任务
// 返回值与 /tasks 同一快照文本（含 JSON 载荷），面板解析后即时刷新，无需再跑一次 /tasks。
import { memoryRootFor } from '../util/fs.js'
import { ProjectMemoryStore } from '../store.js'
import { projectRootFor, adoptStepsToSession, shouldAdoptToHost } from '../setup/taskbridge.js'
import { renderTaskSnapshot, buildTaskPayload } from './tasks.js'

const VERBS = { switch: 'switch', archive: 'archive' }

function describeTask(t) {
  const done = (t.steps || []).filter((s) => s.status === 'completed').length
  const total = (t.steps || []).length
  return `「${t.title}」（步骤 ${done}/${total}）`
}

function withTaskSnapshot(config, cwd, sid, store, note) {
  const tasks = store.getTasks()
  const active = tasks.filter((t) => !t.archived)
  const archived = tasks.length - active.length
  const boundId = sid ? store.getBoundTaskId(sid) : null
  const human = `项目 ${projectRootFor(cwd)}\n${note}\n任务: ${active.length} 套${archived ? `（归档 ${archived}）` : ''}`
  const payload = buildTaskPayload(active, boundId, archived)
  return { kind: 'success', text: `${human}\n\n\`\`\`json\n${payload}\n\`\`\`` }
}

export function taskCommandDefinition(config) {
  return {
    name: 'task',
    description: '任务面板动作：/task switch <任务id> 切换绑定，/task archive <任务id> 归档，/task unbind 取消当前任务绑定',
    input: { hint: 'switch|archive <任务id> | unbind' },
    handler: (invocation) => {
      try {
        const cwd = invocation?.agent?.session?.header?.cwd
        const sid = invocation?.agent?.session?.id
        const raw = (invocation?.rawInput || '').trim()
        const [verb, taskId, ...rest] = raw.split(/\s+/)

        // 无参数：等同 /tasks（不报错、不强制输入任务 id）——
        // switch/archive/unbind 由卡片按钮自动调用，用户无需手敲。
        if (!verb) {
          const snap = renderTaskSnapshot(config, cwd, sid)
          if (snap.kind === 'success') {
            snap.text = `[任务] 用法: /task switch|archive <任务id> | unbind（卡片按钮会自动调用；不带参数等同 /tasks）\n\n${snap.text}`
          }
          return snap
        }
        if (!['unbind', 'todos', 'rename'].includes(verb) && (!taskId || rest.length)) {
          return { kind: 'error', text: '[task] 用法: /task switch|archive <任务id> | unbind' }
        }
        const root = projectRootFor(cwd)
        const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()

        if (verb === 'unbind') {
          if (sid) store.removeBinding(sid)
          store.save()
          // 推空 todo/write 清掉输入框上方的宿主任务清单（TaskBridge 空写=清空，不再自动建档）
          if (invocation?.agent?.session && typeof invocation.agent.session.append === 'function') {
            invocation.agent.session.append('todo/write', { todos: [] })
          }
          const note = '已取消当前任务绑定并清空会话任务清单（需要时可让模型重新规划）'
          return withTaskSnapshot(config, cwd, sid, store, note)
        }

        // /task rename <任务id> <json标题> —— 双击任务标题改名
        if (verb === 'rename') {
          if (!taskId) return { kind: 'error', text: '[task] rename 需要任务 id（由卡片双击调用）' }
          const payload = raw.split(/\s+/).slice(2).join(' ').trim()
          let title = payload
          try {
            const parsed = JSON.parse(payload)
            if (typeof parsed === 'string') title = parsed
          } catch { /* 非 JSON 时按原样取 payload */ }
          title = title.trim()
          if (!title) return { kind: 'error', text: '[task] 标题不能为空' }
          const task = store.getTask(taskId)
          if (!task) return { kind: 'error', text: `[task] 找不到任务: ${taskId}` }
          const oldTitle = task.title
          task.title = title
          task.updatedAt = new Date().toISOString()
          task.lastActiveAt = task.updatedAt
          store.save()
          const note = `已改名「${oldTitle}」→「${title}」`
          return withTaskSnapshot(config, cwd, sid, store, note)
        }

        // /task todos <json> —— 卡片双击编辑步骤后，把整份新清单写回绑定任务并推宿主
        // （与模型 todo_write 同一套数据，只是发起方是用户面板）
        if (verb === 'todos') {
          const rawJson = raw.split(/\s+/).slice(1).join(' ').trim()
          let todos
          try {
            todos = JSON.parse(rawJson)
          } catch {
            return { kind: 'error', text: '[task] todos 需要 JSON 数组参数（由面板自动生成）' }
          }
          if (!Array.isArray(todos)) {
            return { kind: 'error', text: '[task] todos 需要 JSON 数组参数（由面板自动生成）' }
          }
          const norm = todos
            .map((s) => {
              const content = String(s?.content ?? s?.text ?? '').trim()
              const status = ['pending', 'in_progress', 'completed'].includes(s?.status) ? s.status : 'pending'
              return { content, status }
            })
            .filter((s) => s.content.length > 0)
          const boundId = sid ? store.getBoundTaskId(sid) : null
          if (!boundId) {
            return { kind: 'error', text: '[task] 未绑定任务，无法编辑步骤；先在卡片上“切换到此任务”' }
          }
          const task = store.getTask(boundId)
          if (!task) return { kind: 'error', text: '[task] 绑定任务不存在' }
          task.steps = norm
          task.updatedAt = new Date().toISOString()
          task.lastActiveAt = task.updatedAt
          store.save()
          if (shouldAdoptToHost(config)) {
            adoptStepsToSession(invocation?.agent?.session, task)
          }
          const note = `已更新「${task.title}」步骤（${norm.length} 条）`
          return withTaskSnapshot(config, cwd, sid, store, note)
        }

        if (verb === VERBS.switch) {
          const task = store.getTask(taskId)
          if (!task) return { kind: 'error', text: `[task] 找不到任务: ${taskId}（/tasks 查看）` }
          if (task.archived) task.archived = false
          if (sid) {
            store.setBinding(sid, task.id)
          }
          task.updatedAt = new Date().toISOString()
          task.lastActiveAt = task.updatedAt
          store.save()
          // 反向接管：切换成功后把任务步骤推成宿主 todo/write（dsh 清单跟随）
          if (shouldAdoptToHost(config)) {
            adoptStepsToSession(invocation?.agent?.session, task)
          }
          const note = `已切换绑定: ${describeTask(task)}${sid ? '' : '（拿不到会话 id，未持久绑定）'}`
          return withTaskSnapshot(config, cwd, sid, store, note)
        }

        if (verb === VERBS.archive) {
          const task = store.getTask(taskId)
          if (!task) return { kind: 'error', text: `[task] 找不到任务: ${taskId}（/tasks 查看）` }
          if (task.archived) return { kind: 'error', text: `[task] 已归档: ${task.title}` }
          task.archived = true
          task.updatedAt = new Date().toISOString()
          store.save()
          const note = `已归档: ${describeTask(task)}（select_task 可恢复）`
          return withTaskSnapshot(config, cwd, sid, store, note)
        }

        return { kind: 'error', text: `[task] 未知动作: ${verb}（switch|archive）` }
      } catch (err) {
        return { kind: 'error', text: `[task] ${err?.message || err}` }
      }
    },
  }
}

// 保留语义别名：/task-switch、/task-archive（仅当前端/旧入口用）
export function taskSwitchCommandDefinition(config) {
  const base = taskCommandDefinition(config)
  return {
    ...base,
    name: 'task-switch',
    handler: (invocation) => {
      const id = (invocation?.rawInput || '').trim().split(/\s+/)[0]
      return base.handler({ ...invocation, rawInput: id ? `switch ${id}` : '' })
    },
  }
}

export function taskArchiveCommandDefinition(config) {
  const base = taskCommandDefinition(config)
  return {
    ...base,
    name: 'task-archive',
    handler: (invocation) => {
      const id = (invocation?.rawInput || '').trim().split(/\s+/)[0]
      return base.handler({ ...invocation, rawInput: id ? `archive ${id}` : '' })
    },
  }
}

// renderTaskSnapshot 引用保留，供外部（测试/工具）使用
export { renderTaskSnapshot }
