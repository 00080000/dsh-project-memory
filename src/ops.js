// 动作平面：把"这一步在做什么"从工具调用解析成有限的 op + 写目标 + 主机环境。
//
// 为什么不能继续用文本匹配：语料（路径、命令、被读文件正文）里的字符串可以冒充动作。
// 实测病征是 `keyword:rm` 命中 `dcterms`、`keyword:pptx` 命中一个文件扩展名。
// op 与 target 是低维、可枚举、可审计的：不随文本长度变化，也不会被正文污染。
//
// 分工：ops.js 只负责"把调用读成什么动作"，不负责决定注入什么（那是 readiness/auto-inject）。
// 刻意不 import readiness：readiness 要 import 本模块的 op 闭集，反向依赖会造成循环。
// 路径 token 的规则因此收在 util/path-token.js —— 它谁也不依赖，两个模块都能 import
// （原先这里就地抄了一份，注释还写着"与 readiness.extractPaths 同规则"，实际已漂移）。

import { extractPathTokens } from './util/path-token.js'

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

/**
 * 会写盘的文件类命令头。**只作用于命令头**，不再对整条命令做无锚点正则。
 *
 * 为什么改：旧实现对整条命令跑 `/\b(bench|migrate|rm|删除)\b/`，于是
 *   `find src client test scripts bench docs -type f` 里的目录名 `bench` → `run-bench`（实测注入
 *   了 4 条基准 procedure、1777 字符）；`grep -rn "migrate" docs` → `migrate`；子代理提示词里的
 *   "删除/迁移" → `file-delete`/`migrate`（实测父会话连吃 8 步）。
 * 命令头是"这个 shell 到底在做什么"的唯一可靠位置；参数、路径、引号里的词都是**提及**。
 */
const WRITE_HEADS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'mv', 'cp', 'touch', 'tee', 'truncate', 'mkdir'])
/** 包在真命令前面的词：跳过它们再取命令头。 */
const WRAPPERS = new Set(['sudo', 'env', 'command', 'builtin', 'exec', 'time', 'nohup', 'nice', 'stdbuf'])
/** 递归解析 `bash -c "…"` 的壳；深度上限防 `bash -c 'bash -c …'`。 */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
/** 分段：按未加引号的 `\n ; && || | &` 切。引号里的分隔符是正文，不是命令边界。 */
function unquotedSegments(text) {
  const out = []
  let cur = ''
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"' && i + 1 < text.length) { cur += text[++i]; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue }
    // `#` 只有在词首才是注释：URL 的 fragment、`#!` 之类不能当注释切掉。
    if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      while (i < text.length && text[i] !== '\n') i++
      out.push(cur)
      cur = ''
      continue
    }
    if (c === '\n' || c === ';') { out.push(cur); cur = ''; continue }
    if ((c === '&' || c === '|') && text[i + 1] === c) { out.push(cur); cur = ''; i++; continue }
    if (c === '|' || c === '&') { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/**
 * 剥掉 heredoc 正文，只留下 opener 那一行。
 * 正文是脚本内容（可能是 python/js），不是 shell 命令——旧实现会把里面的 `mkdir`/`rm` 当动作。
 */
function stripHeredocBodies(text) {
  return text.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n\2(?=\s*(?:$|\n))/g, (m) => `${m.split('\n')[0]}\n`)
}

/** 简单词法切分（去引号、保转义）。只用于取命令头与参数，不追求完整 shell 语义。 */
function tokenizeWords(segment) {
  const out = []
  let cur = ''
  let quote = null
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]
    if (quote) {
      if (c === quote) { quote = null; continue }
      if (c === '\\' && quote === '"' && i + 1 < segment.length) { cur += segment[++i]; continue }
      cur += c
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (/\s/.test(c)) { if (cur) { out.push(cur); cur = '' } continue }
    if (c === '\\' && i + 1 < segment.length) { cur += segment[++i]; continue }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

/** 跳过环境变量赋值与 sudo/env/time 之类包装，返回真正的命令头与参数。 */
function commandHead(tokens) {
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || WRAPPERS.has(t) || t === '(') { i++; continue }
    break
  }
  const raw = tokens[i] || ''
  const head = raw.split('/').pop().toLowerCase()
  let rest = tokens.slice(i + 1)
  if (rest.length && rest[rest.length - 1] === ')') rest = rest.slice(0, -1)
  return { head, rest }
}

