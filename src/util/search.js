export const CJK_RANGE =
  /[\u3400-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/

const SYNONYMS = new Map([
  ['数据库连接池', ['连接池', 'DB pool', 'db pool']],
  ['连接池', ['数据库连接池', 'DB pool', 'db pool']],
  ['DB pool', ['数据库连接池', '连接池']],
  ['db pool', ['数据库连接池', '连接池']],
])

export function extractCjkPhrases(text) {
  const phrases = []
  let run = ''
  for (const ch of text) {
    if (CJK_RANGE.test(ch)) {
      run += ch
    } else if (run.length >= 3) {
      phrases.push(run)
      run = ''
    } else {
      run = ''
    }
  }
  if (run.length >= 3) phrases.push(run)
  return phrases
}

function expandQuery(query) {
  if (!query) return { original: '', expanded: [], cjkPhrases: [] }
  const lower = query.toLowerCase()
  const expanded = new Set([lower])
  for (const [key, vals] of SYNONYMS) {
    if (lower.includes(key.toLowerCase())) {
      for (const v of vals) expanded.add(v.toLowerCase())
    }
  }
  const cjkPhrases = extractCjkPhrases(query)
  return { original: lower, expanded: [...expanded], cjkPhrases }
}

export function tokenizeRaw(text) {
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
  return tokens
}

export function tokenize(text) {
  return [...new Set(tokenizeRaw(text))]
}

const K1 = 1.5
const B = 0.75
const DELTA = 1

function avgDocLen(docs) {
  if (!docs.length) return 1
  return docs.reduce((sum, d) => sum + d.length, 0) / docs.length
}

export function buildBm25(docs, getFieldText, getPhraseFields) {
  const documents = docs.map((doc) => {
    const text = getFieldText(doc)
    const terms = tokenizeRaw(text)
    const tf = {}
    for (const t of terms) tf[t] = (tf[t] || 0) + 1
    const rawFields = getPhraseFields ? getPhraseFields(doc) : [(doc.title || ''), (doc.keywords || []).join(' ')]
    const phraseFields = Array.isArray(rawFields) ? rawFields : [rawFields]
    const phraseText = phraseFields.filter(Boolean).join(' ').toLowerCase()
    return { doc, length: terms.length, tf, phraseText }
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
      const { expanded, cjkPhrases } = expandQuery(query)
      const qTokens = new Set()
      for (const term of expanded) {
        for (const tok of tokenizeRaw(term)) qTokens.add(tok)
      }
      const q = [...qTokens]
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
          for (const phrase of cjkPhrases) {
            const lowerPhrase = phrase.toLowerCase()
            if (d.phraseText.includes(lowerPhrase)) {
              score *= 1.5
            }
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

export function makeSearchText(entry) {
  return weightedFieldText(entry).toLowerCase()
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
  const bm25 = buildBm25(
    items,
    (item) => `${item.problem} ${item.problem} ${item.problem} ${item.solution} ${item.sourceFile || ''}`,
    (item) => [item.problem],
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

function countOccurrences(text, token) {
  if (!token) return 0
  let count = 0
  let pos = 0
  while ((pos = text.indexOf(token, pos)) !== -1) {
    count++
    pos += token.length
  }
  return count
}

const STREAM_K1 = 1.2
const STREAM_B = 0.75

export function rankEntriesStreaming(entries, queries, idf, limit = 8) {
  if (!queries.length) return entries.slice(0, limit).map((entry) => ({ entry, score: 0 }))
  const merged = new Map()
  for (const query of queries) {
    const { expanded, cjkPhrases } = expandQuery(query)
    const qTokens = new Set()
    for (const term of expanded) {
      for (const tok of tokenizeRaw(term)) qTokens.add(tok)
    }
    const queryTokens = [...qTokens]
    if (!queryTokens.length) continue
    for (const entry of entries) {
      const text = entry.searchText || weightedFieldText(entry).toLowerCase()
      const len = text.length || 1
      let score = 0
      for (const t of queryTokens) {
        const tf = countOccurrences(text, t)
        if (!tf) continue
        const idfVal = idf[t] || 1
        score += idfVal * ((tf * (STREAM_K1 + 1)) / (tf + STREAM_K1 * (1 - STREAM_B + (STREAM_B * len) / 1000)))
      }
      for (const phrase of cjkPhrases) {
        const lowerPhrase = phrase.toLowerCase()
        if (text.includes(lowerPhrase)) {
          score *= 1.5
        }
      }
      if (score > 0) {
        const id = entry.id || entry.sourcePath
        const existing = merged.get(id)
        if (!existing || score > existing.score) {
          merged.set(id, { entry, score })
        }
      }
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}