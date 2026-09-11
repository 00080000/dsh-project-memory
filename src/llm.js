import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { tokenize } from './util/search.js'
import { noteDegraded } from './llm-route.js'

function systemMessage(text) {
  return { role: 'system', content: [{ type: 'text', text }] }
}

function textOf(message) {
  const blocks = message.content || []
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

const MAX_SUMMARY = 300

export function summarizeText(text, max = MAX_SUMMARY) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  if (flat.length <= max) return flat
  const clip = max - 1
  const clipped = flat.slice(0, clip)
  const lastBreak = Math.max(clipped.lastIndexOf('。'), clipped.lastIndexOf('.'), clipped.lastIndexOf(';'))
  return lastBreak > clip * 0.4 ? clipped.slice(0, lastBreak + 1) : clipped + '…'
}

export async function chatText(llm, system, user, { timeoutMs = 120000, route } = {}) {
  // D4：provider/model 是宿主 GenerateOptions 的必填项，缺失时 LlmRuntime 抛 NO_ADAPTER。
  // 这里显式失败（由调用方决定回退并记 degraded），不让异常悄悄消失。
  if (!route?.provider || !route?.model) {
    throw new Error('auxiliary LLM call requires an explicit provider/model route')
  }
  const assembler = new BlockAssembler()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [systemMessage(system), createUserMessage({ content: [{ type: 'text', text: user }] })],
      signal: controller.signal,
    })) {
      assembler.push(chunk)
    }
  } finally {
    clearTimeout(timer)
  }
  return textOf(assembler.message())
}

export function parseStructuredJson(text) {
  return parseJson(text, (parsed) => parsed && typeof parsed === 'object' && !Array.isArray(parsed))
}

export function parseJsonArray(text) {
  return parseJson(text, (parsed) => Array.isArray(parsed))
}

function parseJson(text, validate) {
  if (!text) return null
  let candidate = text.trim()
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidate = fence[1].trim()
  const first = candidate.indexOf('[')
  const firstObj = candidate.indexOf('{')
  let start = firstObj
  if (first >= 0 && (firstObj < 0 || first < firstObj)) start = first
  const end = candidate.lastIndexOf(start === first ? ']' : '}')
  if (start >= 0 && end > start) {
    candidate = candidate.slice(start, end + 1)
  }
  try {
    const parsed = JSON.parse(candidate)
    if (validate(parsed)) return parsed
  } catch {
    // fall through
  }
  return null
}

export async function expandQuery(llm, query, count = 6, { route } = {}) {
  if (!llm) return [query]
  if (!route) {
    noteDegraded('llm.expand.no-route', 'no provider/model route for query expansion; search uses the raw query')
    return [query]
  }
  const system =
    'You are a search-query expander for a codebase/document memory search engine. ' +
    'Given a user query, return a STRICT JSON array of alternative search queries that ' +
    'capture the same intent with different words: synonyms, English/Chinese equivalents, ' +
    'code identifier guesses, and narrower/longer phrasings. Include the original query first. ' +
    'Output only the JSON array of strings, no fences, no commentary.'
  try {
    const raw = await chatText(llm, system, `Query: "${query}"\n\nReturn the JSON array.`, { route })
    const parsed = parseJsonArray(raw)
    if (Array.isArray(parsed) && parsed.length) {
      const variants = parsed.map(String).filter((s) => s.trim()).slice(0, count)
      if (variants.length) return variants
    }
  } catch (err) {
    noteDegraded('llm.expand.failed', `query expansion LLM call failed: ${err?.message || err}`)
  }
  return [query]
}

export async function extractDocEntry(llm, chunk, sourcePath, { route } = {}) {
  const system =
    'You are a project-documentation indexer. Given a chunk of a project document, ' +
    'return a STRICT JSON object with exactly four fields: ' +
    '"title" (short section title, string), ' +
    '"summary" (3-5 sentence dense summary of what this section covers, ' +
    'mentioning concrete names, decisions, constraints, and key technical details), ' +
    '"blindSpots" (string describing what this summary does NOT cover, ' +
    'e.g. "未覆盖：部署细节、性能基准、v0.2 前 API", empty string if none), ' +
    '"keywords" (array of 5-10 searchable strings: ' +
    'cover the document\'s own language AND English equivalents, ' +
    'so a query in either language can match). ' +
    'Do not include markdown fences, do not add commentary, output only the JSON object.'

  const user =
    `Document: ${sourcePath}\nSection: ${chunk.title || '(untitled)'}\n\n` +
    `Content:\n${chunk.text.slice(0, 6000)}\n\nReturn the JSON object.`

  const fallback = () => ({
    title: chunk.title || sourcePath,
    summary: summarizeText(chunk.text),
    blindSpots: '',
    keywords: tokenize(chunk.title).slice(0, 5),
  })

  if (!llm) return fallback()
  if (!route) {
    noteDegraded('llm.doc.no-route', `no provider/model route for doc summary (${sourcePath}); using the truncated fallback`)
    return fallback()
  }

  try {
    const raw = await chatText(llm, system, user, { route })
    const parsed = parseStructuredJson(raw)
    if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim()) return fallback()
    const kw = Array.isArray(parsed.keywords) ? parsed.keywords.map(String).filter((k) => k).slice(0, 8) : []
    return {
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : chunk.title || sourcePath,
      summary: summarizeText(parsed.summary.trim()),
      blindSpots: typeof parsed.blindSpots === 'string' ? parsed.blindSpots.trim() : '',
      keywords: kw.length ? kw : tokenize(chunk.title).slice(0, 5),
    }
  } catch (err) {
    noteDegraded('llm.doc.failed', `doc summary LLM call failed for ${sourcePath}: ${err?.message || err}`)
    return fallback()
  }
}