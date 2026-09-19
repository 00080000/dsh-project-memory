/**
 * 会话级状态的容量管理。
 *
 * 注入引擎有六张「每会话一份」的表（注入指纹 / 丢弃签名 / 已注入条目 / 步号 / 额度 / 动作观察窗）。
 * 它们各自都需要淘汰最旧会话，于是同一个 `while (map.size > CAP) delete(oldest)` 被抄了五遍——
 * 容量上限写在五处，抄漏一处就是无界增长，dispose 时也漏清两张表。这里把容量收成唯一事实：
 * 新增一种会话状态只需换一个 create 函数，不必再想淘汰。
 */

const DEFAULT_MAX_SESSIONS = 200

/** 容量受限的 Map：写入超过 max 时按插入顺序淘汰最旧项（重写已有键会刷新它的位置）。 */
export class BoundedMap extends Map {
  constructor(max, entries) {
    super(entries)
    this.max = max
  }

  set(key, value) {
    if (this.has(key)) super.delete(key)
    super.set(key, value)
    while (this.size > this.max) super.delete(this.keys().next().value)
    return this
  }
}

/**
 * 会话 → 值，容量按会话数封顶（淘汰最久未触碰的会话）。
 * - `ensure(id)`：读不到就用 create 建一份并记下，适合数组 / 计数 / 额度这类累加器；
 * - `peek(id)` / `set(id, v)`：适合只需读写的值（指纹、签名），不假设默认值。
 */
export class SessionCache {
  constructor({ create = () => undefined, maxSessions = DEFAULT_MAX_SESSIONS } = {}) {
    this.create = create
    this.store = new BoundedMap(maxSessions)
  }

  /** 只读查找；不存在返回 undefined（不创建）。读到即刷新其"最近使用"位置。 */
  peek(sessionId) {
    const value = this.store.get(sessionId)
    if (value !== undefined) this.store.set(sessionId, value)
    return value
  }

  /** 读取并（必要时）创建：create 只会在该会话第一次出现时调用。 */
  ensure(sessionId) {
    const value = this.store.get(sessionId)
    if (value !== undefined) {
      this.store.set(sessionId, value)
      return value
    }
    const created = this.create(sessionId)
    this.store.set(sessionId, created)
    return created
  }

  set(sessionId, value) {
    this.store.set(sessionId, value)
  }

  delete(sessionId) {
    return this.store.delete(sessionId)
  }

  clear() {
    this.store.clear()
  }

  get size() {
    return this.store.size
  }
}
