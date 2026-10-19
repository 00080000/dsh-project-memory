/**
 * 跨标签页任务广播的**项目作用域**判定（纯函数，无 React / 无 BroadcastChannel 依赖）。
 *
 * 为什么需要它：同步频道名是固定的（同一浏览器同源的所有 dsh 页面共用一个
 * `dsh-pm-tasks-data`），而消息体只带任务数组。没有作用域判定时，在 A 项目点一下刷新，
 * B 项目的标签页面板就会被贴上 A 的任务列表——它自己保留着 B 的 `boundTaskId`，
 * 于是表现为"绑定莫名丢了"。频道名不能按项目拆：项目根是数据到达后才知道的，
 * 而 `new BroadcastChannel` 在模块加载期就要定名。
 *
 * 判据刻意**严格**：消息里没有根、或本页还没确定根，都不接受。
 *  - 无根：老宿主/老 bundle 的载荷，宁可不同步也不猜；
 *  - 本页未知根：它自己那一次 `/tasks` 会决定归属，不先借别人的数据（避免短暂显示错项目）。
 * 两侧都已知且相等时才接受——这正是"同一项目的两个标签页"。
 *
 * @param {string|null|undefined} localRoot - 本页当前数据的项目根（未同步过为 null）
 * @param {unknown} incomingRoot - 广播消息里的项目根
 * @returns {boolean} true = 这条广播属于同一个项目，可以套用
 */
export function broadcastAppliesTo(localRoot, incomingRoot) {
  if (typeof incomingRoot !== 'string' || incomingRoot === '') return false
  if (typeof localRoot !== 'string' || localRoot === '') return false
  return localRoot === incomingRoot
}

/**
 * 从 `/tasks` 载荷里取项目根（旧宿主没有该键）。
 * @param {unknown} value - `payload.root`
 * @returns {string|null} 非空字符串才算根
 */
export function payloadRoot(value) {
  return typeof value === 'string' && value !== '' ? value : null
}
