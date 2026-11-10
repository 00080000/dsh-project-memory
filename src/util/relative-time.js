/**
 * 相对时间（中文）的唯一实现：面板、`list_tasks`、`/tasks` 共用。
 *
 * 两处调用方对"时间坏掉"的期待不同，所以 fallback 是参数而不是第二份实现：
 *   - 服务端把条目交给模型，省略时间会像"没有时间信息"，默认 `'未知'`；
 *   - 面板是给人看的，时间坏了就留空，不显示脏字。
 *
 * 客户端旧副本用 `new Date(iso).getTime()` 直接算 diff：非法 ISO 得到 NaN，一路比较都不成立，
 * 最后渲染成 "NaN天前"。收敛到这一份后，非法/缺失时间一律走 fallback（而不是各写一套判据）。
 * @param {string} [iso] ISO 时间戳
 * @param {string} [fallback] 解析失败时的文案
 * @returns {string}
 */
export function timeAgo(iso, fallback = '未知') {
  const t = Date.parse(iso ?? '')
  if (!Number.isFinite(t)) return fallback
  const diff = Date.now() - t
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  return `${Math.floor(h / 24)}天前`
}
