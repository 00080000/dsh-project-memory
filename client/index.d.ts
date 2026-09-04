//#region src/client/index.d.ts
/**
 * Required primitives that may not exist on older hosts.
 * If missing, we skip registration gracefully.
 */
declare const REQUIRED_PRIMITIVES: readonly ["Button", "IconChevronDownOutline14", "IconChevronUpOutline14", "IconCloseOutline16", "IconMinimizeOutline14", "IconCheckCircleOutline14", "IconCircleOutline14", "IconPlayCircleOutline14", "IconFolderOutline14", "IconFileOutline14"];
declare function missingPrimitives(mod: Record<string, unknown>, required?: readonly string[]): string[];
/**
 * Minimal host context shape we need (structural typing, no internal deps)
 */
interface TaskPanelHostContext {
  effect(callback: () => unknown, label?: string): void;
  on(event: string, callback: () => void): () => void;
  off(event: string, callback: () => void): void;
  commands: {
    execute(name: string, args: unknown): Promise<unknown>;
  };
  slots: {
    inject(name: string, register: () => unknown): void;
    register(options: Record<string, unknown>, render: () => unknown): unknown;
  };
}
declare const name = "dsh-project-memory";
declare function apply(ctx: TaskPanelHostContext): void;
//#endregion
export { REQUIRED_PRIMITIVES, apply, missingPrimitives, name };
//# sourceMappingURL=index.d.ts.map