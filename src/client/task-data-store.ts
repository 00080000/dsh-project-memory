/**
 * Task Data Store — 仅管服务端同步的数据（tasks、boundTaskId、archivedCount）
 * - 单向数据流：命令执行结果 → setTasks → 广播给其他标签页
 * - 无 UI 状态，无 localStorage，纯内存 + BroadcastChannel 同步
 */
import { useSyncExternalStore } from 'react'

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
    return { tasks: data.tasks, boundId: data.boundId ?? null, archived: data.archived ?? 0 }
  } catch {
    return null
  }
}

interface TaskDataState {
  tasks: Task[]
  boundTaskId: string | null
  archivedCount: number
  lastUpdate: number
}

const SYNC_CHANNEL = typeof window !== 'undefined' ? new BroadcastChannel('dsh-pm-tasks-data') : null

let dataState: TaskDataState = {
  tasks: [],
  boundTaskId: null,
  archivedCount: 0,
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
    lastUpdate: typeof patch?.lastUpdate === 'number' ? patch.lastUpdate : 0,
  }
  for (const listener of dataListeners) listener()
}

function broadcastDataUpdate(tasks: Task[], archivedCount: number): void {
  if (!SYNC_CHANNEL) return
  SYNC_CHANNEL.postMessage({
    type: 'PROJECT_TASKS_UPDATED',
    payload: { tasks: Array.isArray(tasks) ? tasks : [], archivedCount },
  })
}

if (SYNC_CHANNEL) {
  SYNC_CHANNEL.onmessage = (event) => {
    const msg = event.data
    if (msg?.type === 'PROJECT_TASKS_UPDATED' && msg.payload) {
      const { tasks, archivedCount } = msg.payload
      setDataState(prev => ({
        ...prev,
        tasks: Array.isArray(tasks) ? tasks : [],
        archivedCount: typeof archivedCount === 'number' ? archivedCount : prev.archivedCount,
        lastUpdate: Date.now(),
      }))
    }
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
    setTasks(payload: { tasks: Task[]; boundTaskId: string | null; archivedCount: number }): void {
      const nextTasks = payload.tasks || []
      const nextArchived = payload.archivedCount ?? 0
      setDataState({
        tasks: nextTasks,
        boundTaskId: payload.boundTaskId ?? null,
        archivedCount: nextArchived,
        lastUpdate: Date.now(),
      })
      broadcastDataUpdate(nextTasks, nextArchived)
    },
    reset(): void {
      setDataState({
        tasks: [],
        boundTaskId: null,
        archivedCount: 0,
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