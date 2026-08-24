import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { memoryRootFor, resolveIndexRoot } from '../util/fs.js'
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
    async execute(args, exec) {
      const root = path.resolve(args.root)
      const memoryDir = memoryRootFor(root, config.memoryDir)
      const sessionRoot = resolveIndexRoot(exec)
      const sessionMemoryDir = memoryRootFor(sessionRoot, config.memoryDir)
      return withStoreLock(memoryDir, async () => {
        const store = new ProjectMemoryStore(memoryDir).load()
        const mirrorSessionWatchlist = async (present) => {
          if (path.resolve(sessionMemoryDir) === path.resolve(memoryDir)) return
          await withStoreLock(sessionMemoryDir, () => {
            const sessionStore = new ProjectMemoryStore(sessionMemoryDir).load()
            const before = sessionStore.watchlist.length
            sessionStore.watchlist = sessionStore.watchlist.filter((r) => r !== root)
            if (present) sessionStore.addWatch(root)
            if (sessionStore.watchlist.length !== before || present) sessionStore.save()
          })
        }
        if (args.watch === false) {
          watchManager.removeRoot(root)
          store.watchlist = store.watchlist.filter((r) => r !== root)
          store.save()
          await mirrorSessionWatchlist(false)
          return `Stopped watching: ${root}`
        }
        store.addWatch(root)
        store.save()
        await mirrorSessionWatchlist(true)
        watchManager.addRoot(root)
        watchManager.start(config.watchInterval * 1000)
        return `Watching ${root} (interval ${config.watchInterval}s). Docs/code changes will be re-indexed silently.`
      })
    },
  })
}