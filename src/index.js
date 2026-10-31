import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_SCAN_DEPTH, DEFAULT_SCAN_FILES, assertSafeRoot } from './util/fs.js'
import { indexDocTool } from './tools/index-doc.js'
import { indexRepoTool, indexRepository } from './tools/index-repo.js'
import { queryMemoryTool } from './tools/query-memory.js'
import { rememberTool } from './tools/remember.js'
import { forgetTool } from './tools/forget.js'
import { watchRepoTool } from './tools/watch-repo.js'
import { statsTool } from './tools/stats.js'
import { WatchManager, applyWatchSettings } from './watch.js'
import { setupLazyIndexing } from './lazy.js'
import { initTypeScript } from './enhancer.js'
import { setupTaskbridge } from './setup/taskbridge.js'
import { listTasksTool, selectTaskTool, archiveTaskTool, showTaskPanelTool } from './tools/task-tools.js'
import { lessonTool } from './tools/lesson-tools.js'
import { installAutoInject } from './auto-inject.js'
import { rememberRoute } from './llm-route.js'
import { workflowCommandDefinition } from './commands/workflow.js'
import { setupSkill } from './skill.js'
import { flushDirtyStores } from './util/flush.js'
import { cfgValue, changedConfigKeys, asVolatile } from './util/config.js'

export const name = 'dsh-project-memory'
export const inject = ['llm', 'tools']

