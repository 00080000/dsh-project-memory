import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { statSync } from 'node:fs'
import { assertIndexRoot, assertReadableFile, assertSafeRoot, excludedEntryForPath, findProjectRoot, memoryRootFor, sessionMemoryRootOrNull, sha256OfFile, storeKey } from '../util/fs.js'
import { buildDocEntries } from '../doc-pipeline.js'
import { docEntriesNeedBackfill } from '../doc-index.js'
import { ProjectMemoryStore } from '../store.js'

export function indexDocTool(ctx, config) {
  return defineTool({
    name: 'index_doc',
    description:
      'Index one document (PDF/MD/txt) into project memory; unchanged files are skipped.',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: '文档绝对路径',
      },
      root: {
        type: 'string',
        description: '项目根（默认会话项目根）',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const filePath = assertReadableFile(args.file_path, config.maxFileSizeMb)
      // roots.exclude 是"这棵子树里的文件一律不进索引"：显式 index_doc 也要服从。
      const excluded = excludedEntryForPath(filePath, config)
      if (excluded) {
        return (
          `Not indexed: ${filePath} is inside the subtree excluded by \`roots.exclude\` entry ${JSON.stringify(excluded.raw)}. ` +
          'Remove that entry from `config.roots.exclude` under `- id: project-memory` if this file should be indexed.'
        )
      }
      const explicit = args.root && args.root.trim() ? args.root : null
      let root
      if (explicit) {
        root = path.resolve(explicit)
        assertIndexRoot(root, explicit)
        assertSafeRoot(root, { requested: explicit, config })
      } else {
        // 与懒索引同序：文件自身的项目标记优先，其次才是会话记忆根（安全但无标记的 cwd）。
        const sessionRoot = sessionMemoryRootOrNull(exec, config)
        root = findProjectRoot(filePath, { sessionRoot, config })
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
        // 旧记录没有 explicit 时在这里补上：否则重新 index_doc 一次也救不回被扫描清理掉的文件。
        if (!existing.explicit) store.commit((s) => s.markFile(rel, { ...existing, explicit: true }))
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
        // explicit：这个文件可能是被 .gitignore 排除的（显式索引不受 gitignore 限制），
        // 扫描清单里永远不会有它 —— 清理时靠这个标记区分"没扫到"与"被删了"。
        // mtimeMs 让后续 `fs/observed` 的重复读能走 mtime+size 快路径，不必重解析 PDF。
        let mtimeMs
        try {
          mtimeMs = statSync(filePath).mtimeMs
        } catch {
          mtimeMs = undefined
        }
        const record = { sha256: hash, size, type: 'doc', indexedAt: new Date().toISOString(), explicit: true }
        if (typeof mtimeMs === 'number' && Number.isFinite(mtimeMs)) record.mtimeMs = mtimeMs
        s.markFile(rel, record)
        const preview = entries
          .map((e) => `  - ${e.title} @ ${rel}:${e.sourceLine}`)
          .join('\n')
        return `Indexed: ${rel}\nEntries: ${entries.length}\n${preview}`
      })
    },
  })
}