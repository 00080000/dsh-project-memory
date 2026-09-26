import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { statSync } from 'node:fs'
import { assertIndexRoot, assertSafeRoot, memoryDirName, memoryRootFor, relativePath, scanLimits, storeKey, walkDir } from '../util/fs.js'
import { DROP, OVERSIZE, UNCHANGED, commitFileUpdates, fileKind, planFileIndex, toFileUpdate } from '../index-pipeline.js'
import { ProjectMemoryStore } from '../store.js'
import { onFileIndexed, isTypeScriptFile } from '../enhancer.js'

/**
 * 每批提交的文件数。旧实现把整棵树的 updates 攒到最后一次性 commit：一次全量扫描的
 * 峰值内存 ≈ 整棵树的所有条目（家目录级别直接 OOM）。分批后峰值与树的大小解耦。
 */
const COMMIT_BATCH = 200

export async function indexRepository(ctx, config, root, { reindex = false, allowUnsafe = false } = {}) {
  // 先校验根目录：缺了它，下面 `new ProjectMemoryStore(...).load()` 的 save() 会把
  // 不存在的 root 连同 .dsh-project-memory 一起 mkdirSync 出来。
  assertIndexRoot(root)
  // 再校验安全：家目录 / 系统目录 / Homebrew 前缀整体索引会吃满内存（issue #5）。
  assertSafeRoot(root, { allowUnsafe })
  const memoryDir = memoryRootFor(root, config.memoryDir)
  const store = new ProjectMemoryStore(memoryDir).load()

  const seen = new Set()
  const failures = []
  // 增强只能在文件的基础条目**落盘之后**排队：TS 增强是「合并进已有条目」，
  // 若先于提交跑，随后 setEntries 会把增强结果整段覆盖掉。
  const tsFiles = []
  let batch = []
  let indexed = 0
  let updated = 0
  let skipped = 0

  const flushBatch = () => {
    if (!batch.length) return
    // 中间批次不做 unseen 清理（最后一批统一做）——否则每批都要遍历整个 store。
    commitFileUpdates(store, { updates: batch })
    batch = []
  }

  const { files, truncated, skipped: nestedRoots } = walkDir(root, {
    ...scanLimits(config),
    nestedStoreName: memoryDirName(config),
  })
  for (const filePath of files) {
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
        batch.push({ rel, drop: true })
        skipped++
        if (batch.length >= COMMIT_BATCH) flushBatch()
        continue
      }
      batch.push(toFileUpdate(rel, plan, record))
      if (plan.key === DROP) skipped++
      else if (plan.type === 'code') {
        updated++
        if (isTypeScriptFile(filePath)) tsFiles.push([rel, filePath])
      } else {
        indexed++
      }
      if (batch.length >= COMMIT_BATCH) flushBatch()
    } catch {
      failures.push(rel)
    }
  }

  // 收尾：写完最后一批 + 清理本轮未见到的旧条目。
  // 截断时**不做 unseen 清理**：没扫到的文件不等于被删了。
  const { removed } = commitFileUpdates(store, {
    updates: batch,
    unseen: truncated ? null : seen,
  })
  const stats = store.stats()
  let report =
    `Indexed project: ${root}\n` +
    `docs indexed: ${indexed}, code symbols updated: ${updated}, unchanged skipped: ${skipped}, removed: ${removed}\n` +
    `memory store: ${stats.files} files, ${stats.entries} entries, ${stats.experience} experience notes`
  if (truncated) {
    const { maxFiles, maxDepth } = scanLimits(config)
    report +=
      `\nscan truncated at the safety limit (maxFiles=${maxFiles}, maxDepth=${maxDepth}): only part of the tree was indexed.` +
      ' Raise maxScanFiles/maxScanDepth if this project is legitimately that large.'
  }
  if (nestedRoots.length) {
    const rels = nestedRoots.map((p) => storeKey(relativePath(root, p)))
    report +=
      `\nskipped ${nestedRoots.length} nested project root(s) with their own store: ${rels.join(', ')}` +
      "\n(their content lives in their own root's index; this root keeps no duplicate copy)"
    if (removed) report += `, ${removed} stale duplicate entr${removed === 1 ? 'y' : 'ies'} removed`
  }
  if (failures.length) {
    report += `\nfailed to index ${failures.length} file(s): ${failures.join(', ')}`
  }

  // Trigger TS enhancement for code files (TS/JS only), now that the base entries are on disk.
  for (const [rel, filePath] of tsFiles) {
    onFileIndexed(store, rel, filePath, config, root)
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
      assertSafeRoot(root, { requested: args.root, allowUnsafe: config?.allowUnsafeRoots === true })
      return indexRepository(ctx, config, root, { reindex: Boolean(args.reindex) })
    },
  })
}