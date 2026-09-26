import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { isUnsafeRoot, memoryDirName, memoryRootFor, relativePath, scanLimits, storeKey, walkDir } from './util/fs.js'
import { OVERSIZE, UNCHANGED, commitFileUpdates, fileKind, planFileIndex, toFileUpdate } from './index-pipeline.js'
import { ProjectMemoryStore } from './store.js'
import { onFileChanged, isTypeScriptFile } from './enhancer.js'

export class WatchManager {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.roots = new Map()
    this.timer = null
    this._polling = false
    this._truncationWarned = new Set()
    /** 已就「跳过了嵌套项目根」告警过的根：同上，只提示一次。 */
    this._nestedStoreWarned = new Set()
  }

  /** 包含该路径的已注册根（最长前缀）：懒索引据此把文件归到显式 watch 过的无标记项目里。 */
  rootContaining(absPath) {
    let best = null
    for (const root of this.roots.keys()) {
      const rel = path.relative(root, absPath)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      if (!best || root.length > best.length) best = root
    }
    return best
  }

  /** 危险根是否被显式放行（唯一开关，显式工具调用与 watch 共用同一判据）。 */
  unsafeAllowed() {
    return this.config?.allowUnsafeRoots === true
  }

  restorePersisted() {
    const cwd = process.cwd()
    // cwd 是家目录/系统目录时直接跳过：旧顺序是「先 load 再判断」，而历史遗留的超大 store
    // 光读盘就能 OOM —— 那恰恰是 issue #5 的报告者重启后会撞上的场景。
    if (!this.unsafeAllowed() && isUnsafeRoot(cwd)) return
    // 用 load() 的返回值：storeCache 命中时 load() 返回的是缓存实例，忽略返回值会拿到空 store
    const store = new ProjectMemoryStore(memoryRootFor(cwd, this.config.memoryDir)).load()
    if (existsSync(store.dir)) {
      let dropped = 0
      for (const root of [...store.watchlist]) {
        if (typeof root !== 'string' || !root) continue
        // 自愈剔除两类条目：已不存在的根（每轮白跑，还会把目录重新 mkdir 出来），
        // 以及不该整体监听的根（文件系统根 / 家目录 / 系统与包管理器前缀）——
        // 后者同时**修复历史遗留**：0.5.8 及以前被误判进去的家目录、/opt/homebrew
        // 会在下一次启动时被自动摘掉，不需要用户手删 watch.json。
        if (!existsSync(root) || (!this.unsafeAllowed() && isUnsafeRoot(root))) {
          store.removeWatch(root)
          dropped++
          continue
        }
        this.addRoot(root)
      }
      if (dropped) store.save()
    }
  }

  addRoot(root) {
    // 根目录不存在就拒绝：否则每轮 poll 都会 commit → save → mkdirSync，
    // 把一条历史遗留、已被删除的 watchlist 条目重新「创建」出来。
    if (!existsSync(root)) return false
    // 文件系统根 / 家目录 / 系统前缀不整体监听（它们的子目录允许），除非显式放行。
    if (!this.unsafeAllowed() && isUnsafeRoot(root)) return false
    if (!this.roots.has(root)) {
      // **不在这里 load()**：`restorePersisted()` 会对 cwd store 的整条 watchlist 逐个 addRoot，
      // 急切读盘等于「watch 过多少个根，启动就同步读多少个 store 的全部 shard」——一个万文件
      // 的 store 就是秒级，几十个根就是启动卡死 + 内存无上界。这里只登记，store 到第一次
      // pollRoot 真正需要时才取（见 `storeFor`）。
      this.roots.set(root, {
        snapshot: {},
        // rel → 上次已上报的错误信息。坏文件每轮都会重试，逐轮打印会刷屏。
        failures: new Map(),
      })
      return true
    }
    return false
  }

  /**
   * 每个根**按需**取 store：命中 `storeCache` 时是 O(1)（一次 Map 查找 + LRU 挪位）。
   *
   * 刻意不让本类长期持有实例。旧实现把 `store` 塞进 `this.roots` 里，等于给每个 watch 根
   * 加了一个**进程级强引用**，于是：
   *   - 逐出对 watch 根完全不省内存（`storeCache` 丢了 key，watcher 还攥着）；
   *   - 一旦真被逐出，下一次 `load()` 会从盘上**再建一份**，同一个 root 在同一进程里出现两份
   *     互不可见的内存状态，两份各自 `save()` 脏分片 → 最后写者赢，存在丢更新的窗口。
   * 现在唯一的活实例就是缓存里那一个：逐出即真正释放，下一轮 poll 重新读盘（缓存该有的语义），
   * 而内存上界回到 `STORE_CACHE_MAX_BYTES`，不再由「watch 了多少个根」决定。
   */
  storeFor(root) {
    return new ProjectMemoryStore(memoryRootFor(root, this.config.memoryDir)).load()
  }

  removeRoot(root) {
    return this.roots.delete(root)
  }

  start(intervalMs = 30000) {
    if (this.timer) return
    // NaN/undefined 会让定时器退化成 1ms 轮询（Node 只发一条 TimeoutNaNWarning），
    // 足以打满事件循环让 agent 无法响应；非法值回退到默认 30s。
    const raw = Number(intervalMs)
    this._baseInterval = Number.isFinite(raw) ? Math.max(raw, 1000) : 30000
    // 空闲退避：连续没有变化的轮次把间隔翻倍，最长 2 分钟一轮；任何变化立刻回到 base。
    // 轮询本身是 O(树) 的 walkDir + 逐文件 stat（本仓库一轮实测 58–87ms），
    // 常驻 15s 一轮意味着不管有没有改动都在磨 I/O。
    this._maxInterval = Math.max(this._baseInterval, Math.min(this._baseInterval * 8, 120000))
    this._interval = this._baseInterval
    this._stopped = false
    this._schedule()
  }

  _schedule() {
    this.timer = setTimeout(() => this._tick(), this._interval)
    if (this.timer.unref) this.timer.unref()
  }

  async _tick() {
    this.timer = null
    let changed = false
    try {
      changed = await this.poll()
    } catch {
      // poll() 内部已逐根兜底；这里保证无论发生什么都一定排下一轮，不会静默停掉 watch。
    }
    if (this._stopped) return // 轮询期间被 stop() 了，不要再排下一轮
    this._interval = changed ? this._baseInterval : Math.min(this._interval * 2, this._maxInterval)
    this._schedule()
  }

  stop() {
    this._stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async poll() {
    // 慢轮询期间再次进入直接跳过（递归 setTimeout 下正常不会叠加，保留作防御）。
    if (this._polling) return false
    this._polling = true
    let changed = false
    try {
      for (const [root, state] of this.roots) {
        try {
          if (await this.pollRoot(root, state)) changed = true
        } catch (err) {
          console.error(`[dsh-project-memory] watch poll failed for ${root}: ${err.message}`)
        }
      }
    } finally {
      this._polling = false
    }
    return changed
  }

  async pollRoot(root, state) {
    const seen = new Set()
    const updates = []
    // rel → 本轮采集的 mtime:size。提交成功后才落进快照；CAS 失败的条目留在原地等下一轮。
    const signatures = new Map()
    // 本轮用的 store：命中缓存即 O(1)，被逐出则重新读盘。整个 pollRoot 期间共用同一个实例。
    const store = this.storeFor(root)

    const { files, truncated, skipped: nestedRoots } = walkDir(root, {
      ...scanLimits(this.config),
      nestedStoreName: memoryDirName(this.config),
    })
    if (nestedRoots.length && !this._nestedStoreWarned.has(root)) {
      // 同上，只提示一次。这里同时说明"旧副本会被本轮清掉"——升级后的存量重复就是这么收敛的。
      this._nestedStoreWarned.add(root)
      const rels = nestedRoots.map((p) => storeKey(relativePath(root, p)))
      console.error(
        `[dsh-project-memory] watch of ${root} skips nested project root(s) with their own store: ${rels.join(', ')}; ` +
          'their content is refreshed by their own root, and any duplicate copy previously indexed here is being removed.',
      )
    }
    if (truncated && !this._truncationWarned.has(root)) {
      // 只提示一次：这是一条**永久**的降级说明，不是每轮都要刷屏的故障。
      this._truncationWarned.add(root)
      const { maxFiles, maxDepth } = scanLimits(this.config)
      console.error(
        `[dsh-project-memory] watch scan of ${root} hit the limit (maxFiles=${maxFiles}, maxDepth=${maxDepth}); ` +
          'only part of the tree is refreshed. Raise maxScanFiles/maxScanDepth if this project is legitimately that large.',
      )
    }

    for (const filePath of files) {
      const rel = storeKey(relativePath(root, filePath))
      seen.add(rel)
      const kind = fileKind(path.extname(filePath).toLowerCase())
      if (!kind) continue

      let stats
      try {
        stats = statSync(filePath)
      } catch {
        continue
      }
      const sig = `${stats.mtimeMs}:${stats.size}`
      if (state.snapshot[rel] === sig) continue

      const record = store.fileRecord(rel)
      let plan
      try {
        plan = await planFileIndex({
          rel,
          filePath,
          kind,
          config: this.config,
          record,
          existingEntries: store.entries[rel],
          size: stats.size,
        })
      } catch (err) {
        // 坏文件每轮都会重试：同一个文件的同一个错误只上报一次，否则逐轮 console.error 刷屏。
        if (state.failures.get(rel) !== err.message) {
          state.failures.set(rel, err.message)
          console.error(`[dsh-project-memory] re-index failed for ${rel}: ${err.message}`)
        }
        continue
      }
      state.failures.delete(rel)
      // 内容未变 / 体积超限也要落快照：否则 mtime:size 快路径永远命中不了，
      // 每次 poll 都要把整个仓库重读一遍再哈希（watch 默认开、15s 一轮）。
      if (plan.key === UNCHANGED || plan.key === OVERSIZE) {
        state.snapshot[rel] = sig
        continue
      }

      signatures.set(rel, sig)
      updates.push(toFileUpdate(rel, plan, record))
    }

    // 单事务写盘；CAS 失败的条目本轮不落快照，下一轮自然重试。
    // 截断时**不传 unseen**：没扫到的文件不等于被删了，否则一份被上限截掉的树每轮都会
    // 把自己的记忆删掉一半（先删再下轮重新索引，纯粹的抖动）。
    const { stale, removed } = commitFileUpdates(store, {
      updates,
      unseen: truncated ? null : seen,
    })
    const failed = new Set(stale)
    let applied = 0
    for (const update of updates) {
      if (failed.has(update.rel)) continue
      applied++
      state.snapshot[update.rel] = signatures.get(update.rel)
      if (update.type !== 'code') continue
      const filePath = path.join(root, update.rel)
      if (isTypeScriptFile(filePath)) {
        onFileChanged(store, update.rel, filePath, this.config, root)
      }
    }
    // 有变化 → 下一轮回到 base 间隔；纯空转 → 退避。
    return applied > 0 || removed > 0
  }
}