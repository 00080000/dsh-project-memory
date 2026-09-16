import { defineTool } from '@deepseek-ai/dsh-tools'
import { memoryRootFor, resolveIndexRoot } from '../util/fs.js'
import { ProjectMemoryStore } from '../store.js'
import { truncate } from '../util/text.js'
import { cfgInsight, saveInsight, defaultGlobalFile, GlobalStore } from '../insight-store.js'
import { ensureGlobalInit } from '../global-seed.js'
import { INSIGHT_KINDS, INSIGHT_SCOPES } from '../insight-store.js'

function sessionIdOf(exec) {
  return exec?.agent?.session?.id || exec?.ctx?.session?.id
}

export function lessonTool(config) {
  const kindDesc = `insight 语义：lesson(曾踩坑/纠偏, pattern→fix) | decision(权衡选型, choice→reason) | procedure(多步指南, steps) | experience(problem→solution，v0.4 兼容)。默认 lesson。所有 kind 都可带 trigger：命中即在动手前确定性注入。`
  const scopeDesc =
    '作用域：task(任务私有，随任务归档，不进共享注入) | project(项目资产) | global(个人能力库，跨项目，建议配 trigger 关键词以便将来技能命中)。' +
    '解析顺序：显式 scope > task_id > 当前绑定任务 > project。'
  return defineTool({
    name: 'save_lesson',
    description:
      'Save a lesson/decision/procedure/experience into the tiered memory (single insight entity). ' +
      'Call it when the task hit a real pitfall, got corrected, or made a deliberate choice worth remembering — not for routine work. ' +
      'Similar entries auto-merge (bidirectional token overlap >= 0.7) or reinforce (0.65~0.7, accumulating task hits); ' +
      'when the same insight is hit by 2+ tasks it auto-promotes task -> project, 3+ tasks project -> global. ' + kindDesc + ' ' + scopeDesc,
    parameters: {
      title: { type: 'string', description: 'One-line title (lesson: the failure pattern; decision: the topic; procedure: the name).' },
      kind: { type: 'string', enum: INSIGHT_KINDS, description: kindDesc },
      scope: { type: 'string', enum: INSIGHT_SCOPES, description: scopeDesc },
      pattern: { type: 'string', description: 'kind=lesson: 具体错误模式（同 title 时二选一）' },
      fix: { type: 'string', description: 'kind=lesson: 修正做法' },
      choice: { type: 'string', description: 'kind=decision: 选了什么' },
      reason: { type: 'string', description: 'kind=decision: 为什么（权衡点）' },
      steps: { type: 'array', items: { type: 'string' }, description: 'kind=procedure: 有序步骤（未来静默注入的正文）' },
      trigger: {
        type: 'object',
        additionalProperties: false,
        properties: {
          when: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ops: { type: 'array', items: { type: 'string' }, description: '归一动作 id：file-write / file-delete / shell-run / git-commit / git-push / release / npm-publish / deploy / migrate / render-doc / index-doc / read-image / fetch-web / run-bench / query-memory。' },
              writes: { type: 'array', items: { type: 'string' }, description: '本次要【写】的项目相对路径（禁扩展名/泛名 glob）。' },
              intents: { type: 'array', items: { type: 'string' }, description: '人类消息里剥离引用后的意图词（CJK ≥2 字、拉丁 ≥5 字符且不含 _ . /）。' },
            },
            description: '唯一触发面：三者取或。',
          },
          guard: {
            type: 'object',
            additionalProperties: false,
            properties: {
              paths: { type: 'array', items: { type: 'string' }, description: '收窄：写目标必须命中其中之一（自己不能触发）。' },
              not_paths: { type: 'array', items: { type: 'string' } },
              hosts: { type: 'array', items: { type: 'string' }, description: '例如 wsl（命令里出现 /mnt/* 或 powershell.exe）。' },
              tags: { type: 'array', items: { type: 'string' }, description: '项目画像 tag 交集（画像未知时不过滤）。' },
            },
            description: '收窄条件：全部满足才注入。',
          },
          prevents: { type: 'string', description: '准入条件：不知道这条，这一步会做错什么。写不出来 → 不该进自动注入。' },
          keywords: { type: 'array', items: { type: 'string' }, description: '【旧字段】降级为 intents 与被动召回排序。' },
          symbols: { type: 'array', items: { type: 'string' } },
          actions: { type: 'array', items: { type: 'string' }, description: '【旧字段】映射为 when.ops；死值丢弃并计入自检。' },
          paths: { type: 'array', items: { type: 'string' }, description: '【旧字段】具体文件映射为 when.writes；扩展名/泛名 glob 丢弃。' },
          scope: { type: 'array', items: { type: 'string' }, description: '【旧字段】默认忽略（值不在项目画像 tag 空间里）。' },
        },
        description:
          'authored trigger：命中即在**动手前**确定性注入。' +
          'when = 唯一触发面（ops / writes / intents 取或）；guard 只能收窄；prevents 是准入条件。' +
          '没有 when 的条目不会自动推送，只出现在记忆目录里供按需拉取。',
      },
      task_id: { type: 'string', description: '目标任务 id（scope 缺省时优先于绑定任务）' },
      files: { type: 'array', items: { type: 'string' }, description: '关联文件（项目相对路径）' },
      symbols: { type: 'array', items: { type: 'string' }, description: '关联符号' },
      confidence: { type: 'number', description: '置信 0..1（默认 0.8）' },
      root: { type: 'string', description: 'Project root. Defaults to current working directory.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const root = resolveIndexRoot(exec, args.root)
      const memoryDir = memoryRootFor(root, config.memoryDir)
      const store = new ProjectMemoryStore(memoryDir).load()
      const cfg = cfgInsight(config)
      const sid = sessionIdOf(exec)
      const boundTaskId = sid ? store.getBoundTaskId(sid) : undefined
      const taskId = args.task_id || boundTaskId

      const raw = {
        title: args.title,
        kind: args.kind,
        pattern: args.pattern,
        fix: args.fix,
        choice: args.choice,
        reason: args.reason,
        steps: args.steps,
        trigger: args.trigger,
        files: args.files,
        symbols: args.symbols,
        confidence: args.confidence,
      }
      if (!raw.title && !raw.pattern && !raw.choice) {
        return truncate(JSON.stringify({ success: false, error: '需要 title / pattern / choice 之一' }), config.maxOutputChars || 8000)
      }
      if (!INSIGHT_KINDS.includes(raw.kind)) raw.kind = 'lesson'

      let scope = args.scope
      if (!scope) scope = taskId ? 'task' : 'project'
      if (scope === 'task' && !taskId) {
        return truncate(JSON.stringify({ success: false, error: 'task 级写入需要 task_id（或先 select_task 绑定会话）' }), config.maxOutputChars || 8000)
      }

      ensureGlobalInit(config) // 幂等确保 global 文件结构就绪
      const globalStore = new GlobalStore(cfg.globalFile || defaultGlobalFile()).load()

      let result
      store.commit((s) => {
        result = saveInsight({ store: s, globalStore, raw, scope, taskId, cfg, source: 'agent' })
        return result
      })
      // global 变更（global scope 直写或 project 自动提升）单独落盘
      globalStore.commit()
      if (!result) result = { ok: false, error: '写入未完成' }
      const body = result.ok
        ? `Saved insight ${result.id} [scope=${result.scope || scope}] action=${result.action}${result.hint ? ` — ${result.hint}` : ''}`
        : `Failed: ${result.error}`
      return truncate(body, config.maxOutputChars || 8000)
    },
  })
}
