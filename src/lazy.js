import path from 'node:path'
import { statSync } from 'node:fs'
import { findProjectRoot, isUnsafeRoot, memoryRootFor, relativePath, storeKey } from './util/fs.js'
import { DROP, OVERSIZE, UNCHANGED, commitFileUpdates, fileKind, planFileIndex, toFileUpdate } from './index-pipeline.js'
import { ProjectMemoryStore } from './store.js'
import { onFileObserved } from './enhancer.js'

// 根推导策略已收敛到 util/fs.js（唯一实现）。这里重新导出，保持既有 import 路径可用。
export { findProjectRoot }

export async function indexFile(ctx, config, filePath, watchManager = null, sessionRoot = null) {
  const kind = fileKind(path.extname(filePath).toLowerCase())
  if (!kind) return false
  // 根来源优先级：显式 watch 过的根 → 项目标记 → 会话工作目录（安全时）。
  // 显式登记过的根优先，是为了让"没有标记但被 watch_repo 指定过"的项目也能持续刷新。
  const extraRoots = watchManager ? [...watchManager.roots.keys()] : []
  const root = findProjectRoot(filePath, { extraRoots, sessionRoot })
  if (!root || isUnsafeRoot(root)) return false

  const memoryDir = memoryRootFor(root, config.memoryDir)
  const store = new ProjectMemoryStore(memoryDir).load()
  const rel = storeKey(relativePath(root, filePath))
  const record = store.fileRecord(rel)

  let size
  let plan
  try {
    size = statSync(filePath).size
    plan = await planFileIndex({ rel, filePath, kind, config, record, existingEntries: store.entries[rel], size })
  } catch {
    return false
  }
  if (plan.key === UNCHANGED || plan.key === OVERSIZE) return false

  if (watchManager && watchManager.addRoot(root)) {
    // 只有真正新登记的根才持久化：addRoot 拒绝的根（不安全/不存在）不再被无条件
    // addWatch 记进 watch.json —— 那样会造出一个每次启动都复活的"僵尸根"。
    store.addWatch(root)
  }

  if (plan.key !== DROP && plan.type === 'code') {
    onFileObserved(store, rel, filePath, config, root)
  }
  commitFileUpdates(store, { updates: [toFileUpdate(rel, plan, record)] })
  return plan.key !== DROP
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
    const batch = codeFirst([...pending.keys()])
    const roots = new Map(pending)
    pending.clear()
    for (const filePath of batch) {
      try {
        await indexFile(ctx, config, filePath, watchManager, roots.get(filePath) || null)
      } catch (err) {
        console.error(`[dsh-project-memory] lazy index failed for ${filePath}: ${err.message}`)
      }
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
  // 取它的 `agent.session.header.cwd` 作为**本次读取所在会话**的工作目录——比
  // process.cwd() 精确（web profile 下同一进程可能有多个会话/项目）。
  ctx.on('fs/observed', (target, observation, actor) => {
    if (!target || !observation || observation.kind !== 'present') return
    if (typeof target.displayPath !== 'string' || !target.displayPath) return
    queue(target.displayPath, actor?.agent?.session?.header?.cwd)
  })

  ctx.effect(() => () => {
    if (timer) clearTimeout(timer)
  })
}