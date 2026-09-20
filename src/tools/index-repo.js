import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { statSync } from 'node:fs'
import { assertIndexRoot, memoryRootFor, relativePath, storeKey, walkDir } from '../util/fs.js'
import { DROP, OVERSIZE, UNCHANGED, commitFileUpdates, fileKind, planFileIndex, toFileUpdate } from '../index-pipeline.js'
import { ProjectMemoryStore } from '../store.js'
import { onFileIndexed, isTypeScriptFile } from '../enhancer.js'

export async function indexRepository(ctx, config, root, { reindex = false } = {}) {
  // 先校验根目录：缺了它，下面 `new ProjectMemoryStore(...).load()` 的 save() 会把
  // 不存在的 root 连同 .dsh-project-memory 一起 mkdirSync 出来。
  assertIndexRoot(root)
  const memoryDir = memoryRootFor(root, config.memoryDir)
  const store = new ProjectMemoryStore(memoryDir).load()

  const seen = new Set()
  const updates = []
  const failures = []
  let indexed = 0
  let updated = 0
  let skipped = 0

  for (const filePath of walkDir(root)) {
    const rel = storeKey(relativePath(root, filePath))
    seen.add(rel)
    const kind = fileKind(path.extname(filePath).toLowerCase())
    if (!kind) continue

    try {
      const size = statSync(filePath).size
      const record = store.fileRecord(rel)
      const plan = await planFileIndex({ rel, filePath, kind, config, record, existingEntries: store.entries[rel], size, force: reindex })
      if (plan.key === UNCHANGED) {
        skipped++
        continue
      }
      if (plan.key === OVERSIZE) {
        // 体积超限的代码文件：旧记录一律清掉，避免检索命中一个已经不索引的文件。
        updates.push({ rel, drop: true })
        skipped++
        continue
      }
      updates.push(toFileUpdate(rel, plan, record))
      if (plan.key === DROP) skipped++
      else if (plan.type === 'code') updated++
      else indexed++
    } catch {
      failures.push(rel)
    }
  }

  // 单事务提交：写入 + 清理本轮未见到的旧条目 + 重建链接。
  const { removed } = commitFileUpdates(store, { updates, unseen: seen })
  const stats = store.stats()
  let report =
    `Indexed project: ${root}\n` +
    `docs indexed: ${indexed}, code symbols updated: ${updated}, unchanged skipped: ${skipped}, removed: ${removed}\n` +
    `memory store: ${stats.files} files, ${stats.entries} entries, ${stats.experience} experience notes`
  if (failures.length) {
    report += `\nfailed to index ${failures.length} file(s): ${failures.join(', ')}`
  }

  // Trigger TS enhancement for code files (TS/JS only)
  for (const update of updates) {
    if (update.type !== 'code') continue
    const filePath = path.join(root, update.rel)
    if (isTypeScriptFile(filePath)) {
      onFileIndexed(store, update.rel, filePath, config, root)
    }
  }

  return report
}

export function indexRepoTool(ctx, config) {
  return defineTool({
    name: 'index_repo',
    description:
      'Index a whole project into persistent memory. Documents (PDF/Markdown/txt) get a short cited summary plus ' +
      'a full-chunk literal term index (no LLM at index time); ' +
      'code files get a zero-token symbol table (function/class names with line numbers). Incremental: only changed ' +
      'files are re-extracted (content-hash), deleted files are removed from memory. Call once per project, then query_memory.',
    parameters: {
      root: {
        type: 'string',
        required: true,
        description: 'Absolute path to the project root to index.',
      },
      reindex: {
        type: 'boolean',
        description: 'Force full re-index, ignoring content-hash skips. Default false.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const root = path.resolve(args.root)
      // 透传原始入参：Windows 风格路径在 POSIX 上会被 resolve 成 <cwd>/D:\...，
      // 报错时要点明这是路径风格问题，而不是“目录被删了”。
      assertIndexRoot(root, args.root)
      return indexRepository(ctx, config, root, { reindex: Boolean(args.reindex) })
    },
  })
}