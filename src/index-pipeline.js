// 索引一个文件的**唯一**实现。
//
// 这段逻辑以前在 index_repo（批量）、watch（轮询）、lazy（fs/observed 懒索引）里各抄一份，
// 三份随后各自打补丁、已经漂移：index_repo 多一道冗余的 dump 预检、体积超限时删旧记录，
// 而 watch/lazy 保留旧记录；terms 回填与单次读盘的写法也各不相同。
// 现在「这个文件该不该读、读出来该写什么条目」只在这里定义一次；
// 调用方只保留自己的编排（批量计数、watch 的 mtime 快照、lazy 的根解析与副作用）。
import { statSync } from 'node:fs'
import { isSupportedCode, isSupportedDoc, readFileForIndex } from './util/fs.js'
import { buildDocEntries } from './doc-pipeline.js'
import { docEntriesNeedBackfill } from './doc-index.js'
import { scanSymbols } from './symbols.js'

/** 不索引的后缀。 */
export const UNSUPPORTED = 'unsupported'
/** 代码文件超过 maxFileSizeMb：读盘成本不抵符号表收益。 */
export const OVERSIZE = 'oversize'
/** 内容哈希未变，且无需回填词项。 */
export const UNCHANGED = 'unchanged'
/** 文档不可索引（dump / 抽取返回 null）→ 从 store 移除。 */
export const DROP = 'drop'
/** 有内容要写入 store。 */
export const WRITE = 'write'

/** 后缀 → 'code' | 'doc' | null。 */
export function fileKind(ext) {
  if (isSupportedCode(ext)) return 'code'
  if (isSupportedDoc(ext)) return 'doc'
  return null
}

function exceedsSizeCap(kind, size, config) {
  return kind === 'code' && !!config.maxFileSizeMb && size > config.maxFileSizeMb * 1024 * 1024
}

/**
 * 读取 + 判重 + 抽条目。抛出的异常（读盘失败、PDF 解析失败……）由调用方按各自策略处理：
 * index_repo 收进 failures 汇总，watch 去重打印并可重试，lazy 记一行日志。
 *
 * @returns {{key: string, hash?: string, size?: number, type?: string, entries?: object[]}}
 *   key 为 UNSUPPORTED / OVERSIZE / UNCHANGED / DROP / WRITE 之一。
 * @param {object} args
 * @param {number} [args.size] 调用方已 statSync 时传入，避免重复 stat。
 * @param {boolean} [args.force] index_repo 的 reindex：忽略哈希跳过。
 */
export async function planFileIndex({ rel, filePath, kind, config, record, existingEntries = [], size, force = false }) {
  if (!kind) return { key: UNSUPPORTED }
  const fileSize = typeof size === 'number' ? size : statSync(filePath).size
  if (exceedsSizeCap(kind, fileSize, config)) return { key: OVERSIZE }

  // 单次读盘：同一 buffer 供内容哈希与正文解码使用（未变更的文件不解码）。
  const { hash, buffer } = readFileForIndex(filePath)
  // 旧 store 的 doc 条目缺 terms → 即使哈希未变也重抽一次（一次性回填）。
  const backfill = kind === 'doc' && docEntriesNeedBackfill(existingEntries)
  if (!force && record && record.sha256 === hash && !backfill) return { key: UNCHANGED }

  if (kind === 'code') {
    return { key: WRITE, hash, size: fileSize, type: 'code', entries: scanSymbols(rel, filePath, buffer.toString('utf8')) }
  }
  // dump 判定在 buildDocEntries 内部（唯一真源）：不可索引的文档返回 null。
  const entries = await buildDocEntries(rel, filePath, {
    chunkChars: config.chunkChars,
    maxChunks: config.maxChunksPerFile,
    maxFileSizeMb: config.maxFileSizeMb,
    maxPdfPages: config.maxPdfPages,
  })
  return entries === null ? { key: DROP } : { key: WRITE, hash, size: fileSize, type: 'doc', entries }
}

/**
 * plan → 落盘用的更新记录。只接受 DROP / WRITE：UNCHANGED / OVERSIZE 由调用方自己跳过，
 * 误传会直接抛错——静默写进一条 entries=undefined 的记录才是真正的坑。
 * `expectedHash` 是 CAS 基准：扫描之后文件又被改动时，commit 会拒绝这次写入，
 * 调用方据此回滚自己的快照（见 commitFileUpdates 的返回值）。
 */
export function toFileUpdate(rel, plan, record) {
  if (plan.key === DROP) return { rel, drop: true }
  if (plan.key !== WRITE) throw new Error(`toFileUpdate: unexpected plan key ${plan.key}`)
  return {
    rel,
    expectedHash: record?.sha256 ?? null,
    hash: plan.hash,
    size: plan.size,
    type: plan.type,
    entries: plan.entries,
  }
}

/**
 * 一批更新一次性落盘：写入 / 移除 → 清掉本轮未见到的旧条目。
 * 单事务的好处是 store 只 save 一次，watch 每轮不会反复重写。
 *
 * 不再重建 doc↔symbol 链接：链接是读取期解算的派生关系（见 src/link.js），
 * 所以这里也没有了那个「中间批次跳过链接、最后一批统一做」的 `link` 参数。
 *
 * @returns {{stale: string[], removed: number}} stale 是 CAS 失败（并发改动）的 rel，
 *   调用方应让它们保持「未落快照」状态，下一轮重试。
 */
export function commitFileUpdates(store, { updates, unseen = null }) {
  const stale = []
  let removed = 0
  store.commit((s) => {
    for (const update of updates) {
      if (update.drop) {
        s.removeFile(update.rel)
        continue
      }
      if (!s.applyFileUpdate(update.rel, update)) stale.push(update.rel)
    }
    if (unseen) {
      for (const rel of Object.keys(s.files)) {
        if (!unseen.has(rel)) {
          s.removeFile(rel)
          removed++
        }
      }
    }
  })
  return { stale, removed }
}
