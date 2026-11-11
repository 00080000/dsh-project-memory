// TaskBridge 运行时：监听会话事件，把宿主 todo/工具调用同步进任务实体。
// 事实依据：dsh session/event 签名 (session, event)；todo/write data.todos；
// tool/call data.arguments 为 JSON 字符串；fs 工具名 read/write/edit/read_image，参数 file_path。
import path from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { memoryRootFor, resolveProjectMemoryRoot } from '../util/fs.js'
import { sessionWorkingDir } from '../util/session-dir.js'
import { ProjectMemoryStore } from '../store.js'
import { BoundedMap } from '../util/session-cache.js'
import { stepContent, stepStatus } from '../util/task-view.js'
import { patchFilePaths } from '../util/patch.js'
import { flushDirtyStores } from '../util/flush.js'

// apply_patch 的参数是整段补丁文本，路径在正文里（见 util/patch.js），单独分支处理。
const FS_FILE_TOOLS = new Set(['read', 'write', 'edit', 'read_image', 'str_replace_editor', 'apply_patch'])
const WRITE_TOOLS = new Set(['write', 'edit']) // 编辑/写入 = 高热点
const READ_TOOLS = new Set(['read', 'read_image'])
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
  // 毫秒不是唯一性保证：两个会话在同一毫秒建同名任务会拿到同一个 id，
  // addTask 变成"同一 id 两次"，两个会话的绑定互相串台。补 6 位随机后缀。
  return `tsk_${hash8(projectRoot)}_${slug}_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`
}

/** 会话根不可用时统一的用户提示（/tasks、/task、/insight 共用）。 */
export const NO_PROJECT_ROOT_NOTE =
  '当前工作目录不是项目根（是家目录/系统目录且没有项目标记），项目记忆与任务清单已停用；请在项目目录内启动 dsh。'

/**
 * 项目根推导：与全插件同一套策略（util/fs.js 的 `resolveProjectMemoryRoot`）——
 * 最近的 VCS/清单标记优先；标记缺失但 cwd 本身是安全目录时退回 cwd（任务清单按
 * "会话工作目录"归属，没有标记的普通目录也要能用）；cwd 是家目录/系统/包管理器前缀
 * 且上方没有标记时返回 null。
 */
export function projectRootFor(cwd, config) {
  return resolveProjectMemoryRoot(cwd || process.cwd(), config)
}

/** 没有可用项目根时返回 `{ root: null, store: null }`，调用方据此整段跳过。 */
export function taskStoreFor(cwd, config) {
  const root = projectRootFor(cwd, config)
  if (!root) return { root: null, store: null }
  // 会话 cwd 可能已被删除/改名：此时不能 load（save 的 mkdirSync 会把项目根重新造出来）。
  // 与 index_repo / watch_repo 的同一条护栏。
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) return { root: null, store: null }
  } catch {
    return { root: null, store: null }
  }
  return { root, store: new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load() }
}

