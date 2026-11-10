/**
 * 原生服务 seam（D3-1）：`ctx.provide('projectMemory', api)`，v1 只有四个动词
 * `recall / remember / forget / stats`。纯加法、全同步、零 LLM；
 * `remember/forget` 是写入口，先过 `assertSafeRoot`，`recall/stats` 只读。
 */
import path from 'node:path'
import { assertSafeRoot, memoryRootFor, normalizeCitationFiles } from './util/fs.js'
import { ProjectMemoryStore, storeOverview } from './store.js'
import { cfgInsight, defaultGlobalFile, GlobalStore, removeMemory, saveInsight } from './insight-store.js'
import { insightBodyText, recallItems } from './recall.js'
import { forgetVectorRows } from './vector-index.js'

/** 默认四层与 `recallItems` 的默认值保持一致。 */
const DEFAULT_LAYERS = ['doc', 'symbol', 'experience', 'insight']

/** `snippet` 是展示用摘要，不追求全文；正文兜底用 `insightBodyText`（经验条目没有 summary）。 */
const SNIPPET_CHARS = 300

function resolveRoot(root) {
  return path.resolve(root || process.cwd())
}

/** 项目/global 两个 store 都由各自类做进程内缓存。 */
function openStores(root, config) {
  const cfg = cfgInsight(config)
  const memoryDir = memoryRootFor(root, config && config.memoryDir)
  const store = new ProjectMemoryStore(memoryDir).load()
  // 与工具/自动注入同一个 global 解析顺序：显式配置优先，否则用户家目录下的默认文件。
  const globalStore = new GlobalStore(cfg.globalFile || defaultGlobalFile()).load()
  return { cfg, memoryDir, store, globalStore }
}

/** 召回条目的来源路径：insight 适配器给 `sourcePath`，原始经验条目给 `files[0]` / `sourceFile`。 */
function sourcePathOf(item) {
  if (!item || typeof item !== 'object') return ''
  if (typeof item.sourcePath === 'string' && item.sourcePath) return item.sourcePath
  if (Array.isArray(item.files) && typeof item.files[0] === 'string' && item.files[0]) return item.files[0]
  if (typeof item.sourceFile === 'string' && item.sourceFile) return item.sourceFile
  return ''
}

/** `path:line`；无行号只有路径，无来源为空串。 */
function citationOf(root, item) {
  const rel = sourcePathOf(item)
  if (!rel) return ''
  const abs = path.isAbsolute(rel) ? rel : path.join(root, rel)
  return typeof item?.sourceLine === 'number' && item.sourceLine > 0 ? `${abs}:${item.sourceLine}` : abs
}

function snippetOf(item) {
  if (!item) return ''
  // doc/symbol 用 summary/text；insight 适配器用 summary；经验条目回到 insightBodyText。
  const text = item.summary || item.text || (item.kind ? insightBodyText(item) : '') || ''
  return String(text).slice(0, SNIPPET_CHARS)
}

