/**
 * 注入对账的可见性索引：以 session.surface 为真相源，进程缓存只做 fallback。
 * 事件驱动更新；compaction 只标 dirty，下一次 ensure 时全量重建。
 */

import { createHash } from 'node:crypto'
import { isOwnInjection } from './util/message-source.js'

const ITEM_LINE_RE = /^\s*-\s+\[(ins_[^\]\s]+)\].*$/gm
// 一条消息最多带回多少条 provenance：默认 maxItemsPerSession=60，写 40 会漏记尾部，
// 重启/压缩重建后已注入条目会再发一遍。上限只防手写/损坏的异常长数组。
const MAX_PROVENANCE_ITEMS = 1024

function surfaceOf(session) {
  const surface = session && session.surface
  if (!surface || !Array.isArray(surface.nodes) || typeof session.eventAt !== 'function') return null
  return surface
}

export function createVisibleState() {
  return {
    ready: false,
    dirty: true,
    surfaceGen: null,
    genSupported: false,
    nodeCount: 0,
    firstSeq: null,
    // 没有 replaceGeneration 的旧宿主：等长替换/中间替换无法靠长度或首节点发现，
    // 每 N 次 ensure 做一次全量重建兜底（30k 节点约 9ms，摊到 32 步可忽略）。
    fallbackScans: 0,
    degraded: false,
    items: new Map(), // id -> hash | null（null = 已知可见但 hash 未知）
    // 旧消息（无 provenance）按“整行文本 hash”记账：正文/结论改了就不再算可见，
    // 避免以前 `hash=null` 对任何 hash 都可见、编辑后永远不重发。
    legacy: new Map(), // id -> Set(lineHash)
    legacyBlocks: new Set(), // 旧 procedure 的整块文本指纹（正文没有 id）
    blocks: new Set(),
    // 只在真正扫到 surface/事件时登记；用于区分 pending 的乐观块。
    confirmedBlocks: new Set(),
    // 任务卡（entry）的稳定指纹：条目都被跳过时，卡本身不该在下一步/重启后再发一次。
    entries: new Set(),
    // 注入后消息还没被宿主 append 时的乐观登记；下一次 ensureVisible 若 surface 里找不到就撤销。
    pending: [],
    rollback: null,
  }
}

export function isAvailable(session) {
  return surfaceOf(session) !== null
}

/** 旧消息行指纹：同一行文本（去掉首尾空白）才算同一条可见注入。 */
export function lineHash(text) {
  return createHash('sha256').update(String(text).trim()).digest('hex').slice(0, 12)
}

function parseItemLines(text) {
  const out = []
  for (const match of String(text || '').matchAll(ITEM_LINE_RE)) out.push({ id: match[1], hash: lineHash(match[0]) })
  return out
}

function mergeProvenance(state, memory) {
  if (!memory || typeof memory !== 'object') return
  if (typeof memory.b === 'string' && memory.b) {
    state.blocks.add(memory.b)
    state.confirmedBlocks.add(memory.b)
  }
  if (typeof memory.e === 'string' && memory.e) state.entries.add(memory.e)
  if (!Array.isArray(memory.i)) return
  let count = 0
  for (const pair of memory.i) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue
    state.items.set(pair[0], typeof pair[1] === 'string' ? pair[1] : null)
    if (++count >= MAX_PROVENANCE_ITEMS) break
  }
}

function recordMessage(state, message) {
  const memory = message?.source?.memory
  if (memory && memory.v === 1) {
    mergeProvenance(state, memory)
    return
  }
  // 正文回退只对**本插件自己的**旧消息生效。压缩摘要、session-reference 的 recall、用户粘贴的
  // 记忆块、子代理转述都可能包含 `- [ins_x] ...` 行；把它们当已注入会永久压制这些条目
  //（hash=null → 任何 hash 都算可见），编辑后也不再重发。
  if (!isOwnInjection(message?.source)) return
  const text = Array.isArray(message.content)
    ? message.content.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
    : ''
  for (const { id, hash } of parseItemLines(text)) {
    let seen = state.legacy.get(id)
    if (!seen) {
      seen = new Set()
      state.legacy.set(id, seen)
    }
    seen.add(hash)
  }
  // 旧 procedure 正文是 `【标题】\n1. …`，没有 id：整块 hash 是唯一可对账的指纹。
  for (const match of text.matchAll(/【[^】]+】[\s\S]*?(?=\n【|$)/g)) {
    state.legacyBlocks.add(lineHash(match[0]))
  }
}

function scanNodes(session, state, fromIndex = 0) {
  const surface = surfaceOf(session)
  if (!surface) return
  for (const seq of surface.nodes.slice(fromIndex)) {
    const event = session.eventAt(seq)
    if (!event || event.type !== 'user/message') continue
    recordMessage(state, event.data)
  }
  if (surface.nodes.length) state.firstSeq = surface.nodes[0]
  state.nodeCount = surface.nodes.length
}

/**
 * 乐观登记的结算：宿主可能在 waterfall 之后、append 之前中止（abort / prepareRequest 失败），
 * 消息没进 surface。此时不能把这些条目当成“已在上下文里”，否则整个会话都不再补发。
 * 只撤销没有在 surface 扫描结果里出现的 pending；出现了就转正。
 */
