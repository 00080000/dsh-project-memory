import { defineTool } from '@deepseek-ai/dsh-tools'
import { memoryRootFor, resolveIndexRoot } from '../util/fs.js'
import { ProjectMemoryStore, storeOverview } from '../store.js'
import { truncate } from '../util/text.js'

const TOP_N = 30

export function statsTool(config) {
  return defineTool({
    name: 'memory_stats',
    description:
      'Show what the project memory store contains: totals (files / entries / experience notes), last index time, ' +
      'and the per-file list with entry counts sorted by most recently indexed. Use this to answer "what is in my memory store" without reading JSON files.',
    parameters: {
      root: {
        type: 'string',
        description: 'Project root of the memory store. Defaults to the current working directory.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const root = resolveIndexRoot(exec, args.root)
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
      return truncate(lines.join('\n'), config.maxOutputChars)
    },
  })
}
