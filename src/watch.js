import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { isSupportedCode, isSupportedDoc, memoryRootFor, relativePath, sha256OfFile, walkDir } from './util/fs.js'
import { buildDocEntries } from './doc-pipeline.js'
import { scanSymbols } from './symbols.js'
import { linkEntries } from './link.js'
import { ProjectMemoryStore, withStoreLock } from './store.js'

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
    const memoryDir = memoryRootFor(root, this.config.memoryDir)
    await withStoreLock(memoryDir, async () => {
      const files = walkDir(root)
      const seen = new Set()
      let changed = 0

      for (const filePath of files) {
        const rel = relativePath(root, filePath)
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
        state.snapshot[rel] = sig

        if (isSupportedCode(ext) && this.config.maxFileSizeMb && stats.size > this.config.maxFileSizeMb * 1024 * 1024) {
          continue
        }

        const { hash } = await sha256OfFile(filePath)
        const existing = state.store.fileRecord(rel)
        if (existing && existing.sha256 === hash) continue

        try {
          let entries
          if (isSupportedCode(ext)) {
            entries = scanSymbols(filePath, readFileSync(filePath, 'utf8'))
            state.store.markFile(rel, { sha256: hash, size: stats.size, type: 'code', indexedAt: new Date().toISOString() })
          } else {
            entries = await buildDocEntries(this.ctx.llm, filePath, {
              chunkChars: this.config.chunkChars,
              maxChunks: this.config.maxChunksPerFile,
              maxFileSizeMb: this.config.maxFileSizeMb,
              maxPdfPages: this.config.maxPdfPages,
            })
            if (entries === null) {
              state.store.removeFile(rel)
              changed++
              continue
            }
            state.store.markFile(rel, { sha256: hash, size: stats.size, type: 'doc', indexedAt: new Date().toISOString() })
          }
          state.store.setEntries(rel, entries)
          changed++
        } catch (err) {
          delete state.snapshot[rel]
          console.error(`[dsh-project-memory] re-index failed for ${rel}: ${err.message}`)
        }
      }

      for (const rel of Object.keys(state.store.files)) {
        if (!seen.has(rel)) {
          state.store.removeFile(rel)
          changed++
        }
      }

      if (changed) {
        linkEntries(state.store)
        state.store.save()
      }
    })
  }
}