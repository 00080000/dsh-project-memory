import { defineTool } from '@deepseek-ai/dsh-tools'
import { memoryRootFor, resolveIndexRoot } from '../util/fs.js'
import { ProjectMemoryStore } from '../store.js'
import { expandQuery } from '../llm.js'
import { rankEntriesMergedScored, rankExperienceScored, isCjkText } from '../util/search.js'
import { truncate } from '../util/text.js'

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
        enum: ['all', 'doc', 'symbol', 'experience'],
        description: 'Which memory layer to search. Default "all".',
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

      const queries = config.llmQueryExpansion || isCjkText(args.query)
        ? await expandQuery(ctx.llm, args.query, config.expansionCount)
        : [args.query]
      const symbolById = new Map()
      for (const e of store.allEntries()) {
        if (e.type === 'symbol') symbolById.set(e.id, e)
      }

      const lines = []
      if (type === 'all' || type === 'doc' || type === 'symbol') {
        const pool = type === 'all' ? store.allEntries() : store.allEntries().filter((e) => e.type === type)
        const scored = rankEntriesMergedScored(pool, queries, limit)
        if (scored.length) {
          const top = scored[0].score || 1
          lines.push(`## Memory (${type === 'all' ? 'docs + symbols' : type})`)
          for (const { entry: e, score } of scored) {
            const source = e.sourceLine ? `${e.sourcePath}:${e.sourceLine}` : e.sourcePath
            const rel = Math.round((score / top) * 100)
            lines.push(`### ${e.title} (score: ${rel})\n- source: ${source}\n- ${e.summary}`)
            if (e.type === 'doc' && Array.isArray(e.linkedSymbols) && e.linkedSymbols.length) {
              const refs = e.linkedSymbols.slice(0, 5).map((id) => {
                const s = symbolById.get(id)
                return s ? `${s.title} @ ${s.sourcePath}:${s.sourceLine}` : id
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
            const source = e.sourceFile ? ` (source: ${e.sourceFile})` : ''
            lines.push(
              `### Problem: ${e.problem} (score: ${Math.round((score / expTop) * 100)}, id: ${e.id})\n- solution: ${e.solution}${source}\n- updated: ${e.updatedAt}`,
            )
          }
        }
      }

      if (!lines.length) {
        return `No memory matches for "${args.query}" in ${root}. Index it first with index_repo / index_doc, or note a fix with remember.`
      }
      return truncate(lines.join('\n\n'), config.maxOutputChars)
    },
  })
}