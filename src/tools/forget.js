import { defineTool } from '@deepseek-ai/dsh-tools'
import { memoryRootFor, resolveIndexRoot } from '../util/fs.js'
import { ProjectMemoryStore } from '../store.js'

export function forgetTool(config) {
  return defineTool({
    name: 'forget',
    description:
      'Delete experience notes from project memory by id or by matching keywords. Use to clean stale/obsolete notes.',
    parameters: {
      id_or_query: {
        type: 'string',
        required: true,
        description: 'Experience note id (from remember/search output), or keywords to match.',
      },
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
      const memoryDir = memoryRootFor(root, config.memoryDir)
      const store = new ProjectMemoryStore(memoryDir).load()
      return store.commit((s) => {
        const removed = s.removeExperience(args.id_or_query)
        return removed > 0 ? `Removed ${removed} experience note(s).` : 'No matching experience note found.'
      })
    },
  })
}