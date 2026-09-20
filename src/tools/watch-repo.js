import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { assertIndexRoot, isUnwatchableRoot, memoryRootFor, resolveIndexRoot } from '../util/fs.js'
import { ProjectMemoryStore } from '../store.js'

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
      // 不存在的根不写进 watchlist：watch 每轮会 commit → save → mkdirSync，把它重新造出来。
      // 根是**文件**时同样要拦：否则 save() 的 mkdirSync 会抛裸 ENOTDIR。
      if (args.watch !== false) {
        try {
          assertIndexRoot(root, args.root)
        } catch (err) {
          return `Not watching: ${err.message}`
        }
      }
      // 文件系统根 / 共享临时目录不整体监听（子目录允许）：会把无关程序和测试夹具的临时文件全扫进来
      if (args.watch !== false && isUnwatchableRoot(root)) {
        return `Refusing to watch ${root}: it is the filesystem root or the shared temp directory. Pass a project subdirectory instead.`
      }
      const memoryDir = memoryRootFor(root, config.memoryDir)
      const sessionRoot = resolveIndexRoot(exec)
      const sessionMemoryDir = memoryRootFor(sessionRoot, config.memoryDir)
      const store = new ProjectMemoryStore(memoryDir).load()

      const mirrorSessionWatchlist = async (present) => {
        if (path.resolve(sessionMemoryDir) === path.resolve(memoryDir)) return
        const sessionStore = new ProjectMemoryStore(sessionMemoryDir).load()
        const removed = sessionStore.removeWatch(root)
        const added = present ? sessionStore.addWatch(root) : false
        if (removed || added) sessionStore.save()
      }

      if (args.watch === false) {
        watchManager.removeRoot(root)
        store.commit((s) => s.removeWatch(root))
        await mirrorSessionWatchlist(false)
        return `Stopped watching: ${root}`
      }
      store.commit((s) => s.addWatch(root))
      await mirrorSessionWatchlist(true)
      watchManager.addRoot(root)
      watchManager.start(config.watchInterval * 1000)
      return `Watching ${root} (interval ${config.watchInterval}s). Docs/code changes will be re-indexed silently.`
    },
  })
}