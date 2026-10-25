/**
 * 退出/卸载前的最后一道写盘兜底。
 *
 * 为什么需要：保存失败后的后台重试**不能**当正确性保证——用户结束对话、关掉 dsh 时不会等
 * 20s 的重试。正确性来自两点：① `save()` 在锁竞争时同步等待（见 store.js 的 LOCK_WAIT_MS）；
 * ② 万一仍失败，进程正常退出或插件卸载时再同步写一次。
 *
 * 注册的是脏 store（而不是所有 store）：只有内存里还有未落盘变更的才需要 flush。
 * `process.on('exit')` 只允许同步代码，`save()` 本身是同步的，所以这里直接调用。
 * 信号导致的异常退出（SIGKILL / 未处理的 SIGINT）不保证走到这里——那是操作系统的边界。
 */

/** @type {Set<{ flushPending?: (timeoutMs: number) => boolean }>} */
const pending = new Set()
let installed = false

function install() {
  if (installed) return
  installed = true
  process.on('exit', () => {
    flushDirtyStores({ timeoutMs: 1500 })
  })
}

/**
 * 标记"这个 store 有未落盘的变更"。
 * @param {{ flushPending?: (timeoutMs: number) => boolean }} store
 */
export function trackDirty(store) {
  pending.add(store)
  install()
}

/**
 * 落盘成功后取消标记。
 * @param {object} store
 */
export function untrackDirty(store) {
  pending.delete(store)
}

/**
 * 同步 flush 所有脏 store。退出钩子与插件 disposer 共用；测试可直接调用。
 * @param {{ timeoutMs?: number }} [opts] 每个 store 最多等锁多久（退出路径要短，避免"关不掉"）
 * @returns {number} 成功落盘的 store 数
 */
export function flushDirtyStores({ timeoutMs = 1500 } = {}) {
  let saved = 0
  for (const store of [...pending]) {
    try {
      if (typeof store.flushPending === 'function' && store.flushPending(timeoutMs)) saved++
    } catch {
      // 退出路径上的失败只能放弃：不抛、不打印，避免把关闭流程变成错误弹窗
    }
  }
  return saved
}

/** 仅供测试：当前还有多少个脏 store 挂着。 */
export function _pendingDirtyCountForTest() {
  return pending.size
}
