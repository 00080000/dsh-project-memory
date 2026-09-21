// 注入准入的场景回归（PLAN S0/S5）：带标注的 8 个场景 + 四个数（命中 / 假阳性 / 字符 / 次数）。
//   node test/injection-scenarios.test.mjs                 # 棘轮 + 闸门（精确率 ≥ 0.90、对照组零注入）
//   node test/injection-scenarios.test.mjs --selfcheck     # trigger 自检：谁推得动、谁是死值
//   node test/injection-scenarios.test.mjs --store <项目 insights.json> [--global <global.json>]
//                                                          # 真实 store 回放；对照组必须零注入，否则退出码 1
//   加 --hint-cov <n> 可用另一个覆盖底线重放（选阈值时的扫描口）
//
// 为什么在 test/ 而不是 bench/：与 readiness-eval 同款理由——这个基线必须可复现、随仓库
// 发布、由 CI 守住；bench/ 是 .gitignore 的本地脚手架。
//
// 池子是**合成**的，但每一条都照抄真实条目的 trigger（含致病的那几个：`*.pptx` 扩展名 glob、
// `rm` 这种 2 字符关键词、`scope` 与画像 tag 的错配、`benchmark` 这种不在 ACTION_LEXICON
// 里的死 action）。合成是**默认**基线而非唯一来源：`--selfcheck` / `--store` 会先探测
// `.dsh-project-memory/`（见 resolvePool），默认路径（CI 的 npm test）不读真实 store，可复现性不变。
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { buildInjection, cfgEngine } from '../src/auto-inject.js'
import { auditTriggers, normalizeTrigger } from '../src/readiness.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const L = (id, title, extra = {}) => ({ id, kind: 'lesson', scope: 'global', title, fix: `${title} 的做法`, confidence: 1, archived: false, ...extra })
const P = (id, title, extra = {}) => ({ id, kind: 'procedure', scope: 'global', title, steps: [`${title} 第 1 步`, `${title} 第 2 步`], confidence: 1, archived: false, ...extra })

/**
 * 候选池：右侧注释是它照抄的真实条目（真实 id 前缀）。
 * 刻意保留致病的 trigger 写法——回归要盯的正是它们。
 */
