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
    // 结构词项也参与链接：terms 覆盖整个 chunk，符号在后半段被提及时同样能链上（与检索同源）
    const haystack = `${doc.title || ''} ${doc.summary || ''} ${doc.terms || ''} ${doc.keywords ? doc.keywords.join(' ') : ''}`.toLowerCase()
    for (const [, entry] of symbolByName) {
      const hit = entry.re ? entry.re.test(haystack) : haystack.includes(entry.lower)
      for (const s of entry.syms) {
        if (!hit) break
        const before = linked.size
        linked.add(s.id)
        if (linked.size > before) links++
      }
    }
    const before = Array.isArray(doc.linkedSymbols) ? doc.linkedSymbols.join('\u0000') : ''
    const next = [...linked]
    if (before === next.join('\u0000')) continue
    doc.linkedSymbols = next.length ? next : undefined
    // 链接是在**符号**落盘那一刻算出来的，此时 doc 的 shard 往往不是脏的；不标脏就只存在于内存，
    // 下次进程启动重新加载后链接全部丢失（"文档先索引、符号后到"的正常顺序）。
    if (typeof store.markFile === 'function' && typeof store.fileRecord === 'function' && doc.sourcePath) {
      const record = store.fileRecord(doc.sourcePath)
      if (record) store.markFile(doc.sourcePath, record)
    }
  }
  return links
}
