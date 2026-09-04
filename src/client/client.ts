/**
 * dsh-project-memory Client Entry
 * Registers Task Panel in conversation.overlay slot for floating panel
 */
import { h } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { taskStore } from './task-store.ts'
import { TaskPanelEntry } from './TaskPanel.tsx'

const NS = 'dsh-project-memory'

/**
 * Required primitives that may not exist on older hosts.
 * If missing, we skip registration gracefully.
 */
export const REQUIRED_PRIMITIVES = [
  'Button',
  'IconChevronDownOutline14',
  'IconChevronUpOutline14',
  'IconCloseOutline16',
  'IconMinimizeOutline14',
  'IconCheckCircleOutline14',
  'IconCircleOutline14',
  'IconPlayCircleOutline14',
  'IconFolderOutline14',
  'IconFileOutline14',
] as const

export function missingPrimitives(
  mod: Record<string, unknown>,
  required: readonly string[] = REQUIRED_PRIMITIVES
): string[] {
  return required.filter(name => mod[name] === undefined)
}

/**
 * Minimal host context shape we need (structural typing, no internal deps)
 */
interface TaskPanelHostContext {
  effect(callback: () => unknown, label?: string): void
  on(event: string, callback: () => void): () => void
  off(event: string, callback: () => void): void
  commands: {
    execute(name: string, args: unknown): Promise<unknown>
  }
  slots: {
    inject(name: string, register: () => unknown): void
    register(options: Record<string, unknown>, render: () => unknown): unknown
  }
}

export const name = NS

export function apply(ctx: TaskPanelHostContext): void {
  // Check required primitives
  const gaps = missingPrimitives(primitives as unknown as Record<string, unknown>)
  if (gaps.length > 0) {
    console.warn(
      `[${NS}] host ui-primitives missing ${gaps.join(', ')} — task panel disabled`
    )
    return
  }

  // Register floating panel in conversation.overlay slot
  // This renders above conversation but below modals/toasts
  ctx.slots.inject('conversation.overlay', () => {
    return ctx.slots.register(
      {
        name: 'conversation.overlay',
        id: 'dsh-project-memory-task-panel',
        order: 50, // Below modals (100) but above conversation content
        locale: NS,
      },
      () => h(TaskPanelEntry, { ctx })
    )
  })
}