export const Config = Schema.object({
  memoryDir: Schema.string().default('.dsh-project-memory'),
  chunkChars: Schema.number().default(3000),
  maxChunksPerFile: Schema.number().default(40),
  // 单文件内存闸门，不是磁盘设置：索引一个文件要先整个物化，峰值随文件大小线性走。
  // 实测边际系数（峰值 RSS / 磁盘 MB，见 scripts/file-peak.mjs 与 README「单文件内存预算」）：
  // 典型源码 ~10×、符号密集代码 ~22×、文本型 PDF ~20×；10 把单文件增量压在 ~+300 MB。
  maxFileSizeMb: Schema.number().default(10),
  maxOutputChars: Schema.number().default(8000),
  maxPdfPages: Schema.number().default(1000),
  llmQueryExpansion: asVolatile(Schema.boolean().default(false)),
  expansionCount: Schema.number().default(6),
  // 辅助 LLM 调用的路由覆写 —— **索引期零 LLM**，只服务召回期查询扩展与反思期。
  // 未设置时取当前会话 header 的 provider/model，后台路径取最近一次会话路由；都拿不到时
  // 走回退并记录 degraded（不静默）。
  llm: Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
  }).default({}),
  // 以下三个键在 web 的插件页上有可视化设置（`plugins.bundle.config`，见 src/client/settings-card.tsx）。
  // `.volatile()` 是宿主设置页的准入条件：只有 volatile 字段能经 settings 接口写入，且写入后**不重启**
  // 插件、以 ref 形式原地更新。读取一律走 util/config.js 的 cfgValue()（ref 是对象，直接判真会读错）。
  //
  // 其余的键**刻意不标 volatile**：`lazyIndexing` / `watch` / `enableTypeScript` 关掉只会让记忆变旧，
  // 不属于"用户偏好"；它们仍可在 profile 里改，但不出现在卡片上（关掉监视等于放任索引过期）。
  lazyIndexing: Schema.boolean().default(true),
  autoIndexOnFirstUse: asVolatile(Schema.boolean().default(false)),
  watch: Schema.boolean().default(true),
  watchInterval: asVolatile(Schema.number().default(30)),
  // 危险根护栏：家目录 / 文件系统根 / 系统目录 / 包管理器前缀（/opt/homebrew …）整体扫描会吃满
  // 内存，默认一律拒绝。`roots.*` 是配置档级例外表；`allowUnsafeRoots` 只放开内置名单，deny/exclude 仍优先。
  allowUnsafeRoots: Schema.boolean().default(false),
  roots: Schema.object({
    // 即使在内置名单里也允许作根。精确匹配；文件系统根不在可放行之列。
    allow: Schema.array(Schema.string()).default([]),
    // 这个目录不能当根。精确匹配：子目录仍可各自成根。
    deny: Schema.array(Schema.string()).default([]),
    // 这棵子树里的文件一律不进索引（前缀匹配，含子目录）。
    exclude: Schema.array(Schema.string()).default([]),
  }).default({}),
  // 单次扫描上限。超过即截断（并跳过"删除本轮未见到条目"的清理，避免把没扫到的文件误删）。
  // **不可取消**：0 / 负数 / 非数值一律回落默认值（见 util/fs.js 的 scanLimits）。
  maxScanFiles: Schema.number().default(DEFAULT_SCAN_FILES),
  maxScanDepth: Schema.number().default(DEFAULT_SCAN_DEPTH),
  tsPath: Schema.string(),
  enableTypeScript: Schema.boolean().default(true),
  tasklist: Schema.object({
    enabled: Schema.boolean().default(true),
    // 任务成为会话绑定（select_task / /task switch）时，把任务步骤推成宿主 todo/write 快照
    syncHostOnAdopt: Schema.boolean().default(true),
  }).default({}),
  // insight 实体：分层去重/强化/提升/容量/归档
  insight: Schema.object({
    dedupOverlap: Schema.number().default(0.7),
    reinforceBand: Schema.number().default(0.65),
    // 向量带（需 leanvec；未装自动退化成上面的纯词法带）。`0` = 关闭对应那条带
    // （不设 ≠ 0，默认值仍是 0.9 / 0.7）。
    autoMergeCos: Schema.number().default(0.9),
    autoMergeMargin: Schema.number().default(0.05),
    hintCos: Schema.number().default(0.7),
    maxForgetMatches: Schema.number().default(10),
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
  // 静默注入（entry 常驻块 + relevance 门控）；无项目 root 可解析时零副作用。
  autoContext: Schema.object({
    enabled: Schema.boolean().default(true),
    entryOn: Schema.boolean().default(true),
    maxTokens: Schema.number().default(400),
    entryMaxInsights: Schema.number().default(6),
    // 提示通道的相对阈值（层内最高分的比例）——出厂判据
    signalMinRatio: Schema.number().default(0.5),
    // resident 任务卡最多显示几个「编辑中」文件
    editedMax: Schema.number().default(3),
    // 记忆根是"推定"的（会话工作目录且无项目标记）时，首次注入前通告模型根在哪；只发一次、不占条目额度。
    rootNotice: Schema.boolean().default(true),
    // 模型自己维护清单且之后没有新人类消息时，不把任务卡回声给模型
    skipEchoSelfTodo: Schema.boolean().default(true),
    // ⚠️ 旧兼容闸门，**刻意不给默认值**：cfgEngine 以「是否为 number」选分支，有默认值就永远走
    // 旧的绝对 overlap 判据（长消息实测只有 0.014~0.057，必然过不了），signalMinRatio 变死代码；
    // 只有用户显式配置才保留旧行为。
    relevanceMin: Schema.number(),
    // 预算审计日志（stderr）**默认 off**：预算挤掉低优先级条目是正常降级、不是故障。
    // off（永不打印）/ once（每个会话最多一行）/ all（丢弃组合每变化一次一行，作者排查）
    budgetLog: Schema.union(['off', 'once', 'all']).default('off'),
    // 同一条 insight 重复注入的冷却（pre-step 步数）。0（默认）= 正文没变就不再注入（注入消息
    // 留在会话历史里，重发只是重复占位）；>0 用于外部裁剪历史的场景。
    reinjectItemsAfter: Schema.number().default(0),
    gateCooldownSteps: Schema.number().default(2),
    // 这两个是**保险丝**不是节流阀：节流由 gateCooldownSteps 与单轮 maxTokens 负责。
    // 实测旧默认 12 / 4000 时 11/81 个会话打满后永久静默；最长会话用 35 条 / 8640 字符，
    // 故抬到 60 / 24000。显式配小值可复现旧行为。
    maxItemsPerSession: Schema.number().default(60),
    maxItemCharsPerSession: Schema.number().default(24000),
    hintMinCoverage: Schema.number().default(0.45),
    hintMinMatched: Schema.number().default(2),
    hintMinSupport: Schema.number().default(0.15),
    // 可选向量层（leanvec）：**不装就是纯词法**，装了也只改经验/洞察层的**排序**，闸门与返回
    // 条数不变，doc/symbol 层不受影响。`vectorDir` 刻意**不给默认值**（否则"是否启用"永远为真）。
    // 解析顺序：本项显式路径 > DSH_LEANVEC_DIR > 可选依赖 `leanvec`；目录需有 dist/leanvec.f32
    // 与 tokenizer.json。**填 `off` 可强制关闭**（连模型都不加载）。
    vectorDir: Schema.string(),
    // 融合权重 (1-α)·BM25归一 + α·余弦。实测小 k 上 α=0.5 最优（k=3 64% vs 58%、k=5 69% vs 67%），
    // 而 α=1（纯向量）明显更差（hit@10 53% vs 81%）。`0` = 关掉重排（连模型都不加载）；
    // 它**只**管重排，写入侧去重看 `vectorDedup`。
    vectorAlpha: Schema.number().default(0.5),
    // 写入侧近重复检测（0.9 自动覆盖 / 0.7 近邻提示）的独立开关。默认开；关掉只影响写入，不影响召回排序。
    vectorDedup: Schema.boolean().default(true),
    // ⚠ 两个**实验性**旋钮：没有可发布的默认值，所以不设就不启用（不设 ≠ 0）。
    //   itemMin  —— 提示通道的条目级余弦地板；speakMin —— 通道级"语义救援"阈值。
    // 分辨力结论见 src/auto-inject.js 的 scoreHints 注释（**证据不足**），留作真实数据上复现 A/B。
    vectorItemMin: Schema.number(),
    vectorSpeakMin: Schema.number(),
    // legacy `trigger.scope` 的处置。默认 **ignore**：值由作者手写，几乎不可能落在自动派生的
    // 项目画像 tag 空间里，当收窄条件只会判死条目。显式配 'filter' 可恢复旧语义。
    legacyScope: Schema.union(['filter', 'ignore']).default('ignore'),
    auditLog: Schema.boolean().default(true),
    auditMaxBytes: Schema.number().default(262144),
    // 影子记录（admission-shadow.jsonl）：**每步**一行，含全部候选的判据特征与场景。主审计只在
    // 真的注入时写，静默步零痕迹 → 无法离线重放"换个阈值会怎样"。只写盘、不进 prompt、不花 token，
    // 所以默认开。轮转只留 `.1` 一代，单项目日志硬上限是 `2 × shadowMaxBytes + 2 × auditMaxBytes`。
    shadowLog: Schema.boolean().default(true),
    shadowMaxBytes: Schema.number().default(524288),
  }).default({}),
})

