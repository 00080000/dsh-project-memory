import path from 'node:path'
import { statSync } from 'node:fs'
import {
  excludedEntryForPath,
  findProjectRoot,
  isGitIgnored,
  isGitIgnoredBatch,
  memoryRootFor,
  relativePath,
  rootRejection,
  storeKey,
} from './util/fs.js'
import { DROP, OVERSIZE, UNCHANGED, commitFileUpdates, fileKind, planFileIndex, toFileUpdate } from './index-pipeline.js'
import { ProjectMemoryStore } from './store.js'
import { onFileObserved } from './enhancer.js'
import { sessionWorkingDir } from './util/session-dir.js'

// 根推导策略已收敛到 util/fs.js（唯一实现）。这里重新导出，保持既有 import 路径可用。
export { findProjectRoot }

/**
 * 懒索引的成本结构（9p 代理实测，原生 NTFS 同序只是常数小）：
 *   `findProjectRoot`（逐层 readdir）18–45ms、`git check-ignore`（起进程）30ms、
 *   整读 + sha256 4ms、save 35ms。前两项**每个文件各付一次**，与文件内容变没变无关。
 *
 * 所以这里做三件事，且都不改变语义：
 *   ① 根按目录缓存（5s 上限）：一次 flush 里的文件通常同目录，别每个文件走一遍祖先；
 *   ② mtime + size 未变 → 不读盘、不问 git（`record.mtimeMs` 由写入侧记下）；
 *   ③ 一次 flush 只 commit 一次、只起一次 `git check-ignore`。
 * 只缓存**命中**的根：没找到根不缓存，避免"后来才建出 .git"的测试/场景一直拿旧结论。
 */
const ROOT_CACHE_TTL_MS = 5000
const ROOT_CACHE_MAX = 4096
const rootCaches = new WeakMap()

function rootCacheFor(config) {
  let cache = rootCaches.get(config)
  if (!cache) {
    cache = new Map()
    rootCaches.set(config, cache)
  }
  return cache
}

/** 清空根缓存（测试 / 诊断；不传 config 表示全清）。 */
export function clearRootCache(config) {
  if (config) rootCaches.delete(config)
  else rootCaches.clear()
}

function cachedProjectRoot(config, filePath, watchManager, sessionRoot) {
  const cache = rootCacheFor(config)
  const dir = path.dirname(filePath)
  const extraRoots = watchManager ? [...watchManager.roots.keys()] : []
  // 会话工作目录 / watch 根集合变了，答案就可能变：都进 key，不做过期以外的失效。
  const key = `${sessionRoot || ''}\u0000${extraRoots.join('\u0001')}\u0000${dir}`
  const hit = cache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < ROOT_CACHE_TTL_MS) return hit.root
  const root = findProjectRoot(filePath, { extraRoots, sessionRoot, config })
  if (!root) return null
  if (cache.size >= ROOT_CACHE_MAX) cache.clear()
  cache.set(key, { root, at: now })
  return root
}

/**
 * 一批"观察到的文件" → 每个 store 一次 commit。
 *
 * @param {object} config 插件配置
 * @param {{filePath: string, sessionRoot: string|null, watchManager?: object|null}[]} items
 * @returns {Promise<Map<string, boolean>>} filePath → 是否真的写入了条目（未变更 / 被排除 / 失败都是 false）
 */
