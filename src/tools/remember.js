import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { memoryRootFor } from '../util/fs.js'
import { ProjectMemoryStore } from '../store.js'

export function rememberTool(config) {
  return defineTool({
    name: 'remember',
    description:
      'Save an experience note (problem -> solution) into project memory, e.g. a bug you just fixed or a decision made. ' +
      'Retrieved later only when search_experience / query_memory matches the problem, never auto-injected. ' +
      'If a note with a similar problem exists, it is superseded instead of duplicated.',
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
        description: 'Project root of the memory store. Defaults to the current working directory.',
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
    async execute(args) {
      const root = path.resolve(args.root && args.root.trim() ? args.root : process.cwd())
      const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
      const result = store.addExperience({
        problem: args.problem,
        solution: args.solution,
        sourceFile: args.source_file,
      })
      store.save()
      return result.superseded
        ? `Updated existing experience note (${result.id}).`
        : `Saved experience note (${result.id}).`
    },
  })
}