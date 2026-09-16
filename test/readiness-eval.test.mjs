// 就绪引擎的**度量**：带标注的 readiness eval set + 相对阈值扫描（PR3）
//   node test/readiness-eval.test.mjs
//
// 为什么在 test/ 而不是 bench/：bench/ 是 .gitignore 的本地脚手架，而这个阈值必须是
// **可复现、随仓库发布、由 CI 守住**的。所以标注集与扫描都放在这里；跑一次就能看到
// signalMinRatio 在 0.2 / 0.35 / 0.5 / 0.7 上的 precision-recall 表。
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { GlobalStore, cfgInsight } from '../src/insight-store.js'
import { buildInjection, cfgEngine } from '../src/auto-inject.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const L = (id, extra) => ({ id, kind: 'lesson', scope: 'global', title: `lesson ${id}`, fix: 'fix', confidence: 1, archived: false, ...extra })
const P = (id, extra) => ({ id, kind: 'procedure', scope: 'global', title: `procedure ${id}`, steps: ['step'], confidence: 1, archived: false, ...extra })

/**
 * 标注集：每条给出「这一刻应该注入哪些条目」。
 * expect 同时约束召回（该注入的一次不漏）与精度（不该注入的一次不多）。
 */
const CASES = [
  {
    name: 'authored trigger · 人类意图词',
    insights: [L('t_intent', { trigger: { actions: ['git-commit'] } })],
    ctx: { humanText: '你顺便提交一下', actionText: '' },
    expect: ['t_intent'],
  },
  {
    name: 'authored trigger · 已观察动作',
    insights: [L('t_action', { trigger: { actions: ['git-commit'] } })],
    ctx: { humanText: '把收尾做掉', actionText: 'bash {"command":"git commit -m x"}' },
    expect: ['t_action'],
  },
  {
    name: 'authored trigger · 写目标（具体文件）',
    insights: [L('t_path', { trigger: { paths: ['README.md'] } })],
    ctx: { humanText: '继续', actionText: 'edit {"file_path":"/repo/README.md"}' },
    expect: ['t_path'],
  },
  {
    name: 'S2 · 扩展名 glob 不再触发',
    insights: [L('g_ext', { title: 'pptxgenjs 画布尺寸', fix: 'defineLayout', trigger: { paths: ['*.pptx'] } })],
    ctx: { humanText: '把创建时间改到昨天', actionText: 'edit {"file_path":"/repo/deck.pptx"}' },
    expect: [],
  },
  {
    name: 'S2 · 引用内容不得当意图（文件名里的词）',
    insights: [L('q_quote', { title: '做调研要先扫 curated 列表', fix: '按日期倒序扫最近半年', trigger: { keywords: ['调研'] } })],
    ctx: { humanText: '把 "石啸天-LLM记忆方向调研.pptx" 的创建时间改到昨天', actions: [], paths: [] },
    expect: [],
  },
  {
    name: 'authored trigger · keywords',
    insights: [L('t_kw', { trigger: { keywords: ['内部文档'] } })],
    ctx: { humanText: '记得别泄漏内部文档', actionText: '' },
    expect: ['t_kw'],
  },
  {
    name: 'scope 画像过滤（procedure 只走 trigger 通道）',
    insights: [P('t_scope', { trigger: { actions: ['npm-publish'], scope: ['npm'] } })],
    ctx: { humanText: '我要发包', actionText: '' },
    tags: ['vue'],
    expect: [],
  },
  {
    name: '统计提示 · 强相关进、弱相关不进',
    insights: [
      L('h_strong', { title: 'npm 发包要过官方源', fix: '设置 registry 为官方源' }),
      L('h_weak', { title: 'npm 依赖升级注意 semver 兼容', fix: '锁版本' }),
    ],
    ctx: { humanText: 'npm 发包', actionText: '' },
    expect: ['h_strong'],
  },
  {
    name: '缩写巧合（PR）不得命中',
    insights: [
      L('a_pr', { title: '自动安全 PR 扫描：横向越权', fix: 'authz 检查' }),
      L('a_pub', { title: '公开作品仓库的公开面', fix: '内部文档写进 .gitignore' }),
    ],
    ctx: { humanText: 'PR 提交前检查公开面', actionText: '' },
    expect: ['a_pub'],
  },
  {
    name: '无关内容零注入',
    insights: [L('h_none', { title: 'JWT 未校验 exp', fix: '用 jose 校验' })],
    ctx: { humanText: '数据库迁移怎么做', actionText: '' },
    expect: [],
  },
  {
    name: '预算排程 · trigger 存活、提示被挤掉',
    insights: [
      L('b_trig', { trigger: { actions: ['git-commit'] }, fix: 'z'.repeat(90) }),
      L('b_hint', { title: '提交前的检查清单', fix: 'y'.repeat(400) }),
    ],
    ctx: { humanText: '你顺便提交一下', actionText: '' },
    maxTokens: 40,
    expect: ['b_trig'],
  },
]

