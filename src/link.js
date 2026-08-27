const LATIN_NAME = /^[A-Za-z0-9_]+$/
const CJK_CHAR = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/

function buildMatcher(name) {
  const lower = name.toLowerCase()
  if (LATIN_NAME.test(name)) {
    return { lower, re: new RegExp(`(?<![a-z0-9_$])${lower}(?![a-z0-9_$])`) }
  }
  const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 尾部统一挡 CJK + 字母数字下划线，防止纯 CJK 名误链混合后缀、混合名误链更长后缀
  return { lower, re: new RegExp(`${escaped}(?!${CJK_CHAR.source})(?![a-z0-9_$])`) }
}

export function linkEntries(store) {
  const all = store.allEntries()
  const symbols = all.filter((e) => e.type === 'symbol')
  const docs = all.filter((e) => e.type === 'doc')
  if (!symbols.length || !docs.length) return 0

  const symbolByName = new Map()
  for (const s of symbols) {
    const name = s.keywords[0]
    if (!name || name.length < 3) continue
    if (!symbolByName.has(name)) symbolByName.set(name, { syms: [], ...buildMatcher(name) })
    symbolByName.get(name).syms.push(s)
  }

  let links = 0
  for (const doc of docs) {
    const linked = new Set()
    const haystack = `${doc.title || ''} ${doc.summary || ''} ${doc.keywords ? doc.keywords.join(' ') : ''}`.toLowerCase()
    for (const [, entry] of symbolByName) {
      const hit = entry.re ? entry.re.test(haystack) : haystack.includes(entry.lower)
      for (const s of entry.syms) {
        if (!hit) break
        const before = linked.size
        linked.add(s.id)
        if (linked.size > before) links++
      }
    }
    doc.linkedSymbols = linked.size ? [...linked] : undefined
  }
  return links
}
