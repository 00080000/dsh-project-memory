import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertIndexRoot, memoryRootFor, normalizeCitationFiles, resolveSafeIndexRoot } from '../util/fs.js'
import { ProjectMemoryStore } from '../store.js'
import { truncate } from '../util/text.js'
import { cfgInsight, saveInsight, defaultGlobalFile, GlobalStore } from '../insight-store.js'
import { ensureGlobalInit } from '../global-seed.js'
import { INSIGHT_KINDS, INSIGHT_SCOPES } from '../insight-store.js'
import { sessionIdOf } from '../util/task-view.js'
import { createVectorRerank, vectorItemsFrom } from '../vector-index.js'
import { createWriteCosine } from '../auto-inject.js'

export function lessonTool(config) {
  const kindDesc = 'lesson(坑→改法) | decision(选择+理由) | procedure(步骤) | experience(问题→解法)；默认 lesson。'
  const scopeDesc =
    'task(任务私有) | project(项目资产) | global(跨项目)；默认 project；给 id 时就地更新。'
  return defineTool({
    name: 'save_lesson',
    description:
      '写入一条教训 / 决策 / 流程（单条 insight）。写入前与既有记忆比对：高相似度自动覆盖（旧值留在 prev），'
      + '较近的提示近邻 id。发现记错/过时：带 id 再写一次即就地覆盖；确定要删用 forget。',
    parameters: {
      id: { type: 'string', description: '既有条目 id（就地更新，忽略 scope）' },
      title: { type: 'string', description: '一行标题' },
      kind: { type: 'string', enum: INSIGHT_KINDS, description: kindDesc },
      scope: { type: 'string', enum: INSIGHT_SCOPES, description: scopeDesc },
      pattern: { type: 'string', description: '错误模式' },
      fix: { type: 'string', description: '修正做法' },
      choice: { type: 'string', description: '选了什么' },
      reason: { type: 'string', description: '为什么' },
      steps: { type: 'array', items: { type: 'string' }, description: '有序步骤' },
      trigger: {
        type: 'object',
        additionalProperties: false,
        properties: {
          when: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ops: { type: 'array', items: { type: 'string' }, description: 'file-write|file-delete|shell-run|git-commit|git-push|release|npm-publish|deploy|migrate|render-doc|index-doc|read-image|fetch-web|run-bench|query-memory' },
              writes: { type: 'array', items: { type: 'string' }, description: '项目相对路径，禁 glob' },
              intents: { type: 'array', items: { type: 'string' }, description: '意图词（CJK≥2，拉丁≥5）' },
            },
            description: '唯一触发面：三者取或。',
          },
          guard: {
            type: 'object',
            additionalProperties: false,
            properties: {
              paths: { type: 'array', items: { type: 'string' }, description: '写目标须命中其一' },
              not_paths: { type: 'array', items: { type: 'string' } },
              hosts: { type: 'array', items: { type: 'string' }, description: '如 wsl' },
              tags: { type: 'array', items: { type: 'string' }, description: '画像 tag 交集' },
            },
            description: '收窄条件：全部满足才放行。',
          },
          prevents: { type: 'string', description: '不知道它会做错什么' },
          // 旧字段：历史条目与旧调用仍可能带它们，保留形状但不占描述预算。
          keywords: { type: 'array', items: { type: 'string' } },
          symbols: { type: 'array', items: { type: 'string' } },
          actions: { type: 'array', items: { type: 'string' } },
          paths: { type: 'array', items: { type: 'string' } },
          scope: { type: 'array', items: { type: 'string' } },
        },
        description: '命中即在动手前注入；when 是唯一触发面，guard 只能收窄。',
      },
      task_id: { type: 'string', description: '目标任务 id' },
      files: { type: 'array', items: { type: 'string' }, description: '关联文件（项目相对）' },
      symbols: { type: 'array', items: { type: 'string' }, description: '关联符号' },
      confidence: { type: 'number', description: '0..1' },
      root: { type: 'string', description: '项目根' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const root = resolveSafeIndexRoot(exec, args.root, config)
      assertIndexRoot(root, args.root || root)
      // 写入期约束：files 只收项目内相对路径（schema 早就这么承诺，此前没有校验）。
      const citationFiles = normalizeCitationFiles(args.files, root)
      const memoryDir = memoryRootFor(root, config.memoryDir)
      const store = new ProjectMemoryStore(memoryDir).load()
      const cfg = cfgInsight(config)
      const sid = sessionIdOf(exec)
      const boundTaskId = sid ? store.getBoundTaskId(sid) : undefined
      const taskId = args.task_id || boundTaskId

      const raw = {
        id: args.id,
        title: args.title,
        kind: args.kind,
        pattern: args.pattern,
        fix: args.fix,
        choice: args.choice,
        reason: args.reason,
        steps: args.steps,
        trigger: args.trigger,
        files: citationFiles.files,
        symbols: args.symbols,
        confidence: args.confidence,
      }
      // 就地更新只要求 id（可以只改一个字段）；新建仍然要求有个能当标题的东西。
      if (!args.id && !raw.title && !raw.pattern && !raw.choice) {
        return truncate(JSON.stringify({ success: false, error: '需要 title / pattern / choice 之一（或给 id 做就地更新）' }), config.maxOutputChars || 8000)
      }
      if (!INSIGHT_KINDS.includes(raw.kind)) raw.kind = 'lesson'

      let scope = args.scope
      if (!scope) scope = taskId ? 'task' : 'project'
      if (!args.id && scope === 'task' && !taskId) {
        return truncate(JSON.stringify({ success: false, error: 'task 级写入需要 task_id（或先 select_task 绑定会话）' }), config.maxOutputChars || 8000)
      }

      ensureGlobalInit(config) // 幂等确保 global 文件结构就绪
      const globalStore = new GlobalStore(cfg.globalFile || defaultGlobalFile()).load()

      // 可选向量层：**没装/没配就是 null**，此时 saveInsight 逐字段退回原来的纯词法行为。
      // 就地更新（给了 id）不需要比对，跳过它可以省掉一次模型加载（~118ms / ~120MB）。
      let cosine = null
      if (!args.id) {
        cosine = await createWriteCosine(config, { storeDir: memoryDir, items: vectorItemsFrom(store, globalStore) })
      }

      let result
      store.commit((s) => {
        result = saveInsight({ store: s, globalStore, raw, scope, taskId, cfg, source: 'agent', cosine })
        return result
      })
      // global 变更（global scope 直写或 project 自动提升）单独落盘
      globalStore.commit()
      if (!result) result = { ok: false, error: '写入未完成' }
      const body = result.ok
        ? `Saved insight ${result.id} [scope=${result.scope || scope}] action=${result.action}${result.hint ? ` — ${result.hint}` : ''}`
        : `Failed: ${result.error}`
      // 丢弃必须说出来：静默少几行引用，事后只能靠审计发现"查不到"。
      const note = citationFiles.dropped.length
        ? `\n（${citationFiles.dropped.length} 个 files 既不是项目内相对路径也不是项目内绝对路径，已丢弃：${citationFiles.dropped.slice(0, 3).join(', ')}${citationFiles.dropped.length > 3 ? ' …' : ''}）`
        : ''
      return truncate(body + note, config.maxOutputChars || 8000)
    },
  })
}
