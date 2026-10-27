/**
 * 记忆列表的分页窗口工具（纯函数，无 React 依赖），决策边界由 test/client-paging.test.mjs 钉住。
 * 协议：`/tasks insight list <scope> <offset> <limit>` → `{ scope, count, total, offset, items, nextOffset }`，
 * 对应宿主 src/commands/insight-actions.js 的 `list` 分支；`nextOffset === null` 到底，缺字段按全量降级。
 */

/** 每页条数。宿主侧 INSIGHT_PAGE_MAX=200 是防滥用封顶，正常永远走这个值。 */
export const PAGE_SIZE = 30

/**
 * 单次请求的条数上限，必须与宿主 `INSIGHT_PAGE_MAX`（src/commands/insight-actions.js）一致；
 * 客户端 bundle 不能 import 服务端模块，所以这里是第二份常量，test/insight-paging.test.mjs
 * 有交叉断言把两边钉在一起。
 * 宿主对超限的 `limit` 是**静默**夹到 200：动作后的重放整份替换，加载了 500 条的用户点一次
 * 动作就会被打回 200 条，所以必须先在客户端夹住。
 */
export const HOST_PAGE_MAX = 200

/** 预取提前量：哨兵进入视口**下方 600px** 就开始取下一页，数据在滚到底之前到位。 */
export const PREFETCH_MARGIN = '600px 0px'

/** 加载指示的延迟显示阈值（毫秒）：本地数据通常几十毫秒就回来，立即显示只会"闪一下"。 */
export const SPINNER_DELAY_MS = 150

/**
 * 拼一页的请求命令行：数据通道是命令文本，协议只在这里拼一次。
 * @param {string} scope - `task` | `project` | `global`。
 * @param {number} offset - 起始下标。
 * @param {number} limit - 本页条数。
 * @returns {string} 可直接交给 remote.commands.execute 的命令行。
 */
export function insightListLine(scope, offset, limit) {
  return `/tasks insight list ${scope} ${offset} ${limit}`
}

/**
 * 追加一页并**按 id 去重**。去重是必需的：前缀重放（见 {@link reloadWindowRequest}）与并发
 * 刷新都可能让同一 id 出现两次，重复行带重复按钮，点错一个就是误删。
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
 * 动作（archive/delete/promote…）之后的重载窗口：刷新**已加载的整个前缀**而非重置成第一页（否则
 * 会把正在看第 5 页的用户弹回顶部）；用 offset 分页而非 keyset 游标正是为了让"把 0..N 重取一遍"
 * 可行。**上限**：宿主单页最多 {@link HOST_PAGE_MAX} 条且静默截断，`limit` 在这里夹住，余下的由 `nextOffset` 追加。
 * @param {number} loadedCount - 当前已渲染条数。
 * @param {number} [pageSize] - 每页条数下界，保证至少取一页。
 * @returns {{offset: number, limit: number}} 重放请求窗口（limit ≤ HOST_PAGE_MAX）。
 */
export function reloadWindowRequest(loadedCount, pageSize = PAGE_SIZE) {
  const count = Number.isFinite(loadedCount) && loadedCount > 0 ? Math.floor(loadedCount) : 0
  return { offset: 0, limit: Math.min(HOST_PAGE_MAX, Math.max(pageSize, count)) }
}

/**
 * 把宿主载荷归一成窗口状态，兼容三种形态：新宿主分页（有 `total` + `nextOffset`）、新宿主不
 * 分页（省略 limit，`nextOffset === null`）、老宿主/老 bundle（两个字段都没有 → 视为一次给全）。
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
 * 请求闸门：协调首屏 / 追加 / 动作后重放这几类**会重叠**的请求。两件事必须分开：
 *   - **过期响应丢弃**（靠序号 + 作用域判定）；
 *   - **新请求照发**（只有同一个 key 正在飞时才去重，避免哨兵连续触发重复取同一页）。
 * 用"有在途请求就直接 return"的布尔守卫会让切 scope 时新请求被丢掉、过期响应又被作用域检查
 * 丢掉 → 新列表永远空白。
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