export async function indexObservedBatch(config, items, watchManager = null) {
  const results = new Map()
  /** 需要进一步判定（可能真变了）的候选；未变更的文件在这一步就被排除了。 */
  const candidates = []

  for (const item of items) {
    const { filePath, sessionRoot } = item
    try {
      const kind = fileKind(path.extname(filePath).toLowerCase())
      if (!kind) {
        results.set(filePath, false)
        continue
      }
      // roots.exclude 是子树级否定：被排除的文件连根都不推导，直接不落任何记忆。
      if (excludedEntryForPath(filePath, config)) {
        results.set(filePath, false)
        continue
      }
      const root = cachedProjectRoot(config, filePath, watchManager, sessionRoot)
      if (!root || rootRejection(root, config)) {
        results.set(filePath, false)
        continue
      }
      const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
      const rel = storeKey(relativePath(root, filePath))
      const record = store.fileRecord(rel)
      const st = statSync(filePath)
      // 快路径：mtime + size 都没动 → 连 git 都不用问。这是"重复读同一个文件"的主路径。
      // doc 不走这条捷径：旧 store 的 terms 回填条件要看 entries，交给 planFileIndex 判。
      if (kind === 'code' && record && typeof record.mtimeMs === 'number' && record.mtimeMs === st.mtimeMs && record.size === st.size) {
        results.set(filePath, false)
        continue
      }
      candidates.push({ store, root, rel, filePath, kind, record, size: st.size, mtimeMs: st.mtimeMs, gitRel: relativePath(root, filePath) })
      results.set(filePath, false)
    } catch {
      results.set(filePath, false)
    }
  }

  if (candidates.length === 0) return results

  // 按根分组：同一个 flush 里同根的文件共用一次 check-ignore 子进程。
  const byRoot = new Map()
  for (const cand of candidates) {
    let list = byRoot.get(cand.root)
    if (!list) {
      list = []
      byRoot.set(cand.root, list)
    }
    list.push(cand)
  }

  for (const [root, list] of byRoot) {
    // gitignore 只管"**新条目**进不进语料"：已经有记录的条目（这次是内容变了要刷新）
    // 不再逐次问 git —— 那是一次进程启动（9p 30ms / 原生 Windows 15–40ms），
    // 而"文件被加进 .gitignore"由 index_repo / watch 的清理路径负责，不该在读路径上判。
    const fresh = list.filter((c) => !c.record)
    let ignored = new Set()
    if (fresh.length > 0) {
      try {
        ignored = isGitIgnoredBatch(root, fresh.map((c) => c.gitRel))
      } catch {
        ignored = new Set()
      }
    }
    const kept = ignored.size === 0 ? list : list.filter((c) => !ignored.has(c.gitRel))
    if (kept.length === 0) continue

    const store = kept[0].store
    const updates = []
    let refreshed = false
    for (const cand of kept) {
      try {
        const plan = await planFileIndex({
          rel: cand.rel,
          filePath: cand.filePath,
          kind: cand.kind,
          config,
          record: cand.record,
          existingEntries: store.entries[cand.rel],
          size: cand.size,
          mtimeMs: cand.mtimeMs,
        })
        if (plan.key === UNCHANGED) {
          // 内容没变、只有 mtime 变了：把新 mtime 记回去，否则下次还要整读一遍。
          if (typeof plan.mtimeMs === 'number' && store.refreshMtime(cand.rel, plan.mtimeMs)) refreshed = true
          continue
        }
        if (plan.key === OVERSIZE) continue
        updates.push(toFileUpdate(cand.rel, plan, cand.record))
        if (plan.key !== DROP && plan.type === 'code') onFileObserved(store, cand.rel, cand.filePath, config, root)
        results.set(cand.filePath, plan.key !== DROP)
      } catch {
        // 单文件读盘 / 解析失败不影响同批其它文件。
        results.set(cand.filePath, false)
      }
    }

    if (watchManager && watchManager.addRoot(root)) {
      // 只有真正新登记的根才持久化：addRoot 拒绝的根（不安全/不存在）不再被无条件
      // addWatch 记进 watch.json —— 那样会造出一个每次启动都复活的"僵尸根"。
      store.addWatch(root)
    }

    try {
      if (updates.length > 0) commitFileUpdates(store, { updates })
      else if (refreshed) store.commit(() => {})
    } catch (err) {
      console.error(`[dsh-project-memory] lazy index commit failed for ${root}: ${err.message}`)
    }
  }

  return results
}

export async function indexFile(ctx, config, filePath, watchManager = null, sessionRoot = null) {
  const results = await indexObservedBatch(config, [{ filePath, sessionRoot }], watchManager)
  return results.get(filePath) === true
}

export function codeFirst(paths) {
  return [...paths].sort((a, b) => {
    const aCode = fileKind(path.extname(a).toLowerCase()) === 'code' ? 0 : 1
    const bCode = fileKind(path.extname(b).toLowerCase()) === 'code' ? 0 : 1
    return aCode - bCode
  })
}

export function setupLazyIndexing(ctx, config, watchManager = null) {
  const pending = new Map()
  let timer = null

  const flush = async () => {
    timer = null
    const batch = codeFirst([...pending.keys()]).map((filePath) => ({
      filePath,
      sessionRoot: pending.get(filePath) || null,
    }))
    pending.clear()
    try {
      await indexObservedBatch(config, batch, watchManager)
    } catch (err) {
      console.error(`[dsh-project-memory] lazy index batch failed: ${err.message}`)
    }
  }

  const queue = (filePath, sessionRoot) => {
    pending.set(filePath, sessionRoot || null)
    if (!timer) {
      timer = setTimeout(flush, 300)
      if (timer.unref) timer.unref()
    }
  }

  // 第三个参数是宿主工具执行上下文（tool-fs / str-replace-editor 都以 `exec` 发射），
  // 取它的会话工作目录作为**本次读取所在会话**的工作目录——比 process.cwd() 精确
  // （web profile 下同一进程可能有多个会话/项目）。0.2.1+ 该目录由 workingDirectory
  // 投影决定（cd 后会变），见 util/session-dir.js。
  ctx.on('fs/observed', (target, observation, actor) => {
    if (!target || !observation || observation.kind !== 'present') return
    if (typeof target.displayPath !== 'string' || !target.displayPath) return
    queue(target.displayPath, sessionWorkingDir(actor?.agent?.session, { agent: actor?.agent }))
  })

  ctx.effect(() => () => {
    if (timer) clearTimeout(timer)
  })
}
