import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { memoryRootFor, resolveSafeIndexRoot } from '../util/fs.js'
import { ProjectMemoryStore, storeOverview } from '../store.js'
import { expandQuery } from '../llm.js'
import { resolveRoute } from '../llm-route.js'
import { GlobalStore, cfgInsight, defaultGlobalFile, recordHit } from '../insight-store.js'
import { recallItems } from '../recall.js'
import { resolveLinkedSymbols } from '../link.js'
import { truncate } from '../util/text.js'
import { stepContent, stepStatus } from '../util/task-view.js'
function toAbs(root, rel) {
  return path.isAbsolute(rel) ? rel : path.join(root, rel)
}

export function queryMemoryTool(ctx, config) {
  return defineTool({
    name: 'query_memory',
    description:
      'Search persistent project memory: doc summaries and code symbol tables (indexed via index_doc/index_repo), ' +
      'experience notes (problem -> solution, saved via remember) and insights (lessons / decisions / procedures, ' +
      'saved via save_lesson). Every hit returns its source path and line, or its insight id, so you can verify. ' +
      'Docs are cross-linked to the code symbols they mention. ' +
      'Use BEFORE grepping when you need orientation, a spec constraint, or a past decision.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'What to look for, e.g. "payment module fees", "who handles refunds", "spec constraint on timeouts".',
      },
      root: {
        type: 'string',
        description: 'Project root of the memory store to search. Defaults to the current working directory.',
      },
      type: {
        type: 'string',
        enum: ['all', 'doc', 'symbol', 'experience', 'insight', 'task'],
        description: 'Which memory layer to search. Default "all". "insight" searches lessons / decisions / procedures; "task" searches task records.',
      },
      limit: {
        type: 'number',
        description: 'Max results to return. Default 8.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const root = resolveSafeIndexRoot(exec, args.root, config)
      // 空查询不是"全部"：recallItems 会过滤空串，rankEntriesStreaming 随即返回
      // entries.slice(0, limit)（任意条目、分数 0），task 分支的 includes('') 更是命中所有任务。
      if (!String(args.query ?? '').trim()) {
        return 'query must not be empty. Use memory_stats to see what the store contains.'
      }
      const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
      const type = args.type || 'all'
      const limit = Math.max(1, Math.min(Number(args.limit) || 8, 20))

      const queries = config.llmQueryExpansion
        ? await expandQuery(ctx.llm, args.query, config.expansionCount, { route: resolveRoute(exec, config) })
        : [args.query]

      // 会话绑定决定 task 级 insight 的可见性；global 级始终可见。
      const sessionId = exec?.agent?.session?.id
      const boundTaskId = sessionId && typeof store.getBoundTaskId === 'function' ? store.getBoundTaskId(sessionId) : null
      const globalStore = new GlobalStore(cfgInsight(config).globalFile || defaultGlobalFile()).load()
      const wantMemory = type === 'all' || type === 'doc' || type === 'symbol'
      const wantInsight = type === 'all' || type === 'insight'
      // 一次 recall 覆盖全部层：doc/symbol/experience/insight 共用同一个检索核心（src/recall.js）。
      const recalled = recallItems({
        store,
        globalStore,
        queries,
        boundTaskId,
        limit,
        layers: [
          ...(wantMemory ? (type === 'symbol' ? ['symbol'] : type === 'doc' ? ['doc'] : ['doc', 'symbol']) : []),
          ...(wantInsight ? ['insight'] : []),
          ...(type === 'all' || type === 'experience' ? ['experience'] : []),
        ],
      })

      const lines = []
      // 使用记账：检索命中也是"被用到"（活跃度/衰减用得上它，见 recordHit）。查询是热路径
      // （p50 2.6ms），这里只改内存 + 标脏，**不**强制落盘——注入路径会立即落盘，这条路
      // 靠下一次自然 save 带上。记账失败绝不影响查询结果。
      if (wantInsight) {
        try {
          const bucket = recalled.layers.find((l) => l.layer === 'insight')
          recordHit({ store, globalStore, ids: (bucket?.hits || []).map((h) => h.item?.insightId) })
        } catch {
          /* ignore：记账是旁路 */
        }
      }
      if (wantMemory) {
        // doc/symbol 同源同尺度：合并后按加权分排序（规范段提权已计入 weightedScore）
        const memHits = recalled.layers
          .filter((l) => l.layer === 'doc' || l.layer === 'symbol')
          .flatMap((l) => l.hits)
          .sort((a, b) => b.weightedScore - a.weightedScore)
          .slice(0, limit)
        if (memHits.length) {
          const top = memHits[0].weightedScore || 1
          lines.push(`## Memory (${type === 'all' ? 'docs + symbols' : type})`)
          for (const { item: e, weightedScore } of memHits) {
            const absSource = e.sourceLine ? `${toAbs(root, e.sourcePath)}:${e.sourceLine}` : toAbs(root, e.sourcePath)
            const rel = Math.round((weightedScore / top) * 100)
            let summaryLine = `- ${e.summary}`
            if (e.type === 'doc' && e.blindSpots) {
              const queryTokens = queries.flatMap(q => q.split(/[\s\-_]+/)).map(t => t.toLowerCase()).filter(Boolean)
              const blindTokens = e.blindSpots.split(/[\s\-\u3000、，,、;；.。]+/).map(t => t.toLowerCase()).filter(Boolean)
              const hit = queryTokens.some(qt => blindTokens.some(bt => bt.includes(qt) || qt.includes(bt)))
              if (hit) {
                summaryLine += `\n- ⚠️ 摘要未覆盖：${e.blindSpots.replace(/^\s*\/\/\s*未覆盖[:：]\s*/, '')}。建议读原文 ${absSource}`
              }
            }
            // 条目状态占位（可证伪状态机落地前恒为 exact）。
            // 先立字段，后续状态机到位时只改值、不改输出契约。
            lines.push(`### ${e.title} (score: ${rel})\n- source: ${absSource}\n- status: ${e.status || 'exact'}\n${summaryLine}`)
            if (e.type === 'doc') {
              // 读取期解算：链接不落盘，按当前符号表排序取前 5（见 src/link.js）
              const refs = resolveLinkedSymbols(store, e, 5).map(
                (s) => `${s.title} @ ${toAbs(root, s.sourcePath)}:${s.sourceLine}`,
              )
              if (refs.length) lines.push(`- references: ${refs.join('; ')}`)
            }
          }
        }
      }
      if (wantInsight) {
        const bucket = recalled.layers.find((l) => l.layer === 'insight')
        if (bucket && bucket.hits.length) {
          lines.push('## Insights (lessons / decisions / procedures)')
          for (const { item: e, rel } of bucket.hits) {
            const scope = e.scope ? `, scope: ${e.scope}` : ''
            const files = e.files && e.files.length ? `\n- files: ${e.files.map((f) => toAbs(root, f)).join(', ')}` : ''
            const conf = typeof e.confidence === 'number' ? `\n- confidence: ${e.confidence}` : ''
            lines.push(
              `### ${e.title} (score: ${Math.round(rel * 100)}, kind: ${e.kind}${scope}, id: ${e.insightId})\n- ${e.summary}${files}${conf}`,
            )
          }
        }
      }
      if (type === 'all' || type === 'experience') {
        const expBucket = recalled.layers.find((l) => l.layer === 'experience')
        if (expBucket && expBucket.hits.length) {
          lines.push(`## Experience (past problems -> solutions)`)
          for (const { item: e, rel } of expBucket.hits) {
            const source = e.sourceFile ? ` (source: ${toAbs(root, e.sourceFile)})` : ''
            lines.push(
              `### Problem: ${e.problem} (score: ${Math.round(rel * 100)}, id: ${e.id})\n- solution: ${e.solution}${source}\n- updated: ${e.updatedAt}`,
            )
          }
        }
      }

      // TaskBridge: type:'task' 专门查任务记录；type:'all' 尾部附一行任务计数提示
      const tasks = store.tasks || []
      if (type === 'task') {
        const q = (queries[0] || '').toLowerCase()
        const matched = tasks
          .filter((t) => !t.archived && (t.title.toLowerCase().includes(q) || (t.steps || []).some((s) => stepContent(s).toLowerCase().includes(q)) || (t.files || []).some((f) => f.toLowerCase().includes(q))))
          .slice(0, limit)
        if (!matched.length) {
          return `任务记录: 0 套匹配 "${args.query}"（list_tasks 查看全部，select_task 续做）`
        }
        for (const t of matched) {
          const done = (t.steps || []).filter((s) => stepStatus(s) === 'completed').length
          const total = (t.steps || []).length
          const stepsText = (t.steps || []).length
            ? (t.steps || []).map((s) => `- [${stepStatus(s) === 'completed' ? 'x' : stepStatus(s) === 'in_progress' ? '*' : ' '}] ${stepContent(s)}`).join('\n')
            : '（无步骤）'
          const files = (t.files || []).slice(0, 8).join(', ')
          lines.push(`### ${t.title} (${done}/${total} 完成)\n${stepsText}\n- 文件: ${files || '无'}`)
        }
        return truncate(lines.join('\n\n'), config.maxOutputChars)
      }
      if (type === 'all' && tasks.length) {
        lines.push(`任务记录: ${tasks.length} 套（list_tasks 查看，select_task 续做）`)
      }

      if (!lines.length) {
        const overview = storeOverview(store)
        const hint =
          type === 'experience'
            ? 'Note a fix with remember so it can be recalled next time.'
            : type === 'insight'
              ? 'Save a lesson / decision / procedure with save_lesson so it can be recalled next time.'
              : type === 'all'
                ? 'Index it first with index_repo / index_doc, or note a fix with remember or save_lesson.'
                : 'Index it first with index_repo / index_doc.'
        const tail =
          overview.files === 0
            ? '. The store has never been indexed.'
            : overview.latest
              ? `, last indexed at ${overview.latest}. Use memory_stats to see what the store contains.`
              : '. Use memory_stats to see what the store contains.'
        return (
          `No memory matches for "${args.query}" in ${root}. ${hint}\n` +
          `Store overview: ${overview.files} files indexed, ${overview.entries} entries, ${overview.experience} experience notes${tail}`
        )
      }
      return truncate(lines.join('\n\n'), config.maxOutputChars)
    },
  })
}