function runCase(c, override) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'eval-')), 'global.json')
  const gs = new GlobalStore(file).load()
  gs.doc.items.push(...c.insights)
  const cfg = cfgEngine({ insight: {}, autoContext: { maxTokens: c.maxTokens ?? 400, ...override } })
  const out = buildInjection({
    query: c.ctx.humanText,
    readiness: c.ctx,
    globalStore: gs,
    cfg,
    projectTagsList: c.tags || [],
  })
  return out.reasons.map((r) => r.id).sort()
}

function sweep(override, label) {
  let tp = 0
  let fp = 0
  let fn = 0
  const misses = []
  for (const c of CASES) {
    const got = new Set(runCase(c, override))
    const want = new Set(c.expect)
    for (const id of got) (want.has(id) ? tp++ : fp++)
    for (const id of want) {
      if (!got.has(id)) {
        fn++
        misses.push(`${c.name}:${id}`)
      }
    }
  }
  return {
    label,
    tp,
    fp,
    fn,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    misses,
  }
}

// S4 之后，分辨力来自**绝对门槛**（IDF 加权覆盖率），不再是相对阈值：
// 相对阈值只看"层内最高分的比例"，最高分本身是噪声时它照样给 1.00。所以这里两个旋钮都扫。
const RATIOS = [0.2, 0.35, 0.5, 0.7]
const table = RATIOS.map((r) => sweep({ signalMinRatio: r }, r.toFixed(2)))
console.log('\n  signalMinRatio  precision  recall   missed')
for (const row of table) {
  console.log(
    `  ${String(row.label).padEnd(15)} ${row.precision.toFixed(2)}       ${row.recall.toFixed(2)}     ${row.misses.join(', ') || '-'}`,
  )
}

const COVERAGES = [0, 0.3, 0.6, 0.9]
const covTable = COVERAGES.map((c) => sweep({ hintMinCoverage: c }, c.toFixed(2)))
console.log('\n  hintMinCoverage precision  recall   missed')
for (const row of covTable) {
  console.log(
    `  ${String(row.label).padEnd(15)} ${row.precision.toFixed(2)}       ${row.recall.toFixed(2)}     ${row.misses.join(', ') || '-'}`,
  )
}

// ---- 1. 标注集本身可跑通（每条 case 的期望集互不依赖） ----
{
  assert.equal(CASES.length >= 8, true)
  ok(`eval set：${CASES.length} 条标注 case（召回 + 精度双向约束）`)
}

// ---- 2. 出厂默认（signalMinRatio=0.5 + hintMinCoverage=0.3）必须零漏零误 ----
{
  const shipped = sweep({}, 'shipped')
  assert.equal(shipped.recall, 1, `漏注入：${shipped.misses.join(', ')}`)
  assert.equal(shipped.precision, 1, `误注入：precision=${shipped.precision}`)
  ok('出厂默认：标注集上 recall=1.00、precision=1.00')
}

// ---- 3. 相对阈值单调性：放宽只会放进来更多，收紧只会漏掉更多 ----
{
  const recalls = table.map((r) => r.recall)
  const precisions = table.map((r) => r.precision)
  assert.ok(recalls[0] >= recalls[recalls.length - 1], `放宽应收紧召回：${recalls.join(',')}`)
  assert.ok(precisions[0] <= precisions[precisions.length - 1], `放宽应损害精度：${precisions.join(',')}`)
  ok('相对阈值方向正确：放宽↑召回↓精度，收紧相反')
}

// ---- 4. 分辨力：关掉两个**绝对**判据后，相对阈值单独不足（0.2 档会放进弱相关） ----
{
  const noAbs = sweep({ signalMinRatio: 0.2, hintMinCoverage: 0, hintMinMatched: 0 }, '0.2 无绝对门槛')
  assert.ok(
    noAbs.precision < 1,
    '关掉绝对门槛后若仍 precision=1，说明标注集分不出差异，度量无效',
  )
  ok(`度量有分辨力：关掉绝对门槛后 0.2 档 precision=${noAbs.precision.toFixed(2)}（相对阈值单独不足）`)
}

// ---- 5. 带上绝对门槛：即使把相对阈值放到最宽，precision 仍保持 1.00 ----
{
  const wide = sweep({ signalMinRatio: 0.2 }, '0.2 + 绝对门槛')
  assert.equal(wide.precision, 1, `绝对门槛应挡住弱相关：precision=${wide.precision}`)
  assert.equal(wide.recall, 1)
  ok('绝对门槛接力：最宽相对阈值下 precision 仍为 1.00')
}

// ---- 6. 出厂绝对门槛不得伤到召回 ----
{
  const shipped = sweep({}, 'shipped')
  assert.equal(shipped.recall, 1, `出厂门槛不该漏：${shipped.misses.join(', ')}`)
  assert.equal(shipped.precision, 1)
  ok('出厂绝对门槛（coverage 0.3 + 至少 2 词）：零漏零误')
}

console.log(`\nreadiness-eval tests: ${passed} passed`)
