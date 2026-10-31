/**
 * 配置读取的唯一入口。
 *
 * Config 里标了 `.volatile()` 的字段由宿主注入成 **ref**（`{ get() }`）——这是设置页
 * 「改完立即生效、不重启插件」的代价：同一个 `config` 对象上，volatile 字段是 ref、
 * 其余字段仍是普通值。直接写 `if (config.watch)` 会把 ref 对象当成永远为真（watch 关不掉），
 * 所以所有读取点都走 {@link cfg}。
 *
 * 为什么不用顶层 `inject` 或每次读 `config.x.get()`：ref 与值混在一行会让「这个键是活的吗」
 * 变成隐式知识；`cfgValue()` 两种形状都给同一个答案，改字段的 volatile 属性不需要连带改读取点。
 */

/**
 * 读一个顶层配置字段的**当前值**。
 * @param {object | undefined} config 插件 Config
 * @param {string} key 顶层字段名
 * @returns {*} 字段值；volatile 字段取 `ref.get()`
 */
export function cfgValue(config, key) {
  const value = config?.[key]
  return value && typeof value.get === 'function' ? value.get() : value
}

let warnedNoVolatile = false
/**
 * 把 schema 标成 volatile；宿主 schemastery < 3.18.3 时降级为普通值。
 *
 * `.volatile()` 是 3.18.3 才有的方法，而 peer 范围曾经写成 `^3.18.1`：旧宿主在
 * **模块加载期**执行 `Schema.boolean().default(false).volatile()` 会直接抛 TypeError，插件
 * 整个起不来。这里做一次特性探测：方法不在就原样返回（设置页不可用，但 cfgValue 仍能读值，
 * 插件其余功能正常），并只告警一次。
 * @template T
 * @param {T} schema 任意 schemastery schema
 * @returns {T}
 */
export function asVolatile(schema) {
  const method = schema?.volatile
  if (typeof method === 'function') return method.call(schema)
  if (!warnedNoVolatile) {
    warnedNoVolatile = true
    console.warn(
      '[dsh-project-memory] host schemastery has no .volatile() (needs >= 3.18.3); ' +
        'visual settings are unavailable, config values stay static',
    )
  }
  return schema
}

/**
 * 把 `loader/volatile-update` 的路径列表归成顶层字段名集合。
 *
 * 空路径 `[]` 表示整份 Config 都可能变了：返回 `null`（调用方按「全部重读」处理），
 * 而不是一个空集合——空集合会被读成「什么都没变」，正好是相反的结论。
 * @param {readonly (readonly string[])[] | undefined} paths 变更路径
 * @returns {Set<string> | null} 顶层字段名；`null` = 全部
 */
export function changedConfigKeys(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return null
  const keys = new Set()
  for (const path of paths) {
    if (!Array.isArray(path) || path.length === 0) return null
    keys.add(path[0])
  }
  return keys
}
