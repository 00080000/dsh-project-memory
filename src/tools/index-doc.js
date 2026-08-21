import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { assertReadableFile, memoryRootFor, sha256OfFile, storeKey } from '../util/fs.js'
import { buildDocEntries } from '../doc-pipeline.js'
import { linkEntries } from '../link.js'
import { ProjectMemoryStore, withStoreLock } from '../store.js'
import { findProjectRoot } from '../lazy.js'

export function indexDocTool(ctx, config) {
  return defineTool({
    name: 'index_doc',
    description:
      'Index a project document (PDF, Markdown, txt) into persistent project memory: split into sections, ' +
      'summarize each with the LLM, and store cited summaries (path + line) for later query_memory recall. ' +
      'Re-indexing the same unchanged file is a no-op (content-hash skip).',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'Absolute path to the document to index.',
      },
      root: {
        type: 'string',
        description: 'Project root where the .dsh-project-memory store lives. Defaults to the file\'s directory.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const filePath = assertReadableFile(args.file_path, config.maxFileSizeMb)
      const root = path.resolve(args.root && args.root.trim() ? args.root : findProjectRoot(filePath))
      const memoryDir = memoryRootFor(root, config.memoryDir)

      return withStoreLock(memoryDir, async () => {
        const store = new ProjectMemoryStore(memoryDir).load()

        const rel = storeKey(path.relative(root, filePath).split(path.sep).join('/'))
        const { hash, size } = await sha256OfFile(filePath)
        const existing = store.fileRecord(rel)
        if (existing && existing.sha256 === hash) {
          return `Skipped (unchanged): ${rel}\nAlready indexed with ${(store.entries[rel] || []).length} entry/entries.`
        }

        const entries = await buildDocEntries(ctx.llm, filePath, {
          chunkChars: config.chunkChars,
          maxChunks: config.maxChunksPerFile,
          maxFileSizeMb: config.maxFileSizeMb,
          maxPdfPages: config.maxPdfPages,
        })
        if (entries === null) {
          store.removeFile(rel)
          store.save()
          return `Skipped: ${rel} looks like a reflection dump, not a document.`
        }
        store.setEntries(rel, entries)
        store.markFile(rel, { sha256: hash, size, type: 'doc', indexedAt: new Date().toISOString() })
        store.save()
        const links = linkEntries(store)
        if (links) store.save()

        const preview = entries
          .map((e) => `  - ${e.title} @ ${rel}:${e.sourceLine}`)
          .join('\n')
        return `Indexed: ${rel}\nEntries: ${entries.length}\n${preview}`
      })
    },
  })
}