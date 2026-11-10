import { defineTool } from '@deepseek-ai/dsh-tools'
import { TEXT_OUTPUT, persistenceNote, rootParam } from './output.js'
import { openProjectContext } from './context.js'
import { normalizeCitationFiles } from '../util/fs.js'
import { saveInsight, GlobalStore, defaultGlobalFile } from '../insight-store.js'
import { ensureGlobalInit } from '../global-seed.js'
import { vectorItemsFrom } from '../vector-index.js'
import { createWriteCosine } from '../auto-inject.js'

export function rememberTool(config) {
  return defineTool({
    name: 'remember',
    description:
      'Save a problem→solution note as kind:experience; same dedup as save_lesson. '
      + 'Prefer save_lesson for anything else.',
    parameters: {
      problem: {
        type: 'string',
        required: true,
        description: 'problem / symptom',
      },
      solution: {
        type: 'string',
        required: true,
        description: 'concrete fix',
      },
      root: rootParam(),
      source_file: {
        type: 'string',
        description: 'related file (project-relative)',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const { root, memoryDir, store, cfg } = openProjectContext(exec, args, config)
      // 与 save_lesson 同一条约束：files 只收项目内相对路径，项目外/逃出根的丢弃并回报。
      const citation = normalizeCitationFiles(args.source_file ? [args.source_file] : [], root)
      ensureGlobalInit(config) // 幂等：project 写入可能被自动提升到 global
      const globalStore = new GlobalStore(cfg.globalFile || defaultGlobalFile()).load()
      // 与 save_lesson 同一条写入路径 ⇒ 同一套去重/自动覆盖/近邻提示；没装 leanvec 时 `cosine` 为 null，
      // 退回纯词法（与旧版经验层行为一致）。
      const cosine = await createWriteCosine(config, { storeDir: memoryDir, items: vectorItemsFrom(store, globalStore) })
      const raw = {
        title: args.problem,
        kind: 'experience',
        problem: args.problem,
        solution: args.solution,
        files: citation.files.length ? citation.files : undefined,
        confidence: 1,
      }
      let result
      store.commit((s) => {
        result = saveInsight({ store: s, globalStore, raw, scope: 'project', cfg, source: 'agent', cosine })
        return result
      })
      globalStore.commit()
      if (!result || !result.ok) return `Failed: ${result?.error || '写入未完成'}`
      const verb = result.action === 'created' ? 'Saved' : 'Updated existing'
      const dropped = citation.dropped.length
        ? `\n（${citation.dropped.length} 个 source_file 不是项目内路径，已丢弃）`
        : ''
      return `${verb} experience note (${result.id}).${result.hint ? ` ${result.hint}` : ''}${dropped}${persistenceNote(store, globalStore)}`
    },
  })
}
