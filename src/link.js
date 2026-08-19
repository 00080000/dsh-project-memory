export function linkEntries(store) {
  const all = store.allEntries()
  const symbols = all.filter((e) => e.type === 'symbol')
  const docs = all.filter((e) => e.type === 'doc')
  if (!symbols.length || !docs.length) return 0

  const symbolByName = new Map()
  for (const s of symbols) {
    for (const kw of s.keywords) {
      if (!kw || kw.length < 2) continue
      if (!symbolByName.has(kw)) symbolByName.set(kw, [])
      symbolByName.get(kw).push(s)
    }
  }

  let links = 0
  for (const doc of docs) {
    const linked = new Set()
    const haystack = `${doc.title || ''} ${doc.summary || ''} ${doc.keywords ? doc.keywords.join(' ') : ''}`.toLowerCase()
    for (const [name, syms] of symbolByName) {
      const lower = name.toLowerCase()
      if (name.length < 3) continue
      if (haystack.includes(lower)) {
        for (const s of syms) {
          if (linked.add(s.id)) links++
        }
      }
    }
    doc.linkedSymbols = linked.size ? [...linked] : undefined
  }
  return links
}