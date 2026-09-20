/**
 * 就绪引擎（push 侧）。
 *
 * recall 回答"记忆里有什么和这件事有关"；readiness 回答"动手之前必须知道什么"。
 * 交付契约（设计核心）：
 *   - **authored trigger = 确定性注入**：作者写下的 keywords / symbols / actions / paths 命中即在
 *     动手前全文注入，优先级 1。可审计（返回 `why`），不参与任何相似度打分。
 *   - **统计信号 = 提示态**：没有 trigger 的条目只能作为截断提示进入，优先级 2，且判据是
 *     **层内相对阈值**（相对最高分），不是长度敏感的魔法常量。
 *
 * 两个窗口（忠于宿主契约：DSH 没有"工具执行前拦截"钩子，唯一能加上下文的缝是 agent/pre-step）：
 *   - 先发窗口：人类消息里的意图词（"提交/发布/公开"）→ 动作 id 在模型规划动作之前就命中；
 *   - 反应窗口：已观察到的 tool/call 参数（`git commit`、`npm publish`、改动的路径）走同一个匹配器。
 *
 * 纯函数、零依赖、不调用模型。
 * @module dsh-project-memory/readiness
 */

import { FALLBACK_OPS, WEAK_OPS, activityFromText, opForLegacyAction } from './ops.js'
import { CJK_RANGE, tokenize } from './util/search.js'

/**
 * 动作词典：动作 id → 匹配模式。命令形态与人类意图词都归一成同一套 id，
 * 于是"你顺便提交一下"与 `git commit -m x` 对 trigger 是同一件事。
 */
export const ACTION_LEXICON = [
  ['git-add', [/git\s+add\b/i]],
  ['git-commit', [/git\s+commit\b/i, /提交/]],
  ['git-push', [/git\s+push\b/i, /推送/]],
  ['npm-publish', [/npm\s+publish\b/i, /发包/, /发布\s*到\s*npm/i]],
  ['release', [/git\s+tag\b/i, /\brelease\b/i, /发版/, /发布版本/]],
  ['go-public', [/公开/, /开源/, /对外/, /上线/]],
  ['delete', [/rm\s+-rf\b/, /git\s+rm\b/, /删除/, /清理/]],
  ['migrate', [/migrate\b/i, /迁移/]],
  ['deploy', [/\bdeploy\b/i, /部署/]],
]

