import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { assertIndexRoot, assertReadableFile, assertSafeRoot, findProjectRoot, memoryRootFor, sessionMemoryRootOrNull, sha256OfFile, storeKey } from '../util/fs.js'
import { buildDocEntries } from '../doc-pipeline.js'
import { docEntriesNeedBackfill } from '../doc-index.js'
import { ProjectMemoryStore } from '../store.js'

export function indexDocTool(ctx, config) {
  return defineTool({
    name: 'index_doc',
    description:
      'Index a project document (PDF, Markdown, txt) into persistent project memory: split into sections, ' +
      'store a short cited summary plus a full-chunk literal term index (no LLM at index time), for later ' +
      'query_memory recall. Re-indexing the same unchanged file is a no-op (content-hash skip).',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'Absolute path to the document to index.',
      },
      root: {
        type: 'string',
        description: 'Project root where the .dsh-project-memory store lives. Defaults to the session\'s project root.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const filePath = assertReadableFile(args.file_path, config.maxFileSizeMb)
      const explicit = args.root && args.root.trim() ? args.root : null
      let root
      if (explicit) {
        root = path.resolve(explicit)
        assertIndexRoot(root, explicit)
        assertSafeRoot(root, { requested: explicit, allowUnsafe: config?.allowUnsafeRoots === true })
      } else {
        // 与懒索引同序：文件自身的项目标记优先，其次才是会话记忆根（安全但无标记的 cwd）。
        const sessionRoot = sessionMemoryRootOrNull(exec, config)
        root = findProjectRoot(filePath, { sessionRoot })
        if (!root) {
          return (
            `Not indexed: ${filePath} is not inside a detected project ` +
            '(no .git / package.json / pyproject.toml … marker above it). Pass root explicitly to place the memory store.'
          )
        }
      }
      const memoryDir = memoryRootFor(root, config.memoryDir)

      const store = new ProjectMemoryStore(memoryDir).load()

      const rel = storeKey(path.relative(root, filePath).split(path.sep).join('/'))
      const { hash, size } = await sha256OfFile(filePath)
      const existing = store.fileRecord(rel)
      // 与 index_repo/watch/lazy 同一条判据：哈希未变但旧条目缺 terms 时仍要重抽一次（一次性回填）。
      // 少了这一步，terms 回填就是"路径相关"的——只有走 index_repo 才生效。
      if (existing && existing.sha256 === hash && !docEntriesNeedBackfill(store.entries[rel])) {
        return `Skipped (unchanged): ${rel}\nAlready indexed with ${(store.entries[rel] || []).length} entry/entries.`
      }

      const entries = await buildDocEntries(rel, filePath, {
        chunkChars: config.chunkChars,
        maxChunks: config.maxChunksPerFile,
        maxFileSizeMb: config.maxFileSizeMb,
        maxPdfPages: config.maxPdfPages,
      })
      if (entries === null) {
        return store.commit((s) => {
          s.removeFile(rel)
          return `Skipped: ${rel} looks like a reflection dump, not a document.`
        })
      }

      return store.commit((s) => {
        s.setEntries(rel, entries)
        s.markFile(rel, { sha256: hash, size, type: 'doc', indexedAt: new Date().toISOString() })
        const preview = entries
          .map((e) => `  - ${e.title} @ ${rel}:${e.sourceLine}`)
          .join('\n')
        return `Indexed: ${rel}\nEntries: ${entries.length}\n${preview}`
      })
    },
  })
}