export function apply(ctx, config) {
  if (config.enableTypeScript !== false) {
    initTypeScript(config)
  }

  const watchManager = new WatchManager(ctx, config)
  // watchInterval 是 volatile 字段：设置页改完要当场生效（重排定时器），而不是等下次启动。
  // watch 本身不提供界面开关（关掉监视等于放任索引过期），但仍可在 profile 里设 false。
  // 持久化的根清单只恢复一次；先关后开时补一次（否则"打开监视"要等到下次启动才真的开始轮询）。
  let watchRestored = false
  const syncWatch = () => {
    if (cfgValue(config, 'watch') !== false && !watchRestored) {
      watchRestored = true
      watchManager.restorePersisted()
    }
    return applyWatchSettings(watchManager, config)
  }
  ctx.effect(() => {
    syncWatch()
    return () => watchManager.stop()
  })

  if (config.lazyIndexing) {
    setupLazyIndexing(ctx, config, watchManager)
  }

  // 设置页保存（宿主 volatile 更新）后：只有 watchInterval 会影响运行中的定时器，
  // 其余 volatile 字段都在各自的读取点当场生效（llmQueryExpansion 每次查询读、autoIndex 只认启动值）。
  // paths 为 `[[]]` 时表示整份 Config 都可能变了 → changedConfigKeys 返回 null，按"全部重读"处理。
  ctx.on('loader/volatile-update', (paths) => {
    const changed = changedConfigKeys(paths)
    if (changed === null || changed.has('watchInterval')) syncWatch()
  })

  // 卸载/退出前把还脏着的 store 同步写一次（后台重试只是兜底，不能当正确性保证）。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => flushDirtyStores({ timeoutMs: 1500 }))
  }
  // TaskBridge：任务实体 + 宿主 todo 同步
  setupTaskbridge(ctx, config)
  // 用法本身也是记忆的一部分：注册成宿主 skill（可选依赖，没有 skills 服务就静默跳过）。
  setupSkill(ctx)
  // 跟踪会话路由（request/header 事件），为无会话上下文的召回期可选 LLM（查询扩展 / 反思）兜底
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'request/header') rememberRoute(session)
    // 会话活跃信号：跑回合时把 watch 轮询压到最低，回合结束立刻补扫一次（见 watch.js）。
    const key = session?.id ?? 'unknown'
    if (event?.type === 'turn/start' || event?.type === 'step/start') watchManager.setSessionActive(key, true)
    else if (event?.type === 'turn/end') watchManager.setSessionActive(key, false)
  })
  // 会话被销毁时也要摘掉活跃标记，否则没有正常 turn/end 的会话会把轮询**永久**压在兜底节拍。
  ctx.on('session/disposed', (session) => {
    watchManager.setSessionActive(session?.id ?? 'unknown', false)
  })
  ctx.tools.register(listTasksTool(config))
  ctx.tools.register(selectTaskTool(config, { llm: ctx.llm, ctx }))
  ctx.tools.register(archiveTaskTool(config, { llm: ctx.llm, ctx }))
  ctx.tools.register(showTaskPanelTool(config))

  // /tasks：唯一的用户命令（宿主命令注册后必然出现在 `/` 菜单且无法隐藏，所以只留一条）；
  // 切换/归档/审核等子动词由面板按钮经 remote.commands.execute 驱动。
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

  // 注册 agent/pre-step 监听，向每步请求追加记忆消息（默认开；异常/无会话 cwd → 交回默认决策）。
  installAutoInject(ctx, config)

  // 启动时全量索引是**一次性**动作：设置页把它打开只影响下一次启动，不会当场扫全树
  // （卡片上的说明也这么写）。所以这里读的是本次启动时的值，不订阅后续变化。
  if (cfgValue(config, 'autoIndexOnFirstUse')) {
    // effect 回调必须同步并返回 disposer；异步体独立执行，用 cancelled 标志避免卸载后再写日志
    ctx.effect(() => {
      let cancelled = false
      const run = async () => {
        const root = process.cwd()
        // 全量索引 cwd 是显式开启的行为，但"cwd 是家目录"几乎总是误用：拒绝并说明，
        // 而不是替用户扫全树。这里走与工具调用同一个 assertSafeRoot：allow / deny / exclude 全生效。
        try {
          assertSafeRoot(root, { config })
        } catch (err) {
          if (!cancelled) console.error(`[dsh-project-memory] autoIndexOnFirstUse skipped: ${err.message}`)
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