/** 带扩展名的路径 token（README.md、src/util/fs.js …）。 */
const PATH_TOKEN = /(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+\.[A-Za-z][A-Za-z0-9]{0,7}\b/g
/** 点开头的裸文件名（.gitignore、.npmrc …）。 */
const DOTFILE_TOKEN = /(?:^|[\s"'`(])(\.[A-Za-z0-9_-]{2,})/g

/**
 * 文本 → 动作 id 列表（确定性、去重、词典序稳定）。
 * @param {string} text - 人类消息或工具调用参数。
 * @returns {string[]} 动作 id。
 */
export function detectActions(text) {
  const s = String(text || '')
  if (!s) return []
  const out = []
  for (const [id, patterns] of ACTION_LEXICON) {
    if (patterns.some((re) => re.test(s))) out.push(id)
  }
  return out
}

/**
 * 文本 → 路径 token（用于 trigger.paths 的 glob 匹配）。
 * @param {string} text - 工具调用参数或人类消息。
 * @returns {string[]} 去重后的路径 token。
 */
export function extractPaths(text) {
  const s = String(text || '')
  if (!s) return []
  const out = new Set()
  for (const m of s.matchAll(PATH_TOKEN)) out.add(m[0])
  for (const m of s.matchAll(DOTFILE_TOKEN)) out.add(m[1])
  return [...out]
}

/**
 * 组装就绪上下文：人类意图 + 已观察动作。三处来源都做动作/路径归一，调用方只需给文本。
 * @param {object} input
 * @param {string} [input.humanText] - 本轮人类消息（先发窗口）。
 * @param {string} [input.actionText] - 已观察到的 tool/call 参数（反应窗口）。
 * @param {string[]} [input.actions] - 调用方已归一化的动作 id（可选，会被并集）。
 * @param {string[]} [input.paths] - 调用方已归一化的路径（可选，会被并集）。
 * @returns {{ humanText: string, actionText: string, actions: string[], paths: string[] }}
 */
export function buildReadinessContext(input = {}) {
  const humanText = String(input.humanText ?? input.query ?? '')
  const actionText = String(input.actionText || '')
  const actions = new Set([...(input.actions || []), ...detectActions(humanText), ...detectActions(actionText)])
  // 人类消息里提到的路径 = **动手前的写意图**（"帮我改 src/x.js"）；动作文本里的路径不区分读写，
  // 读一个文件不该算写目标（否则 `read README.md` 会命中 writes:['README.md']）。
  // 两者对外仍合并成 `paths`（兼容既有语义），写通道单看 humanPaths。
  // 调用方若已带 humanPaths（injectForStep 构建后再传给 buildInjection），以它为准，
  // 否则退回 paths —— 避免把上一次算出来的并集（含读路径）再当写意图。
  const humanPaths = new Set([
    ...(Array.isArray(input.humanPaths) ? input.humanPaths : (input.paths || [])),
    ...extractPaths(humanText),
  ])
  const paths = new Set([...humanPaths, ...extractPaths(actionText)])
  // 动作平面（S1）：结构化调用优先；没有结构化调用时对 actionText 跑一遍 shell 规则兜底。
  const fromText = activityFromText(actionText)
  const ops = new Set([...(input.ops || []), ...fromText.ops])
  for (const a of actions) {
    const op = opForLegacyAction(a)
    if (op) ops.add(op)
  }
  const targets = new Set([...(input.targets || []), ...fromText.targets])
  const hosts = new Set([...(input.hosts || []), ...fromText.hosts])
  return {
    humanText,
    actionText,
    actions: [...actions],
    paths: [...paths],
    humanPaths: [...humanPaths],
    ops: [...ops],
    targets: [...targets],
    hosts: [...hosts],
    intent: intentText(humanText),
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
  }
}

/**
 * 派生 trigger 的意图词表（有界、确定性）。派生信号**只进提示通道**：它能提升召回，
 * 但永不强制注入——"自动学出来的东西"不该污染上下文。
 */
export const ACTION_WORDS = [
  '提交', '公开', '泄漏', '发布', '发包', '发版', '上线', '部署', '迁移', '删除', '清理', '回滚',
  '推送', '打包', '构建', '依赖', '密钥', '权限', '并发', '超时', '内存', '性能', '安全', '面试',
]

/** 无扩展名但明确是文件名的裸词（README / CHANGELOG / …），当关键词用。 */
const BARE_FILE_NAMES = /\b(?:README|CHANGELOG|LICENSE|AGENTS|CONTRIBUTING|Dockerfile|Makefile)\b/g

const DERIVED_MAX_KEYWORDS = 6
const DERIVED_MAX_ACTIONS = 4
const DERIVED_MAX_PATHS = 6

/**
 * 从一条 insight 的正文确定性派生触发信号（零模型、可重放）。
 * 结果只写进 `triggerDerived`，供提示通道（检索文本）使用；是否强制注入只由 authored `trigger` 决定。
 * @param {object} ins - 归一化后的 insight 条目。
 * @returns {{ keywords: string[], actions: string[], paths: string[] }}
 */
export function deriveTrigger(ins) {
  const text = [
    ins?.title,
    ins?.pattern,
    ins?.fix,
    ins?.choice,
    ins?.reason,
    ins?.problem,
    ins?.solution,
    ins?.topic,
    ins?.body,
    ...(Array.isArray(ins?.steps) ? ins.steps : []),
  ].filter(Boolean).join('\n')
  const bare = text.match(BARE_FILE_NAMES) || []
  const keywords = [...new Set([...ACTION_WORDS.filter((w) => text.includes(w)), ...bare])].slice(0, DERIVED_MAX_KEYWORDS)
  const actions = detectActions(text).slice(0, DERIVED_MAX_ACTIONS)
  const paths = extractPaths(text).slice(0, DERIVED_MAX_PATHS)
  return { keywords, actions, paths }
}

/**
 * insights 文档的懒回填：给缺少 `triggerDerived` 的条目补上派生信号（增量、幂等）。
 * 只改内存；是否落盘由调用方的 commit 决定。
 * @param {{ items?: object[] }} doc - insights 文档。
 * @returns {boolean} 是否发生了变更（用于置 dirty）。
 */
export function backfillDerivedTriggers(doc) {
  if (!doc || !Array.isArray(doc.items)) return false
  let changed = false
  for (const it of doc.items) {
    if (!it || it.triggerDerived) continue
    const derived = deriveTrigger(it)
    if (!derived.keywords.length && !derived.actions.length && !derived.paths.length) continue
    it.triggerDerived = derived
    changed = true
  }
  return changed
}

/**
 * 提示通道的查询文本：剔除 1–3 个字符的拉丁 token。
 *
 * 为什么：`PR` / `CI` / `OS` / `WSL` / `npm` 这类缩写太短、歧义太大，一个巧合命中就能当上
 * 该层最高分，于是以 `relative:1.00` 混进上下文（实测：人类消息里的 "PR" 把一条 task-tools
 * 越权 lesson 顶到了提示位；"wsl" 又把一条 pnpm lesson 顶到了"改文件时间戳"的任务里）。
 * 内容词（≥4 字符的拉丁标识符、CJK 词）不受影响；authored trigger 通道完全不走这里。
 * @param {string} text - 人类消息或工具参数。
 * @returns {string} 过滤后的查询文本。
 */
export function hintQueryText(text) {
  return String(text || '')
    .split(/\s+/)
    // 路径形态的 token 原样保留（src/util/fs.js 里的 fs / js 是有效证据），
    // 只对独立词做缩写剔除。
    .map((w) => (/[/.]/.test(w) ? w : w.replace(/\b[A-Za-z0-9_]{1,3}\b/g, ' ')))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** glob（只支持 `*`）→ 正则。 */
function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

/**
 * 剥离**引用内容**：代码块、行内代码、引号内的路径/文件名、裸路径。
 *
 * 为什么必须剥：人类消息里的文件名是**数据**，不是意图。实测中"石啸天-LLM记忆方向调研.pptx"
 * 这个文件名让一条"做调研要先扫 curated 列表"的经验在改文件时间戳的任务里被注入。
 * @param {string} text - 人类消息原文
 * @returns {string} 只保留意图文字的版本
 */
export function intentText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/“[^”\n]*”/g, ' ')
    .replace(/[A-Za-z]:\\[^\s"']*/g, ' ')
    .replace(/(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+/g, ' ')
    // 带扩展名的**非 ASCII 文件名**（`石啸天-记忆方向调研.pptx` / `docs/面试演示-王金鹏.md`）：
    // 只挡 ASCII 路径不够——中文文件名整块留下，"调研""面试"这类子串照样触发 when.intents，
    // 正是引号剥离要防的那类假阳性。ASCII 裸名（如 de-TODO.md）保持原语义，不在这里动。
    .replace(/\S*[^\x00-\x7F]\S*\.[A-Za-z][A-Za-z0-9]{0,7}\b/g, ' ')
    // 仓库里的裸文件名（README / CHANGELOG …）也是语料，不是意图
    .replace(/\b(?:README|CHANGELOG|LICENSE|AGENTS|CONTRIBUTING|Dockerfile|Makefile)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 意图词是否值得作为触发信号（S2 的准入过滤）。
 *
 * 规则来自实测：`rm` 命中 `dcterms`、`ppt` 命中 `pptx`、`ms` 命中任何含 ms 的词——短拉丁词
 * 是假阳性制造机；含 `_`/`.`/`/` 的是标识符或路径，属于语料平面，不是意图。
 */
export function isIntentWord(word) {
  const s = String(word || '').trim()
  if (!s) return false
  if (CJK_RANGE.test(s)) return s.length >= 2
  if (s.length < 5) return false
  if (/[_./\\*]/.test(s)) return false
  if (/\s/.test(s)) return s.length >= 8
  return true
}

const GLOB_RE = /\*/
/** 扩展名 glob（`*.pptx`）与泛名 glob（`README*`）：只能撒谎，不能收窄。 */
export function isDroppableGlob(pattern) {
  const p = String(pattern || '')
  if (!GLOB_RE.test(p)) return false
  if (/^\*\.\w+$/.test(p)) return true
  if (/^[A-Za-z][A-Za-z0-9_-]*\*$/.test(p)) return true
  return false
}

/**
 * 意图词命中：CJK 用包含，拉丁用词边界（避免 `ppt` 命中 `pptx`）。
 * @param {string} word
 * @param {string} text - 已经是 {@link intentText} 处理过的意图文本
 */
export function matchIntent(word, text) {
  const w = String(word || '').trim()
  const hay = String(text || '')
  if (!w || !hay) return false
  if (CJK_RANGE.test(w)) return w.length >= 2 && hay.includes(w)
  if (w.length < 4) return false
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_])${esc}([^A-Za-z0-9_]|$)`, 'i').test(hay)
}

function matchAnyPath(pattern, targets) {
  const p = String(pattern || '')
  if (!p) return false
  const re = globToRegExp(p)
  return (targets || []).some((cand) => {
    const c = String(cand || '')
    if (!c) return false
    return re.test(c) || re.test(c.split(/[\\/]/).pop() || '')
  })
}

/** guard 是**收窄**条件：全部满足才放行；它自己不能触发任何东西。 */
function guardPass(guard, ctx) {
  if (!guard || typeof guard !== 'object') return true
  const targets = ctx?.targets || []
  if (Array.isArray(guard.paths) && guard.paths.length && !guard.paths.some((p) => matchAnyPath(p, targets))) return false
  if (Array.isArray(guard.not_paths) && guard.not_paths.some((p) => matchAnyPath(p, targets))) return false
  if (Array.isArray(guard.hosts) && guard.hosts.length && !guard.hosts.some((h) => (ctx?.hosts || []).includes(String(h)))) return false
  if (Array.isArray(guard.tags) && guard.tags.length) {
    const tags = ctx?.tags || []
    // 画像未知（tags 为空）时不过滤：这是既有语义，保持兼容。
    if (tags.length && !guard.tags.some((t) => tags.includes(String(t)))) return false
  }
  return true
}

/**
 * trigger 命中判定（确定性，无打分）——**准入化后的语义**。
 *
 * `when` 是唯一的触发面，三个成员按 OR：`ops`（动作）／`writes`（本次要写的文件）／
 * `intents`（人类消息里剥离引用后的意图词）。`guard` 只能收窄。
 * **没有 `when` 的条目不再触发任何东西**（降级为可发现 + 按需拉取）。
 *
 * @param {object|null} trigger
 * @param {object} ctx - {@link buildReadinessContext} 的结果
 * @returns {string|null} 命中原因（`op:…` / `write:…` / `intent:…`），未命中为 null
 */
export function matchTrigger(trigger, ctx) {
  if (!trigger || typeof trigger !== 'object') return null
  const when = trigger.when
  if (!when || typeof when !== 'object') return null
  if (!guardPass(trigger.guard, ctx)) return null
  for (const op of when.ops || []) {
    if (op && (ctx?.ops || []).includes(String(op))) return `op:${op}`
  }
  // 写目标 = 已观察到的结构化写调用 ∪ 人类消息里提到的路径（动手前的写意图）。
  // DSH 没有工具执行前拦截钩子，动手前唯一能拿到的写意图就是人类消息里的路径；
  // 但动作文本里的**读**路径不算（`read README.md` 不是"即将写 README.md"）。
  const writeTargets = [...(ctx?.targets || []), ...(ctx?.humanPaths || [])]
  for (const w of when.writes || []) {
    // 扩展名/泛名 glob 在这里被硬性忽略：`*.pptx` 这类条件只能撒谎，不能收窄。
    if (!w || isDroppableGlob(w)) continue
    if (matchAnyPath(w, writeTargets)) return `write:${w}`
  }
  const intent = ctx?.intent ?? ctx?.humanText ?? ''
  for (const it of when.intents || []) {
    if (it && matchIntent(it, intent)) return `intent:${it}`
  }
  return null
}

/**
 * 旧 trigger → 新 schema（纯函数、幂等、不改原对象）。
 *
 * 迁移规则（都在实测里有据）：
 *   - `actions` → `when.ops`（经 {@link opForLegacyAction} 映射；死值记录进 `triggerNormalized.dropped`）
 *   - 具体的 `paths` → `when.writes`（"我要改这个文件"）；扩展名/泛名 glob 直接丢弃
 *   - `keywords` → `when.intents`，只留通过 {@link isIntentWord} 的
 *   - `scope` → 默认忽略（它的值不在项目画像 tag 空间里，实测把最相关的一条 procedure 判了死刑）
 *
 * @param {object} it
 * @param {{legacyScope?: 'ignore'|'filter'}} [opts]
 */
export function normalizeTrigger(it, opts = {}) {
  const t = it && it.trigger
  if (!t || typeof t !== 'object') return it
  if (t.when && typeof t.when === 'object') return it // 已是新 schema：幂等
  const dropped = []
  const writes = []
  for (const p of t.paths || []) {
    if (!p) continue
    if (isDroppableGlob(p)) dropped.push(`path:${p}`)
    else writes.push(String(p))
  }
  const ops = new Set()
  for (const a of t.actions || []) {
    const op = opForLegacyAction(a)
    if (!op) {
      dropped.push(`action:${a}`)
      continue
    }
    // 有精确 writes 时丢掉弱 op：留着它只会把"改这个文件时"扩大成"任何一次提交时"。
    if (writes.length && WEAK_OPS.has(op)) {
      dropped.push(`weak-action:${a}`)
      continue
    }
    ops.add(op)
  }
  // 具体路径只写进 `when.writes`，**不要**再补一个 `file-write` 到 ops：
  // when 的成员是取或的，补进去等于让"写了任何文件"就命中，把路径条件短路掉
  // （实测：那样会让 D 场景一次多出 6 条假阳性）。
  const intents = []
  for (const k of t.keywords || []) if (isIntentWord(k)) intents.push(String(k))
  // 旧 `symbols` 也走文本平面：不归一就等于静默丢掉一个作者写下的触发面
  // （README 承诺 keywords/symbols/actions/paths/scope 都会迁移）。与 keywords 同一把准入尺子。
  for (const s of t.symbols || []) if (isIntentWord(s)) intents.push(String(s))
  const when = {}
  if (ops.size) when.ops = [...ops].sort()
  if (writes.length) when.writes = [...new Set(writes)]
  if (intents.length) when.intents = [...new Set(intents)]
  const out = { ...t, when }
  const scopeIgnored = Array.isArray(t.scope) && t.scope.length > 0
  if (scopeIgnored && opts.legacyScope !== 'ignore') out.guard = { ...(t.guard || {}), tags: t.scope }
  return { ...it, trigger: out, triggerNormalized: { dropped, scopeIgnored } }
}

/**
 * trigger 自检（S5）：把"哪些条目其实推不动、哪些声明是死的"变成可数的事实。
 * @param {object[]} items
 */
export function auditTriggers(items, opts = {}) {
  const out = {
    total: 0,
    pushable: 0,
    pullOnly: [],
    deadActions: [],
    droppedGlobs: [],
    weakDropped: [],
    fallbackOps: [],
    scopeIgnored: [],
    missingPrevents: [],
  }
  for (const raw of items || []) {
    if (!raw || !raw.id) continue
    out.total++
    const it = normalizeTrigger(raw, opts)
    const meta = it.triggerNormalized || {}
    for (const d of meta.dropped || []) {
      if (d.startsWith('action:')) out.deadActions.push({ id: it.id, value: d.slice(7) })
      else if (d.startsWith('path:')) out.droppedGlobs.push({ id: it.id, value: d.slice(5) })
      else if (d.startsWith('weak-action:')) out.weakDropped.push({ id: it.id, value: d.slice(12) })
    }
    if (meta.scopeIgnored) out.scopeIgnored.push(it.id)
    const when = it.trigger?.when
    for (const w of when?.writes || []) {
      if (isDroppableGlob(w)) out.droppedGlobs.push({ id: it.id, value: w })
    }
    const hasWhen = Boolean(when && ((when.ops || []).length || (when.writes || []).length || (when.intents || []).length))
    if (hasWhen) {
      out.pushable++
      // 兜底 op 出现在 when.ops 里：不是错误，但这条触发面比它看起来宽得多。
      const fb = (when.ops || []).filter((o) => FALLBACK_OPS.has(o))
      if (fb.length) out.fallbackOps.push({ id: it.id, ops: fb })
    } else {
      out.pullOnly.push(it.id)
    }
    if (!it.trigger?.prevents) out.missingPrevents.push(it.id)
  }
  return out
}

/**
 * IDF 加权覆盖率（S4 的**绝对**门槛）：条目覆盖了查询里多少**信息量**，而不是多少个 token。
 *
 * 为什么需要它：`relativeHits` 只看"层内最高分的比例"，而最高分本身可能就是噪声——
 * 实测 `relative:1.00` 出现在和查询毫无关系的条目上。归一在 [0,1]、有真零点，才能设下限。
 *
 * 返回四个量，调用方要一起看：
 *   - `coverage`：在**语料能表示**的词里，条目覆盖了多少信息量（分母不含 df=0 的词——
 *     自然语言查询总有语料没有的词，把它们算成未命中会让任何正常查询都趋零）。
 *   - `matched`：命中的词数。单个通用词（"插件"）也能拿到 coverage=1.00。
 *   - `supported` / `terms`：语料里有对应词的比例。长句子里只有一两个词能在语料中找到对应时，
 *     "覆盖率 1.00"是假象（实测：一句 19 个词的改时间戳请求，只与 WSL 笔记共享一个"文件"，
 *     却拿到 cov=1.00），调用方据此让**整条通道沉默**。
 * @returns {{coverage: number, matched: number, supported: number, terms: number}}
 */
export function idfCoverage(query, itemText, corpusTexts) {
  const q = [...new Set(tokenize(query))]
  if (!q.length) return { coverage: 0, matched: 0, supported: 0, terms: 0 }
  const item = new Set(tokenize(itemText))
  const corpus = (corpusTexts || []).map((t) => new Set(tokenize(t)))
  const n = Math.max(corpus.length, 1)
  let total = 0
  let hit = 0
  let matched = 0
  let supported = 0
  for (const term of q) {
    let df = 0
    for (const doc of corpus) if (doc.has(term)) df++
    // df=0 的词不计入分母：它对"选哪一条"没有分辨力。但 supported 会记下有多少词是
    // 语料根本无法表示的——那是"这条查询整体上离语料太远"的证据，交给调用方决定沉默。
    if (df === 0) continue
    supported++
    const w = Math.log(1 + n / (1 + df))
    total += w
    if (item.has(term)) {
      hit += w
      matched++
    }
  }
  return { coverage: total > 0 ? hit / total : 0, matched, supported, terms: q.length }
}

/**
 * 层内相对阈值：命中分至少达到该层最高分的 `ratioMin`。尺度无关（BM25 分数无上界），
 * 取代"整条消息 vs 整条 insight 的集合重叠 ÷ 较大集合"这种长度敏感判据。
 * @param {{ id?: string, score: number }[]} scored - 已按分数降序的候选。
 * @param {{ ratioMin?: number }} [opts] - 相对阈值，默认 0.5。
 * @returns {object[]} 通过阈值的候选（零分恒被剔除）。
 */
export function relativeHits(scored, { ratioMin = 0.5 } = {}) {
  const list = (scored || []).filter((r) => r && Number.isFinite(r.score) && r.score > 0)
  if (!list.length) return []
  const top = list[0].score
  // 显式的 0 表示"关掉相对门槛"（只剩 score>0）；未给/非法值才回退 0.5。
  // 旧写法 `ratioMin > 0 ? ratioMin : 0.5` 把 0 当成"没配"，配置上无法关闭。
  const ratio = typeof ratioMin === 'number' && Number.isFinite(ratioMin) ? ratioMin : 0.5
  const floor = top * Math.max(0, Math.min(1, ratio))
  return list.filter((r) => r.score >= floor)
}
