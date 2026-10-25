/**
 * 落盘失败的可见性策略：**默认静默**。
 *
 * `ProjectMemoryStore.save()` / `GlobalStore.commit()` 拿不到跨进程写锁时会保持脏状态并返回
 * false；调用方（工具）**不再**追加任何面向用户/模型的警告。理由（作者 2026-10-25 决定）：
 *
 * - 记忆写入是幂等的（经验笔记除外，但重写一次的成本也很低），失败不是数据灾难；
 * - 终端/回复里的错误提示已经够多，"这次没写进磁盘"属于正常降级，不该打断用户；
 * - 长期运行的宿主会在后台重试（store 最多 ~20s），大概率在用户察觉前就写进去了。
 *
 * 排查需要时：`DSH_PROJECT_MEMORY_DEBUG=1` 才打印一行（每个 store 进程内最多一次）。
 * 内部状态 `store.lastSaveOk` / `globalStore.lastCommitOk` 仍然保留，供测试与将来的诊断面使用。
 */

/** 是否输出落盘失败的诊断行。默认关闭：安静是默认行为。 */
export function persistenceDebugEnabled() {
  return process.env.DSH_PROJECT_MEMORY_DEBUG === '1'
}

/**
 * 按需输出一行诊断。调用方负责"只打一次"的去重。
 * @param {string} message
 */
export function debugPersistence(message) {
  if (!persistenceDebugEnabled()) return
  console.error(message)
}
