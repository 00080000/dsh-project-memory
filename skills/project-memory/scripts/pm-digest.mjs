#!/usr/bin/env node
// 项目记忆的体检脚本（零依赖、不调模型、不写盘）。
//
//   node pm-digest.mjs [项目根] [--json]
//
// 面向模型与人类各一半：模型拿它替代"先读三个 JSON 再数数"的多次工具往返；
// 人拿它看 store 是否异常增长、trigger 覆盖多少、任务是不是全归档了。
// 只输出计数与少量标题，不打印正文——避免把记忆内容再塞回上下文。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const json = args.includes('--json')
const root = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd())
const memoryDir = path.join(root, '.dsh-project-memory')

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

if (!insDoc && !taskDoc) {
  const msg = `no memory store at ${memoryDir} (run index_repo or index_doc first)`
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
