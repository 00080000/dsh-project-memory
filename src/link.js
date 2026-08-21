export function linkEntries(store) {
  const all = store.allEntries()
  const symbols = all.filter((e) => e.type === 'symbol')
  const docs = all.filter((e) => e.type === 'doc')
  if (!symbols.length || !docs.length) return 0

  const symbolByName = new Map()
  for (const s of symbols) {
    const name = s.keywords[0]
    if (!name || name.length < 3) continue
    if (!symbolByName.has(name)) symbolByName.set(name, [])
    symbolByName.get(name).push(s)
  }

  let links = 0
  for (const doc of docs) {
    const linked = new Set()
    const haystack = `${doc.title || ''} ${doc.summary || ''} ${doc.keywords ? doc.keywords.join(' ') : ''}`.toLowerCase()
    for (const [name, syms] of symbolByName) {
      if (haystack.includes(name.toLowerCase())) {
        for (const s of syms) {
          const before = linked.size
          linked.add(s.id)
          if (linked.size > before) links++
        }
      }
    }
    doc.linkedSymbols = linked.size ? [...linked] : undefined
  }
  return links
}
