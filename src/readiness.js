/**
 * 就绪引擎（push 侧）：recall 回答"记忆里有什么相关"，readiness 回答"动手之前必须知道什么"。
 * 交付契约：authored trigger = 确定性全文注入（优先级 1，可审计 `why`）；统计信号 = 截断提示
 * （优先级 2，层内相对阈值）。两个窗口靠 agent/pre-step（DSH 没有工具执行前钩子）：人类意图词先发，
 * 已观察到的 tool/call 走同一匹配器。纯函数、零依赖、不调用模型。
 * @module dsh-project-memory/readiness
 */

import { FALLBACK_OPS, WEAK_OPS, activityFromText, opForLegacyAction } from './ops.js'
import { extractPathTokens } from './util/path-token.js'
import { CJK_RANGE, tokenize } from './util/search.js'
import { CYRILLIC_RANGE, CYRILLIC_WORD_RE, RU_STOPWORDS, normalizeRuWord, stemRu } from './util/ru.js'

/**
 * 动作词典：动作 id → 匹配模式。命令形态与人类意图词都归一成同一套 id，
 * 于是"你顺便提交一下"与 `git commit -m x` 对 trigger 是同一件事。
 */
export const ACTION_LEXICON = [
  ['git-add', [/git\s+add\b/i]],
  ['git-commit', [/git\s+commit\b/i, /提交/]],
  ['git-push', [/git\s+push\b/i, /推送/]],
  ['npm-publish', [/npm\s+publish\b/i, /发包/, /发布\s*到\s*npm/i]],
  // 英文 `release` 只在带版本号时才算动作：`release notes` 是文档任务，不是发版。
  ['release', [/git\s+tag\b/i, /发版/, /发布版本/, /\brelease\s+v?\d/i]],
  ['go-public', [/公开/, /开源/, /对外/, /上线/]],
  ['delete', [/rm\s+-rf\b/, /git\s+rm\b/, /删除/, /清理/]],
  ['migrate', [/migrate\b/i, /迁移/]],
  ['deploy', [/\bdeploy\b/i, /部署/]],
]

/**
 * 允许**人类消息里的动作词**触发全文注入的 op 白名单。
 * 判据是"这条记忆必须在动作**之前**到达，晚了就没用，且动作不可逆"：提交 / 发 npm 包 / 发版 /
 * 推远端 / 部署 / 公开仓库。
 * 反过来，`删除 / 清理 / 渲染 / 基准 / 取网页 / 查询记忆` 在人类消息里经常只是**提及**，用它们做
 * 全文注入实测代价是 1200 字符一条的无关 procedure；这些动作仍可由**已观察到的工具调用**触发。
 */
export const PRE_ACTION_OPS = new Set(['npm-publish', 'release', 'git-commit', 'git-push', 'deploy', 'go-public'])

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
 * 文本 → 路径 token（用于 trigger 的 `writes` / `guard.paths` 匹配）。
 * 规则收在 `util/path-token.js`，与 ops 抽写目标是**同一份实现**。
 * @param {string} text - 工具调用参数或人类消息。
 * @returns {string[]} 去重后的路径 token。
 */
export function extractPaths(text) {
  return extractPathTokens(text)
}

/**
 * 组装就绪上下文：人类意图 + 已观察动作。三处来源都做动作/路径归一，调用方只需给文本。
 * **证据来源决定准入**：observed（结构化工具调用）可以触发全文注入；人类消息里的动作词只允许
 * 4 个"不可逆外部动作"触发全文（见 {@link PRE_ACTION_OPS}），其余只进提示通道。
 * @param {object} input `humanText` 本轮人类消息；`actionText` 旧调用方的工具调用文本（测试/老宿主，
 *   生产路径不再传）；`ops`/`targets` 结构化工具调用归一出的动作与写目标（可信）；
 *   `actions`/`paths` 调用方已归一化的动作 id 与路径（可选，会被并集）。
 * @returns {{ humanText: string, actionText: string, actions: string[], paths: string[], humanPaths: string[], ops: string[], opsObserved: string[], intentOps: string[], targets: string[], hosts: string[], intent: string, tags: string[] }}
 */
