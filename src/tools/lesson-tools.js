import { defineTool } from '@deepseek-ai/dsh-tools'
import { TEXT_OUTPUT } from './output.js'
import { openProjectContext } from './context.js'
import { normalizeCitationFiles } from '../util/fs.js'
import { truncate } from '../util/text.js'
import { saveInsight, defaultGlobalFile, GlobalStore } from '../insight-store.js'
import { ensureGlobalInit } from '../global-seed.js'
import { INSIGHT_KINDS, INSIGHT_SCOPES } from '../insight-store.js'
import { sessionIdOf } from '../util/task-view.js'
import { createVectorRerank, vectorItemsFrom } from '../vector-index.js'
import { createWriteCosine } from '../auto-inject.js'

export function lessonTool(config) {
  const kindDesc = 'lesson (pitfall → fix) | decision (choice + reason) | procedure (steps) | experience (problem → solution); default lesson.'
  const scopeDesc =
    'task | project | global; default: task when a task is bound, else project; passing id updates in place.'
  return defineTool({
    name: 'save_lesson',
    description:
      'One lesson / decision / procedure (a single insight). Keep only the criterion and command that stay true next time; run-specific values (version numbers, counts, branch names) stay out. '
      + 'It compares against existing memory first: high similarity overwrites (old value kept in prev), a near match returns the nearest id. '
      + 'If an entry you saw is wrong, stale or too thin to act on, pass its id and write again to update it in place instead of adding a new one; use forget to delete.',
    parameters: {
      id: { type: 'string', description: 'existing entry id (in-place update)' },
      title: { type: 'string', description: 'one-line title' },
      kind: { type: 'string', enum: INSIGHT_KINDS, description: kindDesc },
      scope: { type: 'string', enum: INSIGHT_SCOPES, description: scopeDesc },
      pattern: { type: 'string', description: 'error pattern' },
      fix: { type: 'string', description: 'corrected practice' },
      choice: { type: 'string', description: 'what was chosen' },
      reason: { type: 'string', description: 'why' },
      steps: { type: 'array', items: { type: 'string' }, description: 'ordered steps' },
      trigger: {
        type: 'object',
        additionalProperties: false,
        properties: {
          when: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ops: { type: 'array', items: { type: 'string' }, description: 'file-write|file-delete|shell-run|git-commit|git-push|release|npm-publish|deploy|migrate|render-doc|index-doc|read-image|fetch-web|run-bench|query-memory' },
              writes: { type: 'array', items: { type: 'string' }, description: 'project-relative paths, no glob' },
              intents: { type: 'array', items: { type: 'string' }, description: 'intent words (CJK ≥2, latin ≥5)' },
            },
            description: 'the only trigger surface: any of the three; without it the entry is retrieval-only.',
          },
          guard: {
            type: 'object',
            additionalProperties: false,
            properties: {
              paths: { type: 'array', items: { type: 'string' }, description: 'write target must match one of them' },
              not_paths: { type: 'array', items: { type: 'string' } },
              hosts: { type: 'array', items: { type: 'string' }, description: 'e.g. wsl' },
              tags: { type: 'array', items: { type: 'string' }, description: 'profile tag intersection' },
            },
            description: 'narrowing conditions: all must hold.',
          },
          prevents: { type: 'string', description: 'what breaks without this entry' },
          // 旧字段：历史条目与旧调用仍可能带它们，保留形状但不占描述预算。
          keywords: { type: 'array', items: { type: 'string' } },
          symbols: { type: 'array', items: { type: 'string' } },
          actions: { type: 'array', items: { type: 'string' } },
          paths: { type: 'array', items: { type: 'string' } },
          scope: { type: 'array', items: { type: 'string' } },
        },
        description: 'injects before acting when matched; when is the only trigger surface.',
      },
      task_id: { type: 'string', description: 'target task id' },
      files: { type: 'array', items: { type: 'string' }, description: 'related files (project-relative)' },
      symbols: { type: 'array', items: { type: 'string' }, description: 'related symbols' },
      confidence: { type: 'number', description: '0..1' },
      root: { type: 'string', description: 'project root' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const { root, memoryDir, store, cfg } = openProjectContext(exec, args, config)
      // 写入期约束：files 只收项目内相对路径（schema 早就这么承诺，此前没有校验）。
      const citationFiles = normalizeCitationFiles(args.files, root)
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
      // 只有新建才补默认 kind；带 id 的就地更新必须“只覆盖传了的字段”，
      // 否则一次改 fix/reason 会把 decision/procedure 静默降级成 lesson。
      if (!args.id && !INSIGHT_KINDS.includes(raw.kind)) raw.kind = 'lesson'

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
