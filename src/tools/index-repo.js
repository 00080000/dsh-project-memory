import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { isSupportedCode, isSupportedDoc, looksLikeDump, memoryRootFor, relativePath, sha256OfFile, storeKey, walkDir } from '../util/fs.js'
import { buildDocEntries } from '../doc-pipeline.js'
import { scanSymbols } from '../symbols.js'
import { linkEntries } from '../link.js'
import { ProjectMemoryStore, withStoreLock } from '../store.js'

export async function indexRepository(ctx, config, root, { reindex = false } = {}) {
  return withStoreLock(memoryRootFor(root, config.memoryDir), async () => {
    const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()

    const files = walkDir(root)
    const seen = new Set()
    let indexed = 0
    let updated = 0
    let skipped = 0
    let removed = 0
    const failures = []

    for (const filePath of files) {
      const rel = storeKey(relativePath(root, filePath))
      seen.add(rel)
      const ext = path.extname(filePath).toLowerCase()
      if (!isSupportedDoc(ext) && !isSupportedCode(ext)) continue

      try {
        const size = statSync(filePath).size
        if (isSupportedCode(ext) && config.maxFileSizeMb && size > config.maxFileSizeMb * 1024 * 1024) {
          store.removeFile(rel)
          skipped++
          continue
        }

        const existing = store.fileRecord(rel)
        const { hash } = await sha256OfFile(filePath)
        if (!reindex && existing && existing.sha256 === hash) {
          skipped++
          continue
        }

        let entries
        if (isSupportedCode(ext)) {
          const content = readFileSync(filePath, 'utf8')
          entries = scanSymbols(filePath, content)
          store.markFile(rel, { sha256: hash, size, type: 'code', indexedAt: new Date().toISOString() })
          updated++
        } else {
          const content = readFileSync(filePath, 'utf8')
          if (looksLikeDump(content)) {
            store.removeFile(rel)
            skipped++
            continue
          }
          entries = await buildDocEntries(ctx.llm, filePath, {
            chunkChars: config.chunkChars,
            maxChunks: config.maxChunksPerFile,
            maxFileSizeMb: config.maxFileSizeMb,
            maxPdfPages: config.maxPdfPages,
          })
          if (entries === null) {
            store.removeFile(rel)
            skipped++
            continue
          }
          store.markFile(rel, { sha256: hash, size, type: 'doc', indexedAt: new Date().toISOString() })
          indexed++
        }
        store.setEntries(rel, entries)
      } catch (err) {
        store.removeFile(rel)
        failures.push(rel)
      }
    }

    for (const rel of Object.keys(store.files)) {
      if (!seen.has(rel)) {
        store.removeFile(rel)
        removed++
      }
    }

    store.save()
    const links = linkEntries(store)
    if (links) store.save()
    const stats = store.stats()
    let report =
      `Indexed project: ${root}\n` +
      `docs indexed: ${indexed}, code symbols updated: ${updated}, unchanged skipped: ${skipped}, removed: ${removed}\n` +
      `memory store: ${stats.files} files, ${stats.entries} entries, ${stats.experience} experience notes` +
      (links ? `, ${links} doc<->symbol links` : '')
    if (failures.length) {
      report += `\nfailed to index ${failures.length} file(s): ${failures.join(', ')}`
    }
    return report
  })
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