export function buildReadinessContext(input = {}) {
  const humanText = String(input.humanText ?? input.query ?? '')
  const actionText = String(input.actionText || '')
  // `input.actions` 是调用方**已归一化**的动作（测试/老宿主），当作已观察证据；
  // 只有从 humanText 里现猜出来的词才受 PRE_ACTION_OPS 约束。
  const declaredActions = new Set(input.actions || [])
  const proseActions = detectActions(humanText)
  const actions = new Set([...declaredActions, ...proseActions])
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
  const opsObserved = new Set([...(input.ops || []), ...fromText.ops])
  for (const a of declaredActions) {
    const op = opForLegacyAction(a)
    if (op) opsObserved.add(op)
  }
  // 人类消息里的动作词：`删除/清理/渲染/基准/取网页` 在散文里太容易是**提及**
  // （实测 "删除后的悬空状态"、"清理一下 README 的措辞" 都命中过 file-delete，
  // 后者注入了一条 1200 字符的恢复 procedure）。只有没法等的不可逆外部动作才允许先发。
  const intentOps = new Set()
  for (const a of proseActions) {
    const op = opForLegacyAction(a)
    if (op) intentOps.add(op)
  }
  const ops = new Set([...opsObserved, ...[...intentOps].filter((op) => PRE_ACTION_OPS.has(op))])
  const targets = new Set([...(input.targets || []), ...fromText.targets])
  const hosts = new Set([...(input.hosts || []), ...fromText.hosts])
  return {
    humanText,
    actionText,
    actions: [...actions],
    paths: [...paths],
    humanPaths: [...humanPaths],
    ops: [...ops],
    opsObserved: [...opsObserved],
    intentOps: [...intentOps],
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
 * 结果只写进 `triggerDerived`，供提示通道使用；是否强制注入只由 authored `trigger` 决定。
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
 * `PR` / `CI` / `OS` / `WSL` / `npm` 这类缩写太短、歧义太大，一个巧合命中就能当上该层最高分
 * （实测：人类消息里的 "PR" 把一条越权 lesson 顶到提示位，"wsl" 把 pnpm lesson 顶进改时间戳的任务）。
 * 内容词不受影响；authored trigger 通道完全不走这里。
 * @param {string} text - 人类消息或工具参数。
 * @returns {string} 过滤后的查询文本。
 */
export function hintQueryText(text) {
  return String(text || '')
    .split(/\s+/)
    // 路径形态的 token 原样保留（src/util/fs.js 里的 fs / js 是有效证据），只对独立词做缩写剔除。
    .map((w) => (/[/.]/.test(w) ? w : w.replace(/\b[A-Za-z0-9_]{1,3}\b/g, ' ')))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** glob（只支持 `*`）→ 正则。`?` 不是通配符，必须按字面量转义，否则 `^?` 是非法正则。 */
function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '\\?').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

/**
 * 剥离**引用内容**：代码块、行内代码、引号内的路径/文件名、裸路径。
 * 人类消息里的文件名是**数据**，不是意图：实测"示例调研.pptx"这个文件名让一条调研经验在改文件
 * 时间戳的任务里被注入。
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
    // 带扩展名的**非 ASCII 文件名**（`示例调研.pptx`）也要剥：ASCII 裸名（notes.md）保持原语义不动。
    // 按 token 逐个找 `.ext`，只切"token 开头 → 扩展名结尾"；`\S*` 两段匹配在长中文串上指数回溯（4000 字 12s）。
    .replace(/\S+/g, (tok) => {
      const re = /\.[A-Za-z][A-Za-z0-9]{0,7}\b/g
      for (let m = re.exec(tok); m; m = re.exec(tok)) {
        if (/[^\x00-\x7F]/.test(tok.slice(0, m.index))) return tok.slice(m.index + m[0].length)
      }
      return tok
    })
    // 仓库里的裸文件名（README / CHANGELOG …）也是语料，不是意图
    .replace(/\b(?:README|CHANGELOG|LICENSE|AGENTS|CONTRIBUTING|Dockerfile|Makefile)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 意图词是否值得作为触发信号（准入过滤）：`rm` 命中 `dcterms`、`ppt` 命中 `pptx` 这类短拉丁词
 * 是假阳性制造机；含 `_`/`.`/`/` 的是标识符或路径，属于语料平面，不是意图。
 */
export function isIntentWord(word) {
  const s = String(word || '').trim()
  if (!s) return false
  if (CJK_RANGE.test(s)) return s.length >= 2
  // 俄语：作者写**原形**，匹配时按 Snowball 词干比对（见 matchIntent）；只要 ≥3 字符、不是虚词、
  // 不含路径/标识符字符即可。三字母俄语词几乎都是实词，没有拉丁那种缩写歧义。
  if (CYRILLIC_RANGE.test(s)) {
    const w = normalizeRuWord(s)
    return w.length >= 3 && !RU_STOPWORDS.has(w) && !/[_./\\*]/.test(w) && !/\s/.test(w)
  }
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
 * 意图词命中：CJK 用包含，拉丁用词边界（避免 `ppt` 命中 `pptx`），俄语先做 ё/е 归一 + 词边界
 * 精确匹配，未命中再按 Snowball 词干比对词形。为什么俄语要词干：作者写原形（`миграция`），
 * 人类消息里几乎总是变格（`миграции`），只做字面匹配会让俄语触发面基本失效；词干与检索侧同一
 * 把尺子，`город` 不会命中 `городской`。
 * @param {string} word
 * @param {string} text - 已经是 {@link intentText} 处理过的意图文本
 */
export function matchIntent(word, text) {
  const raw = String(word || '').trim()
  const hay = String(text || '')
  if (!raw || !hay) return false
  if (CJK_RANGE.test(raw)) return raw.length >= 2 && hay.includes(raw)
  if (CYRILLIC_RANGE.test(raw)) {
    // 两侧都归一：作者写 `ёлка`、消息里打 `елка`（或反过来）必须命中。
    const w = normalizeRuWord(raw)
    if (w.length < 3) return false
    const normalizedHay = normalizeRuWord(hay)
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Unicode 词边界：`[^A-Za-z0-9_]` 会把俄文词内部的命中当成边界（`город`/`городской`）；归一后已全小写。
    if (new RegExp(`(^|[^\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])`, 'u').test(normalizedHay)) return true
    const stem = stemRu(w)
    if (stem.length < 2) return false
    for (const candidate of normalizedHay.match(CYRILLIC_WORD_RE) || []) {
      if (candidate.length < 3) continue
      if (stemRu(candidate) === stem) return true
    }
    return false
  }
  const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (raw.length < 4) return false
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
function guardPass(guard, ctx, writeTargets) {
  if (!guard || typeof guard !== 'object') return true
  // 路径面与 `when.writes` 用同一份事实：已观察到的写调用 ∪ 人类消息里的写意图。
  const targets = writeTargets || ctx?.targets || []
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
 * `when` 是唯一触发面，三个成员按 OR：`ops` / `writes` / `intents`（人类消息剥离引用后的意图词）；
 * `guard` 只能收窄。**没有 `when` 的条目不再触发任何东西**（降级为可发现 + 按需拉取）。
 * @param {object|null} trigger
 * @param {object} ctx - {@link buildReadinessContext} 的结果
 * @returns {string|null} 命中原因（`op:…` / `write:…` / `intent:…`），未命中为 null
 */
export function matchTrigger(trigger, ctx) {
  if (!trigger || typeof trigger !== 'object') return null
  const when = trigger.when
  if (!when || typeof when !== 'object') return null
  // 写目标 = 已观察到的结构化写调用 ∪ 人类消息里提到的路径（动手前的写意图）。动作文本里的**读**
  // 路径不算（`read README.md` 不是"即将写 README.md"）；guard 用同一份合集，否则窗口里永不放行。
  const writeTargets = [...(ctx?.targets || []), ...(ctx?.humanPaths || [])]
  if (!guardPass(trigger.guard, ctx, writeTargets)) return null
  for (const op of when.ops || []) {
    if (op && (ctx?.ops || []).includes(String(op))) return `op:${op}`
  }
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
 * 迁移：`actions` → `when.ops`（经 {@link opForLegacyAction}，死值记进 `triggerNormalized.dropped`）；
 * 具体 `paths` → `when.writes`（扩展名/泛名 glob 丢弃）；`keywords` → `when.intents`（只留通过
 * {@link isIntentWord} 的）；`scope` → 默认忽略（它的值不在项目画像 tag 空间里）。
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
  // 具体路径只写进 `when.writes`，**不要**再补 `file-write` 到 ops：when 成员取或，补进去等于让
  // "写了任何文件"就命中，把路径条件短路掉（实测那样一次多出 6 条假阳性）。
  const intents = []
  for (const k of t.keywords || []) if (isIntentWord(k)) intents.push(String(k))
  // 旧 `symbols` 也走文本平面，与 keywords 同一把准入尺子（不归一等于静默丢掉作者写下的触发面）。
  for (const s of t.symbols || []) if (isIntentWord(s)) intents.push(String(s))
  const when = {}
  if (ops.size) when.ops = [...ops].sort()
  if (writes.length) when.writes = [...new Set(writes)]
  if (intents.length) when.intents = [...new Set(intents)]
  const out = { ...t, when }
  const scopeIgnored = Array.isArray(t.scope) && t.scope.length > 0
  // legacy `scope` → guard.tags **只在显式要求 filter 时**才做：作者手写的值几乎落不进自动派生的
  // 画像 tag 空间，当收窄条件用等于判死条目。默认 ignore——与 `src/index.js` 的 schema 默认一致。
  if (scopeIgnored && opts.legacyScope === 'filter') out.guard = { ...(t.guard || {}), tags: t.scope }
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
 * IDF 加权覆盖率（**绝对**门槛）：条目覆盖了查询里多少**信息量**，而不是多少个 token。
 * 为什么需要它：`relativeHits` 只看层内最高分的比例，而最高分本身可能就是噪声（实测
 * `relative:1.00` 出现在和查询毫无关系的条目上）；归一在 [0,1]、有真零点才能设下限。
 * 返回四个量要一起看：`coverage` 在语料能表示的词里覆盖的信息量（df=0 的词不进分母）；
 * `matched` 命中词数（单个通用词也能拿 coverage=1.00）；`supported`/`terms` 语料有对应词的比例，
 * 长句只有一两个词命中时 cov=1.00 是假象，调用方据此让**整条通道沉默**。
 * @returns {{coverage: number, matched: number, supported: number, terms: number}}
 */
export function idfCoverage(query, itemText, corpusTexts) {
  return idfCoveragePrepared(query, itemText, corpusTermSets(corpusTexts))
}

/**
 * 语料 → 词集合数组。**对一批候选循环评分时必须只建一次**。
 * `idfCoverage` 每次都会重建整个语料；对 C 个候选各调一次就是 C×C 次 tokenize——实测真实 store
 * 单步 147 ms，提出循环外降到 1.3 ms（109×），coverage 结果逐字段一致。
 * @param {string[]} texts - 语料正文
 * @returns {Set<string>[]} 与输入同序的词集合
 */
export function corpusTermSets(texts) {
  return (texts || []).map((t) => new Set(tokenize(t)))
}

/**
 * 与 {@link idfCoverage} 同一套判据，但语料词集合由调用方预先建好（见 {@link corpusTermSets}）。
 * @param {string} query - 查询文本
 * @param {string} itemText - 被测条目的评分文本
 * @param {Set<string>[]} corpusSets - {@link corpusTermSets} 的产物
 * @returns {{coverage: number, matched: number, supported: number, terms: number}}
 */
export function idfCoveragePrepared(query, itemText, corpusSets) {
  const q = [...new Set(tokenize(query))]
  if (!q.length) return { coverage: 0, matched: 0, supported: 0, terms: 0 }
  const item = new Set(tokenize(itemText))
  const corpus = corpusSets || []
  const n = Math.max(corpus.length, 1)
  let total = 0
  let hit = 0
  let matched = 0
  let supported = 0
  for (const term of q) {
    let df = 0
    for (const doc of corpus) if (doc.has(term)) df++
    // df=0 的词不计入分母（对"选哪一条"没有分辨力）；但 supported 记下多少词是语料无法表示的，
    // 那是"这条查询整体离语料太远"的证据，交给调用方决定沉默。
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

  const ratio = typeof ratioMin === 'number' && Number.isFinite(ratioMin) ? ratioMin : 0.5
  const floor = top * Math.max(0, Math.min(1, ratio))
  return list.filter((r) => r.score >= floor)
}
