// TaskBridge 运行时：监听会话事件，把宿主 todo/工具调用同步进任务实体。
// 事实依据：dsh session/event 签名 (session, event)；todo/write data.todos；
// tool/call data.arguments 为 JSON 字符串；fs 工具名 read/write/edit/read_image，参数 file_path。
import path from 'node:path'
import { createHash } from 'node:crypto'
import { memoryRootFor } from '../util/fs.js'
import { findProjectRoot } from '../lazy.js'
import { ProjectMemoryStore } from '../store.js'

const FS_FILE_TOOLS = new Set(['read', 'write', 'edit', 'read_image'])
const MAX_FILES_PER_TASK = 100
const TITLE_MAX = 24

export function hash8(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 8)
}

export function slugifyTitle(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TITLE_MAX)
}

export function genTaskId(projectRoot, title) {
  const slug = slugifyTitle(title) || 'task'
  return `tsk_${hash8(projectRoot)}_${slug}_${Date.now()}`
}

/** 项目根推导：findProjectRoot 期望文件路径，传目录会从父级起跳，故用目录内探针路径。 */
export function projectRootFor(cwd) {
  const base = cwd || process.cwd()
  return findProjectRoot(path.join(base, '__taskbridge__.probe'))
}

export function taskStoreFor(cwd, config) {
  const root = projectRootFor(cwd)
  return { root, store: new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load() }
}

/** 把工具参数里的文件路径归一化为项目相对路径；项目外返回 null。 */
export function normalizeRelFile(root, file) {
  if (typeof file !== 'string' || !file) return null
  const abs = path.isAbsolute(file) ? file : path.resolve(root, file)
  const rel = path.relative(root, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

/** content 可能是字符串或 ContentBlock[]，统一取首段文本。 */
export function firstTextOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b.text === 'string' && b.text.trim()) return b.text
    }
  }
  return ''
}

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])

/**
 * 反向接管：任务成为某会话绑定后，把任务步骤推成宿主 todo/write 快照，
 * 让 dsh 渲染的任务清单（UI/投影）变成我们这套任务的步骤。
 * 规则：任务没有步骤时不推（避免误清模型手头正在用的宿主清单）。
 * @returns {boolean} 是否实际推送
 */
export function adoptStepsToSession(session, task) {
  if (!session || typeof session.append !== 'function') return false
  const steps = Array.isArray(task?.steps) ? task.steps : null
  if (!steps || steps.length === 0) return false
  const todos = steps.map((s) => {
    const raw = typeof s === 'string' ? s : s?.content ?? s?.text ?? ''
    const status = TODO_STATUSES.has(s?.status) ? s.status : 'pending'
    return { content: String(raw), status }
  })
  session.append('todo/write', { todos })
  return true
}

/** 是否开启“任务接管时同步宿主清单”（config.tasklist.syncHostOnAdopt 默认 true）。 */
export function shouldAdoptToHost(config) {
  return config?.tasklist?.syncHostOnAdopt !== false
}

function pickTitle(meta, todos) {
  const firstHuman = meta?.firstHuman?.trim()
  if (firstHuman) {
    // 用户消息常带指令前缀（"用 todo_write 规划：…"），优先取最后一个"："后的任务段
    const idx = Math.max(firstHuman.lastIndexOf('：'), firstHuman.lastIndexOf(':'))
    const seg = idx >= 0 ? firstHuman.slice(idx + 1).trim() : ''
    if (seg.length >= 2 && seg.length <= 48) return seg
    return firstHuman.slice(0, 48)
  }
  const firstTodo = todos?.[0]?.content
  if (firstTodo && firstTodo.trim()) return firstTodo.trim().slice(0, 48)
  return 'Untitled Task'
}

/**
 * 单条会话事件处理（导出便于测试）：user/message 记首条真人文本；
 * todo/write → 已绑定则覆盖 steps，未绑定则自动新建任务并绑定；
 * tool/call（fs 工具）→ 绑定任务 files 并集。
 */
export function onSessionEvent(config, session, event, meta) {
  const sessionId = session?.id
  const type = event?.type
  if (!sessionId || !type) return

  if (type === 'user/message') {
    if (!meta.has(sessionId) && event.data?.source?.kind === 'user') {
      const text = firstTextOf(event.data?.content)
      if (text) meta.set(sessionId, { firstHuman: text })
    }
    return
  }

  const { root, store } = taskStoreFor(session?.header?.cwd, config)
  const now = new Date().toISOString()

  if (type === 'todo/write') {
    const todos = event.data?.todos
    if (!Array.isArray(todos)) return
    store.commit((s) => {
      let task = s.getBoundTaskId(sessionId) ? s.getTask(s.getBoundTaskId(sessionId)) : null
      if (!task || task.archived) {
        // 空写 = 清空清单：不自动建档（避免"未绑定会话清空 todo"误建垃圾任务）
        if (todos.length === 0) return
        const title = pickTitle(meta.get(sessionId), todos)
        task = {
          id: genTaskId(root, title),
          projectHash: hash8(root),
          projectRoot: root,
          title,
          steps: null,
          files: [],
          archived: false,
          lastSessionId: sessionId,
          createdAt: now,
          updatedAt: now,
          lastActiveAt: now,
        }
        s.addTask(task)
        s.setBinding(sessionId, task.id)
      }
      task.steps = todos
      task.updatedAt = now
      task.lastActiveAt = now
      task.lastSessionId = sessionId
      s._dirtyTasks = true
    })
    return
  }

  if (type === 'tool/call') {
    const taskId = store.getBoundTaskId(sessionId)
    if (!taskId) return
    const data = event.data
    if (!data?.name || !FS_FILE_TOOLS.has(data.name)) return
    let args
    try {
      args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments
    } catch {
      return
    }
    const raw = typeof args?.file_path === 'string' ? args.file_path : null
    if (!raw) return
    const rel = normalizeRelFile(root, raw)
    if (!rel) return
    store.commit((s) => {
      const task = s.getTask(taskId)
      if (!task || task.archived) return
      if (!task.files.includes(rel)) {
        task.files.push(rel)
        if (task.files.length > MAX_FILES_PER_TASK) task.files.shift()
      }
      task.lastActiveAt = now
      s._dirtyTasks = true
    })
  }
}

/** 插件接线：订阅 session/event；卸载时清会话元数据。 */
export function setupTaskbridge(ctx, config) {
  if (config.tasklist?.enabled === false) return
  const meta = new Map()
  ctx.on('session/event', (session, event) => {
    try {
      onSessionEvent(config, session, event, meta)
    } catch (err) {
      console.error('[dsh-project-memory] taskbridge:', err?.message)
    }
  })
  ctx.effect(() => () => meta.clear())
}
