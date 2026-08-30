import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { isSupportedCode, isSupportedDoc, memoryRootFor, relativePath, sha256OfFile, storeKey, walkDir } from './util/fs.js'
import { buildDocEntries } from './doc-pipeline.js'
import { scanSymbols } from './symbols.js'
import { linkEntries } from './link.js'
import { ProjectMemoryStore } from './store.js'
import { onFileChanged, isTypeScriptFile } from './enhancer.js'

export class WatchManager {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.roots = new Map()
    this.timer = null
  }

  restorePersisted() {
    const cwd = process.cwd()
    const store = new ProjectMemoryStore(memoryRootFor(cwd, this.config.memoryDir))
    if (existsSync(store.dir)) {
      store.load()
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
    this.timer = setInterval(() => this.poll(), Math.max(intervalMs, 1000))
    if (this.timer.unref) this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async poll() {
    for (const [root, state] of this.roots) {
      try {
        await this.pollRoot(root, state)
      } catch (err) {
        console.error(`[dsh-project-memory] watch poll failed for ${root}: ${err.message}`)
      }
    }
  }

  async pollRoot(root, state) {
    const files = walkDir(root)
    const seen = new Set()
    let changed = 0

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

      const { hash } = await sha256OfFile(filePath)
      const existing = state.store.fileRecord(rel)
      if (existing && existing.sha256 === hash) continue

      try {
        let entries
        if (isSupportedCode(ext)) {
          entries = scanSymbols(rel, filePath, readFileSync(filePath, 'utf8'))
        } else {
          entries = await buildDocEntries(this.ctx.llm, rel, filePath, {
            chunkChars: this.config.chunkChars,
            maxChunks: this.config.maxChunksPerFile,
            maxFileSizeMb: this.config.maxFileSizeMb,
            maxPdfPages: this.config.maxPdfPages,
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