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

  start(intervalMs = 15000) {
    if (this.timer) return
    // NaN/undefined 会让 setInterval 退化成 1ms 轮询（Node 只发一条 TimeoutNaNWarning），
    // 足以打满事件循环让 agent 无法响应；非法值回退到 15s。
    const raw = Number(intervalMs)
    const ms = Number.isFinite(raw) ? Math.max(raw, 1000) : 15000
    this.timer = setInterval(() => this.poll(), ms)
    if (this.timer.unref) this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async poll() {
    // setInterval 不等待上一轮：大仓库/文档 LLM 摘要让一轮 >interval 时，
    // 轮询会叠加成并发索引，最终打满事件循环。用重入锁让慢轮询自然跳过。
    if (this._polling) return
    this._polling = true
    try {
      for (const [root, state] of this.roots) {
        try {
          await this.pollRoot(root, state)
        } catch (err) {
          console.error(`[dsh-project-memory] watch poll failed for ${root}: ${err.message}`)
        }
      }
    } finally {
      this._polling = false
    }
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
    const { stale } = commitFileUpdates(state.store, {
      updates,
      unseen: truncated ? null : seen,
      link: updates.length > 0,
    })
    const failed = new Set(stale)
    for (const update of updates) {
      if (failed.has(update.rel)) continue
      state.snapshot[update.rel] = signatures.get(update.rel)
      if (update.type !== 'code') continue
      const filePath = path.join(root, update.rel)
      if (isTypeScriptFile(filePath)) {
        onFileChanged(state.store, update.rel, filePath, this.config, root)
      }
    }
  }
}