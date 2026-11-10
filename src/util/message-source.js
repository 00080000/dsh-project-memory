/**
 * 本插件注入消息的生产者判据。放在 util 里：注入对账（inject-visible）与注入引擎
 * （auto-inject）都要用，但前者被后者 import，反向依赖会成环。
 */

export const SOURCE_KIND = 'plugin:dsh-project-memory'

/**
 * 三种写法都要认，因为同一条历史消息在不同阶段形状不同：
 * `plugin:dsh-project-memory`（现在写的，也是迁移结果）、`project-memory`（保留的别名）、
 * `plugin: 'dsh-project-memory'`（迁移前尚未落盘的旧形状）。
 * @param {object|undefined|null} source - message.source
 * @returns {boolean}
 */
export function isOwnInjection(source) {
  if (!source || typeof source !== 'object') return false
  return source.kind === SOURCE_KIND
    || source.kind === 'project-memory'
    || source.plugin === 'dsh-project-memory'
}