const POOL = [
  P('p_arxiv', '本机查论文/仓库改用 curl', { trigger: { keywords: ['arxiv', '论文', 'paper', 'web_fetch', 'web_search', 'pptx', '爬取', '摘要'], actions: ['research', 'web-fetch'], paths: ['*.pptx'] } }), // ins_0746262e
  P('p_render', '无 root 把 PPTX 渲染成可校验版面', { trigger: { keywords: ['pptx', 'ppt', 'libreoffice', 'soffice', '渲染', '幻灯'], actions: ['generate-pptx', 'render'], paths: ['*.pptx', '*.pdf'] } }), // ins_f5424b08
  L('l_pptxgenjs', 'pptxgenjs 的 LAYOUT_16x9 是 10x5.625', { trigger: { keywords: ['pptxgenjs', 'LAYOUT_16x9', '16:9', '幻灯片', 'ppt'], actions: ['generate-pptx'], paths: ['*.pptx'] } }), // ins_08897b7a
  P('p_purge', '误删文件后的恢复顺序', { trigger: { keywords: ['误删', '恢复', '找回', 'rm', '丢了', 'deleted', 'zstd', '快照'], actions: ['delete', 'recover', 'cleanup'] } }), // ins_490c5be0
  L('l_readimage', 'read_image 被拒但模型有视觉', { trigger: { keywords: ['read_image', '视觉', 'inputModalities', '图片', '看图'], actions: ['read-image'], paths: ['**/settings.yaml', '*.png', '*.jpg'] } }), // ins_0bccb9b3
  L('l_curated', '调研下结论前先按日期扫最近半年', { trigger: { keywords: ['调研', '空白', '综述', '方向', 'state of the art', '没人做'], actions: ['research', 'survey'] } }), // ins_bcacc541
  L('l_wslpnpm', 'WSL 里 Windows 版 pnpm 抢先命中 PATH'), // ins_d6730deb（无 authored trigger，只可能走提示通道）
  L('l_pkgfiles', '文档承诺的脚本在仓库里≠在 npm 包里', { trigger: { keywords: ['上传', '没上传', 'npm 包', '发布', '发版', '打包', 'files 白名单', 'tarball'], actions: ['npm-publish', 'npm-pack', 'git-push'], paths: ['package.json', 'README*', 'CHANGELOG*'] } }), // ins_2551bfb3
  P('p_npmpub', 'npm 包发布流程', { trigger: { keywords: ['npm publish', '发版', '发布', 'release', 'version bump', 'tag', 'CHANGELOG'], scope: ['release', 'npm', 'dsh-project-memory'] } }), // ins_510aa6f6（scope 与画像 tag 错配 → 推不动）
  L('l_changelog', 'CHANGELOG 已写新版本段、package.json 未 bump'), // ins_828da5cc（无 authored trigger）
  L('l_readmedrift', 'README 跟代码漂移', { trigger: { keywords: ['README', '文档', '过时', '漂移', '版本号', '默认值'], actions: ['release', 'write-docs'], paths: ['README*', 'CHANGELOG*', 'package.json'] } }), // ins_e2dd8bef
  L('l_deldoc', '按文件名推断价值删除内部文档 = 不可恢复', { trigger: { keywords: ['删除', '清理', 'de-TODO', 'PLAN', 'gitignore', '内部文档'], actions: ['delete', 'cleanup', 'git-add', 'git-commit'], paths: ['.gitignore', 'de-TODO.md', 'PLAN-*.md'] } }), // ins_4d139a28
  L('l_reload', '插件源码改动在运行中的宿主里不生效', { trigger: { keywords: ['重载', '重启', 'not a declared property', 'schema'], actions: ['reload'], paths: ['src/tools/query-memory.js', 'src/index.js'] } }), // ins_7bbee740
  L('l_budget', '预算丢弃诊断日志默认静默', { trigger: { keywords: ['budgetLog', 'auto-inject', 'degraded', '预算', '日志', '终端噪音'] } }), // ins_0083d0fe
  L('l_dedupe', '增量注入不能用整块指纹去重', { trigger: { keywords: ['注入频率', '重复注入', '去重', 'fingerprint', 'auto-inject', '上下文噪音'] } }), // ins_8aaeb61a
  L('l_retrieval', 'insight 层必须有检索通道', { trigger: { keywords: ['注入', '召回', '阈值', 'triggerDerived', 'signalMinRatio', 'auto-inject'] } }), // ins_af4e5ec6
  L('l_procscope', 'procedure 不能走统计提示通道', { trigger: { keywords: ['procedure', 'scope', '画像过滤'], paths: ['src/auto-inject.js', 'src/readiness.js'] } }), // ins_b25f8978
  P('p_bench', '独立基准脚本 scripts/bench.mjs', { trigger: { keywords: ['bench', '基准', '性能', '复现', 'p50'], actions: ['benchmark'], paths: ['scripts/bench.mjs', 'README.md'] } }), // ins_fcc22cb4
  P('p_testing', '被问「你怎么测试的」时的答法', { trigger: { keywords: ['测试', '怎么测', '性能数据', 'benchmark', '验证', '复现'] } }), // ins_f8d6fcd1
  L('l_harness', '检索基准 harness 会静默骗人'), // ins_32fae71d（无 authored trigger）
  L('l_wslio', 'WSL2 小文件 I/O 慢约 3×'), // ins_b1de23b9（无 authored trigger）
  L('l_vaportok', '邮件里点名引用的论文就是面试第一题', { trigger: { keywords: ['论文', 'VaporTok', 'Vist', '面试', '引用'] } }), // ins_e602b1e2
  L('l_perfnum', '对外引用性能数字必须带规模+硬件口径', { trigger: { keywords: ['性能', '基准', 'benchmark', 'ms', '延迟', '下载量', 'star', '测试数'], actions: ['interview-prep', 'report-metrics'] } }), // ins_547cb96c
  L('l_honesty', '申请材料只写亲手做过的', { trigger: { keywords: ['简历', '夸大', '诚信', '口径', '材料', '群发'] } }), // ins_114ea4cd
]

const bash = (cmd) => `bash {"command":${JSON.stringify(cmd)},"description":"x"}`
const read = (p) => `read {"file_path":${JSON.stringify(p)}}`
const edit = (p) => `edit {"file_path":${JSON.stringify(p)}}`

