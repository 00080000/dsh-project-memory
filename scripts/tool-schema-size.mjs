#!/usr/bin/env node
/**
 * 工具 schema 预算实测 —— 每个工具往每次请求里塞多少字符 / 多少 token。
 *
 * 为什么要有它：工具定义是「每次请求都付」的固定开销。12 个工具轻松吃掉
 * 一万多字符的常驻成本，小上下文模型直接受不了。这个脚本用真实的 defineTool
 * 投影算出每个工具实际发出的 schema 大小，让「描述瘦身」这件事可测、可回归，
 * 而不是靠感觉。
 *
 * 口径：字符数与 token 数分开报，**不要拿一个固定系数去乘混合文本**——
 * 英文约 4 字符/token，CJK 约 1 字符/token。用 1.6 这种中英混合系数去比
 * 「英文改中文」的新旧版本，会把字符数的下降误算成 token 的下降。
 * token 列是同口径的粗估（CJK 字符 1 token、其余 4 字符 1 token），
 * 用于比较两次改动，不是给模型账单用的精确值。
 *
 * 用法: node scripts/tool-schema-size.mjs [--json]
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const SRC = path.join(HERE, '..', 'src')

// 工厂函数只需要在构造期读少量配置；用 Proxy 兜住所有未定义字段，
// 这样脚本不会因为某个字段缺失而崩掉（构造期不应依赖运行时状态）。
const stub = (label) =>
  new Proxy({}, {
    get: (_t, k) => (k === Symbol.toPrimitive || k === 'toString' ? () => `[${label}]` : undefined),
    has: () => true,
  })

const config = stub('config')
const ctx = stub('ctx')
const host = { llm: stub('llm'), ctx }
const watchManager = stub('watchManager')

const { indexDocTool } = await import(pathToFileURL(path.join(SRC, 'tools/index-doc.js')))
const { indexRepoTool } = await import(pathToFileURL(path.join(SRC, 'tools/index-repo.js')))
const { queryMemoryTool } = await import(pathToFileURL(path.join(SRC, 'tools/query-memory.js')))
const { rememberTool } = await import(pathToFileURL(path.join(SRC, 'tools/remember.js')))
const { forgetTool } = await import(pathToFileURL(path.join(SRC, 'tools/forget.js')))
const { watchRepoTool } = await import(pathToFileURL(path.join(SRC, 'tools/watch-repo.js')))
const { statsTool } = await import(pathToFileURL(path.join(SRC, 'tools/stats.js')))
const { listTasksTool, selectTaskTool, archiveTaskTool, showTaskPanelTool } = await import(
  pathToFileURL(path.join(SRC, 'tools/task-tools.js'))
)
const { lessonTool } = await import(pathToFileURL(path.join(SRC, 'tools/lesson-tools.js')))

const BUILDERS = [
  ['list_tasks', () => listTasksTool(config)],
  ['select_task', () => selectTaskTool(config, host)],
  ['archive_task', () => archiveTaskTool(config, host)],
  ['show_task_panel', () => showTaskPanelTool(config)],
  ['index_doc', () => indexDocTool(ctx, config)],
  ['index_repo', () => indexRepoTool(ctx, config)],
  ['query_memory', () => queryMemoryTool(ctx, config)],
  ['remember', () => rememberTool(config)],
  ['forget', () => forgetTool(config)],
  ['watch_repo', () => watchRepoTool(watchManager, config)],
  ['memory_stats', () => statsTool(config)],
  ['save_lesson', () => lessonTool(config)],
]

// CJK 汉字 + 假名 + 全角/CJK 标点：都按 1 token/字符计。
const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFF60\u3000-\u303F]/u

// 模型实际收到的是 {name, description, parameters}, 与 registry 投影一致。
function measure(text) {
  let cjk = 0
  let other = 0
  for (const ch of text) CJK.test(ch) ? cjk++ : other++
  return { chars: cjk + other, tokens: Math.round(cjk + other / 4) }
}

function sizeOf(tool) {
  const desc = measure(String(tool.description ?? ''))
  const params = measure(JSON.stringify(tool.parameters ?? {}))
  const name = measure(String(tool.name ?? ''))
  return {
    desc: desc.chars,
    params: params.chars,
    total: desc.chars + params.chars + name.chars,
    tokens: desc.tokens + params.tokens + name.tokens,
  }
}

const rows = []
const failures = []
for (const [name, build] of BUILDERS) {
  try {
    const tool = build()
    if (!tool || tool.name !== name) throw new Error(`工厂返回的 name=${tool?.name}`)
    rows.push({ name, ...sizeOf(tool) })
  } catch (err) {
    failures.push(`${name}: ${err.message}`)
  }
}

rows.sort((a, b) => b.total - a.total)
const sum = (k) => rows.reduce((s, r) => s + r[k], 0)
const total = sum('total')
const totalDesc = sum('desc')
const totalParams = sum('params')
const totalTokens = sum('tokens')

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ tools: rows, total, totalDesc, totalParams, totalTokens, failures }, null, 2))
} else {
  console.log('工具 schema 预算（每次请求的固定开销）\n')
  console.log('  工具                       工具描述   参数schema      合计       token')
  console.log('  ' + '-'.repeat(62))
  for (const r of rows) {
    console.log(
      `  ${r.name.padEnd(24)} ${String(r.desc).padStart(8)} ${String(r.params).padStart(10)} ${String(r.total).padStart(10)} ${String(r.tokens).padStart(11)}`
    )
  }
  console.log('  ' + '-'.repeat(62))
  console.log(
    `  ${String(rows.length + ' 个工具').padEnd(24)} ${String(totalDesc).padStart(8)} ${String(totalParams).padStart(10)} ${String(total).padStart(10)} ${String(totalTokens).padStart(11)}`
  )
  console.log(
    `\n  口径：字符 + 同口径粗估 token（CJK 1 token/字符，其余 4 字符/token）。` +
      `\n  不要用固定「字符/token」系数跨语言对比 —— 英文改中文会掉字符数，但 token 未必掉。`
  )
  if (failures.length) {
    console.log('\n  [!] 有工具没能构造出来:')
    for (const f of failures) console.log('     ', f)
  }
}

process.exitCode = failures.length ? 1 : 0
