/**
 * Task UI Store — 仅管本地 UI 状态（closed、minimized、position、expandedIds、theme）
 * - 持久化到 localStorage（key: dsh-pm-task-panel-ui）
 * - 不跨标签页同步（每个标签页独立）
 * - 启动/刷新强制 closed: true，面板默认不显示
 */
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'dsh-pm-task-panel-ui'

interface TaskUIState {
  expandedTaskIds: string[]
  panelPosition: { x: number; y: number }
  minimized: boolean
  closed: boolean
  theme: string
}

function defaultPosition(): { x: number; y: number } {
  if (typeof window !== 'undefined') {
    return { x: Math.max(16, window.innerWidth - 408), y: 72 }
  }
  return { x: 0, y: 0 }
}

/**
 * 启动时的初始状态：
 * - closed 恒为 true（不读取 localStorage 的 closed），刷新后面板隐藏；
 * - 其余（展开项/位置/主题）可恢复上次会话偏好，minimized 默认折叠成迷你条。
 */
function getDefaultUIState(): TaskUIState {
  if (typeof window !== 'undefined') {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        return {
          expandedTaskIds: Array.isArray(parsed.expandedTaskIds) ? parsed.expandedTaskIds : [],
          panelPosition: parsed.panelPosition ?? defaultPosition(),
          minimized: parsed.minimized !== false,
          closed: true,
          theme: typeof parsed.theme === 'string' ? parsed.theme : 'native',
        }
      }
    } catch { /* corrupt state — fall through to defaults */ }
  }
  return {
    expandedTaskIds: [],
    panelPosition: defaultPosition(),
    minimized: true,
    closed: true,
    theme: 'native',
  }
}

function persistUI(state: TaskUIState): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* storage full/unavailable — non-fatal */ }
}

let uiState: TaskUIState = getDefaultUIState()
const uiListeners = new Set<() => void>()

function setUIState(next: TaskUIState): void {
  uiState = next
  persistUI(next)
  for (const listener of uiListeners) listener()
}

export const taskUIStore = {
  subscribe(listener: () => void): () => void {
    uiListeners.add(listener)
    return () => { uiListeners.delete(listener) }
  },
  getSnapshot(): TaskUIState {
    return uiState
  },
  actions: {
    toggleTaskExpanded(taskId: string): void {
      const prev = uiState
      const ids = prev.expandedTaskIds.includes(taskId)
        ? prev.expandedTaskIds.filter((id) => id !== taskId)
        : [...prev.expandedTaskIds, taskId]
      setUIState({ ...prev, expandedTaskIds: ids })
    },
    expandAll(taskIds: string[]): void {
      setUIState({ ...uiState, expandedTaskIds: taskIds })
    },
    setPanelPosition(pos: { x: number; y: number }): void {
      setUIState({ ...uiState, panelPosition: pos })
    },
    open(): void {
      setUIState({ ...uiState, minimized: false, closed: false })
    },
    minimize(): void {
      setUIState({ ...uiState, minimized: true, closed: false })
    },
    close(): void {
      setUIState({ ...uiState, minimized: true, closed: true })
    },
    setTheme(theme: string): void {
      setUIState({ ...uiState, theme })
    },
    reset(): void {
      setUIState(getDefaultUIState())
    },
  },
}

export function useTaskUI(): TaskUIState {
  return useSyncExternalStore(taskUIStore.subscribe, taskUIStore.getSnapshot, taskUIStore.getSnapshot)
}

export function useTaskUIActions() {
  return taskUIStore.actions
}
