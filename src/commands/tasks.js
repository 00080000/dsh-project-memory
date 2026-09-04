// /tasks 用户命令：不经模型，直接展示本项目任务总览（非归档 + 归档计数 + 当前会话绑定）。
// 同时嵌入结构化 JSON 供 Client 端 Task Panel 解析渲染交互式面板。
import { memoryRootFor } from '../util/fs.js'
import { ProjectMemoryStore } from '../store.js'
import { projectRootFor } from '../setup/taskbridge.js'

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  return `${Math.floor(h / 24)}天前`
}

function buildTaskPayload(tasks, boundId, archived) {
  return JSON.stringify({
    tasks: tasks.map(t => ({
      id: t.id,
      title: t.title,
      steps: (t.steps || []).map(s => ({ content: s.content || s.text, status: s.status })),
      files: (t.files || []).map(f => ({ path: f, line: undefined })),
      lastActiveAt: t.lastActiveAt,
      updatedAt: t.updatedAt,
      archived: t.archived || false,
    })),
    boundId: boundId || null,
    archived,
  })
}

export function tasksCommandDefinition(config) {
  return {
    name: 'tasks',
    description: '查看本项目的任务清单（几套任务、进度、涉及文件、当前绑定）',
    handler: (invocation) => {
      try {
        const cwd = invocation?.agent?.session?.header?.cwd
        const root = projectRootFor(cwd)
        const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
        const tasks = store.getTasks()
        const active = tasks.filter((t) => !t.archived)
        const archived = tasks.length - active.length
        const sid = invocation?.agent?.session?.id
        const boundId = sid ? store.getBoundTaskId(sid) : null
        const bound = boundId ? tasks.find((t) => t.id === boundId) : null

        if (!active.length) {
          const payload = buildTaskPayload([], boundId, archived)
          return {
            kind: 'success',
            text: `项目 ${root}\n任务记录: 0 套${archived ? `（归档 ${archived}）` : ''}。让模型开始干活并维护 todo 清单后会自动建档。\n\n\`\`\`json\n${payload}\n\`\`\``,
          }
        }
        const lines = [`项目 ${root}`, `任务: ${active.length} 套${archived ? `（归档 ${archived}）` : ''}`, '']
        for (const t of active) {
          const done = (t.steps || []).filter((s) => s.status === 'completed').length
          const total = (t.steps || []).length
          const progress = total ? `${done}/${total}` : '无步骤'
          const inProgress = (t.steps || []).find((s) => s.status === 'in_progress')
          const step = inProgress ? ` · 当前: ${inProgress.content}` : ''
          const marker = bound && bound.id === t.id ? '（本会话绑定）' : ''
          const files = (t.files || []).slice(0, 8)
          const fileLine = files.length ? `\n  文件: ${files.join(', ')}${t.files.length > 8 ? ' …' : ''}` : ''
          lines.push(`● ${t.title}${marker}  步骤 ${progress}${step} · ${timeAgo(t.lastActiveAt || t.updatedAt)}${fileLine}`)
        }
        lines.push('', '续接/改名/归档：直接告诉模型（list_tasks / select_task / archive_task）。')
        const humanText = lines.join('\n')
        const payload = buildTaskPayload(active, boundId, archived)
        return { kind: 'success', text: `${humanText}\n\n\`\`\`json\n${payload}\n\`\`\`` }
      } catch (err) {
        return { kind: 'error', text: `[tasks] ${err?.message || err}` }
      }
    },
  }
}
