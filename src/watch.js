import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { isUnsafeRoot, memoryRootFor, relativePath, scanLimits, storeKey, walkDir } from './util/fs.js'
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
      this.roots.set(root, {
        store: new ProjectMemoryStore(memoryRootFor(root, this.config.memoryDir)).load(),
        snapshot: {},
        // rel → 上次已上报的错误信息。坏文件每轮都会重试，逐轮打印会刷屏。
        failures: new Map(),
      })
      return true
    }
    return false
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

    const { files, truncated } = walkDir(root, scanLimits(this.config))
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

      const record = state.store.fileRecord(rel)
      let plan
      try {
        plan = await planFileIndex({
          rel,
          filePath,
          kind,
          config: this.config,
          record,
          existingEntries: state.store.entries[rel],
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
    const { stale, removed } = commitFileUpdates(state.store, {
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
        onFileChanged(state.store, update.rel, filePath, this.config, root)
      }
    }
    // 有变化 → 下一轮回到 base 间隔；纯空转 → 退避。
    return applied > 0 || removed > 0
  }
}