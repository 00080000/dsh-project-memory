import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertIndexRoot, memoryRootFor, resolveSafeIndexRoot } from '../util/fs.js'
import { ProjectMemoryStore } from '../store.js'
import { cfgInsight, saveInsight, GlobalStore, defaultGlobalFile } from '../insight-store.js'
import { ensureGlobalInit } from '../global-seed.js'
import { vectorItemsFrom } from '../vector-index.js'
import { createWriteCosine } from '../auto-inject.js'

export function rememberTool(config) {
  return defineTool({
    name: 'remember',
    description:
      'Save an experience note (problem -> solution) into project memory, e.g. a bug you just fixed. ' +
      'It lands as a `kind:experience` entry in the same store as lessons / decisions / procedures, so query_memory ' +
      'finds it and the same dedup applies (near-identical writes merge, similar ones report the nearest id). ' +
      'Prefer save_lesson for anything that is not a problem->solution note.',
    parameters: {
      problem: {
        type: 'string',
        required: true,
        description: 'The problem/situation, e.g. "pdfjs OPS import fails on Node 24".',
      },
      solution: {
        type: 'string',
        required: true,
        description: 'The concrete fix or decision, e.g. "import OPS from pdfjs-dist/legacy/build/pdf.mjs".',
      },
      root: {
        type: 'string',
        description: '项目根目录，默认当前工作目录。',
      },
      source_file: {
        type: 'string',
        description: 'Optional file the problem is about, for traceability.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const root = resolveSafeIndexRoot(exec, args.root, config)
      // 写盘前校验根：否则一个拼错的 root 会被 mkdir 成字面量目录（连同 .dsh-project-memory）。
      assertIndexRoot(root, args.root || root)
      const memoryDir = memoryRootFor(root, config.memoryDir)
      const store = new ProjectMemoryStore(memoryDir).load()
      const cfg = cfgInsight(config)
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
        files: args.source_file ? [args.source_file] : undefined,
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
      return `${verb} experience note (${result.id}).${result.hint ? ` ${result.hint}` : ''}`
    },
  })
}
