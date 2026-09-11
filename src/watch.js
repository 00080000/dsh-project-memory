import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { isSupportedCode, isSupportedDoc, memoryRootFor, readFileForIndex, relativePath, storeKey, walkDir } from './util/fs.js'
import { buildDocEntries } from './doc-pipeline.js'
import { scanSymbols } from './symbols.js'
import { linkEntries } from './link.js'
import { ProjectMemoryStore } from './store.js'
import { onFileChanged, isTypeScriptFile } from './enhancer.js'
import { resolveRoute } from './llm-route.js'

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
      for (const root of store.watchlist) {
        if (typeof root === 'string' && root) this.addRoot(root)
      }
    }
  }

  addRoot(root) {
    if (!this.roots.has(root)) {
      this.roots.set(root, {
        store: new ProjectMemoryStore(memoryRootFor(root, this.config.memoryDir)).load(),
        snapshot: {},
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
    const files = walkDir(root)
    const seen = new Set()
    let changed = 0
    // watch 轮询没有会话上下文：路由取 config.llm 覆写或最近一次会话路由（llm-route.js）
    const route = resolveRoute(undefined, this.config)

    // First pass: collect all file info and compute hashes/entries (async work outside commit)
    const fileUpdates = []

    for (const filePath of files) {
      const rel = storeKey(relativePath(root, filePath))
      seen.add(rel)
      const ext = path.extname(filePath).toLowerCase()
      if (!isSupportedDoc(ext) && !isSupportedCode(ext)) continue

      let stats
      try {
        stats = statSync(filePath)
      } catch {
        continue
      }
      const sig = `${stats.mtimeMs}:${stats.size}`
      if (state.snapshot[rel] === sig) continue

      if (isSupportedCode(ext) && this.config.maxFileSizeMb && stats.size > this.config.maxFileSizeMb * 1024 * 1024) {
        continue
      }

      // 单次读盘：同一 buffer 供哈希与正文使用
      const { hash, buffer } = readFileForIndex(filePath)
      const existing = state.store.fileRecord(rel)
      if (existing && existing.sha256 === hash) continue

      try {
        let entries
        if (isSupportedCode(ext)) {
          entries = scanSymbols(rel, filePath, buffer.toString('utf8'))
        } else {
          entries = await buildDocEntries(this.ctx.llm, rel, filePath, {
            chunkChars: this.config.chunkChars,
            maxChunks: this.config.maxChunksPerFile,
            maxFileSizeMb: this.config.maxFileSizeMb,
            maxPdfPages: this.config.maxPdfPages,
            route,
          })
          if (entries === null) {
            // Dump file - update snapshot so we don't re-hash next poll, but don't index
            fileUpdates.push({ rel, expectedHash: state.store.fileRecord(rel)?.sha256, deleted: true, _sig: sig })
            changed++
            continue
          }
        }
        fileUpdates.push({ rel, expectedHash: state.store.fileRecord(rel)?.sha256, hash, size: stats.size, entries, type: isSupportedCode(ext) ? 'code' : 'doc', _sig: sig })
        changed++
      } catch (err) {
        // Index failed - rollback snapshot so next poll retries
        delete state.snapshot[rel]
        console.error(`[dsh-project-memory] re-index failed for ${rel}: ${err.message}`)
        continue
      }
    }

    // Single commit with all updates
    state.store.commit((s) => {
      for (const update of fileUpdates) {
        const result = s.applyFileUpdate(update.rel, update)
        if (result.skipped) {
          // CAS failed - file was modified concurrently, rollback snapshot to retry next poll
          delete state.snapshot[update.rel]
          // Mark this update to skip snapshot update after commit
          update._skipSnapshot = true
        }
      }

      // Remove deleted files
      for (const rel of Object.keys(s.files)) {
        if (!seen.has(rel)) {
          s.removeFile(rel)
        }
      }

      if (changed) {
        linkEntries(s)
      }
    })

    // Trigger TS enhancement for code files (TS/JS only)
    for (const update of fileUpdates) {
      if (update._skipSnapshot) continue
      if (update.type === 'code') {
        const filePath = path.join(root, update.rel)
        if (isTypeScriptFile(filePath)) {
          onFileChanged(state.store, update.rel, filePath, this.config, root)
        }
      }
      state.snapshot[update.rel] = update._sig
    }
  }
}