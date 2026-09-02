import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { memoryRootFor, resolveIndexRoot } from '../util/fs.js'
import { ProjectMemoryStore, storeOverview } from '../store.js'
import { expandQuery } from '../llm.js'
import { rankEntriesMergedScored, rankExperienceScored, rankEntriesStreaming } from '../util/search.js'
import { truncate } from '../util/text.js'

function toAbs(root, rel) {
  return path.isAbsolute(rel) ? rel : path.join(root, rel)
}

export function queryMemoryTool(ctx, config) {
  return defineTool({
    name: 'query_memory',
    description:
      'Search persistent project memory: doc summaries and code symbol tables (indexed via index_doc/index_repo) ' +
      'plus experience notes (problem -> solution, saved via remember). Every hit returns its source path and line so ' +
      'you can verify by reading the real file. Docs are cross-linked to the code symbols they mention. ' +
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
        enum: ['all', 'doc', 'symbol', 'experience', 'task'],
        description: 'Which memory layer to search. Default "all". "task" searches task records (title/steps/files).',
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
      const root = resolveIndexRoot(exec, args.root)
      const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
      const type = args.type || 'all'
      const limit = Math.max(1, Math.min(Number(args.limit) || 8, 20))

      const queries = config.llmQueryExpansion
        ? await expandQuery(ctx.llm, args.query, config.expansionCount)
        : [args.query]
      const symbolById = new Map()
      for (const e of store.allEntries()) {
        if (e.type === 'symbol') symbolById.set(e.id, e)
      }

      const idf = store.getIdfCache()

      const lines = []
      if (type === 'all' || type === 'doc' || type === 'symbol') {
        const pool = type === 'all' ? store.allEntries() : store.allEntries().filter((e) => e.type === type)
        const scored = rankEntriesStreaming(pool, queries, idf, limit)
        if (scored.length) {
          const top = scored[0].score || 1
          lines.push(`## Memory (${type === 'all' ? 'docs + symbols' : type})`)
          for (const { entry: e, score } of scored) {
            const absSource = e.sourceLine ? `${toAbs(root, e.sourcePath)}:${e.sourceLine}` : toAbs(root, e.sourcePath)
            const rel = Math.round((score / top) * 100)
            let summaryLine = `- ${e.summary}`
            if (e.type === 'doc' && e.blindSpots) {
              const queryTokens = queries.flatMap(q => q.split(/[\s\-_]+/)).map(t => t.toLowerCase()).filter(Boolean)
              const blindTokens = e.blindSpots.split(/[\s\-\u3000、，,、;；.。]+/).map(t => t.toLowerCase()).filter(Boolean)
              const hit = queryTokens.some(qt => blindTokens.some(bt => bt.includes(qt) || qt.includes(bt)))
              if (hit) {
                summaryLine += `\n- ⚠️ 摘要未覆盖：${e.blindSpots.replace(/^\s*\/\/\s*未覆盖[:：]\s*/, '')}。建议读原文 ${absSource}`
              }
            }
            lines.push(`### ${e.title} (score: ${rel})\n- source: ${absSource}\n${summaryLine}`)
            if (e.type === 'doc' && Array.isArray(e.linkedSymbols) && e.linkedSymbols.length) {
              const refs = e.linkedSymbols.slice(0, 5).map((id) => {
                const s = symbolById.get(id)
                return s ? `${s.title} @ ${toAbs(root, s.sourcePath)}:${s.sourceLine}` : id
              })
              lines.push(`- references: ${refs.join('; ')}`)
            }
          }
        }
      }
      if (type === 'all' || type === 'experience') {
        const scoredExp = rankExperienceScored(store.experience, queries, limit)
        if (scoredExp.length) {
          const expTop = scoredExp[0].score || 1
          lines.push(`## Experience (past problems -> solutions)`)
          for (const { item: e, score } of scoredExp) {
            const source = e.sourceFile ? ` (source: ${toAbs(root, e.sourceFile)})` : ''
            lines.push(
              `### Problem: ${e.problem} (score: ${Math.round((score / expTop) * 100)}, id: ${e.id})\n- solution: ${e.solution}${source}\n- updated: ${e.updatedAt}`,
            )
          }
        }
      }

      // TaskBridge: type:'task' 专门查任务记录；type:'all' 尾部附一行任务计数提示
      const tasks = store.tasks || []
      if (type === 'task') {
        const q = (queries[0] || '').toLowerCase()
        const matched = tasks
          .filter((t) => !t.archived && (t.title.toLowerCase().includes(q) || (t.steps || []).some((s) => s.text?.toLowerCase().includes(q)) || (t.files || []).some((f) => f.toLowerCase().includes(q))))
          .slice(0, limit)
        if (!matched.length) {
          return `任务记录: 0 套匹配 "${args.query}"（list_tasks 查看全部，select_task 续做）`
        }
        for (const t of matched) {
          const done = (t.steps || []).filter((s) => s.status === 'completed').length
          const total = (t.steps || []).length
          const stepsText = (t.steps || []).length
            ? (t.steps || []).map((s) => `- [${s.status === 'completed' ? 'x' : s.status === 'in_progress' ? '*' : ' '}] ${s.text}`).join('\n')
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
            : type === 'all'
              ? 'Index it first with index_repo / index_doc, or note a fix with remember.'
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