import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_SCAN_DEPTH, DEFAULT_SCAN_FILES, isUnsafeRoot } from './util/fs.js'
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
import { workflowCommandDefinition } from './commands/workflow.js'

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
  // 辅助 LLM 调用的路由覆写 —— **索引期零 LLM**，这里的路由只服务于召回期可选项
  // （llmQueryExpansion 查询扩展）与反思期（reflection.enabled）。
  // 未设置时：工具调用取当前会话 header 的 provider/model；后台路径取最近一次会话路由（request/header）。
  // 两者都拿不到时明确走回退并记录 degraded（不静默）。
  llm: Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
  }).default({}),
  lazyIndexing: Schema.boolean().default(true),
  autoIndexOnFirstUse: Schema.boolean().default(false),
  watch: Schema.boolean().default(true),
  watchInterval: Schema.number().default(15),
  // 危险根护栏（issue #5）：家目录 / 文件系统根 / 系统目录 / 包管理器前缀（/opt/homebrew …）
  // 整体扫描会吃满内存，默认一律拒绝。**自动路径永不越权**——懒索引、会话审计、任务桥在
  // 这类目录里始终零副作用；这个开关只放开**显式**工具调用（index_repo / watch_repo /
  // remember 等带 root 的调用）。
  allowUnsafeRoots: Schema.boolean().default(false),
  // 单次扫描上限。超过即截断（并跳过"删除本轮未见到条目"的清理，避免把没扫到的文件误删）。
  // 显式设 0 表示不限制——自担风险。
  maxScanFiles: Schema.number().default(DEFAULT_SCAN_FILES),
  maxScanDepth: Schema.number().default(DEFAULT_SCAN_DEPTH),
  tsPath: Schema.string(),
  enableTypeScript: Schema.boolean().default(true),
  tasklist: Schema.object({
    enabled: Schema.boolean().default(true),
    // 任务成为会话绑定（select_task / /task switch）时，把任务步骤推成宿主 todo/write 快照
    syncHostOnAdopt: Schema.boolean().default(true),
  }).default({}),
  // v0.5 单一 insight 实体：分层去重/强化/提升/容量/归档
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
  // 反思管线（召回期可选 LLM 消费点，默认关）。产出只写 task 级草稿。
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
    entryMaxInsights: Schema.number().default(6),
    // 提示通道的相对阈值（层内最高分的比例）——出厂判据
    signalMinRatio: Schema.number().default(0.5),
    // resident 任务卡最多显示几个「编辑中」文件
    editedMax: Schema.number().default(3),
    // 记忆根是"推定"的（会话工作目录，且该目录没有项目标记）时，首次注入前通告模型
    // 根在哪、怎么改。状态声明，只发一次、不占条目额度。
    rootNotice: Schema.boolean().default(true),
    // 模型自己维护清单且之后没有新人类消息时，不把任务卡回声给模型
    skipEchoSelfTodo: Schema.boolean().default(true),
    // ⚠️ 旧兼容闸门，**刻意不给默认值**：cfgEngine 以「relevanceMin 是否为 number」选分支，
    // 一旦有默认值就会永远走旧的绝对 overlap 判据——而它对长消息实测只有 0.014~0.057，
    // 必然过不了，相对阈值 signalMinRatio 就变成死代码。只有用户显式配置才保留旧行为。
    relevanceMin: Schema.number(),
    // 预算审计日志（stderr）**默认 off**：终端是用户可见面，而"预算挤掉低优先级条目"是
    // 正常降级、不是故障——默认打印会让一次 dsh web 启动刷出多行，用户的第一反应是卸载插件。
    // off（默认，永不打印）/ once（每个会话最多一行，首次出现丢弃时）/ all（丢弃组合每变化一次一行，作者排查）
    budgetLog: Schema.union(['off', 'once', 'all']).default('off'),
    // 同一条 insight 在本会话里重复注入的冷却（pre-step 步数）。0（默认）= 正文没变就不再注入：
    // 注入消息留在会话历史里（宿主只追加不压缩），整块重发只是重复占位。>0 用于外部裁剪历史的场景。
    reinjectItemsAfter: Schema.number().default(0),
    // --- 准入旋钮（0.5.8 起补声明）---
    // 下面这些键自 S2/S4 起就在 cfgEngine / cfgAudit 里生效、README 也一直写着，但**从未**在
    // Schema 里声明过：走 cordis.patch.yml 配它们会被宿主按「not a declared property」拒掉，
    // 等于文档里的旋钮是假的。默认值以 cfgEngine 的兜底值为准（那里是权威，这里只负责暴露）。
    gateCooldownSteps: Schema.number().default(2),
    maxItemsPerSession: Schema.number().default(12),
    maxItemCharsPerSession: Schema.number().default(4000),
    hintMinCoverage: Schema.number().default(0.45),
    hintMinMatched: Schema.number().default(2),
    hintMinSupport: Schema.number().default(0.15),
    legacyScope: Schema.union(['filter', 'ignore']).default('filter'),
    auditLog: Schema.boolean().default(true),
    auditMaxBytes: Schema.number().default(262144),
    // 影子记录（admission-shadow.jsonl）：**每步**一行，含全部候选的判据特征与场景。
    // 主审计只在真的注入时写，静默步零痕迹 → 无法离线重放"换个阈值会怎样"，也攒不出样本。
    // 只写盘、不进 prompt、不花 token，所以默认开。
    shadowLog: Schema.boolean().default(true),
    shadowMaxBytes: Schema.number().default(2097152),
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
  // 跟踪会话路由（request/header 事件），为无会话上下文的召回期可选 LLM（查询扩展 / 反思）兜底
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'request/header') rememberRoute(session)
  })
  ctx.tools.register(listTasksTool(config))
  ctx.tools.register(selectTaskTool(config, { llm: ctx.llm, ctx }))
  ctx.tools.register(archiveTaskTool(config, { llm: ctx.llm, ctx }))
  ctx.tools.register(showTaskPanelTool(config))

  // /tasks：唯一的用户命令（合并自原 /tasks、/task、/insight —— 宿主命令只要注册就会
  // 出现在 `/` 菜单的「指令」组里且无法隐藏，三条命令就是三行去不掉的原始行）。
  // 切换/归档/审核等动作作为子动词，由面板按钮经 remote.commands.execute 驱动。
  try {
    ctx.inject(['commands'], (commandsCtx) => {
      commandsCtx.commands.register(workflowCommandDefinition(config, ctx))
    })
  } catch (err) {
    console.error(`[dsh-project-memory] /tasks registration skipped: ${err.message}`)
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
        // 全量索引 cwd 是显式开启的行为，但"cwd 是家目录"几乎总是误用：拒绝并说明，
        // 而不是替用户把整棵树扫一遍（旧实现直接 indexRepository(ctx, config, cwd)，
        // 没有任何护栏——这正是 issue #5 里最直接的 OOM 入口）。
        if (isUnsafeRoot(root) && config.allowUnsafeRoots !== true) {
          if (!cancelled) {
            console.error(
              `[dsh-project-memory] autoIndexOnFirstUse skipped: cwd ${root} is not a project root ` +
                '(home / system / package-manager prefix). Start dsh inside a project directory, ' +
                'or set allowUnsafeRoots: true to override.',
            )
          }
          return
        }
        try {
          watchManager.addRoot(root)
          const report = await indexRepository(ctx, config, root, { allowUnsafe: config.allowUnsafeRoots === true })
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