/**
 * expect = 这一刻**应该被推送**的条目（同时约束召回与精度）。
 * 准入化之后，没有 `when` 的条目（纯关键词、或只有坏 glob）不再推送——它们只按需拉取，
 * 因此不出现在任何 expect 里。每处与旧标注不同的地方都写了理由。
 */
const SCENARIOS = [
  {
    name: 'A 发版 0.5.6 → npm',
    tags: ['dsh-plugin', 'tsdown'],
    human: '发个 0.5.6 吧，CHANGELOG 已经写好一段了，帮我 bump 版本并发布到 npm',
    actions: [bash('npm version minor'), bash('git commit -am release && git tag v0.5.6'), read('package.json'), edit('CHANGELOG.md')],
    // p_npmpub 缺席：scope=['release','npm','dsh-project-memory'] 与本仓库派生的依赖 tag 无交集
    // → 被画像过滤判死。这是既有数据问题，不是引擎缺陷；--selfcheck 会把它列出来。
    expect: ['l_changelog', 'l_pkgfiles', 'l_readmedrift'],
    note: 'p_npmpub 被 legacy scope 过滤（既有数据问题，留给作者改 trigger）',
  },
  {
    name: 'B 改注入触发逻辑',
    tags: ['dsh-plugin'],
    human: 'trigger 老是误命中，我想改一下 auto-inject 的预算、去重和相对阈值',
    actions: [read('src/auto-inject.js'), edit('src/readiness.js')],
    expect: ['l_retrieval', 'l_dedupe', 'l_budget', 'l_procscope'],
  },
  {
    name: 'C 源码改动不生效',
    tags: ['dsh-plugin'],
    human: '我改了 src/tools/query-memory.js，宿主里报 not a declared property，是不是没重启',
    actions: [bash('node --test test/insight-store.test.mjs'), read('src/tools/query-memory.js')],
    expect: ['l_reload'],
  },
  {
    name: 'D 跑基准更新 README',
    tags: ['dsh-plugin'],
    human: '跑一下 bench 脚本，把新的 p50 数字更新到 README 的表格里',
    actions: [bash('node scripts/bench.mjs'), edit('README.md')],
    // l_wslio / l_harness 无 authored trigger（按需拉取）；p_testing 的意图词是"被问怎么测试"，
    // 本场景没有这个意图 → 三者都不进 expect。
    expect: ['p_bench'],
  },
  {
    name: 'G 误删 de-TODO.md',
    tags: ['dsh-plugin'],
    human: '我好像把 de-TODO.md 删了，还能找回吗',
    actions: [bash('ls -la de-TODO.md')],
    expect: ['p_purge', 'l_deldoc'],
  },
  {
    name: 'E 面试问 VaporTok',
    tags: [],
    human: '明天面试，老师要是顺着邮件问 VaporTok 的核心机制我该怎么说',
    actions: [read('9-15面试速答卡-王金鹏.md')],
    // l_perfnum 不进 expect：它的触发面是"对外报数字"，本场景是"被问论文机制"。
    expect: ['l_vaportok'],
  },
  {
    name: 'H 面试官问怎么测试的',
    tags: [],
    human: '面试官问我这个插件是怎么测试的',
    actions: [read('README.md')],
    // l_vaportok 进 expect：'面试' 是真实意图词，命中即注入是意图通道的设计行为。
    expect: ['p_testing', 'l_vaportok'],
  },
  {
    name: 'F 对照：改 pptx 时间戳（真实原文）',
    tags: [],
    human: '你在wsl，怎么把"C:\\Users\\33880\\OneDrive\\桌面\\石啸天-LLM记忆方向调研.pptx"这个文件的创建时间从”2026年9月16日，21:00:14“改到昨天17：23：14。',
    actions: [
      bash('ls -la /mnt/c/Users/33880/OneDrive/桌面/石啸天-LLM记忆方向调研.pptx'),
      bash('powershell.exe -NoProfile -Command SetFileTime'),
    ],
    // 整份 PLAN 的验收底线：文件名里的"调研"、扩展名 .pptx、powershell 命令，都不许触发任何东西。
    expect: [],
  },
]

const CFG = cfgEngine({ insight: {}, autoContext: { maxTokens: 400 } })

