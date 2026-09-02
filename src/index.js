import Schema from '@deepseek-ai/schemastery'
import { indexDocTool } from './tools/index-doc.js'
import { indexRepoTool, indexRepository } from './tools/index-repo.js'
import { queryMemoryTool } from './tools/query-memory.js'
import { rememberTool } from './tools/remember.js'
import { forgetTool } from './tools/forget.js'
import { watchRepoTool } from './tools/watch-repo.js'
import { statsTool } from './tools/stats.js'
import { WatchManager } from './watch.js'
import { setupLazyIndexing } from './lazy.js'
import { initTypeScript } from './enhancer.js'
import { setupTaskbridge } from './setup/taskbridge.js'
import { listTasksTool, selectTaskTool, archiveTaskTool } from './tools/task-tools.js'
import { tasksCommandDefinition } from './commands/tasks.js'

export const name = 'dsh-project-memory'
export const inject = ['llm', 'tools']

export const Config = Schema.object({
  memoryDir: Schema.string().default('.dsh-project-memory'),
  chunkChars: Schema.number().default(3000),
  maxChunksPerFile: Schema.number().default(40),
  maxFileSizeMb: Schema.number().default(50),
  maxOutputChars: Schema.number().default(8000),
  maxPdfPages: Schema.number().default(1000),
  llmQueryExpansion: Schema.boolean().default(false),
  expansionCount: Schema.number().default(6),
  lazyIndexing: Schema.boolean().default(true),
  autoIndexOnFirstUse: Schema.boolean().default(false),
  watch: Schema.boolean().default(true),
  watchInterval: Schema.number().default(15),
  tsPath: Schema.string(),
  enableTypeScript: Schema.boolean().default(true),
  tasklist: Schema.object({
    enabled: Schema.boolean().default(true),
  }).default({}),
})

export function apply(ctx, config) {
  // Initialize TypeScript enhancer if enabled
  if (config.enableTypeScript !== false) {
    initTypeScript(config)
  }

  const watchManager = new WatchManager(ctx, config)
  if (config.watch) {
    watchManager.restorePersisted()
    ctx.effect(() => {
      watchManager.start(config.watchInterval * 1000)
      return () => watchManager.stop()
    })
  }

  if (config.lazyIndexing) {
    setupLazyIndexing(ctx, config, watchManager)
  }

  // TaskBridge：任务实体 + 宿主 todo 同步
  setupTaskbridge(ctx, config)
  ctx.tools.register(listTasksTool(config))
  ctx.tools.register(selectTaskTool(config))
  ctx.tools.register(archiveTaskTool(config))

  // /tasks 用户命令（宿主 commands 服务存在时注册，feature-detect 降级）
  try {
    ctx.inject(['commands'], (commandsCtx) => {
      commandsCtx.commands.register(tasksCommandDefinition(config))
    })
  } catch (err) {
    console.error(`[dsh-project-memory] /tasks registration skipped: ${err.message}`)
  }

  ctx.tools.register(indexDocTool(ctx, config))
  ctx.tools.register(indexRepoTool(ctx, config))
  ctx.tools.register(queryMemoryTool(ctx, config))
  ctx.tools.register(rememberTool(config))
  ctx.tools.register(forgetTool(config))
  ctx.tools.register(watchRepoTool(watchManager, config))
  ctx.tools.register(statsTool(config))

  if (config.autoIndexOnFirstUse) {
    ctx.effect(async () => {
      const root = process.cwd()
      try {
        watchManager.addRoot(root)
        const report = await indexRepository(ctx, config, root)
        console.log(`[dsh-project-memory] ${report}`)
      } catch (err) {
        console.error(`[dsh-project-memory] auto-index failed for ${root}: ${err.message}`)
      }
    })
  }
}