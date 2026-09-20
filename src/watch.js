import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { isUnwatchableRoot, memoryRootFor, relativePath, storeKey, walkDir } from './util/fs.js'
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
  }

  restorePersisted() {
    const cwd = process.cwd()
    // 用 load() 的返回值：storeCache 命中时 load() 返回的是缓存实例，忽略返回值会拿到空 store
    const store = new ProjectMemoryStore(memoryRootFor(cwd, this.config.memoryDir)).load()
    if (existsSync(store.dir)) {
      let dropped = 0
      for (const root of [...store.watchlist]) {
        if (typeof root !== 'string' || !root) continue
        // 自愈剔除两类条目：已不存在的根（每轮白跑，还会把目录重新 mkdir 出来），
        // 以及不该整体监听的文件系统根 / 共享临时目录（会把别人和测试的临时文件全扫进来）。
        if (!existsSync(root) || isUnwatchableRoot(root)) {
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
    // 文件系统根 / 共享临时目录不整体监听（子目录允许）。
    if (isUnwatchableRoot(root)) return false
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

    for (const filePath of walkDir(root)) {
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
      if (plan.key === UNCHANGED || plan.key === OVERSIZE) continue

      signatures.set(rel, sig)
      updates.push(toFileUpdate(rel, plan, record))
    }

    // 单事务写盘；CAS 失败的条目本轮不落快照，下一轮自然重试。
    const { stale } = commitFileUpdates(state.store, { updates, unseen: seen, link: updates.length > 0 })
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