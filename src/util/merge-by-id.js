/**
 * 跨进程按 id 合并同一份条目列表（project/global insights 与任务内嵌 insights 共用一份实现）。
 *
 * 这套判据原先在 `store.js` 的 insights 合并、`insight-store.js` 的 global 合并与 `store.js`
 * 的 `mergeTaskInsights` 里各抄一份，而 in-memory 守卫已经漂移（两份用 `isRecord`、一份只判
 * `?.id`）。三处必须对同一份历史给出同一个结果：磁盘缺条目到底是"对方删了"还是"我还没写"，
 * 判错的代价分别是**复活已删记忆**与**静默丢一次写入**，都不是展示问题。
 *
 * 三条判据，按顺序：
 *   1. 墓碑：本进程删掉的 id 一律不写回——磁盘上的副本也不能让它复活；
 *   2. 磁盘缺、本地有：只有**本进程新建**的条目才补写；否则是对方删了，丢掉本地旧副本；
 *   3. 两边都有：`updatedAt` 新者胜，**平手取本地**（`>=`）。本地刚改的条目与磁盘同毫秒时
 *      相信本进程的改动；反过来会在"写盘前又读回旧值"时静默覆盖刚做的修改。
 *
 * 脏数据（null / 数组 / 无 id）两边都跳过：一次合并不该把脏值写进磁盘，也不该让整次合并
 * 抛错。现存数据不受影响（真实 store 的 96/56/2 条全是带字符串 id 与 ISO `updatedAt` 的对象）。
 *
 * 顺序：磁盘条目在前（Map 保持插入序），本进程新建的按本地顺序追加。
 * @module dsh-project-memory/util/merge-by-id
 */

import { isRecord, newerIso } from './value.js'

const NONE = new Set()

/**
 * 合并磁盘与内存里的条目列表。
 * @param {object} args
 * @param {unknown} args.diskItems - 磁盘上读到的数组；非数组（文件缺失/损坏/旧形状）返回 null，
 *   由调用方决定"保留内存副本"还是"过滤脏值后写回"——两种 fail-safe 由各自的存储语义决定。
 * @param {unknown} args.localItems - 本进程内存里的数组；非数组按空处理。
 * @param {Set<string>} [args.deletedIds] - 本进程删掉的 id（墓碑）。
 * @param {Set<string>} [args.createdIds] - 本进程新建的 id（磁盘缺失时允许补写）。
 * @returns {object[] | null} 合并结果；`diskItems` 不是数组时为 null。
 */
export function mergeById({ diskItems, localItems, deletedIds = NONE, createdIds = NONE }) {
  if (!Array.isArray(diskItems)) return null
  const deleted = deletedIds || NONE
  const created = createdIds || NONE
  const byId = new Map()
  for (const item of diskItems) if (isRecord(item) && item.id) byId.set(item.id, item)
  for (const item of Array.isArray(localItems) ? localItems : []) {
    if (!isRecord(item) || !item.id) continue
    if (deleted.has(item.id)) continue
    const prev = byId.get(item.id)
    if (!prev) {
      // 磁盘没有：本进程新建的才补写；否则是**对方删了**，丢掉内存里的旧副本。
      if (created.has(item.id)) byId.set(item.id, item)
      continue
    }
    if (newerIso(item.updatedAt, prev.updatedAt) >= 0) byId.set(item.id, item)
  }
  // 墓碑最后统一删：本地数组里已经移除的条目（原地 splice）不会出现在上面的循环里。
  for (const id of deleted) byId.delete(id)
  return [...byId.values()]
}
