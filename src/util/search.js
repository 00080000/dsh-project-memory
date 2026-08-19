export const CJK_RANGE =
  /[\u3400-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/

export function isCjkText(text) {
  return CJK_RANGE.test(text || '')
}

export function tokenize(text) {
  if (!text) return []
  const lower = text.toLowerCase()
  const tokens = []
  let cjkRun = ''
  const flushCjk = () => {
    if (cjkRun.length === 1) {
      tokens.push(cjkRun)
    } else {
      for (let i = 0; i < cjkRun.length - 1; i++) tokens.push(cjkRun.slice(i, i + 2))
    }
    cjkRun = ''
  }
  const latin = lower.match(/[a-z0-9_]+/g) || []
  for (const tok of latin) tokens.push(tok)
  for (const ch of lower) {
    if (CJK_RANGE.test(ch)) cjkRun += ch
    else flushCjk()
  }
  flushCjk()
  return [...new Set(tokens)]
}

const K1 = 1.5
const B = 0.75
const DELTA = 1

function avgDocLen(docs) {
  if (!docs.length) return 1
  return docs.reduce((sum, d) => sum + d.length, 0) / docs.length
}

export function buildBm25(docs, getFieldText) {
  const documents = docs.map((doc) => {
    const text = getFieldText(doc)
    const terms = tokenize(text)
    const tf = {}
    for (const t of terms) tf[t] = (tf[t] || 0) + 1
    return { doc, length: terms.length, tf }
  })
  const df = {}
  for (const d of documents) {
    for (const t of Object.keys(d.tf)) df[t] = (df[t] || 0) + 1
  }
  const N = documents.length
  const avgdl = avgDocLen(documents)
  const idf = (t) => Math.log(1 + (N - (df[t] || 0) + 0.5) / ((df[t] || 0) + 0.5))
  return {
    idf,
    score(query) {
      const q = tokenize(query)
      if (!q.length) return []
      const avgLen = avgdl
      return documents
        .map((d) => {
          const len = d.length || 1
          let score = 0
          for (const t of q) {
            const tf = d.tf[t] || 0
            if (!tf) continue
            score += idf(t) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / avgLen)))
          }
          return { doc: d.doc, score }
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
    },
  }
}

export function weightedFieldText(entry) {
  const parts = []
  for (let i = 0; i < 5; i++) parts.push(entry.title || '')
  parts.push((entry.keywords || []).join(' '))
  parts.push(entry.summary || '')
  parts.push(entry.sourcePath || '')
  return parts.join(' ')
}

export function rankEntries(entries, query, limit = 8) {
  const bm25 = buildBm25(entries, weightedFieldText)
  const scored = bm25.score(query)
  return scored.slice(0, limit).map((r) => r.doc)
}

export function rankEntriesMerged(entries, queries, limit = 8) {
  return rankEntriesMergedScored(entries, queries, limit).map((r) => r.entry)
}

export function rankEntriesMergedScored(entries, queries, limit = 8) {
  if (!queries.length) return entries.slice(0, limit).map((entry) => ({ entry, score: 0 }))
  const bm25 = buildBm25(entries, weightedFieldText)
  const merged = new Map()
  for (const query of queries) {
    for (const r of bm25.score(query)) {
      const id = r.doc.id || r.doc.sourcePath
      if (merged.has(id)) {
        if (r.score > merged.get(id).score) merged.get(id).score = r.score
      } else {
        merged.set(id, { entry: r.doc, score: r.score })
      }
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export function rankExperience(items, queryOrQueries, limit = 5) {
  return rankExperienceScored(items, queryOrQueries, limit).map((r) => r.item)
}

export function rankExperienceScored(items, queryOrQueries, limit = 5) {
  const bm25 = buildBm25(items, (item) =>
    `${item.problem} ${item.problem} ${item.problem} ${item.solution} ${item.sourceFile || ''}`,
  )
  const queries = Array.isArray(queryOrQueries) ? queryOrQueries : [queryOrQueries]
  const merged = new Map()
  for (const query of queries) {
    for (const r of bm25.score(query)) {
      if (merged.has(r.doc.id)) {
        if (r.score > merged.get(r.doc.id).score) merged.get(r.doc.id).score = r.score
      } else {
        merged.set(r.doc.id, { item: r.doc, score: r.score })
      }
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}