function poolStore(items) {
  return { insightItems: () => items }
}

function runScenario(s, pool, cfg = CFG) {
  const out = buildInjection({
    query: s.human,
    readiness: { humanText: s.human, actionText: s.actions.join('\n') },
    task: null,
    store: poolStore(pool),
    globalStore: null,
    projectTagsList: s.tags || [],
    cfg,
  })
  const got = out.reasons.map((r) => r.id)
  const hit = got.filter((id) => s.expect.includes(id))
  const fp = got.filter((id) => !s.expect.includes(id))
  const fn = s.expect.filter((id) => !got.includes(id))
  return { got, hit, fp, fn, chars: out.text.length, injections: out.text ? 1 : 0, why: out.reasons, dropped: out.dropped }
}

function measure(pool, scenarios) {
  let tp = 0
  let fp = 0
  let fn = 0
  let chars = 0
  let injections = 0
  const rows = []
  for (const s of scenarios) {
    const r = runScenario(s, pool)
    tp += r.hit.length
    fp += r.fp.length
    fn += r.fn.length
    chars += r.chars
    injections += r.injections
    rows.push({ s, r })
  }
  return {
    tp,
    fp,
    fn,
    chars,
    injections,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    rows,
  }
}

function printReport(m) {
  console.log('\n  场景                              注入  命中  假阳  漏召  字符')
  const pad = (t, n) => String(t).padEnd(n)
  for (const { s, r } of m.rows) {
    console.log(`  ${pad(s.name, 34)}  ${pad(r.got.length, 4)}  ${pad(r.hit.length, 4)}  ${pad(r.fp.length, 4)}  ${pad(r.fn.length, 4)}  ${pad(r.chars, 5)}`)
    for (const why of r.why) {
      const mark = s.expect.includes(why.id) ? '✔' : '✘'
      console.log(`        ${mark} [${why.channel}] ${String(why.why).padEnd(26)} ${why.id}`)
    }
    for (const id of r.fn) console.log(`        ✘ 漏召 ${id}`)
    if (s.note) console.log(`        note ${s.note}`)
  }
  console.log(`\n  四个数: 命中 ${m.tp}  假阳性 ${m.fp}  漏召 ${m.fn}  注入 ${m.injections} 次 / ${m.chars} 字符`)
  console.log(`  精确率 ${m.precision.toFixed(2)} (${m.tp}/${m.tp + m.fp})   召回率 ${m.recall.toFixed(2)} (${m.tp}/${m.tp + m.fn})`)
}

function printSelfcheck(pool) {
  const a = auditTriggers(pool, { legacyScope: 'filter' })
  console.log('\n  === trigger 自检 ===')
  console.log(`  可推送 ${a.pushable} / 仅按需拉取 ${a.pullOnly.length}（共 ${a.total}）`)
  console.log(`  死 action ${a.deadActions.length}: ${a.deadActions.map((d) => `${d.id}(${d.value})`).join(', ') || '-'}`)
  console.log(`  被丢弃的坏 glob ${a.droppedGlobs.length}: ${a.droppedGlobs.map((d) => `${d.id}(${d.value})`).join(', ') || '-'}`)
  console.log(`  因已有精确 writes 被丢弃的弱 action ${a.weakDropped.length}: ${a.weakDropped.map((d) => `${d.id}(${d.value})`).join(', ') || '-'}`)
  console.log(`  兜底 op 当触发面 ${a.fallbackOps.length}: ${a.fallbackOps.map((d) => `${d.id}(${d.ops})`).join(', ') || '-'}`)
  console.log(`  带 scope 的条目 ${a.scopeIgnored.length}: ${a.scopeIgnored.join(', ') || '-'}`)
  console.log(`  缺 prevents ${a.missingPrevents.length}/${a.total}`)
  console.log(`  仅按需拉取: ${a.pullOnly.join(', ') || '-'}`)
}

// ---------------------------------------------------------------------------
// 记录基线（棘轮）：只允许变好，不允许变差。改进之后来这里上调。
// 2026-09-16 v1（准入化之前）：命中 13 / 假阳性 14 / 漏召 5 / 8 次注入 / 1740 字符 / P 0.48 R 0.72。
// 2026-09-16 v2（S1–S4 落地，标注按新架构重写）：P/R = 1.00/1.00，7 次注入 / 613 字符。
const BASELINE = { precision: 1, recall: 1 }
// 目标闸门：精确率是硬门（一条噪声永久占上下文，代价不对称），对照组必须零注入。
const GATE_PRECISION = 0.9

