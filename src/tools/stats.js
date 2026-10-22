import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertIndexRoot, memoryRootFor, resolveSafeIndexRoot } from '../util/fs.js'
import { ProjectMemoryStore, storeOverview } from '../store.js'
import { cfgInsight, defaultGlobalFile, GlobalStore } from '../insight-store.js'
import { cfgEngine } from '../auto-inject.js'
import { resolveVectorLayer, vectorIndexSummary, vectorItemsFrom } from '../vector-index.js'
import { truncate } from '../util/text.js'

const TOP_N = 30

export function statsTool(config) {
  return defineTool({
    name: 'memory_stats',
    description:
      'Show store totals, last index time and the per-file index list.',
    parameters: {
      root: {
        type: 'string',
        description: '项目根（默认当前工作目录）',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const root = resolveSafeIndexRoot(exec, args.root, config)
      // 读路径也要验根存在：可选的向量层（leanvec）在索引空 store 时会落盘 vectors 缓存，
      // 于是"传错一个 root"就能在任意可写位置造出 `<root>/.dsh-project-memory` —— 而回报
      // 只是"空 store"，看起来像"这个项目没有记忆"。与 index_repo/watch_repo 同一道护栏。
      assertIndexRoot(root, args.root || root)
      const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
      const overview = storeOverview(store)
      const files = Object.entries(store.files).sort((a, b) => String(b[1].indexedAt || '').localeCompare(String(a[1].indexedAt || '')))
      const lines = [
        `Memory store: ${store.dir}`,
        `Files indexed: ${overview.files} | Entries: ${overview.entries} | Experience notes: ${overview.experience}`,
        overview.latest ? `Last index: ${overview.latest}` : 'Last index: never',
      ]
      if (files.length) {
        lines.push('')
        for (const [rel, rec] of files.slice(0, TOP_N)) {
          const count = (store.entries[rel] || []).length
          lines.push(`- ${rel} [${rec.type}] entries: ${count}, indexed at ${rec.indexedAt || 'unknown'}`)
        }
        if (files.length > TOP_N) lines.push(`- ... ${files.length - TOP_N} more files`)
      }
      // 可选向量层的**状态**（不含模型加载）：这一层静默降级太厉害——`vectorDir` 拼错一个
      // 字母与"没装 leanvec"在输出上完全一样，而两者的语义差别是"排序里有没有语义"。
      // 只报三件可判定的东西：能不能用、缓存索引对不对得上、写入去重开没开。
      {
        const engine = cfgEngine(config)
        const off = typeof engine.vectorDir === 'string' && engine.vectorDir.trim().toLowerCase() === 'off'
        let resolved = { dir: null }
        try { resolved = off ? { dir: null } : await resolveVectorLayer(engine.vectorDir) } catch { resolved = { dir: null } }
        const memDir = memoryRootFor(root, config.memoryDir)
        const cfgI = cfgInsight(config)
        const globalStore = new GlobalStore(cfgI.globalFile || defaultGlobalFile()).load()
        const vs = vectorIndexSummary({ dir: memDir, items: vectorItemsFrom(store, globalStore) })
        const state = resolved?.dir ? `on (leanvec @ ${resolved.dir})` : off ? "off (vectorDir: 'off')" : 'off (leanvec 未解析到)'
        lines.push('')
        lines.push(`Vector: ${state} | re-rank alpha ${engine.vectorAlpha} | write-dedup ${engine.vectorDedup ? 'on' : 'off'}`)
        lines.push(
          vs.rows
            ? `Vector index: ${vs.rows} rows · ${vs.live} live / ${vs.stale} stale · ${(vs.bytes / 1024).toFixed(0)} KB · model ${vs.model || '?'} · updated ${vs.updatedAt || '?'}`
            : 'Vector index: 尚未建立（首次查询/写入时构建）',
        )
      }
      return truncate(lines.join('\n'), config.maxOutputChars)
    },
  })
}
