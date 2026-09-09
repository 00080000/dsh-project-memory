// PR 2 静默注入引擎（entry 常驻块 + relevance 门控）
// 安全约定：
//  - 纯函数 buildInjection 可单测；
//  - wrapLlmStream 仅在 resolver 给出项目 root 时才会真正动 messages，
//    任何异常/禁用/无 root → 原样透传（零副作用），绝不让宿主请求受影响。
//  - “静默注入”文本带 [Memory Inject] 前缀，落在最后一条 user message 内容块里；
//    指纹去重保证内容未变不重复追加（变更由宿主消息历史自然保留到压缩前）。
import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ProjectMemoryStore } from './store.js'
import { memoryRootFor } from './util/fs.js'
import { insightMatchText } from './similarity.js'
import { normalizedTokenOverlap } from './similarity.js'
import { cfgInsight, GlobalStore, defaultGlobalFile } from './insight-store.js'
import { projectTags } from './project-profile.js'

export const INJECT_MARK = '[Memory Inject]'

/** 注入引擎配置：insight 默认之上叠加 autoContext 预算/门控参数。 */
export function cfgEngine(config) {
  const c = (config && config.autoContext) || {}
  const base = cfgInsight(config)
  return {
    ...base,
    maxTokens: typeof c.maxTokens === 'number' ? c.maxTokens : 400,
    entryMaxInsights: typeof c.entryMaxInsights === 'number' ? c.entryMaxInsights : 6,
    relevanceMin: typeof c.relevanceMin === 'number' ? c.relevanceMin : 0.25,
    // resident 任务卡最多显示几个"编辑中"文件（纯写权重，最近写优先）
    editedMax: typeof c.editedMax === 'number' ? c.editedMax : 3,
    // 模型自己写/维护任务清单后、尚无新人类消息时，不把任务卡再回声给模型（省 token）
    skipEchoSelfTodo: c.skipEchoSelfTodo !== false,
  }
}

function textOf(message) {
  const blocks = (message && message.content) || []
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user') {
      const t = textOf(m)
      if (t.trim()) return t.trim()
    }
  }
  return ''
}