/** 只构造 api，不负责 provide；`ctx` 留给将来需要宿主能力时用。 */
export function createProjectMemoryService(ctx, config) {
  return {
    recall(query, opts = {}) {
      const q = String(query ?? '')
      // 空查询不是“全部”：ranker 会把前 limit 条当命中（分数 0）。
      if (!q.trim()) return { results: [] }
      if (opts.layers !== undefined && !Array.isArray(opts.layers)) {
        throw new Error('projectMemory.recall: layers must be an array')
      }
      const root = resolveRoot(opts.root)
      // 只读动词也要过根护栏：被 deny 的根不能借 recall 加载（超大 store 的 load 本身就危险），
      // 更不能在加载时顺手建出 `.dsh-project-memory` / `.gitignore`。
      assertSafeRoot(root, { config })
      const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.min(50, Math.floor(opts.limit)) : 8
      const layers = Array.isArray(opts.layers) && opts.layers.length ? opts.layers : DEFAULT_LAYERS
      const { store, globalStore } = openStores(root, config)
      const recalled = recallItems({
        store,
        globalStore,
        queries: [q],
        layers,
        limit,
        // task 级条目只在绑定任务时可见；remember(scope:'task') 写进去的必须能读回来。
        boundTaskId: opts.taskId || null,
      })
      const results = (recalled.flat || []).map((hit) => {
        const item = hit.item || {}
        return {
          id: item.insightId || item.id || '',
          title: String(item.title || item.problem || '(untitled)'),
          snippet: snippetOf(item),
          citation: citationOf(root, item),
        }
      })
      return { results }
    },

    remember(entry, opts = {}) {
      const root = resolveRoot(opts.root)
      const scope = opts.scope || 'project'
      const taskId = opts.taskId
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('projectMemory.remember: entry must be an object')
      }
      // 调用方错误：在打开 store 之前就报。
      if (scope === 'task' && !taskId) {
        throw new Error("projectMemory.remember: scope='task' requires taskId")
      }
      // 写入口先过根护栏，拒绝发生在 store 目录被建出来之前。
      assertSafeRoot(root, { config })
      // 与 save_lesson 同一条写入期路径约束：只收项目内相对路径。
      const citations = normalizeCitationFiles(entry.files, root)
      const raw = { ...entry, files: citations.files }
      const { cfg, store, globalStore } = openStores(root, config)
      let saved
      // 与 save_lesson 同一条写入路径与落盘时机。
      store.commit((s) => {
        saved = saveInsight({ store: s, globalStore, raw, scope, taskId, cfg, source: 'api' })
        return saved
      })
      globalStore.commit()
      if (!saved || !saved.ok) {
        throw new Error(`projectMemory.remember failed: ${saved && saved.error ? saved.error : 'unknown error'}`)
      }
      return {
        id: saved.id,
        action: saved.action,
        ...(store.lastSaveOk === false ? { persisted: false } : {}),
      }
    },

    // v1 契约只返回 `{ deleted }`：关键词命中数超过 `maxForgetMatches` 时 `removeMemory` 会返回
    // `ok:false / tooMany`，这里与"没有命中"一样落成 `{ deleted: [] }`——调用方无法区分这两者，
    // 是刻意换取四动词返回形状稳定的取舍（不让 v1 契约随内部错误码漂移）。
    forget(idOrQuery, opts = {}) {
      const root = resolveRoot(opts.root)
      // 删除也是写盘入口：先过根护栏，拒绝发生在 store / 删除留痕文件被写出之前。
      assertSafeRoot(root, { config })
      const { cfg, memoryDir, store, globalStore } = openStores(root, config)
      let removed
      store.commit((s) => {
        removed = removeMemory({ store: s, globalStore, idOrQuery, maxMatches: cfg.maxForgetMatches })
        return removed
      })
      globalStore.commit()
      const deleted = ((removed && removed.removed) || []).map((it) => it.id)
      // 向量缓存也是"这条记忆"的一部分：与 forget 工具同一承诺，留着就不算真删。
      // 缓存清理失败不影响删除承诺（条目已经从真相源移除）。
      try {
        forgetVectorRows({ dir: memoryDir, ids: deleted })
      } catch {
        /* ignore：vectors.json 是缓存，不是真相源 */
      }
      return { deleted, ...(store.lastSaveOk === false ? { persisted: false } : {}) }
    },

    stats(opts = {}) {
      const root = resolveRoot(opts.root)
      assertSafeRoot(root, { config })
      const { store, globalStore } = openStores(root, config)
      const overview = storeOverview(store)
      return {
        files: overview.files,
        entries: overview.entries,
        experience: overview.experience,
        latest: overview.latest,
        insights: store.insightItems().length,
        global: globalStore.items().length,
      }
    },
  }
}

/**
 * 安装服务：老宿主/测试桩没有 `ctx.provide` 时**安全跳过**（返回 null，不抛），
 * 否则 `ctx.provide('projectMemory', api)` 并返回同一个 api。
 * @param {object} ctx - cordis 上下文
 * @param {object} config - 插件 Config
 * @returns {object|null} 已注册的 api；宿主无 provide 时为 null
 */
export function installProjectMemoryService(ctx, config) {
  if (typeof ctx?.provide !== 'function') return null
  const api = createProjectMemoryService(ctx, config)
  ctx.provide('projectMemory', api)
  return api
}
