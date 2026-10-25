import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertIndexRoot, memoryRootFor, resolveSafeIndexRoot } from '../util/fs.js'
import { ProjectMemoryStore } from '../store.js'
import { truncate } from '../util/text.js'
import { sessionIdOf, stepProgress, timeAgo } from '../util/task-view.js'
import { genTaskId, hash8, adoptStepsToSession, shouldAdoptToHost } from '../setup/taskbridge.js'
import { fireReflect } from '../reflection-pipeline.js'
import { resolveRoute } from '../llm-route.js'
import { NOT_PERSISTED_NOTE } from '../util/persist.js'
import { createHash } from 'node:crypto'

function summaryOf(task) {
  const { done, total } = stepProgress(task)
  const files = (task.files || []).length
  const mark = task.archived ? ' [归档]' : ''
  return `### ${task.title}${mark}\n- 进度: ${done}/${total} 完成\n- 文件: ${files} 个\n- 最后活动: ${timeAgo(task.lastActiveAt || task.updatedAt)}`
}

export function listTasksTool(config) {
  return defineTool({
    name: 'list_tasks',
    description:
      '列出本项目的任务记录（含归档）。新会话或续接前先看它，再用 select_task 选一个。',
    parameters: {
      root: { type: 'string', description: '项目根（默认当前工作目录）' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const root = resolveSafeIndexRoot(exec, args.root, config)
      assertIndexRoot(root, args.root || root)
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

export function selectTaskTool(config, host) {
  return defineTool({
    name: 'select_task',
    description:
      '把会话绑定到一个任务（此后 todo 与读过的文件同步进它）。按 taskId 精确绑定，或按 title 完全匹配'
      + '（无则新建）；返回任务卡用于重建清单。',
    parameters: {
      taskId: { type: 'string', description: '精确 task id' },
      title: { type: 'string', description: '精确标题；无则新建' },
      root: { type: 'string', description: '项目根（默认当前工作目录）' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const root = resolveSafeIndexRoot(exec, args.root, config)
      assertIndexRoot(root, args.root || root)
      const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
      const sid = sessionIdOf(exec)
      const now = new Date().toISOString()
      const error = (msg) => truncate(JSON.stringify({ success: false, error: msg }), config.maxOutputChars)
      const prevBound = sid ? store.getBoundTaskId(sid) : undefined

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
      // 解归档 / 改名 / 戳活动时间都是直接改 task：不标脏则 save() 早退，tasks.json 不落盘。
      store.markTasksDirty()
      store.save()

      // 反向接管：绑定成功后，把任务步骤推成宿主 todo/write（dsh 清单跟随我们的任务）
      if (shouldAdoptToHost(config)) {
        adoptStepsToSession(exec?.agent?.session || exec?.ctx?.session, task)
      }

      // 反思钩子：切走旧任务时异步收割（默认关，零成本；失败只记日志）
      if (prevBound && prevBound !== task.id) {
        fireReflect(config, host, root, prevBound, 'switch-away', resolveRoute(exec, config))
      }

      const card = {
        taskId: task.id,
        title: task.title,
        steps: task.steps,
        files: task.files,
        insights: task.insights || [], // v0.5：任务级 lessons/decisions/procedures
        hint: hint + '；请据此用 todo_write 重建本会话清单',
      }
      // 落盘失败必须如实说：否则模型以为"任务已续接"，重启后绑定却不存在。
      if (store.lastSaveOk === false) {
        card.persisted = false
        card.hint += `；${NOT_PERSISTED_NOTE}`
      }
      return truncate(JSON.stringify(card), config.maxOutputChars)
    },
  })
}

export function showTaskPanelTool(config) {
  return defineTool({
    name: 'show_task_panel',
    description: 'Open the task panel in the UI.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute() {
      // 开面板的动作在**客户端**：这个工具名被 src/client/ShowTaskPanelNode.tsx 认领，
      // 结果节点一渲染就由浏览器侧调 `taskUIStore.open()`。
      //
      // 宿主进程没有触碰面板状态的通道 —— 面板的 closed/minimized 是浏览器侧 UI store，
      // 而 `ToolRunContext` 只有 `deferContext()` / `concludeTurn()` 两个自有成员
      // （packages/core/tools/src/index.ts:418），**没有 `ctx`**。旧实现读 `exec.ctx` 再
      // `emit('dsh:task-panel:show')`，于是每次都返回「无法获取上下文」，面板从未打开过。
      return '已请求打开任务面板。'
    },
  })
}

export function archiveTaskTool(config, host) {
  return defineTool({
    name: 'archive_task',
    description: 'Archive a task (restore by selecting it again).',
    parameters: {
      taskId: { type: 'string', required: true, description: 'task id' },
      root: { type: 'string', description: '项目根（默认当前工作目录）' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const root = resolveSafeIndexRoot(exec, args.root, config)
      assertIndexRoot(root, args.root || root)
      const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
      const task = store.getTask(args.taskId)
      if (!task) return truncate(JSON.stringify({ success: false, error: 'Task not found' }), config.maxOutputChars)
      if (task.archived) return truncate(JSON.stringify({ success: false, error: 'Already archived' }), config.maxOutputChars)
      task.archived = true
      task.updatedAt = new Date().toISOString()
      store.markTasksDirty()
      store.save()
      // 反思钩子：归档即收割最终教训（默认关）
      fireReflect(config, host, root, args.taskId, 'archive', resolveRoute(exec, config))
      const hint = store.lastSaveOk === false ? `已归档；${NOT_PERSISTED_NOTE}` : '已归档，select_task 可恢复'
      return truncate(JSON.stringify({ success: true, archived: true, persisted: store.lastSaveOk !== false, hint }), config.maxOutputChars)
    },
  })
}
