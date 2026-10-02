/**
 * Task UI Store — 仅管本地 UI 状态（closed、minimized、position、expandedIds、theme、showHints）
 * - 持久化到 localStorage（key: dsh-pm-task-panel-ui）
 * - 不跨标签页同步（每个标签页独立）
 * - 启动/刷新强制 closed: true，面板默认不显示
 */
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'dsh-pm-task-panel-ui'

/**
 * 面板的三个视图页。**单一事实来源**：面板的切页按钮与 `/` 菜单的三行都读它。
 * 两边各抄一份必然漂移 —— 实测就是这样：菜单行去执行宿主命令"开记忆页"，而面板的 view
 * 是组件内部 state，谁也够不着它，于是点击没有任何可见效果。
 */
export const PANEL_VIEWS = ['task', 'project', 'global'] as const
export type PanelView = (typeof PANEL_VIEWS)[number]

/** 把任意值收敛成一个合法视图页（脏 localStorage / 外部传入都要过这一关）。 */
export function normalizeView(value: unknown): PanelView {
  return (PANEL_VIEWS as readonly unknown[]).includes(value) ? (value as PanelView) : 'task'
}

interface TaskUIState {
  expandedTaskIds: string[]
  panelPosition: { x: number; y: number }
  minimized: boolean
  closed: boolean
  theme: string
  /** 是否显示悬停提示信息（title 气泡）；false 时面板内所有功能提示都不弹出。 */
  showHints: boolean
  /**
   * 当前视图页。放在 store 而不是 TaskPanel 的局部 state —— `/` 菜单那三行就是
   * 「打开某一页」，它们从**组件外面**触发，必须有一个可寻址的落点。
   */
  view: PanelView
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
          showHints: parsed.showHints !== false,
          // 视图页可恢复：它是"上次在看哪一页"，刷新后仍该停在那里（与 closed 不同）。
          view: normalizeView(parsed.view),
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
    showHints: true,
    view: 'task',
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
    /**
     * 切页但不动开合状态（面板里那个循环按钮用）。
     * 非法值一律忽略 —— 这个入口会被菜单行与脏 localStorage 碰到，静默归一比抛错合适。
     */
    setView(view: PanelView): void {
      if (!(PANEL_VIEWS as readonly unknown[]).includes(view)) return
      if (uiState.view === view) return
      setUIState({ ...uiState, view })
    },
    /**
     * 打开面板并切到指定页 —— `/` 菜单那三行的**全部**动作。
     *
     * 纯客户端：不再绕 `remote.commands.execute('/tasks insight list …')` 一圈。那条路
     * 只在对话里留下一个命令节点，而客户端渲染命令节点的是按**命令名**分发的
     * `TaskCommandNode`（`name === 'tasks'`），它拿任务解析器去解记忆载荷，解析必然失败
     * —— 于是点菜单"开记忆页"什么都不会发生。
     * @param view - 目标视图页；非法值直接忽略（不打开面板，避免"点了没反应还弹窗"）。
     */
    openView(view: PanelView): void {
      if (!(PANEL_VIEWS as readonly unknown[]).includes(view)) return
      setUIState({ ...uiState, view, minimized: false, closed: false })
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
    toggleHints(): void {
      setUIState({ ...uiState, showHints: !uiState.showHints })
    },
    setShowHints(showHints: boolean): void {
      setUIState({ ...uiState, showHints })
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
