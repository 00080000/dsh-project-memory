import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { memoryRootFor } from '../util/fs.js'
import { ProjectMemoryStore, withStoreLock } from '../store.js'

export function watchRepoTool(watchManager, config) {
  return defineTool({
    name: 'watch_repo',
    description:
      'Start silent auto-refresh for a project: the plugin polls the root (configurable interval), ' +
      'detects changed/new docs and code files via mtime+content-hash, and re-indexes only those silently. ' +
      'No GUI, no manual re-index needed after this. Stop by reloading the plugin or calling with watch=false.',
    parameters: {
      root: {
        type: 'string',
        required: true,
        description: 'Absolute path to the project root to watch.',
      },
      watch: {
        type: 'boolean',
        description: 'Set false to stop watching this root. Default true.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const root = path.resolve(args.root)
      const memoryDir = memoryRootFor(root, config.memoryDir)
      return withStoreLock(memoryDir, () => {
        const store = new ProjectMemoryStore(memoryDir).load()
        if (args.watch === false) {
          watchManager.removeRoot(root)
          store.watchlist = store.watchlist.filter((r) => r !== root)
          store.save()
          return `Stopped watching: ${root}`
        }
        store.addWatch(root)
        store.save()
        watchManager.addRoot(root)
        watchManager.start(config.watchInterval * 1000)
        return `Watching ${root} (interval ${config.watchInterval}s). Docs/code changes will be re-indexed silently.`
      })
    },
  })
}