const argv = process.argv.slice(2)
const gate = argv.includes('--gate')
const storeIdx = argv.indexOf('--store')
const argOf = (flag) => (argv.indexOf(flag) !== -1 ? argv[argv.indexOf(flag) + 1] : undefined)

const DEFAULT_PROJECT_STORE = path.join(process.cwd(), '.dsh-project-memory', 'insights.json')
const DEFAULT_GLOBAL_STORE = path.join(homedir(), '.config', 'dsh-project-memory', 'global.json')
const readItems = (file) => JSON.parse(readFileSync(file, 'utf8')).items || []
const cfgWith = (override) => cfgEngine({ insight: {}, autoContext: { maxTokens: 400, ...override } })

/**
 * 候选池来源解析：`--store` 显式路径 > 本地 `./.dsh-project-memory/insights.json` > 合成池 POOL。
 *
 * 存在的理由：`npm run selfcheck:triggers` 只传 `--selfcheck`，而原实现把 `--selfcheck` 分支放在
 * `--store` 之前并 `process.exit(0)`——于是这条命令**恒定**打印合成池，README 承诺的"看你自己
 * 哪些条目推不动"从来没让人看到过自己的条目。默认路径（`npm test`）不经过这里，CI 依旧可复现。
 * @returns {{items: object[], sources: string[]}}
 */
function resolvePool() {
  const projPath = argOf('--store') || (existsSync(DEFAULT_PROJECT_STORE) ? DEFAULT_PROJECT_STORE : null)
  if (!projPath) return { items: POOL, sources: ['合成池 POOL（未找到本地 store）'] }
  const proj = readItems(projPath)
  const sources = [`${projPath} (${proj.length} 条)`]
  const globalPath = argOf('--global') || (existsSync(DEFAULT_GLOBAL_STORE) ? DEFAULT_GLOBAL_STORE : null)
  if (!globalPath) return { items: proj, sources }
  const global = readItems(globalPath)
  sources.push(`${globalPath} (${global.length} 条)`)
  return { items: [...proj, ...global], sources }
}

if (argv.includes('--selfcheck')) {
  const { items, sources } = resolvePool()
  console.log(`\n  池子来源: ${sources.join('  +  ')}`)
  printSelfcheck(items)
  console.log('')
  process.exit(0)
}

if (storeIdx !== -1) {
  // 真实 store 模式：本地复盘用。**只对对照组判定**——场景的 expect 用的是合成池的 id，真实
  // store 里是另一套 id，拿它算语义精确率只会得到误导性的 0；但"expect 为空的场景该不该沉默"
  // 与 id 无关，所以它是真实 store 上唯一可判定的硬闸门（也是 0.5.8 修的那条：0.3 底线下
  // 对照场景 F 会注入 3 条无关提示）。
  const { items, sources } = resolvePool()
  const pool = items.map((it) => normalizeTrigger(it, { legacyScope: CFG.legacyScope }))
  const covArg = argOf('--hint-cov')
  const cfg = covArg === undefined ? CFG : cfgWith({ hintMinCoverage: Number(covArg) })
  console.log(`\n  池子来源: ${sources.join('  +  ')}   hintMinCoverage=${cfg.hintMinCoverage}`)
  let violations = 0
  for (const s of SCENARIOS) {
    const r = runScenario(s, pool, cfg)
    console.log(`\n  === ${s.name}  注入 ${r.got.length} 条 / ${r.chars} 字符`)
    for (const why of r.why) {
      const title = String(pool.find((i) => i.id === why.id)?.title || '?').slice(0, 40)
      console.log(`      [${why.channel}] ${String(why.why).padEnd(26)} ${why.id.slice(0, 16)}  ${title}`)
    }
    for (const d of r.dropped || []) {
      console.log(`      · dropped ${String(d.id).slice(0, 16)} (${d.reason})`)
    }
    if (!r.got.length) console.log('      （零注入）')
    if (!s.expect.length && r.got.length) {
      violations++
      console.log(`      ✘ 对照组失守：期望零注入，实得 ${r.got.length} 条`)
    }
  }
  printSelfcheck(items)
  console.log('\n  （--store 模式：对照组硬闸门 + 语义精确率只报告；池子里共 %d 条候选）', pool.length)
  if (violations) {
    console.log(`\n  对照组失守 ${violations} 个场景`)
    process.exit(1)
  }
  process.exit(0)
}

