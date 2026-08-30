import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { isSupportedCode, isSupportedDoc, looksLikeDump, memoryRootFor, relativePath, sha256OfFile, storeKey, walkDir } from '../util/fs.js'
import { buildDocEntries } from '../doc-pipeline.js'
import { scanSymbols } from '../symbols.js'
import { linkEntries } from '../link.js'
import { ProjectMemoryStore } from '../store.js'
import { onFileIndexed } from '../enhancer.js'

export async function indexRepository(ctx, config, root, { reindex = false } = {}) {
  const memoryDir = memoryRootFor(root, config.memoryDir)
  const store = new ProjectMemoryStore(memoryDir).load()

  const files = walkDir(root)
  const seen = new Set()
  let indexed = 0
  let updated = 0
  let skipped = 0
  let removed = 0
  const failures = []

  // First pass: collect all file info and compute hashes/entries (async work outside commit)
  const fileUpdates = []

  for (const filePath of files) {
    const rel = storeKey(relativePath(root, filePath))
    seen.add(rel)
    const ext = path.extname(filePath).toLowerCase()
    if (!isSupportedDoc(ext) && !isSupportedCode(ext)) continue

    try {
      const size = statSync(filePath).size
        const existing = store.fileRecord(rel)
      if (isSupportedCode(ext) && config.maxFileSizeMb && size > config.maxFileSizeMb * 1024 * 1024) {
        fileUpdates.push({ rel, deleted: true })
        skipped++
        continue
      }

      // existing declared above before hash
      const { hash } = await sha256OfFile(filePath)
      if (!reindex && existing && existing.sha256 === hash) {
        skipped++
        continue
      }

      let entries
      if (isSupportedCode(ext)) {
        const content = readFileSync(filePath, 'utf8')
        entries = scanSymbols(rel, filePath, content)
        fileUpdates.push({ rel, expectedHash: existing?.sha256, hash, size, entries, type: 'code' })
        updated++
      } else {
        const content = readFileSync(filePath, 'utf8')
        if (looksLikeDump(content)) {
          fileUpdates.push({ rel, deleted: true })
          skipped++
          continue
        }
        entries = await buildDocEntries(ctx.llm, rel, filePath, {
          chunkChars: config.chunkChars,
          maxChunks: config.maxChunksPerFile,
          maxFileSizeMb: config.maxFileSizeMb,
          maxPdfPages: config.maxPdfPages,
        })
        if (entries === null) {
          fileUpdates.push({ rel, deleted: true })
          skipped++
          continue
        }
        fileUpdates.push({ rel, expectedHash: existing?.sha256, hash, size, entries, type: 'doc' })
        indexed++
      }
    } catch (err) {
      failures.push(rel)
    }
  }

  // Second pass: single commit with all updates
  const report = store.commit((s) => {
    for (const update of fileUpdates) {
      const result = s.applyFileUpdate(update.rel, update)
      if (result.skipped) {
        // CAS failed - file was modified concurrently, skip
        continue
      }
    }

    // Remove files not seen
    for (const rel of Object.keys(s.files)) {
      if (!seen.has(rel)) {
        s.removeFile(rel)
        removed++
      }
    }

    linkEntries(s)
    const stats = s.stats()
    let report =
      `Indexed project: ${root}\n` +
      `docs indexed: ${indexed}, code symbols updated: ${updated}, unchanged skipped: ${skipped}, removed: ${removed}\n` +
      `memory store: ${stats.files} files, ${stats.entries} entries, ${stats.experience} experience notes`
    if (failures.length) {
      report += `\nfailed to index ${failures.length} file(s): ${failures.join(', ')}`
    }
    return report
  })

  // Trigger TS enhancement for code files
  for (const update of fileUpdates) {
    if (update.type === 'code') {
      const filePath = path.join(root, update.rel)
      onFileIndexed(store, update.rel, filePath, config)
    }
  }

  return report
}

export function indexRepoTool(ctx, config) {
  return defineTool({
    name: 'index_repo',
    description:
      'Index a whole project into persistent memory. Documents (PDF/Markdown/txt) are summarized by the LLM; ' +
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
      return indexRepository(ctx, config, root, { reindex: Boolean(args.reindex) })
    },
  })
}