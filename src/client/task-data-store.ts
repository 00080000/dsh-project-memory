/**
 * Task Data Store — 仅管服务端同步的数据（tasks、boundTaskId、archivedCount）
 * - 单向数据流：命令执行结果 → setTasks → 广播给其他标签页
 * - 无 UI 状态，无 localStorage，纯内存 + BroadcastChannel 同步
 */
import { useSyncExternalStore } from 'react'
import { broadcastAppliesTo, payloadRoot } from './task-scope.js'

export interface TaskStep {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface TaskFile {
  path: string
  line?: number
}

export interface TaskInsight {
  id: string
  kind: string
  title: string
  draft?: boolean
}

export interface Task {
  id: string
  title: string
  steps: TaskStep[]
  files: TaskFile[]
  lastActiveAt: string
  updatedAt: string
  archived?: boolean
  insights?: TaskInsight[]
}

export interface TaskPayload {
  tasks: Task[]
  boundId: string | null
  archived: number
  /** 项目根。旧宿主没有这个键（null）：跨标签页同步在未知根时退回"只按会话"处理。 */
  root?: string | null
}

export function parseTaskPayloadText(text?: string | null): TaskPayload | null {
  if (!text) return null
  let jsonBlock: string | null = null
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (fenced) jsonBlock = fenced[1]
  else {
    const lastBrace = text.lastIndexOf('{')
    if (lastBrace !== -1) jsonBlock = text.slice(lastBrace)
  }
  if (!jsonBlock) return null
  try {
    const data = JSON.parse(jsonBlock)
    if (!Array.isArray(data.tasks)) return null
    return {
      tasks: data.tasks,
      boundId: data.boundId ?? null,
      archived: data.archived ?? 0,
      root: payloadRoot(data.root),
    }
  } catch {
    return null
  }
}

interface TaskDataState {
  tasks: Task[]
  boundTaskId: string | null
  archivedCount: number
  /** 这份数据的项目根：广播按它做作用域，避免多项目标签页互相覆盖。 */
  root: string | null
  lastUpdate: number
}

const SYNC_CHANNEL = typeof window !== 'undefined' ? new BroadcastChannel('dsh-pm-tasks-data') : null

let dataState: TaskDataState = {
  tasks: [],
  boundTaskId: null,
  archivedCount: 0,
  root: null,
  lastUpdate: 0,
}

const dataListeners = new Set<() => void>()

function setDataState(next: TaskDataState | ((prev: TaskDataState) => TaskDataState)): void {
  // 兼容对象与函数式 updater（BroadcastChannel 曾误把 updater 当对象写入，
  // 导致 dataState 变成函数、tasks 丢失 → 面板崩溃）。写入一律归一化为完整 shape。
  const patch = typeof next === 'function' ? next(dataState) : next
  dataState = {
    tasks: Array.isArray(patch?.tasks) ? patch.tasks : [],
    boundTaskId: patch?.boundTaskId ?? null,
    archivedCount: typeof patch?.archivedCount === 'number' ? patch.archivedCount : 0,
    root: payloadRoot(patch?.root),
    lastUpdate: typeof patch?.lastUpdate === 'number' ? patch.lastUpdate : 0,
  }
  for (const listener of dataListeners) listener()
}

function broadcastDataUpdate(tasks: Task[], archivedCount: number, root: string | null): void {
  if (!SYNC_CHANNEL) return
  SYNC_CHANNEL.postMessage({
    type: 'PROJECT_TASKS_UPDATED',
    payload: { tasks: Array.isArray(tasks) ? tasks : [], archivedCount, root },
  })
}

if (SYNC_CHANNEL) {
  SYNC_CHANNEL.onmessage = (event) => {
    const msg = event.data
    if (msg?.type !== 'PROJECT_TASKS_UPDATED' || !msg.payload) return
    const { tasks, archivedCount, root } = msg.payload
    // 频道名是固定的（同一浏览器同源的所有 dsh 页面共用一个），所以**必须**按项目根过滤：
    // 否则在 A 项目点一下刷新，B 项目的标签页面板就被贴上 A 的任务列表（而它还保留自己的
    // boundTaskId，看起来像"绑定丢了"）。两侧都已知根且不同 → 丢弃；本页还不知道根（还没
    // 同步过）→ 也丢弃，让它自己那一次 /tasks 决定归属，不先借别人的数据。
    if (!broadcastAppliesTo(dataState.root, root)) return
    setDataState(prev => ({
      ...prev,
      tasks: Array.isArray(tasks) ? tasks : [],
      archivedCount: typeof archivedCount === 'number' ? archivedCount : prev.archivedCount,
      lastUpdate: Date.now(),
    }))
  }
}

export const taskDataStore = {
  subscribe(listener: () => void): () => void {
    dataListeners.add(listener)
    return () => { dataListeners.delete(listener) }
  },
  getSnapshot(): TaskDataState {
    return dataState
  },
  actions: {
    setTasks(payload: { tasks: Task[]; boundTaskId: string | null; archivedCount: number; root?: string | null }): void {
      const nextTasks = payload.tasks || []
      const nextArchived = payload.archivedCount ?? 0
      const nextRoot = payloadRoot(payload.root)
      setDataState({
        tasks: nextTasks,
        boundTaskId: payload.boundTaskId ?? null,
        archivedCount: nextArchived,
        root: nextRoot,
        lastUpdate: Date.now(),
      })
      broadcastDataUpdate(nextTasks, nextArchived, nextRoot)
    },
    reset(): void {
      setDataState({
        tasks: [],
        boundTaskId: null,
        archivedCount: 0,
        root: null,
        lastUpdate: 0,
      })
    },
  },
}

export function useTaskData(): TaskDataState {
  return useSyncExternalStore(taskDataStore.subscribe, taskDataStore.getSnapshot, taskDataStore.getSnapshot)
}

export function useTaskDataActions() {
  return taskDataStore.actions
}