function settlePending(state) {
  if (!state.pending.length) return
  const dropped = []
  for (const pending of state.pending) {
    if (state.confirmedBlocks.has(pending.block)) continue
    state.blocks.delete(pending.block)
    for (const [id, hash] of pending.items) {
      if (state.items.get(id) === hash) state.items.delete(id)
    }
    dropped.push(pending)
  }
  state.pending = []
  if (dropped.length) {
    state.rollback = {
      ids: dropped.flatMap((p) => p.ids),
      chars: dropped.reduce((n, p) => n + p.chars, 0),
      step: Math.max(...dropped.map((p) => p.step ?? -1)),
    }
  }
}

/** 取走“上一步的注入没进 surface”的账，调用方回滚额度/命中/条目冷却。 */
export function takeRollback(state) {
  if (!state) return null
  const rollback = state.rollback
  state.rollback = null
  return rollback || null
}

/** 常驻任务卡是否仍可见（条目全被跳过时，卡本身不该重复发）。 */
export function isEntryVisible(state, entryHash) {
  return Boolean(state && entryHash && state.entries.has(entryHash))
}

/** 旧 procedure 的整块文本是否仍可见（正文无 id，只能按整块 hash 对账）。 */
export function isLegacyBodyVisible(state, body) {
  return Boolean(state && body && state.legacyBlocks.has(lineHash(body)))
}

export function ensureVisible(session, state) {
  const surface = surfaceOf(session)
  if (!surface || state.degraded) return false
  const gen = Number.isFinite(surface.replaceGeneration) ? surface.replaceGeneration : null
  state.genSupported = gen !== null
  if (!state.genSupported) {
    state.fallbackScans += 1
    if (state.fallbackScans >= 32) {
      state.fallbackScans = 0
      state.dirty = true
    }
  }
  if (!state.ready || state.dirty || (state.genSupported && gen !== state.surfaceGen)
    || (!state.genSupported && (surface.nodes.length < state.nodeCount
      || (state.firstSeq !== null && surface.nodes[0] !== state.firstSeq)))) {
    state.items.clear()
    state.legacy.clear()
    state.legacyBlocks.clear()
    state.blocks.clear()
    state.confirmedBlocks.clear()
    state.entries.clear()
    state.firstSeq = null
    state.nodeCount = 0
    state.dirty = false
    state.ready = true
    state.surfaceGen = gen
    try {
      scanNodes(session, state)
    } catch {
      state.degraded = true
      state.items.clear()
      state.legacy.clear()
      state.legacyBlocks.clear()
      state.blocks.clear()
      state.confirmedBlocks.clear()
      state.entries.clear()
      return false
    }
    settlePending(state)
    return true
  }
  // 事件流可能漏掉（宿主版本差异）：只补扫尾部追加的节点。
  if (surface.nodes.length > state.nodeCount) {
    try {
      scanNodes(session, state, state.nodeCount)
    } catch {
      state.degraded = true
      state.items.clear()
      state.legacy.clear()
      state.legacyBlocks.clear()
      state.blocks.clear()
      state.confirmedBlocks.clear()
      state.entries.clear()
      return false
    }
  }
  settlePending(state)
  return true
}

export function onSessionEvent(state, event) {
  if (!state || !event) return
  if (typeof event.type === 'string' && event.type.startsWith('compaction/')) {
    state.dirty = true
    return
  }
  if (event.type !== 'user/message') return
  recordMessage(state, event.data)
}

/**
 * 注入后立即登记（消息可能还没 commit 到 surface）；下一步发现 surface 里没有就撤销。
 * 注意这里**不能**走 mergeProvenance：它把块标成“已确认”，而这条消息此刻还没进 surface。
 */
export function recordInjected(state, message, meta = {}) {
  const memory = message?.source?.memory
  if (memory && memory.v === 1) {
    const block = typeof memory.b === 'string' ? memory.b : ''
    if (block) state.blocks.add(block)
    const items = []
    for (const pair of Array.isArray(memory.i) ? memory.i : []) {
      if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue
      const hash = typeof pair[1] === 'string' ? pair[1] : null
      state.items.set(pair[0], hash)
      items.push([pair[0], hash])
    }
    state.pending.push({ block, items, chars: Number(meta.chars) || 0, step: Number.isFinite(meta.step) ? meta.step : null, ids: (meta.reasons || []).map((r) => r && r.id).filter(Boolean) })
    return
  }
  recordMessage(state, message)
}

/**
 * @param {object} state 可见性索引
 * @param {string} id 条目 id
 * @param {string} hash 当前条目正文指纹
 * @param {string[]} [legacyHashes] 旧消息可能留下的整行指纹（见 lineHash）
 */
export function isItemVisible(state, id, hash, legacyHashes = []) {
  if (!state) return false
  if (state.items.has(id)) {
    const seen = state.items.get(id)
    return seen === null || seen === hash
  }
  const lines = state.legacy.get(id)
  return Boolean(lines && legacyHashes.some((h) => lines.has(h)))
}

export function isBlockVisible(state, block) {
  return Boolean(state && block && state.blocks.has(block))
}

export function provenanceOf(block, reasons, max = MAX_PROVENANCE_ITEMS, entry = null) {
  const items = []
  for (const reason of reasons || []) {
    if (!reason || !reason.id || !reason.hash) continue
    items.push([reason.id, reason.hash])
    if (items.length >= max) break
  }
  return { v: 1, b: String(block || ''), i: items, ...(entry ? { e: String(entry) } : {}) }
}
