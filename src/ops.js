// 动作平面（PLAN S1）：把"这一步在做什么"从工具调用解析成有限的 op + 写目标 + 主机环境。
//
// 为什么不能继续用文本匹配：语料（路径、命令、被读文件正文）里的字符串可以冒充动作。
// 实测病征是 `keyword:rm` 命中 `dcterms`、`keyword:pptx` 命中一个文件扩展名。
// op 与 target 是低维、可枚举、可审计的：不随文本长度变化，也不会被正文污染。
//
// 分工：ops.js 只负责"把调用读成什么动作"，不负责决定注入什么（那是 readiness/auto-inject）。
// 刻意不 import readiness：readiness 要 import 本模块的 op 闭集，反向依赖会造成循环。

/** 带扩展名的路径 token（与 readiness.extractPaths 同规则；这里就地实现以免循环依赖）。 */
const PATH_TOKEN = /(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+\.[A-Za-z][A-Za-z0-9]{0,7}\b/g

function extractPaths(text) {
  const s = String(text || '')
  if (!s) return []
  return [...new Set([...s.matchAll(PATH_TOKEN)].map((m) => m[0]))]
}

/** op 闭集。新增一个 op 必须同时想清楚：它是动作，不是话题。 */
export const OP_IDS = [
  'file-write',
  'file-delete',
  'shell-run',
  'git-commit',
  'git-push',
  'release',
  'npm-publish',
  'deploy',
  'migrate',
  'go-public',
  'render-doc',
  'index-doc',
  'read-image',
  'fetch-web',
  'run-bench',
  'query-memory',
]

/**
 * 兜底 op：它们描述的是"发生了某类操作"，信息量低、假阳性高。
 * 允许写进 `when.ops`，但自检会 warn——兜底 op 只该命中兜底级记忆。
 */
export const FALLBACK_OPS = new Set(['shell-run', 'file-write', 'query-memory'])

/**
 * 弱 op：日常动作。它本身不构成边界（每天都在提交），所以当条目**已经有更精确的 writes**
 * 时，迁移会把弱 op 丢掉——留着它只会把"改这个文件时"扩大成"任何一次提交时"。
 * 实测：`git-commit` 让一条"别删内部文档"的教训在发版场景里被注入。
 */
export const WEAK_OPS = new Set([...FALLBACK_OPS, 'git-commit', 'git-push'])

/** 旧 action id → op。旧值里有一批从来没进过 ACTION_LEXICON 的死值，这里给它们一个归宿。 */
export const LEGACY_ACTION_ALIAS = {
  'git-add': 'git-commit',
  'npm-pack': 'npm-publish',
  'release': 'release',
  'generate-pptx': 'render-doc',
  'render': 'render-doc',
  'read-image': 'read-image',
  'web-fetch': 'fetch-web',
  'benchmark': 'run-bench',
  'cleanup': 'file-delete',
  'delete': 'file-delete',
  'recover': null, // 没有对应动作：恢复是意图，不是工具动作
  'research': null,
  'survey': null,
  'interview-prep': null,
  'write-resume': null,
  'report-metrics': null,
  'write-docs': null,
}

const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'apply_patch', 'str_replace', 'create_file', 'notebook_edit'])
const READ_IMAGE_TOOLS = new Set(['read_image'])
const INDEX_TOOLS = new Set(['index_doc', 'index_repo', 'watch_repo'])
const FETCH_TOOLS = new Set(['web_fetch', 'web_search'])
const SHELL_TOOLS = new Set(['bash', 'shell', 'pwsh', 'powershell', 'run', 'exec', 'job_run'])
const QUERY_TOOLS = new Set(['query_memory', 'recall'])

/** bash 命令 → op。顺序有意义：先具体后兜底。 */
const SHELL_OP_RULES = [
  [/\bnpm\s+(publish|pack)\b/, 'npm-publish'],
  [/\bnpm\s+version\b/, 'release'],
  [/\bgit\s+tag\b/, 'release'],
  [/\bgit\s+push\b/, 'git-push'],
  [/\bgit\s+(commit|add)\b/, 'git-commit'],
  [/\bgit\s+(checkout|restore|reset)\b/, 'file-write'],
  // `\brm\b` 而不是 `rm\s+-[rf]`：后者被 `\b` 卡在 'rm -rf' 的 r 后面（f 还是词字符），永远匹配不上。
  [/\b(rm|git\s+rm|unlink|rmdir|shred)\b/, 'file-delete'],
  [/\b(kubectl|docker\s+push|systemctl\s+restart|pm2\s+(deploy|restart)|vercel|netlify\s+deploy)\b/, 'deploy'],
  [/\b(migrate|alembic|prisma\s+migrate|db:migrate)\b/, 'migrate'],
  // 注意：只认"渲染器"，不认 .pptx 扩展名——否则给 pptx 改个时间戳也会命中"做 PPT"
  [/(pptxgenjs|soffice|libreoffice|render\.sh|marp|pandoc|slidev)/, 'render-doc'],
  [/(bench\.mjs|\bbench(mark)?\b)/, 'run-bench'],
  [/\b(curl|wget|web_fetch)\b/, 'fetch-web'],
]

