import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertIndexRoot, memoryRootFor, resolveSafeIndexRoot } from '../util/fs.js'
import { ProjectMemoryStore } from '../store.js'
import { cfgInsight, GlobalStore, defaultGlobalFile, removeMemory } from '../insight-store.js'

/** 回报用的一行：`ins_xxx《标题》(project)`。标题已在 removeMemory 里截断。 */
function line(e) {
  return `${e.id}《${e.title}》(${e.home})`
}

export function forgetTool(config) {
  return defineTool({
    name: 'forget',
    description:
      'Delete memories by id or by matching keywords — lessons / decisions / procedures and legacy experience notes, ' +
      'at task / project / global scope alike (one call, no need to know which layer it lives in). Real deletion, no undo. ' +
      'An exact id deletes that one entry; keywords match on how much of the query the entry covers. ' +
      'A keyword that matches more than the configured cap deletes nothing and lists the candidates instead.',
    parameters: {
      id_or_query: {
        type: 'string',
        required: true,
        description: 'Insight/experience id (from save_lesson, query_memory or a near-match hint), or keywords to match. An exact id always wins over treating it as keywords.',
      },
      root: {
        type: 'string',
        description: '项目根目录，默认当前工作目录。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const root = resolveSafeIndexRoot(exec, args.root, config)
      assertIndexRoot(root, args.root || root)
      const memoryDir = memoryRootFor(root, config.memoryDir)
      const store = new ProjectMemoryStore(memoryDir).load()
      const cfg = cfgInsight(config)
      const globalStore = new GlobalStore(cfg.globalFile || defaultGlobalFile()).load()
      let res
      store.commit((s) => {
        res = removeMemory({ store: s, globalStore, idOrQuery: args.id_or_query, maxMatches: cfg.maxForgetMatches })
        return res
      })
      globalStore.commit() // global 侧若被删过才落盘
      if (res && res.tooMany) {
        const head = res.matches.slice(0, 10).map(line)
        const more = res.matches.length > head.length ? ` …（共 ${res.matches.length} 条）` : ''
        return `Matched ${res.matches.length} memories (cap ${cfg.maxForgetMatches}), removed none — narrow the query or delete by id:\n` + head.map((l) => `- ${l}`).join('\n') + more
      }
      if (!res || !res.ok || !res.removed.length) return 'No matching memory found.'
      return `Removed ${res.removed.length} memory entries:\n` + res.removed.map((e) => `- ${line(e)}`).join('\n')
    },
  })
}
