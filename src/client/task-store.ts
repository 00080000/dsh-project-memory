/**
 * Task Panel Client Store（自包含：不依赖宿主 store 包）
 * Reactive store for task list, bound task, UI state.
 * 数据由 /tasks、/task 命令执行结果（JSON 载荷）写入，localStorage 持久化 UI 状态。
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
  expandedTaskIds: string[]
  panelPosition: { x: number; y: number }
  /** true = 折叠成顶部迷你条（仍可见、可拖拽）。 */
  minimized: boolean
  /** true = 彻底隐藏（无迷你条），仅可通过 /task /tasks 或重新加载唤起。 */
  closed: boolean
  /** 卡片强调色主题：native 或 accent 名（azure/violet/teal/rose）。 */
  theme: string
  lastUpdate: number
}

/** /tasks 命令响应（text）里夹带的 JSON 载荷结构。 */
export interface TaskPayload {
  tasks: Task[]
  boundId: string | null
  archived: number
}

/** 从命令输出文本中解析任务快照 JSON（支持 fenced ```json 块或尾部对象）。 */
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

const STORAGE_KEY = 'dsh-pm-task-panel-state'

function defaultPosition(): { x: number; y: number } {
  if (typeof window !== 'undefined') {
    return { x: Math.max(16, window.innerWidth - 408), y: 72 }
  }
  return { x: 0, y: 0 }
}

function getDefaultState(): TaskPanelState {
  if (typeof window !== 'undefined') {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        return {
          tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
          boundTaskId: parsed.boundTaskId ?? null,
          archivedCount: parsed.archivedCount ?? 0,
          expandedTaskIds: Array.isArray(parsed.expandedTaskIds) ? parsed.expandedTaskIds : [],
          panelPosition: parsed.panelPosition ?? defaultPosition(),
          minimized: parsed.minimized !== false, // 默认折叠成迷你条
          theme: typeof parsed.theme === 'string' ? parsed.theme : 'native',
          closed: !!parsed.closed,
          lastUpdate: parsed.lastUpdate ?? 0,
        }
      }
    } catch { /* corrupt state — fall through to defaults */ }
  }
  return {
    tasks: [],
    boundTaskId: null,
    archivedCount: 0,
    expandedTaskIds: [],
    panelPosition: defaultPosition(),
    minimized: true, // 默认折叠，不打扰
    closed: false,
    theme: 'native',
    lastUpdate: 0,
  }
}

function persist(state: TaskPanelState): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* storage full/unavailable — non-fatal */ }
}

let state: TaskPanelState = getDefaultState()
const listeners = new Set<() => void>()

function setState(next: TaskPanelState): void {
  state = next
  persist(next)
  for (const listener of listeners) listener()
}

export const taskStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  getSnapshot(): TaskPanelState {
    return state
  },
  actions: {
    setTasks(payload: { tasks: Task[]; boundTaskId: string | null; archivedCount: number }): void {
      const prev = state
      setState({
        ...prev,
        tasks: payload.tasks || [],
        boundTaskId: payload.boundTaskId ?? null,
        archivedCount: payload.archivedCount ?? 0,
        lastUpdate: Date.now(),
      })
    },
    toggleTaskExpanded(taskId: string): void {
      const prev = state
      const ids = prev.expandedTaskIds.includes(taskId)
        ? prev.expandedTaskIds.filter((id) => id !== taskId)
        : [...prev.expandedTaskIds, taskId]
      setState({ ...prev, expandedTaskIds: ids })
    },
    expandAll(): void {
      const prev = state
      setState({ ...prev, expandedTaskIds: prev.tasks.map((t) => t.id) })
    },
    setPanelPosition(pos: { x: number; y: number }): void {
      setState({ ...state, panelPosition: pos })
    },
    /** 展开面板（同时解除隐藏/折叠）。 */
    open(): void {
      setState({ ...state, minimized: false, closed: false })
    },
    /** 折叠成顶部迷你条（仍可见）。 */
    minimize(): void {
      setState({ ...state, minimized: true, closed: false })
    },
    /** 彻底隐藏（无迷你条）；仅能通过 /task、/tasks 或重新加载唤起。 */
    close(): void {
      setState({ ...state, minimized: true, closed: true })
    },
    setTheme(theme: string): void {
      setState({ ...state, theme })
    },
    setMinimized(minimized: boolean): void {
      setState({ ...state, minimized, closed: minimized ? state.closed : false })
    },
    reset(): void {
      setState(getDefaultState())
    },
  },
}

export function useTaskStore(): TaskPanelState {
  return useSyncExternalStore(taskStore.subscribe, taskStore.getSnapshot, taskStore.getSnapshot)
}

export function useTaskActions() {
  return taskStore.actions
}
