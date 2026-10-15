/**
 * 记忆列表的分页窗口工具（纯函数，无 React 依赖）。
 *
 * 为什么要单独成模块：客户端测试跑的是一个**手写的 React 替身**
 * （`useState` 的 setter 是 no-op、`useEffect` 由测试手动触发，见 test/client-toolview.test.mjs），
 * 它验证不了"滚到底 → 追加渲染"这类行为。所以把分页的**决策**收敛成纯函数：
 * 拼命令、算下一页窗口、追加去重、判定是否还有更多——边界由
 * test/client-paging.test.mjs 直接钉住，组件只负责把结果接到渲染上。
 *
 * 协议约定（与宿主 src/commands/insight-actions.js 的 `list` 分支一一对应）：
 *   `/tasks insight list <scope> <offset> <limit>` → 载荷 `{ scope, count, total, offset, items, nextOffset }`
 * `nextOffset === null` 表示到底；载荷缺这些字段（老宿主）时按"一次性返回全部"降级处理。
 */

/** 每页条数。宿主侧 INSIGHT_PAGE_MAX=200 是防滥用的封顶，正常永远走这个值。 */
export const PAGE_SIZE = 30

/**
 * 预取提前量：哨兵进入视口**下方 600px** 就开始取下一页，
 * 让用户在真正滚到底之前数据已经到位——这是"无感"的来源，不是滚到底再转圈。
 */
export const PREFETCH_MARGIN = '600px 0px'

/**
 * 加载指示的延迟显示阈值（毫秒）。本地数据通常几十毫秒就回来，
 * 立即显示加载行只会造成"闪一下"；超过这个时间才认为用户真的在等。
 */
export const SPINNER_DELAY_MS = 150

/**
 * 拼一页的请求命令行。数据通道是命令文本，协议只在这里拼一次。
 * @param {string} scope - `task` | `project` | `global`。
 * @param {number} offset - 起始下标。
 * @param {number} limit - 本页条数。
 * @returns {string} 可直接交给 remote.commands.execute 的命令行。
 */
export function insightListLine(scope, offset, limit) {
  return `/tasks insight list ${scope} ${offset} ${limit}`
}

/**
 * 追加一页并**按 id 去重**。去重是必需的不是防御性的：前缀重放（见
 * {@link reloadWindowRequest}）与并发刷新都可能让同一 id 出现两次，重复行会带上
 * 重复的按钮，点错一个就是误删。
 * @param {ReadonlyArray<{id?: string}>} prev - 已渲染条目。
 * @param {ReadonlyArray<{id?: string}>} page - 新到的一页。
 * @returns {Array} 追加后的数组；无新增时**原样返回** prev（避免无意义的重渲染）。
 */
export function appendUnique(prev, page) {
  if (!Array.isArray(page) || page.length === 0) return prev
  const seen = new Set(prev.map((row) => row && row.id))
  const fresh = page.filter((row) => row && !seen.has(row.id))
  if (fresh.length === 0) return prev
  return [...prev, ...fresh]
}

/**
 * 动作（archive/delete/promote…）之后的重载窗口：刷新**已加载的整个前缀**，
 * 而不是重置成第一页——后者会把正在看第 5 页的用户直接弹回顶部。
 *
 * 用 offset 分页而不是 keyset 游标，正是为了让这条路可行：游标只能"往后翻"，
 * 表达不了"把 0..N 重取一遍"。删除/归档导致的窗口收缩下，前缀重取依然不重不漏。
 * @param {number} loadedCount - 当前已渲染条数。
 * @param {number} [pageSize] - 每页条数下界，保证至少取一页。
 * @returns {{offset: number, limit: number}} 重放请求窗口。
 */
export function reloadWindowRequest(loadedCount, pageSize = PAGE_SIZE) {
  const count = Number.isFinite(loadedCount) && loadedCount > 0 ? Math.floor(loadedCount) : 0
  return { offset: 0, limit: Math.max(pageSize, count) }
}

/**
 * 把宿主载荷归一成窗口状态，兼容三种形态：
 *   - 新宿主分页：有 `total` + `nextOffset`；
 *   - 新宿主不分页（省略 limit）：`nextOffset === null`；
 *   - 老宿主/老 bundle：两个字段都没有 → 视为"一次给全，没有下一页"。
 * @param {any} data - 已解析的 JSON 载荷。
 * @param {number} fallbackOffset - 请求时的 offset（载荷没给 offset 时用它）。
 * @returns {{items: any[], total: number, offset: number, nextOffset: number|null}} 归一化窗口。
 */
export function normalizeWindow(data, fallbackOffset = 0) {
  const items = Array.isArray(data && data.items) ? data.items : []
  const rawTotal = data && typeof data.total === 'number' ? data.total : data && typeof data.count === 'number' ? data.count : items.length
  const total = Number.isFinite(rawTotal) && rawTotal >= 0 ? rawTotal : items.length
  const offset = data && Number.isFinite(data.offset) ? data.offset : fallbackOffset
  const next = data && data.nextOffset
  const nextOffset = typeof next === 'number' && Number.isFinite(next) && next >= 0 ? next : null
  return { items, total, offset, nextOffset }
}

/**
 * 页脚文案用的"已显示 N / 总数"。
 * @param {number} loaded - 已渲染条数。
 * @param {number} total - 服务端总数。
 * @returns {{loaded: number, total: number}} 归一化后的计数（total 不会小于 loaded）。
 */
export function progressCounts(loaded, total) {
  const l = Number.isFinite(loaded) && loaded > 0 ? Math.floor(loaded) : 0
  const t = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
  return { loaded: l, total: Math.max(l, t) }
}

/**
 * 请求闸门：协调首屏 / 追加 / 动作后重放这几类**会重叠**的请求。
 *
 * 这里踩过一个坑，规则就是照着它定的：早期实现用"有在途请求就直接 return"的布尔守卫。
 * 于是"上一页还在飞的时候切 scope（或点动作）"时，新请求被**直接丢掉**，而过期响应又
 * 被作用域检查丢掉 → 新列表永远空白，只能手动刷新才出来。正确语义是两件事分开：
 *   - **过期响应丢弃**（靠序号 + 作用域判定）；
 *   - **新请求照发**（只有同一个 key 正在飞时才去重，避免哨兵连续触发重复取同一页）。
 * @returns {{begin: Function, end: Function, isStale: Function}} 闸门。
 */
export function createRequestGate() {
  let seq = 0
  let inflightKey = null
  return {
    /**
     * 申请发起一次请求。
     * @param {string} key - 请求身份（scope|offset|limit|append）。
     * @returns {number|false} 该请求的序号；同一 key 已在飞时返回 false（去重）。
     */
    begin(key) {
      if (inflightKey === key) return false
      inflightKey = key
      seq += 1
      return seq
    },
    /**
     * 请求结束。
     * @param {string} key - 请求身份。
     * @param {number} ticket - begin 返回的序号。
     * @returns {boolean} 它是否仍是最后一次请求（决定加载标志该不该回落）。
     */
    end(key, ticket) {
      if (inflightKey === key) inflightKey = null
      return ticket === seq
    },
    /**
     * 该响应是否已过期。
     * @param {number} ticket - 发出时的序号。
     * @param {string} requestedScope - 发出时的作用域。
     * @param {string} currentScope - 当前作用域。
     * @returns {boolean} true=必须整份丢弃。
     */
    isStale(ticket, requestedScope, currentScope) {
      return ticket !== seq || requestedScope !== currentScope
    },
  }
}
