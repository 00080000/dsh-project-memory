/**
 * 后台索引失败的进程内账本：只负责"把静默失败报出来"，不落盘。
 *
 * watch 的失败过去只打一行日志，懒索引的单文件失败甚至整段吞掉（`catch {}`），于是
 * "某些文件一直没进语料"没有任何可观察面。这里按根记住最近失败的 rel 与原因，
 * 由 index_repo / pm_stats 一并报出。
 *
 * 不持久化是刻意的：watch 每轮都会重试，问题仍在时失败会重新登记；重启后立刻又能看见。
 */

const MAX_PER_ROOT = 50
const byRoot = new Map()

export function recordIndexFailure(root, rel, message) {
  let failures = byRoot.get(root)
  if (!failures) {
    failures = new Map()
    byRoot.set(root, failures)
  }
  failures.set(rel, { message: message || 'index failed', at: Date.now() })
  // 上限只防失控（一次坏掉上千个文件时别把内存吃掉）；超出就丢最早登记的。
  if (failures.size > MAX_PER_ROOT) failures.delete(failures.keys().next().value)
}

export function clearIndexFailure(root, rel) {
  const failures = byRoot.get(root)
  if (!failures) return
  failures.delete(rel)
  if (failures.size === 0) byRoot.delete(root)
}

/** 按最近失败时间倒序返回 `{ count, items }`；`items` 至多 limit 条。 */
export function listIndexFailures(root, limit = 5) {
  const failures = byRoot.get(root)
  if (!failures) return { count: 0, items: [] }
  const items = [...failures.entries()]
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, Math.max(0, limit))
    .map(([rel, value]) => ({ rel, message: value.message }))
  return { count: failures.size, items }
}

/** 测试用：账本是模块级状态，用例之间要能清干净。 */
export function _resetIndexFailuresForTest() {
  byRoot.clear()
}
