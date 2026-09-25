// doc → symbol 交叉引用：**读取期解算**，不再物化进 entry。
//
// 旧实现（≤0.5.10）在每次索引提交时把「本 chunk 命中的所有符号 id」写进
// `entry.linkedSymbols` 并落盘。实测一个真实 TypeScript 仓库（本仓库的 361MB store）：
// 17174 个 chunk 共 3,948,420 个链接槽位，只对应 15,456 个符号，单 chunk 最多 2231 个；
// 而唯一的消费者 `query_memory` 只读前 5 个——存了消费量的 46 倍。
//
// 更根本的问题是它把**跨实体派生关系**固化进了源记录：doc 链接的有效性取决于符号表的
// 当前状态，而符号是独立写入的。于是必须追失效（`markFile` 标脏、"文档先索引、符号后到
// 则链接丢失"），并且每个索引提交点都要对整库做 O(chunks × symbols) 全表重扫。
//
// 现在：entry 只存事实；链接在查询时用每 store 的符号索引解算，成本 O(本 chunk 词数)，
// 且天然反映当前符号表——后索引的符号也能链上，`markFile` 那套失效机制随之删除。

const LATIN_NAME = /^[A-Za-z0-9_]+$/
const CJK_CHAR = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/
/** 与 latin 边界后视 `[a-z0-9_$]` 同字符集：切出的词直接可查倒排表。 */
const LATIN_WORD = /[a-z0-9_$]+/g

function buildMatcher(name) {
  const lower = name.toLowerCase()
  if (LATIN_NAME.test(name)) {
    return { re: new RegExp(`(?<![a-z0-9_$])${lower}(?![a-z0-9_$])`) }
  }
  const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 尾部统一挡 CJK + 字母数字下划线，防止纯 CJK 名误链混合后缀、混合名误链更长后缀
  return { re: new RegExp(`${escaped}(?!${CJK_CHAR.source})(?![a-z0-9_$])`) }
}

/** 纯 latin 符号名按整词查倒排；其余（CJK / 混合 / 带 `$`）保留正则回退，语义与旧实现一致。 */
export function buildSymbolIndex(store) {
  const latin = new Map() // lowerName -> symbol[]
  const other = []
  const otherByName = new Map()
  for (const entry of store.allEntries()) {
    if (!entry || entry.type !== 'symbol') continue
    const name = Array.isArray(entry.keywords) ? entry.keywords[0] : undefined
    if (typeof name !== 'string' || name.length < 3) continue
    const key = name.toLowerCase()
    if (LATIN_NAME.test(name)) {
      const bucket = latin.get(key)
      if (bucket) bucket.push(entry)
      else latin.set(key, [entry])
      continue
    }
    const existing = otherByName.get(key)
    if (existing) {
      existing.syms.push(entry)
      continue
    }
    const { re } = buildMatcher(name)
    const record = { reGlobal: new RegExp(re.source, 'g'), syms: [entry] }
    otherByName.set(key, record)
    other.push(record)
  }
  return { latin, other }
}

/** 每 store 一份符号索引，按 `store.entriesVersion` 失效（任何 entry 变更即重建）。 */
const indexCache = new WeakMap()

function symbolIndexOf(store) {
  const version = store.entriesVersion
  const cached = indexCache.get(store)
  if (cached && cached.version === version) return cached.index
  const index = buildSymbolIndex(store)
  indexCache.set(store, { version, index })
  return index
}

/**
 * 解算一条 doc entry 提到的符号，按相关度取前 `limit` 个。
 *
 * 判据与旧 linkEntries 同源（title / summary / terms / keywords 四个字段），
 * 排序为：命中次数 → 名字长度 → id（稳定序）。旧实现交给消费者的前 5 个是符号表的
 * 插入序，即「任意 5 个」，这也是本次一并修掉的行为。
 *
 * @param {object} store 带 `allEntries()` 与 `entriesVersion` 的 ProjectMemoryStore
 * @param {object} doc 待解算的 doc entry
 * @param {number} limit 最多返回多少个符号 entry
 * @returns {object[]} 符号 entry 列表（可能为空）
 */
export function resolveLinkedSymbols(store, doc, limit = 5) {
  if (!store || !doc || doc.type !== 'doc' || !(limit > 0)) return []
  const haystack = `${doc.title || ''} ${doc.summary || ''} ${doc.terms || ''} ${
    Array.isArray(doc.keywords) ? doc.keywords.join(' ') : ''
  }`.toLowerCase()
  if (!haystack.trim()) return []

  const { latin, other } = symbolIndexOf(store)
  const hits = new Map() // symbol entry -> 命中次数

  if (latin.size) {
    const counts = new Map() // token -> 在 haystack 中的出现次数
    for (const token of haystack.match(LATIN_WORD) || []) counts.set(token, (counts.get(token) || 0) + 1)
    for (const [token, n] of counts) {
      const bucket = latin.get(token)
      if (!bucket) continue
      for (const symbol of bucket) hits.set(symbol, (hits.get(symbol) || 0) + n)
    }
  }
  for (const { reGlobal, syms } of other) {
    reGlobal.lastIndex = 0
    const n = haystack.match(reGlobal)?.length || 0
    if (!n) continue
    for (const symbol of syms) hits.set(symbol, (hits.get(symbol) || 0) + n)
  }
  if (!hits.size) return []

  const nameOf = (e) => (Array.isArray(e.keywords) && e.keywords[0]) || e.title || ''
  return [...hits.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      const delta = nameOf(b[0]).length - nameOf(a[0]).length
      if (delta !== 0) return delta
      return String(a[0].id).localeCompare(String(b[0].id))
    })
    .slice(0, limit)
    .map(([entry]) => entry)
}