function fingerprint(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

function linesOf(list) {
  const out = []
  for (const it of list || []) {
    if (!it || it.archived || it.draft) continue
    const body = it.fix || it.solution || it.choice || (Array.isArray(it.steps) ? `步骤 ${it.steps.length} 条` : '')
    out.push(`- [${it.id}] ${it.kind}: ${it.title}${body ? ` — ${String(body).slice(0, 120)}` : ''}`)
  }
  return out
}

/** 任务卡上"编辑中"文件（写过、最近写优先，最多 max 个）。 */
export function editedFiles(task, max) {
  if (!task || !task.fileMeta) return []
  const meta = task.fileMeta
  // task.files 已由 taskbridge 保持热序（写过在前、按 lastWriteAt 倒序）
  return (task.files || []).filter((f) => meta[f] && meta[f].lastWriteAt).slice(0, max)
}

/**
 * 是否回声 resident 任务卡：最近一次推进是模型自己 todo 写步骤、且之后没有新人类消息时，
 * 不回声（模型刚写的东西再喂回去 = 噪音/浪费 token）。保留相关 insights 注入不变。
 */
export function shouldEchoTaskCard(task, cfg) {
  if (!task) return false
  const c = cfg || {}
  if (c.skipEchoSelfTodo === false) return true
  const lt = task.lastTodoAt
  const lh = task.lastHumanAt
  if (lt && lh) return !(lt > lh)
  return true
}

/** 任务卡 + 非草稿任务级 insights 摘要（常驻块主体）。 */
export function buildEntryContent(task, cfg) {
  if (!task) return ''
  const c = cfg || {}
  const steps = (task.steps || []).map((s) => (typeof s === 'string' ? s : s.content || s.text || '').slice(0, 80))
  const card = [`任务: ${task.title || '(untitled)'}`, `进度: ${steps.filter((s) => true).length ? `${steps.length} 步` : ''}`, ...steps.slice(0, 12).map((s, i) => `  ${i + 1}. ${s}`)]
  const insights = linesOf(task.insights)
  const edited = editedFiles(task, c.editedMax || 3)
  const parts = [...card]
  if (edited.length) parts.push(`  编辑中: ${edited.join(', ')}`)
  if (insights.length) parts.push(`任务记忆:`, ...insights.slice(0, c.entryMaxInsights || 6))
  return parts.join('\n')
}

/**
 * 构建注入内容（不写盘、无副作用）。
 * @param {object} opts { query, task, store, globalStore, projectTagsList, cfg }
 * @returns {{ text: string, labels: string[] }}
 */
export function buildInjection(opts) {
  const { query, task, globalStore, cfg } = opts
  const store = opts.store || null
  const tags = opts.projectTagsList || []
  const labels = []
  const parts = []
  let budgetChars = (cfg.maxTokens || 400) * 3

  // B) relevance：procedure（trigger 命中）全步骤优先
  const gItems = globalStore ? globalStore.items() : []
  const matched = []
  for (const it of gItems) {
    if (!it || it.archived || it.kind !== 'procedure' || !it.trigger) continue
    const tr = it.trigger
    const kwHit = (tr.keywords || []).some((k) => query.toLowerCase().includes(String(k).toLowerCase()))
    const symHit = (tr.symbols || []).some((s) => query.includes(s))
    if (!kwHit && !symHit) continue
    if (Array.isArray(tr.scope) && tr.scope.length && tags.length) {
      if (!tr.scope.some((s) => tags.includes(s))) continue // 画像过滤
    }
    matched.push({ it, score: 1 })
  }
  // procedure 之外的相关 insights（project + global 非草稿非归档），lexical top-k
  const cands = [...(store ? store.insightItems() : []), ...gItems]
  for (const it of cands) {
    if (!it || it.archived || it.draft) continue
    if (it.kind === 'procedure') continue // procedure 只经 trigger 通道注入，避免绕过 scope 过滤
    const score = normalizedTokenOverlap(query, insightMatchText(it))
    if (score >= (cfg.relevanceMin || 0.25)) matched.push({ it, score })
  }
  matched.sort((a, b) => b.score - a.score)
  const seen = new Set()
  for (const { it } of matched) {
    if (seen.has(it.id)) continue
    seen.add(it.id)
    const label = it.kind === 'procedure' ? 'procedure' : 'insight'
    const body =
      it.kind === 'procedure' && Array.isArray(it.steps)
        ? `【${it.title}】\n${it.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
        : `- [${it.id}] ${it.title}${it.fix || it.solution || it.choice ? ` — ${it.fix || it.solution || it.choice}` : ''}`
    parts.push(body)
    labels.push(label)
    if (parts.join('\n').length > budgetChars) break
  }
  // 常驻块文本（内容哈希由 wrapper 判“是否已注入过”）
  const entry = shouldEchoTaskCard(task, cfg) ? buildEntryContent(task, cfg) : ''
  const total = [entry, ...parts].filter(Boolean)
  if (!total.length) return { text: '', labels: [] }
  let text = total.join('\n')
  if (text.length > budgetChars) text = text.slice(0, budgetChars) + '\n…(截断)'
  return { text, labels }
}

/**
 * 包装 llm.stream。resolver(ctx, config) 返回项目 root；返回 null → 完全透传。
 * opts.state 持有“当前注入指纹”（跨请求去重）。
 */
export function wrapLlmStream(streamFn, config, { resolveRoot, state, llmName = 'llm' } = {}) {
  const auto = (config && config.autoContext) || {}
  if (auto.enabled === false) return streamFn
  const orig = typeof streamFn === 'function' ? streamFn : () => {}
  const cfg = cfgEngine(config)
  const mem = state || {}
  return async function* wrapped(params) {
    try {
      const resolved = resolveRoot ? resolveRoot(config) : null
      const root = typeof resolved === 'string' ? resolved : (resolved && resolved.root) || null
      const sessionId = resolved && typeof resolved === 'object' ? resolved.sessionId || null : null
      if (root) {
        const query = lastUserText(params && params.messages)
        const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
        const globalStore = new GlobalStore(cfgInsight(config).globalFile || defaultGlobalFile()).load()
        const sid = sessionId || null
        const boundTaskId = sid && store.getBoundTaskId(sid) ? store.getBoundTaskId(sid) : null
        const task = boundTaskId ? store.getTask(boundTaskId) : null
        const built = buildInjection({ query, task, store, globalStore, projectTagsList: projectTags(root), cfg })
        const fp = fingerprint(built.text)
        if (built.text && fp !== mem.lastFp) {
          const last = params.messages && params.messages[params.messages.length - 1]
          if (last && last.role === 'user') {
            const content = Array.isArray(last.content) ? last.content : []
            content.push({ type: 'text', text: `\n\n${INJECT_MARK} ${llmName}\n${built.text}` })
            last.content = content
            mem.lastFp = fp
            if (!mem.loggedFire) {
              mem.loggedFire = true
              console.log(`[dsh-project-memory] auto-context: FIRST injection fired (${built.text.length} chars, root=${root}${sessionId ? `, session=${sessionId}` : ''})`)
            }
          }
        }
      }
    } catch (err) {
      console.error(`[dsh-project-memory] auto-inject skipped: ${err?.message || err}`)
    }
    // 无论注入与否都原样走宿主 stream（异常同样原样传播）
    yield* orig(params)
  }
}

/** 注册 agent/pre-step 监听，向每步请求的 enter 决策追加记忆消息（默认开）。
 * 宿主瀑布事件签名为 (payload, next)：payload.agent.session 提供会话（header.cwd=项目根）。
 * 任何异常/无会话 cwd → 原样返回默认决策，零副作用，绝不让宿主请求受影响。
 */
export function installAutoInject(ctx, config) {
  const auto = (config && config.autoContext) || {}
  if (auto.enabled === false) return
  const cfg = cfgEngine(config)
  const mem = {}
  ctx.on('agent/pre-step', async (payload, next) => {
    // 宿主契约是 waterfall(payload, next)，next 一定存在；但一旦宿主版本漂移、或事件被当
    // 普通事件调用，next 缺失会让本监听器 reject（历史事故正是 `next is not a function`）。
    // 更致命的是返回 undefined：宿主 agent.ts 直接读 `decision.kind`，会崩掉整步 → 无法回复。
    // 因此两种情况都退化为一个合法的 enter 决策，绝不让宿主请求受影响。
    const fallback = () => ({ kind: 'enter', messages: (payload && payload.messages) || [] })
    const decision = typeof next === 'function' ? await next() : fallback()
    if (!decision) return fallback()
    if (decision.kind !== 'enter') return decision
    try {
      const agent = payload && payload.agent
      const session = agent && agent.session
      const root = session && session.header && session.header.cwd
      const sessionId = session && session.id
      if (!root || !sessionId) return decision
      const query = lastUserText(decision.messages)
      const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
      const globalStore = new GlobalStore(cfgInsight(config).globalFile || defaultGlobalFile()).load()
      const boundTaskId = store.getBoundTaskId(sessionId) ? store.getBoundTaskId(sessionId) : null
      const task = boundTaskId ? store.getTask(boundTaskId) : null
      const built = buildInjection({ query: query || '', task, store, globalStore, projectTagsList: projectTags(root), cfg })
      const fp = fingerprint(built.text)
      if (built.text && fp !== mem.lastFp) {
        // 以宿主 createUserMessage 构造的完整 user 消息追加（带 id/source，plan-mode narration 同款）。
        // 裸 {role,content} 消息缺 source 会让宿主逐条读 message.source.kind 时崩溃。
        mem.lastFp = fp
        const injectMessage = createUserMessage({
          content: [{ type: 'text', text: `\n\n${INJECT_MARK} auto-context\n${built.text}` }],
          source: { kind: 'plugin', plugin: 'dsh-project-memory', form: 'notice', summary: `记忆注入 ${built.text.length} 字符` },
        })
        return { ...decision, messages: [...decision.messages, injectMessage] }
      }
    } catch (err) {
      console.error(`[dsh-project-memory] auto-inject skipped: ${err?.message || err}`)
    }
    return decision
  })
}