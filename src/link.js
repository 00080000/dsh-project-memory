const LATIN_NAME = /^[A-Za-z0-9_]+$/

function buildMatcher(name) {
  const lower = name.toLowerCase()
  if (!LATIN_NAME.test(name)) return { lower, re: null }
  return { lower, re: new RegExp(`(?<![a-z0-9_$])${lower}(?![a-z0-9_$])`) }
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