const BENCH_ARG = /(^|\/)bench(mark)?(\/|\.(mjs|js|ts|cjs|mts|json)$)/i
const RENDER_ARG = /(^|\/)(pptxgenjs|soffice|libreoffice|pandoc|marp|slidev)(\b|\/)/i
/** npm script 名（`bench` / `bench:peak` / `benchmark`）：`npm run bench` 是文档里的跑法。 */
const BENCH_SCRIPT = /^(bench|benchmark)(:[\w.-]+)?$/i
/** 包管理器里带值的全局 flag（`npm --prefix x …`）。 */
const PM_VALUE_FLAGS = new Set(['-C', '--prefix', '--cwd', '-w', '--workspace', '--filter', '-F', '--dir'])

/** 跳过全局 flag，返回第一个子命令及其后的参数。 */
function packageSubcommand(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) {
      if (PM_VALUE_FLAGS.has(args[i])) i++
      continue
    }
    return { sub: args[i].toLowerCase(), rest: args.slice(i + 1) }
  }
  return { sub: '', rest: [] }
}

/** 包管理器 / npx 之后的参数里识别动作。只有命令头是 runner 时才走这里。 */
function runnerOps(args) {
  const ops = []
  if (args.some((a) => RENDER_ARG.test(a))) ops.push('render-doc')
  if (args.some((a) => BENCH_ARG.test(a) || BENCH_SCRIPT.test(a))) ops.push('run-bench')
  if (args[0] === 'migrate' || args.some((a) => /^db:migrate$/.test(a))) ops.push('migrate')
  return ops
}

/** 命令头 → op。空数组表示"认得这个头，但它不是这些动作"。 */
function opsOfHead(head, rest) {
  const sub = String(rest[0] || '').toLowerCase()
  switch (head) {
    case 'npm': case 'pnpm': case 'yarn': case 'bun': {
      const { sub: name, rest: after } = packageSubcommand(rest)
      if (name === 'publish' || name === 'pack') return ['npm-publish']
      if (name === 'version') return ['release']
      if (name === 'run' || name === 'exec' || name === 'dlx' || name === 'x') return runnerOps(after)
      // `yarn bench` / `bun bench` 这类"直接按脚本名跑"的形态
      if (name && BENCH_SCRIPT.test(name)) return ['run-bench']
      return []
    }
    case 'npx': case 'pnpx': case 'bunx':
      return runnerOps(rest)
    case 'node': case 'tsx': case 'deno':
      return rest.some((a) => BENCH_ARG.test(a)) ? ['run-bench'] : []
    case 'git': {
      const gsub = firstSubcommand(rest)
      if (gsub === 'commit' || gsub === 'add') return ['git-commit']
      if (gsub === 'push') return ['git-push']
      if (gsub === 'tag') return ['release']
      if (gsub === 'rm') return ['file-delete']
      if (gsub === 'checkout' || gsub === 'restore' || gsub === 'reset') return ['file-write']
      return []
    }
    case 'rm': case 'rmdir': case 'unlink': case 'shred':
      return ['file-delete']
    case 'kubectl': case 'systemctl': case 'pm2': case 'vercel': case 'netlify':
      return ['deploy']
    case 'docker':
      return sub === 'push' || sub === 'compose' || sub === 'stack' ? ['deploy'] : []
    case 'migrate': case 'alembic':
      return ['migrate']
    case 'prisma':
      return sub === 'migrate' || sub === 'db' ? ['migrate'] : []
    case 'soffice': case 'libreoffice': case 'pandoc': case 'marp': case 'slidev':
      return ['render-doc']
    case 'bench': case 'benchmark':
      return ['run-bench']
    case 'curl': case 'wget':
      return ['fetch-web']
    default:
      return []
  }
}

