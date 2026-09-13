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
  const paths = new Set([...(input.paths || []), ...extractPaths(actionText), ...extractPaths(humanText)])
  return { humanText, actionText, actions: [...actions], paths: [...paths] }
}

/** glob（只支持 `*`）→ 正则。 */
function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

/**
 * trigger 命中判定（确定性，无打分）。
 * @param {object|null} trigger - `{ keywords?, symbols?, actions?, paths?, scope? }`。
 * @param {object} ctx - {@link buildReadinessContext} 的结果。
 * @returns {string|null} 命中原因（`keyword:…` / `symbol:…` / `action:…` / `path:…`），未命中为 null。
 */
export function matchTrigger(trigger, ctx) {
  if (!trigger) return null
  const haystack = `${ctx?.humanText || ''}\n${ctx?.actionText || ''}`
  const lower = haystack.toLowerCase()
  for (const kw of trigger.keywords || []) {
    const k = String(kw || '')
    if (k && lower.includes(k.toLowerCase())) return `keyword:${k}`
  }
  for (const sym of trigger.symbols || []) {
    const s = String(sym || '')
    if (s && haystack.includes(s)) return `symbol:${s}`
  }
  const actions = new Set(ctx?.actions || [])
  for (const a of trigger.actions || []) {
    const id = String(a || '')
    if (id && actions.has(id)) return `action:${id}`
  }
  for (const p of trigger.paths || []) {
    const pattern = String(p || '')
    if (!pattern) continue
    const re = globToRegExp(pattern)
    const hit = (ctx?.paths || []).some((cand) => {
      const c = String(cand || '')
      if (!c) return false
      return re.test(c) || re.test(c.split(/[\\/]/).pop() || '')
    })
    if (hit) return `path:${pattern}`
  }
  return null
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
  const floor = top * (typeof ratioMin === 'number' && ratioMin > 0 ? ratioMin : 0.5)
  return list.filter((r) => r.score >= floor)
}