/** 把工具参数里的文件路径归一化为项目相对路径；项目外返回 null。 */
export function normalizeRelFile(root, file) {
  if (typeof file !== 'string' || !file) return null
  const abs = path.isAbsolute(file) ? file : path.resolve(root, file)
  const rel = path.relative(root, abs)
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null
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

/**
 * 反向接管：任务成为某会话绑定后，把任务步骤推成宿主 todo/write 快照，
 * 让 dsh 渲染的任务清单（UI/投影）变成我们这套任务的步骤。
 * 规则：任务没有步骤时不推（避免误清模型手头正在用的宿主清单）。
 * @returns {boolean} 是否实际推送
 */
export function adoptStepsToSession(session, task, { force = false } = {}) {
  if (!session || typeof session.append !== 'function') return false
  const steps = Array.isArray(task?.steps) ? task.steps : null
  // 隐式路径（例如工具顺手更新文件热点）不推空，避免清掉模型手头的清单；显式切换/清空必须推，
  // 否则面板绑到 B、输入框里仍是 A 的步骤。
  if ((!steps || steps.length === 0) && !force) return false
  const todos = (steps || []).map((s) => ({ content: String(stepContent(s)), status: stepStatus(s) }))
  session.append('todo/write', { todos })
  return true
}

/** 是否开启“任务接管时同步宿主清单”（config.tasklist.syncHostOnAdopt 默认 true）。 */
export function shouldAdoptToHost(config) {
  return config?.tasklist?.syncHostOnAdopt !== false
}

/**
 * 子代理会话判定：宿主 SessionHeader 对 in-process 子代理恒定写入
 * `origin: 'subagent'` 与 `delegationDepth`（parent depth + 1）。
 * 刻意不看 parentSession —— 那是 fork/seed 血缘，用户 fork 出来的顶层会话同样带它。
 */
export function isSubagentSession(session) {
  const header = session?.header
  if (!header) return false
  if (header.origin === 'subagent') return true
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0
}

/**
 * 标题优先级：清单首条 > 首条真人消息 > 'Untitled Task'（0.5.3 反转前两者）。
 * 真人消息只在清单没有可用文本时兜底：重启后 meta.firstHuman 是重启后的第一条消息
 * （常常只是半途闲聊，如"刚刚你卡死了，注意点"），拿它命名会把任务带偏。
 */
function pickTitle(meta, todos) {
  const firstTodo = todos?.[0]?.content
  if (typeof firstTodo === 'string' && firstTodo.trim()) return firstTodo.trim().slice(0, 48)
  const firstHuman = meta?.firstHuman?.trim()
  if (firstHuman) {
    // 用户消息常带指令前缀（"用 todo_write 规划：…"），优先取最后一个"："后的任务段
    const idx = Math.max(firstHuman.lastIndexOf('：'), firstHuman.lastIndexOf(':'))
    const seg = idx >= 0 ? firstHuman.slice(idx + 1).trim() : ''
    if (seg.length >= 2 && seg.length <= 48) return seg
    return firstHuman.slice(0, 48)
  }
  return 'Untitled Task'
}

/**
 * 热点排序：写过(编辑)的文件永远排前；同是写过按 lastWriteAt 倒序；
 * 纯读文件按 lastReadAt 倒序排在写区之后（任何读取都不会越过写过文件）。
 */
export function hotSortFiles(files, meta) {
  const m = meta || {}
  return (files || []).slice().sort((a, b) => {
    const A = m[a]
    const B = m[b]
    const aw = A && A.lastWriteAt ? 1 : 0
    const bw = B && B.lastWriteAt ? 1 : 0
    if (aw !== bw) return bw - aw
    if (aw) return String(B.lastWriteAt).localeCompare(String(A.lastWriteAt))
    return String(B.lastReadAt || '').localeCompare(String(A.lastReadAt || ''))
  })
}

/** 触碰文件后更新元数据并重排 task.files（写 vs 读分别记时间/次数）。 */
export function touchTaskFile(task, rel, kind, now) {
  // 手改 / 旧版本的 tasks.json 可能没有这两个集合。读路径必须容错：这里抛一次就会让
  // 该任务后续的所有文件热点更新都静默停掉（外层 catch 只打一行日志）。
  if (!Array.isArray(task.files)) task.files = []
  task.fileMeta = task.fileMeta && typeof task.fileMeta === 'object' && !Array.isArray(task.fileMeta) ? task.fileMeta : {}
  if (!task.files.includes(rel)) task.files.push(rel)
  const m = task.fileMeta[rel] || {}
  m.n = (m.n || 0) + 1 // 兼容旧字段：读+写总数（保留，避免老任务语义漂移）
  // 读/写分计数（先只采集，不消费 —— 排序与注入仍只用 lastWriteAt/lastReadAt）
  if (kind === 'write') {
    m.writes = (m.writes || 0) + 1
    m.lastWriteAt = now
  } else if (kind === 'read') {
    m.reads = (m.reads || 0) + 1
  }
  m.lastReadAt = now
  task.fileMeta[rel] = m
  task.files = hotSortFiles(task.files, task.fileMeta)
  // 超限丢最冷的：列表已按热度降序，末尾即最冷。旧代码在**重排前** shift()，
  // 而那时 files 本身就是热序，shift 恰好把最热的那个文件（刚写的）丢掉、留下最冷的。
  while (task.files.length > MAX_FILES_PER_TASK) {
    const dropped = task.files.pop()
    delete task.fileMeta[dropped]
  }
}

/** 判据与 auto-inject 的 lastUserText 一致：缺 source 或 kind==='user' 才是人话；
 * 本插件注入（含旧 {plugin} 形状）与 agent-message 等一律排除。 */
function isHumanUserMessage(data) {
  if (!data || typeof data !== 'object') return false
  if (data.role != null && data.role !== 'user') return false
  const source = data.source
  if (!source || typeof source !== 'object') return true
  if (source.plugin === 'dsh-project-memory') return false
  const kind = source.kind
  // 空 kind 与缺 kind 同义：auto-inject 的判据是 `if (kind && kind !== 'user') continue`。
  return !kind || kind === 'user'
}

/**
 * 单条会话事件处理（导出便于测试）：user/message 记首条真人文本并刷新 lastHumanAt；
 * todo/write → 已绑定则覆盖 steps，未绑定则自动新建任务并绑定（子代理会话除外，
 * 由 isSubagentSession 判定）；tool/call（fs 工具）→ 绑定任务 files 并集。
 */
export function onSessionEvent(config, session, event, meta, ctx) {
  const sessionId = session?.id
  const type = event?.type
  if (!sessionId || !type) return
  const now = new Date().toISOString()
  // 任务清单按「会话当前工作目录」归属：0.2.1+ 该目录由 workingDirectory 投影决定
  // （cd 后会变），老宿主回退 header.cwd。`ctx` 只在宿主装配路径上给得到；测试与
  // 老调用方不给也能跑（回退 header.cwd）。
  const cwd = sessionWorkingDir(session, { ctx })

  // 人类消息：记首条真人文本 + 若已绑定任务则刷新 lastHumanAt（供“模型自维护不回声任务卡”判断）
  if (type === 'user/message') {
    if (isHumanUserMessage(event.data)) {
      const text = firstTextOf(event.data?.content)
      const m = meta.get(sessionId) || {}
      if (!m.firstHuman && text) m.firstHuman = text
      m.lastHumanAt = now
      meta.set(sessionId, m)
      try {
        const { store } = taskStoreFor(cwd, config)
        if (!store) return
        store.commit((s) => {
          const tid = s.getBoundTaskId(sessionId)
          const task = tid ? s.getTask(tid) : null
          if (task && !task.archived) {
            task.lastHumanAt = now
            task.updatedAt = now
            // 直接改了 task 内容就必须走标脏入口：只手置 _dirtyTasks 会漏掉驻留估算的新版本维。
            s.markTasksDirty()
          }
        }, { save: false })
      } catch {
        /* 人类消息戳记失败不影响主流程 */
      }
    }
    return
  }

  const { root, store } = taskStoreFor(cwd, config)
  // 没有项目根（家目录/系统目录会话）：不建档、不记文件、不落任何盘。
  if (!store) return

  if (type === 'todo/write') {
    const todos = event.data?.todos
    if (!Array.isArray(todos)) return
    store.commit((s) => {
      let task = s.getBoundTaskId(sessionId) ? s.getTask(s.getBoundTaskId(sessionId)) : null
      if (!task || task.archived) {
        // 空写 = 清空清单：不自动建档（避免"未绑定会话清空 todo"误建垃圾任务）
        if (todos.length === 0) return
        // 子代理会话不建档：否则每个子代理都铸一条项目任务（子代理任务融合另行设计）
        if (isSubagentSession(session)) return
        const title = pickTitle(meta.get(sessionId), todos)
        task = {
          id: genTaskId(root, title),
          projectHash: hash8(root),
          projectRoot: root,
          title,
          steps: null,
          files: [],
          fileMeta: {},
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
      task.lastTodoAt = now // 模型/todo 最近一次自维护时刻
      task.updatedAt = now
      task.lastActiveAt = now
      task.lastSessionId = sessionId
      s.markTasksDirty()
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
    // 文件工具调用是最高频的写口：每次 commit 都落盘会把 tasks.json 写成“每读一个文件一次”。
    // 这里只改内存 + 标脏，回合结束（turn/end）或会话销毁时统一 flush。
    const record = (rels, kind) => store.commit((s) => {
      const task = s.getTask(taskId)
      if (!task || task.archived) return
      for (const rel of rels) touchTaskFile(task, rel, kind, now)
      task.lastActiveAt = now
      s.markTasksDirty()
    }, { save: false })

    // 0.2.2 的 apply_patch：路径只在补丁正文的文件头里，没有 file_path / path。
    // 相对路径以会话当前工作目录为基准（= 宿主文档约定的“Session working directory”），
    // 再归一到项目根；项目外的路径由 normalizeRelFile 丢掉。
    // Delete/Move 也记为写：任务卡片关心“这次任务碰过哪些文件”，而不是它们是否还存在。
    // 正文里一个路径都取不到时**不返回**：同名工具若走 path/file_path 参数，交给下面的通用分支。
    if (data.name === 'apply_patch') {
      const base = typeof cwd === 'string' && cwd ? cwd : root
      const rels = []
      for (const target of patchFilePaths(args?.input)) {
        const rel = normalizeRelFile(root, path.isAbsolute(target) ? target : path.resolve(base, target))
        if (rel) rels.push(rel)
      }
      if (rels.length > 0) {
        record(rels, 'write')
        return
      }
    }

    // read/write/edit/read_image 用 file_path；宿主的 str_replace_editor 用 path。
    const raw = typeof args?.file_path === 'string'
      ? args.file_path
      : typeof args?.path === 'string' ? args.path : null
    if (!raw) return
    // 相对路径以会话当前工作目录为基准，与宿主 read/write 一致；项目根只在 cwd 缺失时兜底。
    const base = typeof cwd === 'string' && cwd ? cwd : root
    const rel = normalizeRelFile(root, path.isAbsolute(raw) ? raw : path.resolve(base, raw))
    if (!rel) return
    let kind = null
    if (data.name === 'str_replace_editor') {
      const cmd = typeof args?.command === 'string' ? args.command.toLowerCase() : ''
      if (cmd === 'view') kind = 'read'
      else if (['create', 'str_replace', 'insert'].includes(cmd)) kind = 'write'
    } else if (data.name === 'apply_patch') {
      kind = 'write' // 补丁没解析出文件头时的 path/file_path 变体：仍是写
    } else {
      kind = WRITE_TOOLS.has(data.name) ? 'write' : READ_TOOLS.has(data.name) ? 'read' : null
    }
    if (!kind) return
    record([rel], kind)
  }
}

/** 把延迟写的任务变更落盘；没有脏数据时 save() 自身早退。 */
export function flushTaskStore(cwd, config) {
  if (!cwd) return
  try {
    const { store } = taskStoreFor(cwd, config)
    // 回合结束的 flush 不能按默认 15s 等锁：写路径已经有同步等待，这里只做一次短兜底。
    if (store) store.save({ timeoutMs: 1500 })
  } catch (err) {
    console.error('[dsh-project-memory] taskbridge flush:', err?.message || err)
  }
}

function flushSessionTaskStore(session, config, ctx) {
  try {
    flushTaskStore(sessionWorkingDir(session, { ctx }), config)
  } catch (err) {
    console.error('[dsh-project-memory] taskbridge flush:', err?.message || err)
  }
}

/** 插件接线：订阅 session/event；卸载时清会话元数据。 */
export function setupTaskbridge(ctx, config) {
  if (config.tasklist?.enabled === false) return
  // 会话元数据按会话封顶：旧实现用无界 Map，长期运行的 web 进程里每个会话都会永久留一条。
  const meta = new BoundedMap(200)
  ctx.on('session/event', (session, event) => {
    try {
      onSessionEvent(config, session, event, meta, ctx)
    } catch (err) {
      console.error('[dsh-project-memory] taskbridge:', err?.message)
    }
    // 文件热点/人类消息戳记是延迟写：回合结束补一次落盘，崩溃时最多丢一个回合的计数。
    if (event?.type === 'turn/end') {
      flushSessionTaskStore(session, config, ctx)
      // 本回合可能 cd 过：按“当时的 cwd”找根会漏掉绑定根。把所有标脏的 store 一起落盘。
      flushDirtyStores({ timeoutMs: 1500 })
    }
  })
  ctx.on('session/disposed', (session) => {
    flushSessionTaskStore(session, config, ctx)
    // 会话可能 cd 过：disposed 时按当前 cwd 只能找到最后一个根，之前根里的热点
    // （tool/call 用 save:false 延迟写）会一直留到进程退出。与 turn/end 一样兜底。
    flushDirtyStores({ timeoutMs: 1500 })
    if (session?.id) meta.delete(session.id)
  })
  ctx.effect(() => () => meta.clear())
}