/** 未加引号的 `>` / `>>` 目标。引号里的 `>` 是正文（`echo "a > b"`），`<<` 不是写。 */
function redirectTargets(segment) {
  const out = []
  let quote = null
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '\\') { i++; continue }
    if (c !== '>') continue
    if (segment[i + 1] === '>') i++
    let j = i + 1
    while (j < segment.length && /\s/.test(segment[j])) j++
    let tok = ''
    while (j < segment.length && !/[\s;|&)]/.test(segment[j])) { tok += segment[j]; j++ }
    i = Math.max(i, j - 1)
    if (!tok) continue
    if (tok.startsWith('&') || tok === '/dev/null' || tok.startsWith('/dev/stdout') || tok.startsWith('/dev/stderr')) continue
    if (/^\d+$/.test(tok)) continue
    out.push(tok)
  }
  return out
}

/** 这个段落在写盘吗？写盘命令头、`sed -i`、重定向都算。 */
function isWriteSegment(head, rest, redirects) {
  if (redirects.length) return true
  if (WRITE_HEADS.has(head)) return true
  if (head === 'sed' && rest.includes('-i')) return true
  if (head === 'git' && String(rest[0] || '').toLowerCase() === 'rm') return true
  return false
}

/**
 * git 的子命令要跳过全局 flag（`git -C repo commit` 不能被读成 `-C`）。
 * @param {string[]} args
 * @returns {string} 小写子命令；没有则空串
 */
function firstSubcommand(args) {
  const takesValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('-')) {
      if (takesValue.has(arg)) i++
      continue
    }
    return arg.toLowerCase()
  }
  return ''
}

/** 合并去重（保持顺序）。 */
function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value)
}

/** WSL 路径或 Windows 壳的签名：只用于 hosts，不参与动作判定。 */
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

/** 内部的递归实现：`bash -c` 会再解析一层。 */
function classifyCommand(command, depth) {
  const raw = String(command || '')
  const ops = []
  const targets = []
  for (const segment of unquotedSegments(stripHeredocBodies(raw))) {
    const { head, rest } = commandHead(tokenizeWords(segment))
    if (SHELLS.has(head) && depth < 2) {
      // `-lc` / `-ec` 这类合并短选项也带 `-c`。
      const ci = rest.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a))
      if (ci >= 0 && rest[ci + 1]) {
        const inner = classifyCommand(rest.slice(ci + 1).join(' '), depth + 1)
        for (const op of inner.ops) if (op !== 'shell-run') pushUnique(ops, op)
        for (const t of inner.targets) pushUnique(targets, t)
      }
    } else {
      for (const op of opsOfHead(head, rest)) pushUnique(ops, op)
    }
    const redirects = redirectTargets(segment)
    if (isWriteSegment(head, rest, redirects)) {
      for (const t of extractPathTokens(segment)) pushUnique(targets, t)
    }
  }
  if (!ops.length) ops.push('shell-run')
  const hosts = WSL_HINT_RE.test(raw) || /\b(powershell|pwsh|cmd)\.exe\b/i.test(raw) ? ['wsl'] : []
  return { ops, targets, hosts }
}

export function classifyShellCommand(command) {
  return classifyCommand(command, 0)
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
    const targets = path ? [path, ...extractPathTokens(path)] : []
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
    // 纯文本行里没有 shell 动作时不要退化成 shell-run（那是噪音源）。但**只丢这个 op**：
    // 行里的写目标/主机是具体事实（要靠路径 token、/mnt/ 这类签名才抽得出，泛泛的散文产不出来），
    // 一起丢掉会让 `bash {"command":"echo x >> .gitignore"}` 这种 shell-run-only 的写意图
    // 到不了 when.writes —— 实测它连结构化工具调用行的写目标都会被静默吞掉。
    const noiseOp = r.ops.length === 1 && r.ops[0] === 'shell-run' && !/\b\w+\s+-/.test(line)
    if (!noiseOp) for (const op of r.ops) ops.add(op)
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
