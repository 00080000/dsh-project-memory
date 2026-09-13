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
    name: 'authored trigger · 路径 glob',
    insights: [L('t_path', { trigger: { paths: ['README*'] } })],
    ctx: { humanText: '继续', actionText: 'edit {"file_path":"/repo/README.md"}' },
    expect: ['t_path'],
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

function runCase(c, ratioMin) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'eval-')), 'global.json')
  const gs = new GlobalStore(file).load()
  gs.doc.items.push(...c.insights)
  const cfg = cfgEngine({ insight: {}, autoContext: { maxTokens: c.maxTokens ?? 400, signalMinRatio: ratioMin } })
  const out = buildInjection({
    query: c.ctx.humanText,
    readiness: c.ctx,
    globalStore: gs,
    cfg,
    projectTagsList: c.tags || [],
  })
  return out.reasons.map((r) => r.id).sort()
}

function sweep(ratioMin) {
  let tp = 0
  let fp = 0
  let fn = 0
  const misses = []
  for (const c of CASES) {
    const got = new Set(runCase(c, ratioMin))
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
    ratioMin,
    tp,
    fp,
    fn,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    misses,
  }
}

const RATIOS = [0.2, 0.35, 0.5, 0.7]
const table = RATIOS.map((r) => sweep(r))
console.log('\n  signalMinRatio  precision  recall   missed')
for (const row of table) {
  console.log(
    `  ${row.ratioMin.toFixed(2)}            ${row.precision.toFixed(2)}       ${row.recall.toFixed(2)}     ${row.misses.join(', ') || '-'}`,
  )
}

// ---- 1. 标注集本身可跑通（每条 case 的期望集互不依赖） ----
{
  assert.equal(CASES.length >= 8, true)
  ok(`eval set：${CASES.length} 条标注 case（召回 + 精度双向约束）`)
}

// ---- 2. 出厂默认 signalMinRatio=0.5 必须在标注集上零漏零误 ----
{
  const shipped = sweep(0.5)
  assert.equal(shipped.recall, 1, `漏注入：${shipped.misses.join(', ')}`)
  assert.equal(shipped.precision, 1, `误注入：precision=${shipped.precision}`)
  ok('出厂阈值 0.5：标注集上 recall=1.00、precision=1.00')
}

// ---- 3. 阈值单调性：放宽只会放进来更多，收紧只会漏掉更多 ----
{
  const recalls = table.map((r) => r.recall)
  const precisions = table.map((r) => r.precision)
  assert.ok(recalls[0] >= recalls[recalls.length - 1], `放宽应收紧召回：${recalls.join(',')}`)
  assert.ok(precisions[0] <= precisions[precisions.length - 1], `放宽应损害精度：${precisions.join(',')}`)
  ok('阈值方向正确：放宽↑召回↓精度，收紧相反')
}

// ---- 4. 最宽松档必须能暴露"弱相关被拉进来"（证明这个度量真的有分辨力） ----
{
  const loose = sweep(0.2)
  assert.ok(loose.precision < 1, '最宽松档若仍 precision=1，说明标注集分不出阈值差异，度量无效')
  ok('度量有分辨力：0.2 档会放进弱相关（precision 下降）')
}

console.log(`\nreadiness-eval tests: ${passed} passed`)
