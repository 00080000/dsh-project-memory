import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { assertIndexRoot, assertSafeRoot, memoryRootFor, resolveIndexRoot, rootRejection, sessionMemoryRootOrNull, storeKey } from '../util/fs.js'
import { ProjectMemoryStore } from '../store.js'
import { cfgValue } from '../util/config.js'
import { normalizeWatchIntervalMs } from '../watch.js'

export function watchRepoTool(watchManager, config) {
  return defineTool({
    name: 'watch_repo',
    description:
      'Auto-refresh a project on change; watch=false stops.',
    parameters: {
      root: {
        type: 'string',
        required: true,
        description: 'project root (relative: session cwd)',
      },
      watch: {
        type: 'boolean',
        description: 'false = stop watching',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const root = resolveIndexRoot(exec, args.root)
      // 不存在的根不写进 watchlist：watch 每轮会 commit → save → mkdirSync，把它重新造出来。
      // 根是**文件**时同样要拦：否则 save() 的 mkdirSync 会抛裸 ENOTDIR。
      // 家目录 / 系统目录 / Homebrew 前缀也不监听：整体轮询扫描会吃满内存（issue #5）。
      if (args.watch !== false) {
        try {
          assertIndexRoot(root, args.root)
          assertSafeRoot(root, { requested: args.root, config })
        } catch (err) {
          return `Not watching: ${err.message}`
        }
      }
      const memoryDir = memoryRootFor(root, config.memoryDir)
      // 会话记忆根与工具侧同一套解析（标记优先 → 会话 cwd）；拿不到就跳过镜像。
      const sessionRoot = sessionMemoryRootOrNull(exec, config)
      const sessionMemoryDir = sessionRoot ? memoryRootFor(sessionRoot, config.memoryDir) : null

      const mirrorSessionWatchlist = async (present) => {
        // 会话根不可用（家目录/系统目录且无标记）时跳过镜像：那会在不该有项目记忆的目录里
        // 造出 watch.json，而 watch.json 一旦落在那里，下次以该目录为 cwd 启动又会把它读回来。
        if (!sessionRoot || !sessionMemoryDir) return
        // Windows/macOS 大小写不敏感：同一目录的两种写法不能当成两个 store 互相镜像。
        if (storeKey(path.resolve(sessionMemoryDir)) === storeKey(path.resolve(memoryDir))) return
        const sessionStore = new ProjectMemoryStore(sessionMemoryDir).load()
        const removed = sessionStore.removeWatch(root)
        const added = present ? sessionStore.addWatch(root) : false
        if (removed || added) sessionStore.save()
      }

      if (args.watch === false) {
        watchManager.removeRoot(root)
        // 危险根的 store 一律不读不写：load() 一个历史遗留的超大 store 光读盘就能 OOM
        // （这正是要修的场景），而写它会在家目录里造出 .dsh-project-memory。那份
        // watch.json 现在也没有任何启动路径会读取（restorePersisted 只认会话 cwd），
        // 留着即可；会话侧的镜像条目照常摘掉。
        // 根可能早已被删除：这时**不能** load/commit，否则 save() 的 mkdirSync 会把
        // watch_repo 刚停掉的路径重新创建出来。watch.json 的清理只对仍存在的根有意义。
        if (existsSync(root) && !rootRejection(root, config)) {
          new ProjectMemoryStore(memoryDir).load().commit((s) => s.removeWatch(root))
        }
        await mirrorSessionWatchlist(false)
        return `Stopped watching: ${root}`
      }
      new ProjectMemoryStore(memoryDir).load().commit((s) => s.addWatch(root))
      await mirrorSessionWatchlist(true)
      watchManager.addRoot(root)
      const intervalMs = normalizeWatchIntervalMs(Number(cfgValue(config, 'watchInterval')) * 1000)
      watchManager.start(intervalMs)
      return `Watching ${root} (interval ${intervalMs / 1000}s). Docs/code changes will be re-indexed silently.`
    },
  })
}