const m = measure(POOL, SCENARIOS)
printReport(m)

// --- 1. 池子与场景自身的完整性 ---
{
  const ids = new Set(POOL.map((i) => i.id))
  for (const s of SCENARIOS) {
    for (const id of s.expect) assert.ok(ids.has(id), `场景 ${s.name} 的 expect 引用了不存在的条目 ${id}`)
  }
  assert.ok(SCENARIOS.length >= 8, '场景数不足')
  ok(`标注集：${POOL.length} 条候选 / ${SCENARIOS.length} 个场景，expect 全部可解析`)
}

// --- 2. 棘轮：不得比记录的基线更差 ---
{
  assert.ok(
    m.precision >= BASELINE.precision - 1e-9,
    `精确率回退：${m.precision.toFixed(2)} < 基线 ${BASELINE.precision.toFixed(2)}`,
  )
  assert.ok(
    m.recall >= BASELINE.recall - 1e-9,
    `召回率回退：${m.recall.toFixed(2)} < 基线 ${BASELINE.recall.toFixed(2)}`,
  )
  ok(`棘轮守住：precision ≥ ${BASELINE.precision.toFixed(2)}、recall ≥ ${BASELINE.recall.toFixed(2)}`)
}

// --- 3. 闸门：精确率 + 对照组零注入（S2 之后这就是硬门）---
{
  const f = m.rows.find(({ s }) => s.name.startsWith('F '))
  assert.equal(f.r.got.length, 0, `对照组不该有任何注入，实得 ${f.r.got.join(',')}`)
  ok('闸门：对照组零注入（文件名 / 扩展名 / 命令都不再触发）')
  assert.ok(m.precision >= GATE_PRECISION, `精确率未达闸门 ${GATE_PRECISION}：实得 ${m.precision.toFixed(2)}`)
  ok(`闸门：precision ≥ ${GATE_PRECISION}（实得 ${m.precision.toFixed(2)}）`)
}

// --- 4. 准入化不变量：没有任何可触发成员的条目一律推不动 ---
{
  // keywords 会（有意地）降级为 intents，所以"没有 when"要用**全死值**的 trigger 来构造：
  // 旧 action 表里有一批从来没进过 ACTION_LEXICON 的值（interview-prep 之类）。
  const bare = L('bare_dead', '只有死 action 的条目', { trigger: { actions: ['interview-prep'] } })
  const normalized = normalizeTrigger(bare, { legacyScope: CFG.legacyScope })
  assert.equal(normalized.trigger.when.ops, undefined, '死 action 不应产出任何 op')
  const r = runScenario({ name: 'x', tags: [], human: '阈值和注入都要改', actions: [], expect: [] }, [bare])
  assert.equal(r.got.length, 0, '没有任何可触发成员的条目不得被推送')
  ok('准入化：没有可触发成员（死 action / 坏 glob）的条目不推送，只按需拉取')
}

// --- 5. 意图词必须过词边界与引用剥离 ---
{
  const ext = L('bare_ext', '扩展名触发', { trigger: { paths: ['*.pptx'] } })
  const quoted = L('bare_quote', '文件名里的词', { trigger: { keywords: ['调研'] } })
  const r = runScenario({
    name: 'x',
    tags: [],
    human: '把 "石啸天-记忆方向调研.pptx" 的创建时间改到昨天',
    actions: [bash('ls -la /mnt/c/x/石啸天-记忆方向调研.pptx')],
    expect: [],
  }, [ext, quoted])
  assert.equal(r.got.length, 0, `坏 glob 与引用内容都不得触发：${r.got.join(',')}`)
  ok('引用剥离 + 坏 glob 拦截：文件名里的词与 *.pptx 都不触发')
}

if (gate) ok('--gate：显式跑闸门（与默认行为一致）')

console.log(`\ninjection-scenarios tests: ${passed} passed`)
