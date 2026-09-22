/**
 * 会话列表快照 → 当前会话 id（宿主版本兼容层）。
 *
 * 快照结构被宿主改过一次，旧写法只认第一种：
 *   - dsh ≤0.1.6：`{ current?: id, items: [{ sessionId, blank }] }`
 *   - dsh 0.1.7+：`{ ids: id[], byId: Record<id, SessionSummary>, phase, projectionsBySession }`
 *     —— `current` 与 `items` **都不存在了**。
 *
 * 后果一（永远 null）：0.1.7 上 `snap.current` 和 `snap.items` 都是 undefined → 旧代码永远
 * 返回 null → 面板显示「还没有会话」、记忆视图报 `同步失败: no session / commands service`。
 * 而**任务视图渲染的是 task-data-store 里的缓存快照**，看起来还正常，所以这个故障很容易被
 * 误读成"数据格式/旧版本兼容"问题。
 *
 * 后果二（不跟随切换）：光"取一个非 null 的 id"不够 —— 兜底取的是宿主列表里第一个非 blank 的
 * 会话，它**不随用户切换对话而变化**，面板会一直停在同一个会话（从而显示错项目的任务）。
 * 0.1.7 判断"当前会话"的正式依据是 `SessionSummary.retainedBy.mainView > 0`：
 * 主视图正在 retain 的那个就是用户正在看的那个（第一方同款判据，见 ui-layout/DocumentTitle.tsx
 * 与 ui-session）。它就在**列表快照的 byId 行上**，而 retain 计数变化会 `list.set(...)` 重新发布
 * 快照（session-controller/.../sessions/service.ts 的 publishRetention），所以订阅
 * `ctx.sessions.list` 的组件会在切换会话时自动重渲染 —— 这条必须走快照内字段，不能另开
 * `retainInfo()` 订阅，否则切换不会触发重渲染。
 *
 * 实测形状见 `packages/api/session-controller/src/client/sessions/service.ts` 的
 * `SessionListState` / `SessionSummary`。
 */

/** 正数才算持有（retain 计数缺失/0/负数一律当没有）。 */
function heldCount(value) {
  return typeof value === 'number' && value > 0 ? value : 0
}

/** 从一行 summary 抽出本模块关心的三个事实。 */
function rowFacts(row) {
  return {
    blank: row?.blank === true,
    /** 主视图对这条会话的 retain 计数；> 0 即"用户正在看它"。 */
    mainView: heldCount(row?.retainedBy?.mainView),
  }
}

/**
 * 把两种快照形状统一成 `{ id, blank, mainView }` 列表，顺序保持宿主给的顺序。
 * @param {object|undefined|null} snap - `ctx.sessions.list.getSnapshot()`
 * @returns {Array<{id: string, blank: boolean, mainView: number}>} 认不出的形状返回空数组
 */
export function sessionRows(snap) {
  if (!snap || typeof snap !== 'object') return []
  // 旧形状：items 里每行自带 sessionId / blank / retainedBy
  if (Array.isArray(snap.items)) {
    return snap.items
      .map((row) => ({ id: row?.sessionId, ...rowFacts(row) }))
      .filter((row) => typeof row.id === 'string' && row.id !== '')
  }
  const byId = snap.byId && typeof snap.byId === 'object' ? snap.byId : null
  // 0.1.7 形状：ids 表达宿主列表成员（顺序权威），行数据在 byId 里
  if (Array.isArray(snap.ids)) {
    return snap.ids
      .map((id) => ({ id, ...rowFacts(byId?.[id]) }))
      .filter((row) => typeof row.id === 'string' && row.id !== '')
  }
  // 只有 byId 的半成品形状：仍然可用，只是丢了宿主顺序
  if (byId) {
    return Object.keys(byId)
      .map((id) => ({ id, ...rowFacts(byId[id]) }))
      .filter((row) => typeof row.id === 'string' && row.id !== '')
  }
  return []
}

/**
 * 选出一个可用于执行命令的会话 id（即"用户正在看的那个"）。
 *
 * 优先级：
 *  1. 旧形状的显式 `current`（≤0.1.6 的权威字段，保持原语义）；
 *  2. `retainedBy.mainView > 0` 的会话（0.1.7 的权威判据，**跟随会话切换**）；
 *  3. 第一个非 blank → 第一个（对两种形状都适用的兜底）。
 * @param {object|undefined|null} snap - `ctx.sessions.list.getSnapshot()`
 * @returns {string|null} 会话 id；拿不到返回 null（调用方据此显示「还没有会话」）
 */
export function pickSessionId(snap) {
  if (!snap || typeof snap !== 'object') return null
  if (typeof snap.current === 'string' && snap.current !== '') return snap.current
  const rows = sessionRows(snap)
  const live = rows.find((row) => row.mainView > 0)
  if (live) return live.id
  const chosen = rows.find((row) => !row.blank) ?? rows[0]
  return chosen ? chosen.id : null
}
