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
import { listTasksTool, selectTaskTool, archiveTaskTool, showTaskPanelTool } from './tools/task-tools.js'
import { lessonTool } from './tools/lesson-tools.js'
import { installAutoInject } from './auto-inject.js'
import { rememberRoute } from './llm-route.js'
import { tasksCommandDefinition } from './commands/tasks.js'
import { taskCommandDefinition } from './commands/task-actions.js'
import { insightCommandDefinition } from './commands/insight-actions.js'

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
  // D4：辅助 LLM 调用（doc 摘要 / 查询扩展 / 反思）的路由覆写。
  // 未设置时：工具调用取当前会话 header 的 provider/model；后台 watch/lazy 取最近一次会话路由。
  // 两者都拿不到时明确走非 LLM 回退并记录 degraded（不静默）。
  llm: Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
  }).default({}),
  lazyIndexing: Schema.boolean().default(true),
  autoIndexOnFirstUse: Schema.boolean().default(false),
  watch: Schema.boolean().default(true),
  watchInterval: Schema.number().default(15),
  tsPath: Schema.string(),
  enableTypeScript: Schema.boolean().default(true),
  tasklist: Schema.object({
    enabled: Schema.boolean().default(true),
    // 任务成为会话绑定（select_task / /task switch）时，把任务步骤推成宿主 todo/write 快照
    syncHostOnAdopt: Schema.boolean().default(true),
  }).default({}),
  // v0.5 单一 insight 实体：分层去重/强化/提升/容量/归档（详见 PLAN-v0.5.0.md）
  insight: Schema.object({
    dedupOverlap: Schema.number().default(0.7),
    reinforceBand: Schema.number().default(0.65),
    maxProject: Schema.number().default(100),
    maxGlobalProcedures: Schema.number().default(200),
    promoteConfidence: Schema.number().default(0.7),
    globalPromoteTasks: Schema.number().default(3),
    decayDays: Schema.number().default(90),
    globalFile: Schema.string(),
  }).default({}),
  // PR 1b：反思管线（LLM 消费点，默认关）。产出只写 task 级草稿，见 PLAN §3
  reflection: Schema.object({
    enabled: Schema.boolean().default(false),
    cooldownMs: Schema.number().default(1800000),
    maxLessonsPerReflect: Schema.number().default(3),
    maxDecisionsPerReflect: Schema.number().default(2),
  }).default({}),
  // PR 2：静默注入（entry 常驻块 + relevance 门控）。无项目 root 可解析时零副作用
  autoContext: Schema.object({
    enabled: Schema.boolean().default(true),
    entryOn: Schema.boolean().default(true),
    maxTokens: Schema.number().default(400),
    relevanceMin: Schema.number().default(0.25),
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
  // D4：跟踪会话路由（request/header 事件），为 watch/lazy 等无会话上下文的后台索引兜底
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'request/header') rememberRoute(session)
  })
  ctx.tools.register(listTasksTool(config))
  ctx.tools.register(selectTaskTool(config, { llm: ctx.llm, ctx }))
  ctx.tools.register(archiveTaskTool(config, { llm: ctx.llm, ctx }))
  ctx.tools.register(showTaskPanelTool(config))

  // /tasks、/task、/insight 用户命令（宿主 commands 服务存在时注册，feature-detect 降级）
  try {
    ctx.inject(['commands'], (commandsCtx) => {
      commandsCtx.commands.register(tasksCommandDefinition(config, ctx))
      commandsCtx.commands.register(taskCommandDefinition(config, ctx))
      commandsCtx.commands.register(insightCommandDefinition(config, ctx))
    })
  } catch (err) {
    console.error(`[dsh-project-memory] /tasks,/task,/insight registration skipped: ${err.message}`)
  }

  ctx.tools.register(indexDocTool(ctx, config))
  ctx.tools.register(indexRepoTool(ctx, config))
  ctx.tools.register(queryMemoryTool(ctx, config))
  ctx.tools.register(rememberTool(config))
  ctx.tools.register(forgetTool(config))
  ctx.tools.register(lessonTool(config))
  ctx.tools.register(watchRepoTool(watchManager, config))
  ctx.tools.register(statsTool(config))

  // PR 2：注册 agent/pre-step 监听，向每步请求的 enter 决策追加记忆消息（默认开；
  // 任何异常/无会话 cwd → 交回默认决策，零副作用）
  installAutoInject(ctx, config)

  if (config.autoIndexOnFirstUse) {
    // effect 回调必须同步并返回 disposer；异步体独立执行，用 cancelled 标志避免卸载后再写日志
    ctx.effect(() => {
      let cancelled = false
      const run = async () => {
        const root = process.cwd()
        try {
          watchManager.addRoot(root)
          const report = await indexRepository(ctx, config, root)
          if (!cancelled) console.log(`[dsh-project-memory] ${report}`)
        } catch (err) {
          if (!cancelled) console.error(`[dsh-project-memory] auto-index failed for ${root}: ${err.message}`)
        }
      }
      run()
      return () => {
        cancelled = true
      }
    })
  }
}