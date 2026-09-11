// 辅助 LLM 调用（**仅召回期 / 反思期，按需可选**；索引期不调用任何模型）。
// chatText 是唯一的宿主调用出口：provider/model 必填，缺失时显式抛错，由调用方决定回退并记 degraded。
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
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

export async function chatText(llm, system, user, { timeoutMs = 120000, route } = {}) {
  // provider/model 是宿主 GenerateOptions 的必填项，缺失时 LlmRuntime 抛 NO_ADAPTER。
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

/** 召回期可选的查询扩展（默认关；开启时才需要 provider/model 路由）。 */
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