/** 会改动文件系统的 shell 动作前缀：只有这些命令的路径才算"写目标"。 */
const SHELL_WRITE_RE = /\b(rm|rmdir|unlink|shred|mv|cp|touch|tee|truncate|mkdir)\b|>>?\s*\S|\bsed\s+-i\b/

const WSL_HINT_RE = /\/mnt\/[a-z]\//i

function safeJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

function argsFields(argsText) {
  const obj = safeJson(argsText)
  if (!obj) return {}
  const pick = (...keys) => keys
    .map((k) => obj[k])
    .filter((v) => typeof v === 'string' && v)
    .join(' ')
  return {
    command: pick('command', 'cmd', 'script', 'code'),
    path: pick('file_path', 'path', 'file', 'target', 'notebook_path'),
  }
}

/** bash 命令 → { ops, targets, hosts }。 */
export function classifyShellCommand(command) {
  const cmd = String(command || '')
  const ops = []
  if (cmd) {
    for (const [re, op] of SHELL_OP_RULES) {
      if (re.test(cmd) && !ops.includes(op)) ops.push(op)
    }
  }
  if (!ops.length) ops.push('shell-run')
  const targets = SHELL_WRITE_RE.test(cmd) ? extractPaths(cmd) : []
  const hosts = WSL_HINT_RE.test(cmd) || /\b(powershell|pwsh|cmd)\.exe\b/i.test(cmd) ? ['wsl'] : []
  return { ops, targets, hosts }
}

/**
 * 一次工具调用 → { ops, targets, hosts }。
 * @param {string} name 工具名
 * @param {string} argsText 工具参数（JSON 字符串或裸文本）
 */
export function classifyToolCall(name, argsText) {
  const tool = String(name || '').toLowerCase()
  const { command, path } = argsFields(argsText)
  if (SHELL_TOOLS.has(tool)) return classifyShellCommand(command || String(argsText || ''))
  if (READ_IMAGE_TOOLS.has(tool)) return { ops: ['read-image'], targets: [], hosts: [] }
  if (INDEX_TOOLS.has(tool)) return { ops: ['index-doc'], targets: [], hosts: [] }
  if (FETCH_TOOLS.has(tool)) return { ops: ['fetch-web'], targets: [], hosts: [] }
  if (QUERY_TOOLS.has(tool)) return { ops: ['query-memory'], targets: [], hosts: [] }
  if (WRITE_TOOLS.has(tool)) {
    const targets = path ? [path, ...extractPaths(path)] : []
    const hosts = targets.some((t) => WSL_HINT_RE.test(t)) ? ['wsl'] : []
    return { ops: ['file-write'], targets: [...new Set(targets)], hosts }
  }
  return { ops: [], targets: [], hosts: [] }
}

/**
 * 把一组已观察到的工具调用合成这一个线程的动态面。
 * @param {{name?: string, arguments?: string}[]} calls
 */
export function activityFromCalls(calls) {
  const ops = new Set()
  const targets = new Set()
  const hosts = new Set()
  for (const call of calls || []) {
    const r = classifyToolCall(call?.name, call?.arguments)
    for (const op of r.ops) ops.add(op)
    for (const t of r.targets) targets.add(t)
    for (const h of r.hosts) hosts.add(h)
  }
  return { ops: [...ops], targets: [...targets], hosts: [...hosts] }
}

/**
 * 没拿到结构化调用时的兜底：直接对一段文本跑 shell 规则。
 * 用于 `actionText` 形式的就绪上下文（测试与老宿主），以及人类消息里的动作词。
 */
export function activityFromText(text) {
  const s = String(text || '')
  if (!s) return { ops: [], targets: [], hosts: [] }
  const lines = s.split('\n').filter(Boolean)
  const ops = new Set()
  const targets = new Set()
  const hosts = new Set()
  for (const line of lines) {
    // 先按"工具调用"解析（`edit {"file_path":"..."}`）：结构化参数比正则猜命令可靠得多。
    const call = /^\s*([A-Za-z_][\w-]*)\s+(\{[\s\S]*\})\s*$/.exec(line)
    const r = call ? classifyToolCall(call[1], call[2]) : classifyShellCommand(line)
    // 纯文本行里没有 shell 动作时不要退化成 shell-run（那是噪音源）
    if (r.ops.length === 1 && r.ops[0] === 'shell-run' && !/\b\w+\s+-/.test(line)) continue
    for (const op of r.ops) ops.add(op)
    for (const t of r.targets) targets.add(t)
    for (const h of r.hosts) hosts.add(h)
  }
  return { ops: [...ops], targets: [...targets], hosts: [...hosts] }
}

/** 旧 action id（含死值）→ op；无法映射返回 null。 */
export function opForLegacyAction(action) {
  const a = String(action || '')
  if (!a) return null
  if (OP_IDS.includes(a)) return a
  if (a in LEGACY_ACTION_ALIAS) return LEGACY_ACTION_ALIAS[a]
  return null
}
