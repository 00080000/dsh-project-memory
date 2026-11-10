/**
 * 注入对账的可见性索引：以 session.surface 为真相源，进程缓存只做 fallback。
 * 事件驱动更新；compaction 只标 dirty，下一次 ensure 时全量重建。
 */

const ITEM_LINE_RE = /^\s*-\s+\[(ins_[^\]\s]+)\]/gm

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
    degraded: false,
    items: new Map(), // id -> hash | null（null = 旧消息，只知道可见）
    blocks: new Set(),
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
  if (typeof memory.b === 'string' && memory.b) state.blocks.add(memory.b)
  if (!Array.isArray(memory.i)) return
  let count = 0
  for (const pair of memory.i) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue
    state.items.set(pair[0], typeof pair[1] === 'string' ? pair[1] : null)
    if (++count >= 40) break
  }
}

function recordMessage(state, message) {
  const source = message && message.source
  if (!source || typeof source.kind !== 'string') return
  const memory = source.memory
  if (memory && memory.v === 1) {
    mergeProvenance(state, memory)
    return
  }
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
  state.nodeCount = surface.nodes.length
}

export function ensureVisible(session, state) {
  const surface = surfaceOf(session)
  if (!surface || state.degraded) return false
  const gen = Number.isFinite(surface.replaceGeneration) ? surface.replaceGeneration : null
  state.genSupported = gen !== null
  if (!state.ready || state.dirty || (state.genSupported && gen !== state.surfaceGen) || (!state.genSupported && surface.nodes.length < state.nodeCount)) {
    state.items.clear()
    state.blocks.clear()
    state.maxSeq = -1
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
      return false
    }
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
      return false
    }
  }
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

/** 注入后立即登记（消息可能还没 commit 到 surface）。 */
export function recordInjected(state, message) {
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

export function provenanceOf(block, reasons, max = 40) {
  const items = []
  for (const reason of reasons || []) {
    if (!reason || !reason.id || !reason.hash) continue
    items.push([reason.id, reason.hash])
    if (items.length >= max) break
  }
  return { v: 1, b: String(block || ''), i: items }
}
