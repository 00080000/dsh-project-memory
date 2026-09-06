/**
 * Task Panel Hooks — 步骤拖拽交互逻辑（useTaskDrag）。
 * 只依赖 react + task-data-store 类型，不碰数据/UI store。
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { TaskStep } from './task-data-store.ts'

interface DragState {
  fromIndex: number
  stepContent: string
  clientX: number
  clientY: number
  dragging: boolean
}

/**
 * useTaskDrag — 步骤拖拽重排（绑定任务内，同一任务卡的步骤行间移动）。
 *
 * 交互模型（拖动全程按住鼠标）：
 *  - 步骤行上按下（左键、非按钮/输入区域）→ 进入预览；
 *  - 按住 350ms 不松，或按住后移动超过 6px → 唤起跟随鼠标的浮动幽灵卡片；
 *  - 幽灵悬停到本任务卡内的步骤行时显示蓝色插入线（上半=插到该行前，下半=插到该行后）；
 *  - 松手（mouseup）：落在有效位置 → onReorder 落子；落在卡外/别的任务卡/原行
 *    （插入自身前后）/按钮输入等控件上 → 取消；
 *  - 350ms 内原地松手 = 普通点击，不产生幽灵；Esc → 取消。
 */
export function useTaskDrag(
  taskId: string,
  steps: TaskStep[],
  isBound: boolean,
  onReorder: (fromIndex: number, toIndex: number) => void
) {
  const [dragState, setDragState] = useState<DragState | null>(null)
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null)

  // 最新值镜像：拖拽期间 window 监听只在“会话开始/结束”时挂载/卸载，
  // 避免每次 mousemove 更新状态导致监听器重挂、连 350ms 定时器都被清掉。
  const dragRef = useRef(dragState)
  dragRef.current = dragState
  const longPressTimer = useRef<number | undefined>(undefined)
  const dragOrigin = useRef<{ x: number; y: number } | null>(null)

  const clearTimer = useCallback(() => {
    if (longPressTimer.current !== undefined) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = undefined
    }
  }, [])

  const cancelDrag = useCallback(() => {
    clearTimer()
    dragOrigin.current = null
    document.body.style.userSelect = ''
    setDropTargetIndex(null)
    setDragState(null)
  }, [clearTimer])

  const startDrag = useCallback((
    fromIndex: number,
    stepContent: string,
    e: React.MouseEvent
  ) => {
    if (!isBound || e.button !== 0) return
    if (dragRef.current) return // 已有预览/拖拽会话
    e.preventDefault()
    e.stopPropagation()
    document.body.style.userSelect = 'none'
    dragOrigin.current = { x: e.clientX, y: e.clientY }
    setDropTargetIndex(null)
    setDragState({ fromIndex, stepContent, clientX: e.clientX, clientY: e.clientY, dragging: false })
    clearTimer()
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = undefined
      // 350ms 长按 → 唤起幽灵卡片
      setDragState(prev => (prev ? { ...prev, dragging: true } : null))
    }, 350)
  }, [isBound, clearTimer])

  /** 计算某行上 y 坐标对应的插入位（行数下标：上半=该行前，下半=该行后）；非本任务卡返回 null */
  const dropIndexAt = useCallback((row: Element, clientY: number): number | null => {
    const parentOl = row.closest('ol')
    if (!parentOl || !parentOl.closest(`article[data-task-id="${taskId}"]`)) return null
    const index = Array.from(parentOl.children).indexOf(row)
    const rect = row.getBoundingClientRect()
    return clientY < rect.top + rect.height / 2 ? index : index + 1
  }, [taskId])

  /** 在 (x,y) 处结算：命中有效落点则重排，否则取消；并结束本次拖拽 */
  const commitDrop = useCallback((x: number, y: number) => {
    const cur = dragRef.current
    if (!cur || !cur.dragging) return
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    // 松手点在按钮/输入等交互控件上：不落子，直接取消
    if (el && !el.closest('button, input, textarea, a')) {
      const row = el.closest('[data-step-row]')
      if (row) {
        const drop = dropIndexAt(row, y)
        if (drop !== null) {
          // 行下标形式的落点：插到目标行前/后；落在自身原位视为取消（不产生空推送）
          const effective = drop > cur.fromIndex ? drop - 1 : drop
          if (effective !== cur.fromIndex) onReorder(cur.fromIndex, drop)
        }
      }
    }
    cancelDrag()
  }, [dropIndexAt, onReorder, cancelDrag])

  const active = dragState !== null

  useEffect(() => {
    if (!active) return

    const onMouseMove = (e: MouseEvent) => {
      const cur = dragRef.current
      if (!cur) return
      if (!cur.dragging) {
        // 未到 350ms：移动超过阈值视为拖拽开始（不必死等长按）
        const origin = dragOrigin.current
        if (!origin) return
        if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < 6) return
        clearTimer()
        setDragState(prev => (prev ? { ...prev, dragging: true, clientX: e.clientX, clientY: e.clientY } : null))
      } else {
        setDragState(prev => (prev ? { ...prev, clientX: e.clientX, clientY: e.clientY } : null))
      }
      const row = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-step-row]')
      setDropTargetIndex(row ? dropIndexAt(row, e.clientY) : null)
    }

    const onMouseUp = (e: MouseEvent) => {
      const cur = dragRef.current
      if (!cur) return
      if (cur.dragging) {
        // 拖拽中松手 = 落子/取消
        commitDrop(e.clientX, e.clientY)
      } else {
        // 350ms 内原地松手 = 普通点击
        cancelDrag()
      }
    }

    const onClick = (e: MouseEvent) => {
      // 兜底：mouseup 发生在窗口外等情况时，下一次点击直接结算
      const cur = dragRef.current
      if (!cur || !cur.dragging) return
      commitDrop(e.clientX, e.clientY)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelDrag()
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('click', onClick, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.userSelect = ''
    }
  }, [active, taskId, dropIndexAt, onReorder, cancelDrag, commitDrop])

  useEffect(() => () => clearTimer(), [clearTimer])

  return { dragState, dropTargetIndex, startDrag, cancelDrag }
}
