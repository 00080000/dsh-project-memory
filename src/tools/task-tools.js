import { defineTool } from '@deepseek-ai/dsh-tools'
import { memoryRootFor, resolveIndexRoot } from '../util/fs.js'
import { ProjectMemoryStore } from '../store.js'
import { truncate } from '../util/text.js'
import { genTaskId, hash8, adoptStepsToSession, shouldAdoptToHost } from '../setup/taskbridge.js'
import { createHash } from 'node:crypto'

function sessionIdOf(exec) {
  return exec?.agent?.session?.id || exec?.ctx?.session?.id
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  return `${Math.floor(h / 24)}天前`
}

function summaryOf(task) {
  const done = (task.steps || []).filter((s) => s.status === 'completed').length
  const total = (task.steps || []).length
  const files = (task.files || []).length
  const mark = task.archived ? ' [归档]' : ''
  return `### ${task.title}${mark}\n- 进度: ${done}/${total} 完成\n- 文件: ${files} 个\n- 最后活动: ${timeAgo(task.lastActiveAt || task.updatedAt)}`
}

export function listTasksTool(config) {
  return defineTool({
    name: 'list_tasks',
    description:
      'List all task records in this project (archived included, marked). Call this first in a new session or before continuing work, to see what tasks exist and pick one with select_task.',
    parameters: {
      root: { type: 'string', description: 'Project root. Defaults to current working directory.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const root = resolveIndexRoot(exec, args.root)
      const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
      const tasks = store.getTasks()
      if (!tasks.length) {
        return '任务记录: 0 套（先做一步再建清单，或用 select_task 新建）'
      }
      const lines = ['## 任务记录']
      for (const task of tasks) lines.push(summaryOf(task))
      lines.push(`\n任务记录: ${tasks.length} 套（list_tasks 查看，select_task 续做/切换）`)
      return truncate(lines.join('\n\n'), config.maxOutputChars)
    },
  })
}

export function selectTaskTool(config) {
  return defineTool({
    name: 'select_task',
    description:
      'Bind the current session to a task record so its todo list and read files sync into it. When starting NEW work, call select_task(title="任务名") FIRST, then maintain your plan with todo_write — you choose the task title (short, no need to restate the user message). taskId: exact id from list_tasks (auto-unarchives; pass title too to rename). title: exact match only; multiple matches return candidates; no match creates a new task. Returns a task card (title, steps, files) to rebuild the session todo from. Call list_tasks first in a new session.',
    parameters: {
      taskId: { type: 'string', description: 'Exact task id, e.g. tsk_ab12cd34_...' },
      title: { type: 'string', description: 'Exact task title; creates a new task when absent' },
      root: { type: 'string', description: 'Project root. Defaults to current working directory.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const root = resolveIndexRoot(exec, args.root)
      const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
      const sid = sessionIdOf(exec)
      const now = new Date().toISOString()
      const error = (msg) => truncate(JSON.stringify({ success: false, error: msg }), config.maxOutputChars)

      if (!args.taskId && !args.title) {
        return error('需要 taskId 或 title（先 list_tasks；未绑定会话出现 todo 时会自动新建任务）')
      }

      let task = null
      let hint = ''
      if (args.taskId) {
        task = store.getTask(args.taskId)
        if (!task) return error(`Task not found: ${args.taskId}`)
        if (task.archived) {
          task.archived = false
          hint = '已解归档'
        }
        if (args.title && args.title !== task.title) {
          task.title = args.title // 改名（自动标题可能带指令前缀，续接时可顺手改干净）
          hint = (hint ? hint + '；' : '') + `已改名「${args.title}」`
        }
      } else {
        const matches = store.getTasks().filter((t) => t.title === args.title)
        if (matches.length > 1) {
          const candidates = matches.map((t) => ({ taskId: t.id, title: t.title, updatedAt: t.updatedAt, archived: t.archived }))
          return truncate(JSON.stringify({ success: false, error: '多个同名任务', candidates }), config.maxOutputChars)
        }
        if (matches.length === 1) {
          task = matches[0]
          if (task.archived) {
            task.archived = false
            hint = '已解归档'
          }
        } else {
          task = {
            id: genTaskId(root, args.title),
            projectHash: hash8(root),
            projectRoot: root,
            title: args.title,
            steps: null,
            files: [],
            archived: false,
            lastSessionId: sid,
            createdAt: now,
            updatedAt: now,
            lastActiveAt: now,
          }
          store.addTask(task)
          hint = '已新建任务'
        }
      }

      if (sid) {
        store.setBinding(sid, task.id)
        hint = (hint ? hint + '；' : '') + '已绑定本会话'
      } else {
        hint = (hint ? hint + '；' : '') + '（拿不到会话 id，未能持久绑定）'
      }
      task.updatedAt = now
      task.lastActiveAt = now
      if (sid) task.lastSessionId = sid
      store.save()

      // 反向接管：绑定成功后，把任务步骤推成宿主 todo/write（dsh 清单跟随我们的任务）
      if (shouldAdoptToHost(config)) {
        adoptStepsToSession(exec?.agent?.session || exec?.ctx?.session, task)
      }

      const card = {
        taskId: task.id,
        title: task.title,
        steps: task.steps,
        files: task.files,
        hint: hint + '；请据此用 todo_write 重建本会话清单',
      }
      return truncate(JSON.stringify(card), config.maxOutputChars)
    },
  })
}

export function archiveTaskTool(config) {
  return defineTool({
    name: 'archive_task',
    description: 'Archive a task: hide from default views, exclude from capacity, stop syncing. Restore by selecting it again.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id to archive (from list_tasks / select_task)' },
      root: { type: 'string', description: 'Project root. Defaults to current working directory.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const root = resolveIndexRoot(exec, args.root)
      const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
      const task = store.getTask(args.taskId)
      if (!task) return truncate(JSON.stringify({ success: false, error: 'Task not found' }), config.maxOutputChars)
      if (task.archived) return truncate(JSON.stringify({ success: false, error: 'Already archived' }), config.maxOutputChars)
      task.archived = true
      task.updatedAt = new Date().toISOString()
      store.save()
      return truncate(JSON.stringify({ success: true, archived: true, hint: '已归档，select_task 可恢复' }), config.maxOutputChars)
    },
  })
}
