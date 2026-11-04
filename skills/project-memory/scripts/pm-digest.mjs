#!/usr/bin/env node
// 项目记忆的体检脚本（零依赖、不调模型、不写盘）。
//
//   node pm-digest.mjs [项目根] [--json] [--memory-dir <name>]
//
// 面向模型与人类各一半：模型拿它替代"先读三个 JSON 再数数"的多次工具往返；
// 人拿它看 store 是否异常增长、trigger 覆盖多少、任务是不是全归档了。
// 只输出计数与少量标题，不打印正文——避免把记忆内容再塞回上下文。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const DEFAULT_MEMORY_DIR = '.dsh-project-memory'
const STORE_MARKER = 'format.json'

const args = process.argv.slice(2)
const json = args.includes('--json')
// store 目录名 = config 的 memoryDir；显式 --memory-dir / 环境变量优先。
let memoryDirName = process.env.DSH_PROJECT_MEMORY_DIR || ''
const positional = []
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--json') continue
  if (arg === '--memory-dir') {
    memoryDirName = args[++i] || ''
    continue
  }
  if (arg.startsWith('--memory-dir=')) {
    memoryDirName = arg.slice('--memory-dir='.length)
    continue
  }
  if (arg.startsWith('--')) continue
  positional.push(arg)
}
const root = path.resolve(positional[0] || process.cwd())

const isFile = (file) => {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * store 目录。写死默认名在自定义 `memoryDir` 的项目上会报"没有 store"，
 * 而脚本读不到宿主 profile，所以：显式名 → 默认名 → 根下一层按 `format.json` 标记找**唯一**候选。
 * 0 个或多个候选都不猜，沿用默认名并在报错里点名怎么传。
 */
function resolveMemoryDir(root, name) {
  if (name) return { dir: path.join(root, name), name }
  const fallback = path.join(root, DEFAULT_MEMORY_DIR)
  if (isFile(path.join(fallback, STORE_MARKER))) return { dir: fallback, name: DEFAULT_MEMORY_DIR }
  let candidates = []
  try {
    candidates = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isFile(path.join(root, entry.name, STORE_MARKER)))
      .map((entry) => entry.name)
  } catch {
    candidates = []
  }
  if (candidates.length === 1) return { dir: path.join(root, candidates[0]), name: candidates[0], detected: true }
  return { dir: fallback, name: DEFAULT_MEMORY_DIR }
}

const resolved = resolveMemoryDir(root, memoryDirName)
const memoryDir = resolved.dir

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const days = (iso) => {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 86_400_000)) : null
}

function shardStats(dir) {
  try {
    let files = 0
    let bytes = 0
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const st = statSync(path.join(dir, name))
        if (!st.isFile()) continue
        files++
        bytes += st.size
      } catch {
        /* 分片在统计途中消失：跳过 */
      }
    }
    return { files, bytes }
  } catch {
    return { files: 0, bytes: 0 }
  }
}

function insightStats(items) {
  const kinds = {}
  const scopes = {}
  let archived = 0
  let withTrigger = 0
  let withFiles = 0
  let stale90 = 0
  let lastAt = null
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    kinds[it.kind || '?'] = (kinds[it.kind || '?'] || 0) + 1
    scopes[it.scope || '?'] = (scopes[it.scope || '?'] || 0) + 1
    if (it.archived) archived++
    if (it.trigger && it.trigger.when) withTrigger++
    if (Array.isArray(it.files) && it.files.length) withFiles++
    const age = days(it.updatedAt || it.createdAt)
    if (age !== null && age > 90) stale90++
    const at = it.updatedAt || it.createdAt
    if (at && (!lastAt || at > lastAt)) lastAt = at
  }
  return { total: items.length, kinds, scopes, archived, withTrigger, withFiles, stale90, lastAt }
}

function taskStats(tasks) {
  let archived = 0
  let steps = 0
  let files = 0
  let withInsights = 0
  const active = []
  for (const t of tasks) {
    if (!t || typeof t !== 'object') continue
    if (t.archived) archived++
    else if (t.title) active.push(String(t.title))
    if (Array.isArray(t.steps)) steps += t.steps.length
    if (Array.isArray(t.files)) files += t.files.length
    if (Array.isArray(t.insights) && t.insights.length) withInsights++
  }
  return { total: tasks.length, archived, active: tasks.length - archived, steps, files, withInsights, activeTitles: active.slice(0, 3) }
}

const insDoc = readJson(path.join(memoryDir, 'insights.json'), null)
const taskDoc = readJson(path.join(memoryDir, 'tasks.json'), null)
const binding = readJson(path.join(memoryDir, 'binding.json'), null)
const globalFile = path.join(homedir(), '.config', 'dsh-project-memory', 'global.json')
const globalDoc = readJson(globalFile, null)

// 有没有 store：`format.json` 标记（走过一次 save）或已有的 insights/tasks 都算。
// 只看后两者会把"只索引了文档、还没写洞察/任务"的项目误报成没有 store。
const hasStore = isFile(path.join(memoryDir, STORE_MARKER)) || Boolean(insDoc || taskDoc)

if (!hasStore) {
  const hint = resolved.detected || memoryDirName
    ? ''
    : '; if `memoryDir` is customized, pass --memory-dir <name>'
  const msg = `no memory store at ${memoryDir} (run index_repo or index_doc first)${hint}`
  if (json) process.stdout.write(JSON.stringify({ root, memoryDir, store: false }, null, 2) + '\n')
  else process.stdout.write(msg + '\n')
  process.exit(0)
}

const shards = shardStats(path.join(memoryDir, 'shards'))
const insights = insightStats((insDoc && insDoc.items) || [])
const tasks = taskStats((Array.isArray(taskDoc) ? taskDoc : []) || [])
const summary = {
  root,
  memoryDir,
  ...(resolved.detected ? { detected: true } : {}),
  store: true,
  shards,
  insights,
  tasks,
  bindings: binding && typeof binding === 'object' ? Object.keys(binding).length : 0,
  global: { items: globalDoc && Array.isArray(globalDoc.items) ? globalDoc.items.length : 0 },
}

if (json) {
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
  process.exit(0)
}

const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 102.4) / 10} KB`)
const line = (label, value) => process.stdout.write(`${label.padEnd(12)} ${value}\n`)
line('project', root)
if (resolved.name !== DEFAULT_MEMORY_DIR || resolved.detected) {
  line('location', `${resolved.name}${resolved.detected ? ' (auto-detected)' : ''}`)
}
line('store', `${shards.files} shards · ${kb(shards.bytes)} · ${insights.total} insights · ${tasks.total} tasks`)
if (insights.total) {
  const kinds = Object.entries(insights.kinds).map(([k, n]) => `${k} ${n}`).join(' · ')
  line('insights', `${kinds}${insights.archived ? ` · archived ${insights.archived}` : ''}`)
  line('triggers', `${insights.withTrigger}/${insights.total} with when · ${insights.withFiles} with files · ${insights.stale90} older than 90d`)
}
if (tasks.total) {
  line('tasks', `${tasks.active} active · ${tasks.archived} archived · ${tasks.steps} steps · ${tasks.files} file links`)
  if (tasks.activeTitles.length) line('active', tasks.activeTitles.join(' | '))
  if (tasks.withInsights === 0) line('task memory', 'none — task-scoped insights are not used here')
}
line('bindings', `${summary.bindings} session(s) bound`)
line('global', `${summary.global.items} entries (~/.config/dsh-project-memory/global.json)`)
