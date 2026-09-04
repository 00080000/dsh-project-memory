/**
 * Task Panel Client Store
 * Reactive store for task list, bound task, UI state
 */
import { createStore, useStore } from '@deepseek-ai/dsh-client-store'
import { useSyncExternalStore } from 'react'

export interface TaskStep {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface TaskFile {
  path: string
  line?: number
}

export interface Task {
  id: string
  title: string
  steps: TaskStep[]
  files: TaskFile[]
  lastActiveAt: string
  updatedAt: string
  archived?: boolean
}

export interface TaskPanelState {
  tasks: Task[]
  boundTaskId: string | null
  archivedCount: number
  // UI state
  expandedTaskIds: Set<string>
  panelPosition: { x: number; y: number }
  minimized: boolean
  lastUpdate: number
}

const STORAGE_KEY = 'dsh-pm-task-panel-state'

function getDefaultState(): TaskPanelState {
  if (typeof window !== 'undefined') {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        return {
          tasks: [],
          boundTaskId: null,
          archivedCount: 0,
          expandedTaskIds: new Set(parsed.expandedTaskIds || []),
          panelPosition: parsed.panelPosition || { x: window.innerWidth - 440, y: 80 },
          minimized: parsed.minimized || false,
          lastUpdate: 0,
        }
      }
    } catch {}
  }
  return {
    tasks: [],
    boundTaskId: null,
    archivedCount: 0,
    expandedTaskIds: new Set(),
    panelPosition: { x: 0, y: 0 },
    minimized: false,
    lastUpdate: 0,
  }
}

function persist(state: TaskPanelState) {
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        expandedTaskIds: Array.from(state.expandedTaskIds),
        panelPosition: state.panelPosition,
        minimized: state.minimized,
      }))
    } catch {}
  }
}

export const taskStore = createStore<TaskPanelState>({
  name: 'dsh-project-memory-task-panel',
  initialState: getDefaultState(),
  reducers: {
    setTasks(state, payload: { tasks: Task[]; boundTaskId: string | null; archivedCount: number }) {
      state.tasks = payload.tasks
      state.boundTaskId = payload.boundTaskId
      state.archivedCount = payload.archivedCount
      state.lastUpdate = Date.now()
    },
    toggleTaskExpanded(state, taskId: string) {
      const next = new Set(state.expandedTaskIds)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      state.expandedTaskIds = next
      persist(state)
    },
    setPanelPosition(state, pos: { x: number; y: number }) {
      state.panelPosition = pos
      persist(state)
    },
    setMinimized(state, minimized: boolean) {
      state.minimized = minimized
      persist(state)
    },
    reset() {
      return getDefaultState()
    },
  },
})

export function useTaskStore() {
  return useSyncExternalStore(taskStore.subscribe, taskStore.getSnapshot, taskStore.getSnapshot)
}

export function useTaskActions() {
  const store = useStore(taskStore)
  return store.actions
}