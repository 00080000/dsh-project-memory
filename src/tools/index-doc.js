import { defineTool } from '@deepseek-ai/dsh-tools'
import { TEXT_OUTPUT, persistenceNote, rootParam } from './output.js'
import path from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { assertIndexRoot, assertReadableFile, assertSafeRoot, excludedEntryForPath, findProjectRoot, memoryRootFor, resolveIndexRoot, sessionMemoryRootOrNull, sha256OfFile, storeKey } from '../util/fs.js'
import { buildDocEntries } from '../doc-pipeline.js'
import { docEntriesNeedBackfill } from '../doc-index.js'
import { fileKind } from '../index-pipeline.js'
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
        description: 'absolute path of the document',
      },
      root: rootParam({ description: 'project root (default: session project root)' }),
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      // 相对路径按会话当前工作目录解析；直接用会落到宿主进程 cwd（web profile 里可能是 /）。
      const rawPath = typeof args.file_path === 'string' ? args.file_path : ''
      // 先只做“存在且可读”检查（不限大小）：超大/被 exclude 的文件也要能解析出 root，
      // 才能把旧索引摘掉。
      const filePath = assertReadableFile(
        path.isAbsolute(rawPath) ? rawPath : path.resolve(resolveIndexRoot(exec), rawPath),
        0,
      )
      // roots.exclude 是"这棵子树里的文件一律不进索引"：显式 index_doc 也要服从。
      const excluded = excludedEntryForPath(filePath, config)
      const explicit = args.root && args.root.trim() ? args.root : null
      let root
      if (explicit) {
        // 相对 root 按会话当前工作目录解析（不是宿主进程 cwd）。
        root = resolveIndexRoot(exec, explicit)
        assertIndexRoot(root, explicit)
        assertSafeRoot(root, { requested: explicit, config })
      } else {
        // 与懒索引同序：文件自身的项目标记优先，其次才是会话记忆根（安全但无标记的 cwd）。
        const sessionRoot = sessionMemoryRootOrNull(exec, config)
        root = findProjectRoot(filePath, { sessionRoot, config })
        if (!root) {
          // 被 exclude 的文件在无标记目录里先命中排除规则：报排除原因（此时也没有可清理的 store）。
          if (excluded) {
            return (
              `Not indexed: ${filePath} is inside the subtree excluded by \`roots.exclude\` entry ${JSON.stringify(excluded.raw)}. ` +
              'Remove that entry from `config.roots.exclude` under `- id: project-memory` if this file should be indexed.'
            )
          }
          return (
            `Not indexed: ${filePath} is not inside a detected project ` +
            '(no .git / package.json / pyproject.toml … marker above it). Pass root explicitly to place the memory store.'
          )
        }
      }
      const memoryDir = memoryRootFor(root, config.memoryDir)
      // root 可以是显式传入的。文件必须真的在 root 之内：否则 rel 会变成 `../x`，引用路径
      // 逃出项目根，下一次扫描也不可能再见到它（既不会被清理，也没法按项目相对路径引用）。
      const relRaw = path.relative(root, filePath)
      if (!relRaw || relRaw === '..' || relRaw.startsWith(`..${path.sep}`) || path.isAbsolute(relRaw)) {
        return (
          `Not indexed: ${filePath} is outside the index root ${root}. ` +
          'Pass the document\'s own project root (or omit root to detect it from the document path).'
        )
      }

      const rel = storeKey(relRaw.split(path.sep).join('/'))
      // index_doc 只接受文档。此前不校验后缀，代码文件会被 buildDocEntries 当文本抽成
      // 一条 doc chunk，并用 type:'doc' 覆盖掉 index_repo 写下的同 rel 符号条目——
      // 符号层随即查不到东西，直到下一次 index_repo 才自愈。
      const kind = fileKind(path.extname(filePath).toLowerCase())
      if (kind !== 'doc') {
        const why = kind === 'code'
          ? 'this is a source file; use index_repo (or lazy indexing) for code symbols'
          : 'unsupported extension (index_doc accepts PDF/MD/txt)'
        return `Not indexed: ${rel} — ${why}. The existing record was left untouched.`
      }
      const storeExists = existsSync(memoryDir)

      // 被排除 / 超大：旧版本留下的索引必须摘掉，否则 query_memory 会继续命中已删除的内容。
      // 但没有 store 时绝不能为了“清理”先建一个空 store（老契约：拒绝不产生副作用）。
      const dropStale = (reason) => {
        if (!storeExists) return reason
        const staleStore = new ProjectMemoryStore(memoryDir).load()
        return staleStore.commit((s) => {
          s.removeFile(rel)
          return reason
        }) + persistenceNote(staleStore)
      }
      if (excluded) {
        return dropStale(
          `Not indexed: ${filePath} is inside the subtree excluded by \`roots.exclude\` entry ${JSON.stringify(excluded.raw)}. ` +
          `Removed stale index (if any). Remove that entry from \`config.roots.exclude\` under \`- id: project-memory\` if this file should be indexed.`,
        )
      }
      const sizeLimit = config.maxFileSizeMb
      if (sizeLimit) {
        let size = 0
        try { size = statSync(filePath).size } catch { size = 0 }
        if (size > sizeLimit * 1024 * 1024) {
          return dropStale(`Not indexed: ${rel} is now ${(size / 1024 / 1024).toFixed(1)} MB, over the ${sizeLimit} MB limit. Removed stale index (if any).`)
        }
      }

      const store = new ProjectMemoryStore(memoryDir).load()
      // mtime 必须在读正文之前取：记录里的 mtime 不能比内容新，否则懒索引的快路径会跳过之后的真实改动。
      let mtimeMs
      try {
        mtimeMs = statSync(filePath).mtimeMs
      } catch {
        mtimeMs = undefined
      }
      const { hash, size } = await sha256OfFile(filePath)
      const existing = store.fileRecord(rel)
      // 与 index_repo/watch/lazy 同一条判据：哈希未变但旧条目缺 terms 时仍要重抽一次（一次性回填）。
      // 少了这一步，terms 回填就是"路径相关"的——只有走 index_repo 才生效。
      if (existing && existing.sha256 === hash && !docEntriesNeedBackfill(store.entries[rel])) {
        // 旧记录没有 explicit 时在这里补上：否则重新 index_doc 一次也救不回被扫描清理掉的文件。
        if (!existing.explicit) store.commit((s) => s.markFile(rel, { ...existing, explicit: true }))
        return `Skipped (unchanged): ${rel}\nAlready indexed with ${(store.entries[rel] || []).length} entry/entries.` + persistenceNote(store)
      }

      const entries = await buildDocEntries(rel, filePath, {
        chunkChars: config.chunkChars,
        maxChunks: config.maxChunksPerFile,
        maxFileSizeMb: config.maxFileSizeMb,
        maxPdfPages: config.maxPdfPages,
      })
      if (entries === null) {
        const text = store.commit((s) => {
          s.removeFile(rel)
          return `Skipped: ${rel} looks like a reflection dump, not a document.`
        })
        return text + persistenceNote(store)
      }

      return store.commit((s) => {
        s.setEntries(rel, entries)
        // explicit：这个文件可能是被 .gitignore 排除的（显式索引不受 gitignore 限制），
        // 扫描清单里永远不会有它 —— 清理时靠这个标记区分"没扫到"与"被删了"。
        const record = { sha256: hash, size, type: 'doc', indexedAt: new Date().toISOString(), explicit: true }
        if (typeof mtimeMs === 'number' && Number.isFinite(mtimeMs)) record.mtimeMs = mtimeMs
        s.markFile(rel, record)
        const preview = entries
          .map((e) => `  - ${e.title} @ ${rel}:${e.sourceLine}`)
          .join('\n')
        return `Indexed: ${rel}\nEntries: ${entries.length}\n${preview}`
      }) + persistenceNote(store)
    },
  })
}