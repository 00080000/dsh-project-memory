/**
 * 注入对账的可见性索引：以 session.surface 为真相源，进程缓存只做 fallback。
 * 事件驱动更新；compaction 只标 dirty，下一次 ensure 时全量重建。
 */

import { isOwnInjection } from './util/message-source.js'

const ITEM_LINE_RE = /^\s*-\s+\[(ins_[^\]\s]+)\]/gm
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
    maxSeq: -1,
    firstSeq: null,
    degraded: false,
    items: new Map(), // id -> hash | null（null = 旧消息，只知道可见）
    blocks: new Set(),
    // 只在真正扫到 surface/事件时登记；用于区分 pending 的乐观块。
    confirmedBlocks: new Set(),
    // 注入后消息还没被宿主 append 时的乐观登记；下一次 ensureVisible 若 surface 里找不到就撤销。
    pending: [],
  }
}

export function isAvailable(session) {
  return surfaceOf(session) !== null
}

export function parseItemIds(text) {
  const ids = []
  for (const match of String(text || '').matchAll(ITEM_LINE_RE)) ids.push(match[1])
  return ids
}

function mergeProvenance(state, memory) {
  if (!memory || typeof memory !== 'object') return
  if (typeof memory.b === 'string' && memory.b) {
    state.blocks.add(memory.b)
    state.confirmedBlocks.add(memory.b)
  }
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
  for (const id of parseItemIds(text)) state.items.set(id, null)
}

function scanNodes(session, state, fromIndex = 0) {
  const surface = surfaceOf(session)
  if (!surface) return
  for (const seq of surface.nodes.slice(fromIndex)) {
    const event = session.eventAt(seq)
    if (!event || event.type !== 'user/message') continue
    recordMessage(state, event.data)
    if (seq > state.maxSeq) state.maxSeq = seq
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
  for (const pending of state.pending) {
    if (state.confirmedBlocks.has(pending.block)) continue
    state.blocks.delete(pending.block)
    for (const [id, hash] of pending.items) {
      if (state.items.get(id) === hash) state.items.delete(id)
    }
  }
  state.pending = []
}

export function ensureVisible(session, state) {
  const surface = surfaceOf(session)
  if (!surface || state.degraded) return false
  const gen = Number.isFinite(surface.replaceGeneration) ? surface.replaceGeneration : null
  state.genSupported = gen !== null
  if (!state.ready || state.dirty || (state.genSupported && gen !== state.surfaceGen)
    || (!state.genSupported && (surface.nodes.length < state.nodeCount
      || (state.firstSeq !== null && surface.nodes[0] !== state.firstSeq)))) {
    state.items.clear()
    state.blocks.clear()
    state.confirmedBlocks.clear()
    state.maxSeq = -1
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
      state.blocks.clear()
      state.confirmedBlocks.clear()
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
      state.blocks.clear()
      state.confirmedBlocks.clear()
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
  if (Number.isFinite(event.seq) && event.seq > state.maxSeq) state.maxSeq = event.seq
}

/**
 * 注入后立即登记（消息可能还没 commit 到 surface）；下一步发现 surface 里没有就撤销。
 * 注意这里**不能**走 mergeProvenance：它把块标成“已确认”，而这条消息此刻还没进 surface。
 */
export function recordInjected(state, message) {
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
    state.pending.push({ block, items })
    return
  }
  recordMessage(state, message)
}

export function isItemVisible(state, id, hash) {
  if (!state || !state.items.has(id)) return false
  const seen = state.items.get(id)
  return seen === null || seen === hash
}

export function isBlockVisible(state, block) {
  return Boolean(state && block && state.blocks.has(block))
}

export function provenanceOf(block, reasons, max = MAX_PROVENANCE_ITEMS) {
  const items = []
  for (const reason of reasons || []) {
    if (!reason || !reason.id || !reason.hash) continue
    items.push([reason.id, reason.hash])
    if (items.length >= max) break
  }
  return { v: 1, b: String(block || ''), i: items }
}
