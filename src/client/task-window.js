/**
 * 任务列表的渐进渲染窗口（纯函数，无 React 依赖）。
 *
 * 任务数据整份都在面板载荷里（`/tasks` 快照，单任务的步骤/文件已由服务端截断），
 * 这里只决定**渲染多少张卡**：首屏 TASK_PAGE_SIZE 张，滚到列表底部由哨兵放出下一批。
 * 不改变服务端给的顺序，也不动已展开卡片的 UI 状态——只是把 DOM 数量跟视口挂钩。
 * 决策边界由 test/client-task-window.test.mjs 钉住。
 */

/** 每批渲染的任务卡数。卡片比记忆行高（约 70px 起，展开后更高），批次取小些。 */
export const TASK_PAGE_SIZE = 12

/**
 * 哨兵的预取余量。这里故意是 0：任务数据本来就在载荷里，放下一批是同步的、没有等待，
 * 预取只会让"首屏 12 张"变成"首屏 24 张"（12 张折叠卡约 520px，600px 的预取带宽会立刻
 * 再触发一次）。滚到列表底部时下一批当场出现，用户看不到加载态。
 */
export const TASK_PREFETCH_MARGIN = '0px'

/**
 * 再放一批之后渲染到第几张。
 * @param {number} current - 当前渲染上限。
 * @param {number} total - 当前活跃任务总数。
 * @param {number} [step] - 每批张数，默认 TASK_PAGE_SIZE。
 * @returns {number} 新的渲染上限：不超过 total，也不比 current 小（非法输入按 0 起算）。
 */
export function nextTaskCount(current, total, step = TASK_PAGE_SIZE) {
  const t = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
  if (t === 0) return 0
  const s = Number.isFinite(step) && step > 0 ? Math.floor(step) : TASK_PAGE_SIZE
  const c = Number.isFinite(current) && current > 0 ? Math.floor(current) : 0
  return Math.min(t, c + s)
}
