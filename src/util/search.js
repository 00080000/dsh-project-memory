import { CYRILLIC_WORD_RE, RU_STOPWORDS, normalizeRuWord, stemRu } from './ru.js'

export const CJK_RANGE =
  /[\u3400-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/

/**
 * 分词契约的版本号。改 tokenizeRaw 的**输出集合**（新增书写系统、词干、停用词）就要 +1：
 * 落盘的 doc `terms` 是它的产物，旧版本写的 terms 里没有新词项，必须让
 * `docEntriesNeedBackfill` 触发一次重抽（见 doc-index.js）。
 * 1 = 隐式的旧版本（那时条目上没有这个字段），2 = 加入俄语词干/停用词。
 */
export const TOKENIZER_VERSION = 2

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
  // 西里尔（只做了俄语）：切词 → 去虚词 → Snowball 词干。
  // 拉丁与 CJK 分支保持原样（老用户的分数/阈值都是在那套输出上标定的，动它们要单独评审）。
  for (const raw of lower.match(CYRILLIC_WORD_RE) || []) {
    const word = normalizeRuWord(raw)
    if (word.length < 2 || RU_STOPWORDS.has(word)) continue
    // ≤3 字符不词干：俄语缩写（ИИ / БД / ОС）在 Snowball 下会被削成单字母
    // （`ии` → `и`），那既丢语义又和虚词撞车；这些短词本来也没有可削的格尾。
    const stem = word.length <= 3 ? word : stemRu(word)
    if (stem.length >= 2) tokens.push(stem)
  }
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
          let matched = 0
          for (const t of q) {
            const tf = d.tf[t] || 0
            if (!tf) continue
            matched++
            score += idf(t) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / avgLen)))
          }
          for (const phrase of cjkPhrases) {
            const lowerPhrase = phrase.toLowerCase()
            if (d.phraseText.includes(lowerPhrase)) {
              score *= 1.5
            }
          }
          // `matched` = **命中的不同查询词数**。调用方用它做最小相关性闸门：
          // 单个片段（`no` 这种从 `--no-edit` 切出来的 2 字符词）也能让 score>0，
          // 而 score>0 本身不构成"相关"的证据。
          return { doc: d.doc, score, matched }
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
  // 符号的一行声明（签名/重载/类型体）也是可检索事实：只落盘不检索等于白存。
  parts.push(entry.text || '')
  // 结构词项：覆盖整个 chunk 的字面词项，把「只有前 300 字符可检索」补回来（索引期零 LLM）
  parts.push(entry.terms || '')
  parts.push(entry.sourcePath || '')
  return parts.join(' ')
}

export function makeSearchText(entry) {
  return weightedFieldText(entry).toLowerCase()
}

// 说明：文档/符号的线上检索走 `rankEntriesStreaming`（recall.js），它不重建整库 BM25，
// 而是用预物化的 `searchText` + 每 store 缓存的 idf。曾经存在的 `rankEntries` /
// `rankEntriesMerged`（每次调用都 buildBm25 全库分词，70k 条目实测 p50 1.4s）已删除——
// 它们在生产路径上没有调用方，留着只会被误用。

export function rankEntriesMergedScored(entries, queries, limit = 8) {
  if (!queries.length) return entries.slice(0, limit).map((entry) => ({ entry, score: 0, matched: 0 }))
  const bm25 = buildBm25(entries, weightedFieldText)
  const merged = new Map()
  for (const query of queries) {
    for (const r of bm25.score(query)) {
      const id = r.doc.id || r.doc.sourcePath
      const prev = merged.get(id)
      if (prev) {
        if (r.score > prev.score) prev.score = r.score
        if (r.matched > prev.matched) prev.matched = r.matched
      } else {
        merged.set(id, { entry: r.doc, score: r.score, matched: r.matched })
      }
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

// 说明：经验层（`kind:'experience'`）曾有自己的打分器 `rankExperienceScored`（v0.4 的
// `{problem,solution}` 形状）。统一存储后它与洞察层是同一个实体，也由 `save_lesson` 写出
// （没有 problem/solution 参数），独立打分器会把那种条目打成 0 分且无处可查。现由
// `recall.js` 用与洞察层相同的 `insightToEntry` 适配器打分，本函数随能力一起删除。

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