/**
 * 落盘失败的统一口径。
 *
 * `ProjectMemoryStore.save()` / `GlobalStore.commit()` 拿不到跨进程写锁时会保持脏状态并返回失败；
 * 但工具层过去照样返回 "Saved …" / `success: true`，用户与模型都以为写进去了（实测：一次
 * 崩溃残留锁让 `remember` 报成功而 `insights.json` 根本没生成）。
 *
 * 这里只做两件事：判断某次写是否落盘、给出一句人话。**不重试**——后台重试由 store 自己做。
 */

export const NOT_PERSISTED_NOTE =
  'WARNING: the change is only in memory — it was NOT written to disk because another dsh process holds the write lock. '
  + 'The host retries in the background; if this session ends before that, run the same call again.'

/**
 * @param {{lastSaveOk?: boolean}|null|undefined} store - ProjectMemoryStore
 * @param {{lastCommitOk?: boolean}|null|undefined} [globalStore] - GlobalStore（可选）
 * @returns {boolean} 是否发生了"内存成功、磁盘失败"
 */
export function persistFailed(store, globalStore) {
  return store?.lastSaveOk === false || globalStore?.lastCommitOk === false
}
