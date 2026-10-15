// 注入准入的场景回归（PLAN S0/S5）：带标注的 8 个场景 + 四个数（命中 / 假阳性 / 字符 / 次数）。
//   node test/injection-scenarios.test.mjs                 # 合成池冒烟（P/R 地板 + 对照组零注入）
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
import { insightScoringText } from '../src/recall.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const L = (id, title, extra = {}) => ({ id, kind: 'lesson', scope: 'global', title, fix: `${title} 的做法`, confidence: 1, archived: false, ...extra })
const P = (id, title, extra = {}) => ({ id, kind: 'procedure', scope: 'global', title, steps: [`${title} 第 1 步`, `${title} 第 2 步`], confidence: 1, archived: false, ...extra })

/**
 * 候选池：右侧注释标出它对应的实测条目（已去掉 id）。
 * 刻意保留致病的 trigger 写法——回归要盯的正是它们。
 */
const POOL = [
  P('p_arxiv', '本机查论文/仓库改用 curl', { trigger: { keywords: ['arxiv', '论文', 'paper', 'web_fetch', 'web_search', 'pptx', '爬取', '摘要'], actions: ['research', 'web-fetch'], paths: ['*.pptx'] } }), // 实测条目
  P('p_render', '无 root 把 PPTX 渲染成可校验版面', { trigger: { keywords: ['pptx', 'ppt', 'libreoffice', 'soffice', '渲染', '幻灯'], actions: ['generate-pptx', 'render'], paths: ['*.pptx', '*.pdf'] } }), // 实测条目
  L('l_pptxgenjs', 'pptxgenjs 的 LAYOUT_16x9 是 10x5.625', { trigger: { keywords: ['pptxgenjs', 'LAYOUT_16x9', '16:9', '幻灯片', 'ppt'], actions: ['generate-pptx'], paths: ['*.pptx'] } }), // 实测条目
  P('p_purge', '误删文件后的恢复顺序', { trigger: { keywords: ['误删', '恢复', '找回', 'rm', '丢了', 'deleted', 'zstd', '快照'], actions: ['delete', 'recover', 'cleanup'] } }), // 实测条目
  L('l_readimage', '工具被拒时先查能力声明', { trigger: { keywords: ['read_image', '视觉', 'inputModalities', '图片', '看图'], actions: ['read-image'], paths: ['**/settings.yaml', '*.png', '*.jpg'] } }), // 实测条目
  L('l_curated', '调研下结论前先按日期扫最近半年', { trigger: { keywords: ['调研', '空白', '综述', '方向', 'state of the art', '没人做'], actions: ['research', 'survey'] } }), // 实测条目
  L('l_wslpnpm', '两个同名可执行文件抢先命中 PATH'), // 实测条目（无 authored trigger，只可能走提示通道）
  L('l_pkgfiles', '文档承诺的脚本在仓库里≠在 npm 包里', { trigger: { keywords: ['上传', '没上传', 'npm 包', '发布', '发版', '打包', 'files 白名单', 'tarball'], actions: ['npm-publish', 'npm-pack', 'git-push'], paths: ['package.json', 'README*', 'CHANGELOG*'] } }), // 实测条目
  P('p_npmpub', '发版流程', { trigger: { keywords: ['npm publish', '发版', '发布', 'release', 'version bump', 'tag', 'CHANGELOG'], scope: ['release', 'npm', 'dsh-project-memory'] } }), // 实测条目（scope 与画像 tag 错配 → 推不动）
  L('l_changelog', 'CHANGELOG 已写新版本段、package.json 未 bump'), // 实测条目（无 authored trigger）
  L('l_readmedrift', 'README 跟代码漂移', { trigger: { keywords: ['README', '文档', '过时', '漂移', '版本号', '默认值'], actions: ['release', 'write-docs'], paths: ['README*', 'CHANGELOG*', 'package.json'] } }), // 实测条目
  L('l_deldoc', '清理内部文档前别只看文件名', { trigger: { keywords: ['删除', '清理', 'notes.md', 'TODO', 'gitignore', '内部文档'], actions: ['delete', 'cleanup', 'git-add', 'git-commit'], paths: ['.gitignore', 'notes.md', 'TODO-*.md'] } }), // 实测条目
  L('l_reload', '热更新在运行中的宿主里不生效', { trigger: { keywords: ['重载', '重启', 'not a declared property', 'schema'], actions: ['reload'], paths: ['src/tools/query-memory.js', 'src/index.js'] } }), // 实测条目
  L('l_budget', '被预算挤掉时要不要出声', { trigger: { keywords: ['budgetLog', 'auto-inject', 'degraded', '预算', '日志', '终端噪音'] } }), // 实测条目
  L('l_dedupe', '重复注入的判重粒度不能取整块', { trigger: { keywords: ['注入频率', '重复注入', '去重', 'fingerprint', 'auto-inject', '上下文噪音'] } }), // 实测条目
  L('l_retrieval', 'insight 层必须有检索通道', { trigger: { keywords: ['注入', '召回', '阈值', 'triggerDerived', 'signalMinRatio', 'auto-inject'] } }), // 实测条目
  L('l_procscope', 'procedure 不能走统计提示通道', { trigger: { keywords: ['procedure', 'scope', '画像过滤'], paths: ['src/auto-inject.js', 'src/readiness.js'] } }), // 实测条目
  P('p_bench', '独立基准脚本 scripts/bench.mjs', { trigger: { keywords: ['bench', '基准', '性能', '复现', 'p50'], actions: ['benchmark'], paths: ['scripts/bench.mjs', 'README.md'] } }), // 实测条目
  P('p_testing', '被问「你怎么测试的」时的答法', { trigger: { keywords: ['测试', '怎么测', '性能数据', 'benchmark', '验证', '复现'] } }), // 实测条目
  L('l_harness', '检索基准 harness 会静默骗人'), // 实测条目（无 authored trigger）
  L('l_wslio', 'WSL2 小文件 I/O 慢约 3×'), // 实测条目（无 authored trigger）
  L('l_followup', '被追问时先给机制再给结论', { trigger: { keywords: ['追问', '提问', '机制', '原理', '讲解', '引用'] } }), // 实测条目
  L('l_perfnum', '对外引用性能数字必须带规模+硬件口径', { trigger: { keywords: ['性能', '基准', 'benchmark', 'ms', '延迟', '下载量', 'star', '测试数'], actions: ['report-metrics'] } }), // 实测条目
  L('l_honesty', '对外材料只写亲手验证过的事实', { trigger: { keywords: ['夸大', '口径', '材料', '群发', '对外'] } }), // 实测条目
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
    // p_npmpub 在 expect 里：它的 legacy `scope=['release','npm','dsh-project-memory']` 与派生画像
    // tag 无交集，旧默认（`legacyScope: 'filter'`）把这条最该命中的 procedure 判死；
    // 0.5.16 把默认改成 `'ignore'` 后它按 `when.intents`（'npm publish'）正常命中。
    expect: ['l_changelog', 'l_pkgfiles', 'l_readmedrift', 'p_npmpub'],
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
    name: 'G 误删内部笔记',
    tags: ['dsh-plugin'],
    human: '我好像把 notes.md 删了，还能找回吗',
    actions: [bash('ls -la notes.md')],
    expect: ['p_purge', 'l_deldoc'],
  },
  {
    name: 'E 同事追问机制',
    tags: [],
    human: '同事追问 PaperX 的核心机制，我该怎么说',
    actions: [read('docs/faq.md')],
    // l_perfnum 不进 expect：它的触发面是"对外报数字"，本场景是"被追问机制"。
    expect: ['l_followup'],
  },
  {
    name: 'H 同事问怎么测试的',
    tags: [],
    human: '同事问我这个插件是怎么测试的',
    actions: [read('README.md')],
    // p_testing 的意图词"测试 / 怎么测"命中即注入，是意图通道的设计行为。
    expect: ['p_testing'],
  },
  {
    name: 'F 对照：改 pptx 时间戳（真实原文）',
    tags: [],
    human: '你在wsl，怎么把"C:\\Users\\me\\OneDrive\\桌面\\示例调研.pptx"这个文件的创建时间从”2026年9月16日，21:00:14“改到昨天17：23：14。',
    actions: [
      bash('ls -la /mnt/c/Users/me/OneDrive/桌面/示例调研.pptx'),
      bash('powershell.exe -NoProfile -Command SetFileTime'),
    ],
    // 整份 PLAN 的验收底线：文件名里的"调研"、扩展名 .pptx、powershell 命令，都不许触发任何东西。
    expect: [],
  },
  // 下面三条是**自然语言对照**（2026-10-12 新增）：expect 为空，但查询是**人类口语句子**、
  // 且刻意不含任何池内 trigger 关键词。存在的理由：原来的对照 F 是"文件名 + 扩展名 + 命令"
  // 的**路径型**查询，向量在那种查询上天然低分（0.38 封顶），拿它当唯一对照会把"余弦能不能
  // 当出声判据"量得过分乐观。要定阈值就必须有"自然语言但与语料无关"的对照。
  {
    name: 'L 对照·自然语言 改变量名',
    tags: [],
    human: '帮我把这个函数的变量名统一改成小驼峰',
    actions: [],
    expect: [],
  },
  {
    name: 'M 对照·自然语言 调边距',
    tags: [],
    human: '这个页面在手机上的边距太大了，帮我调小一点',
    actions: [],
    expect: [],
  },
  {
    name: 'N 对照·自然语言 排序',
    tags: [],
    human: '把这个列表按日期倒序排一下',
    actions: [],
    expect: [],
  },
  {
    name: 'O 对照·自然语言 excel 时间格式',
    tags: [],
    human: '这个 excel 导出的时间格式不对，帮我改成 yyyy-mm-dd',
    actions: [],
    expect: [],
  },
  {
    name: 'P 对照·自然语言 加 toString',
    tags: [],
    human: '帮我给这个类加一个 toString 方法',
    actions: [],
    expect: [],
  },
]

/**
 * hint-only 标注场景（2026-10-12 新增，**待复核**）：expect 只含**没有 authored trigger** 的条目，
 * 因此只可能由统计提示通道交付——这是唯一能度量"向量重排"的标注面。
 *
 * 为什么必须新加：上面 8 个场景的 15 条 expect 里 14 条由 trigger 通道交付（实测），
 * 那个 ratchet 钉的是 trigger 通道，向量臂在它上面**结构上不可能**有效果。
 *
 * 选词纪律：查询里不出现任何池内 trigger 的关键词（`基准`/`发版`/`版本号`/`打包`…），
 * 也不给 actions——否则触发器会顺带命中，把"提示通道"的度量污染成假阳性。
 * 标注由 agent 起草、**尚未经作者复核**，故默认只记分不设召回硬门（精度仍设门，见下）。
 */
const HINT_SCENARIOS = [
  {
    name: 'I hint-only WSL 小文件慢',
    tags: [],
    human: '我这个 WSL 环境里读小文件特别慢，是不是文件系统的问题',
    actions: [],
    expect: ['l_wslio'],
  },
  {
    name: 'J hint-only 检索脚本骗人',
    tags: [],
    human: '我那个检索评测脚本明明语料是空的却给了满分，harness 是不是在骗我',
    actions: [],
    expect: ['l_harness'],
  },
  {
    name: 'K hint-only WSL 版 pnpm',
    tags: [],
    human: '我在 WSL 里装的 pnpm 好像和 CI 上跑的不是同一个版本',
    actions: [],
    expect: ['l_wslpnpm'],
  },
]

const CFG = cfgEngine({ insight: {}, autoContext: { maxTokens: 400 } })

function poolStore(items) {
  return { insightItems: () => items }
}

function runScenario(s, pool, cfg = CFG, rerank = null) {
  const out = buildInjection({
    query: s.human,
    readiness: { humanText: s.human, actionText: s.actions.join('\n') },
    task: null,
    store: poolStore(pool),
    globalStore: null,
    projectTagsList: s.tags || [],
    cfg,
    rerank,
  })
  const got = out.reasons.map((r) => r.id)
  const hintGot = out.reasons.filter((r) => r.channel === 'hint').map((r) => r.id)
  const hit = got.filter((id) => s.expect.includes(id))
  const fp = got.filter((id) => !s.expect.includes(id))
  const fn = s.expect.filter((id) => !got.includes(id))
  return { got, hintGot, hit, fp, fn, chars: out.text.length, injections: out.text ? 1 : 0, why: out.reasons, dropped: out.dropped, candidates: out.candidates }
}

/**
 * 通道 1（authored trigger）与通道 2（统计提示）必须**分开记分**。
 *
 * 为什么：8 个场景 15 条 expect 里 14 条由 trigger 通道交付，只有 `l_changelog` 一条走 hint
 * （实测已验证）。也就是这个 ratchet 原先测的是 trigger 通道——而向量重排只作用于 hint。
 * 混在一起记分会让"向量臂"看起来毫无作用（本来就已经 P/R=1.00），也会掩盖 hint 通道的真实漏召。
 * `HINT_ONLY_IDS` = 池子里没有 authored trigger、**只可能**由 hint 通道交付的条目。
 */
const HINT_ONLY_IDS = new Set(['l_wslpnpm', 'l_changelog', 'l_harness', 'l_wslio'])

function measure(pool, scenarios, rerank = null, cfg = CFG) {
  let tp = 0
  let fp = 0
  let fn = 0
  let chars = 0
  let injections = 0
  let hintTp = 0
  let hintFp = 0
  let hintOnlyExp = 0
  let hintOnlyGot = 0
  const rows = []
  for (const s of scenarios) {
    const r = runScenario(s, pool, cfg, rerank)
    tp += r.hit.length
    fp += r.fp.length
    fn += r.fn.length
    chars += r.chars
    injections += r.injections
    hintTp += r.hintGot.filter((id) => s.expect.includes(id)).length
    hintFp += r.hintGot.filter((id) => !s.expect.includes(id)).length
    const only = s.expect.filter((id) => HINT_ONLY_IDS.has(id))
    hintOnlyExp += only.length
    hintOnlyGot += only.filter((id) => r.hintGot.includes(id)).length
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
    hintTp,
    hintFp,
    hintOnlyExp,
    hintOnlyGot,
    hintPrecision: hintTp + hintFp === 0 ? 1 : hintTp / (hintTp + hintFp),
    hintRecall: hintOnlyExp === 0 ? 1 : hintOnlyGot / hintOnlyExp,
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
// 合成池的定位（2026-10-11 起）：**冒烟 + 地板**，不再是逐位棘轮。
//
// 历史基线（留档）：2026-09-16 v1（准入化前）P 0.48 / R 0.72；v2（S1–S4）P/R 1.00/1.00。
// 为什么退掉"必须 ≥ 1.00"：那钉的是**当前实现的行为**，任何真实改进（删一个错门槛、
// 修一条被判死的 trigger）都会以"回归"名义被拦下；而且场景由写 trigger 的同一个作者构造，
// 结构上测不出漏召。硬门只留两条：**对照组零注入**（下面第 3 段）与下面的地板。
const GATE_PRECISION = 0.9
const GATE_RECALL = 0.9

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

// --- 2. 合成池退回**冒烟**：只报告 + 地板，不再拿"逐位不变"当棘轮 ---
// 为什么退：原棘轮钉的是 `precision/recall ≥ 1.00`（= 当前实现的行为）。任何真实改进
// （删一个错门槛、修一条被判死的 trigger）都会以"回归"的名义被拦下 —— 0.5.16 修好
// legacy scope 后场景 A 多注入 p_npmpub，正是这种情形。合成场景由写 trigger 的同一个作者
// 构造，结构上测不出漏召，所以它只配当冒烟，硬门留给"对照组零注入"与地板。
{
  assert.ok(
    m.precision >= GATE_PRECISION,
    `精确率低于地板 ${GATE_PRECISION}：${m.precision.toFixed(2)}`,
  )
  assert.ok(
    m.recall >= GATE_RECALL,
    `召回率低于地板 ${GATE_RECALL}：${m.recall.toFixed(2)}`,
  )
  ok(`冒烟：precision ${m.precision.toFixed(2)} ≥ ${GATE_PRECISION}、recall ${m.recall.toFixed(2)} ≥ ${GATE_RECALL}（不再是逐位棘轮）`)
}

// --- 3. 闸门：精确率 + 对照组零注入（S2 之后这就是硬门）---
{
  // 对照组 = **所有** expect 为空的场景（F 路径型 + L/M/N 自然语言型）。
  const f = m.rows.find(({ s }) => s.name.startsWith('F '))
  assert.equal(f.r.got.length, 0, `对照组不该有任何注入，实得 ${f.r.got.join(',')}`)
  ok('闸门：对照组零注入（文件名 / 扩展名 / 命令都不再触发）')
  const bad = m.rows.filter(({ s, r }) => !s.expect.length && r.got.length)
  // 已知基线缺陷（2026-10-12 记录，**不是**放行而是钉住）：自然语言对照 N「把这个列表按日期
  // 倒序排一下」会经提示通道注入 `l_curated`（"调研下结论前先按日期扫最近半年"），
  // 判据 `relative:1.00 cov:1.00/2` 全关通过——纯粹因为共享"日期"二字，是典型的词法巧合假阳性。
  // 上界钉在 1：它不许变多；等向量层把这条压掉之后要改成 0（tools/vector-eval 的救援扫描在看）。
  // 路径型对照 F 仍是 0（下面单独断言，那是原有硬门）。
  const nlCtrls = m.rows.filter(({ s }) => !s.expect.length && s.name.startsWith('F ') === false)
  const nlBad = nlCtrls.filter(({ r }) => r.got.length)
  assert.ok(
    nlBad.length <= 1,
    `自然语言对照的假阳性变多了（上界 1）：${nlBad.map(({ s, r }) => `${s.name}→${r.got.join(',')}`).join('; ')}`,
  )
  if (nlBad.length) {
    console.log(`  ⚠ 已知基线缺陷（上界 1）：${nlBad.map(({ s, r }) => `${s.name} → ${r.got.join(',')}`).join('; ')}`)
  }
  ok(`闸门：${nlCtrls.length} 个自然语言对照假阳性 ≤ 1（已验证 0 或已知那 1 条）`)
  assert.ok(m.precision >= GATE_PRECISION, `精确率未达闸门 ${GATE_PRECISION}：实得 ${m.precision.toFixed(2)}`)
  ok(`闸门：precision ≥ ${GATE_PRECISION}（实得 ${m.precision.toFixed(2)}）`)
}

// --- 3b. legacy scope 必须默认忽略（定向：地板抓不住回退）---
// 场景 A 少注入 p_npmpub 时是 14/15 = 0.93，仍高于 0.9 地板 —— 所以地板**抓不住**这条回退，
// 必须定向断言。它测的是：引擎默认配置下，"发版 + npm publish"语境真的能把发布流程推出来。
{
  assert.equal(cfgEngine({}).legacyScope, 'ignore', "cfgEngine 默认必须是 'ignore'")
  const a = m.rows.find(({ s }) => s.name.startsWith('A '))
  assert.ok(
    a.r.got.includes('p_npmpub'),
    `场景 A 必须注入 p_npmpub（legacy scope 被误当收窄条件时它会消失），实得 ${a.r.got.join(',')}`,
  )
  ok('legacy scope 默认忽略：发版场景真的推出 p_npmpub')
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
    human: '把 "示例调研.pptx" 的创建时间改到昨天',
    actions: [bash('ls -la /mnt/c/x/示例调研.pptx')],
    expect: [],
  }, [ext, quoted])
  assert.equal(r.got.length, 0, `坏 glob 与引用内容都不得触发：${r.got.join(',')}`)
  ok('引用剥离 + 坏 glob 拦截：文件名里的词与 *.pptx 都不触发')
}

if (gate) ok('--gate：显式跑闸门（与默认行为一致）')

// --- 6. hint-only 组：唯一能度量统计提示通道（进而度量向量重排）的标注面 ---
// 硬门只设**精度**（提示通道不许出现假阳性——那正是用户抱怨的"召回了无关的东西"）；
// 召回只报告不设门，因为标注是 agent 起草、尚未复核，设门等于把起草者的猜测钉成规格。
{
  const hm = measure(POOL, HINT_SCENARIOS)
  console.log('\n  === hint-only 组（expect 只含无 trigger 的条目，只能由提示通道交付）===')
  for (const { s, r } of hm.rows) {
    const got = r.hintGot.length ? r.hintGot.join(',') : '（提示通道零注入）'
    const missed = s.expect.filter((id) => !r.hintGot.includes(id))
    console.log(`  ${s.name.padEnd(30)} 交付 ${got}${missed.length ? `   漏召 ${missed.join(',')}` : ''}`)
    for (const d of r.dropped || []) console.log(`        · dropped ${d.id} (${d.reason})`)
    for (const c of r.candidates || []) {
      if (!s.expect.includes(c.id)) continue
      console.log(`        · 目标条目判据 rel=${c.rel} coverage=${c.coverage} matched=${c.matched} decision=${c.decision} outcome=${c.outcome}`)
    }
  }
  console.log(`  hint 通道：精度 ${hm.hintPrecision.toFixed(2)} (${hm.hintTp}/${hm.hintTp + hm.hintFp})   只可能由 hint 交付的条目召回 ${hm.hintOnlyGot}/${hm.hintOnlyExp}`)
  const fpIds = hm.rows.flatMap(({ s, r }) => r.hintGot.filter((id) => !s.expect.includes(id)).map((id) => `${s.name}/${id}`))
  assert.equal(hm.hintFp, 0, `提示通道出现了 ${hm.hintFp} 条假阳性：${fpIds.join(', ')}`)
  ok('hint-only 组：提示通道零假阳性（召回只报告，见上）')
}

// --- 7. 向量重排臂（`--vector <leanvec 目录>`）：默认不跑，CI 不需要 leanvec ---
// 这是可选依赖的**运行时降级**口径：装了就启用、没装就走纯词法，行为不变。
{
  const vectorDir = argOf('--vector') || process.env.LEANVEC_DIR || null
  if (!vectorDir) {
    console.log('\n  （未给 --vector <leanvec 目录>：向量重排臂跳过；注入行为与旧版逐字节一致）')
  } else {
    const { loadLeanvec } = await import(path.join(vectorDir, 'src/embed.mjs'))
    const lv = loadLeanvec({
      table: path.join(vectorDir, 'dist/leanvec.f32'),
      tokenizer: path.join(vectorDir, 'dist/leanvec.tokenizer.json'),
    })
    const memo = new Map()
    const vecOf = (it) => {
      let v = memo.get(it.id)
      if (v === undefined) { v = lv.embed(insightScoringText(it)); memo.set(it.id, v) }
      return v
    }
    const rerank = {
      score(q, cands) {
        const out = new Map()
        const qv = lv.embed(q)
        if (!qv) return out // 查询无法编码 → 空 Map → 排序退化回纯词法，不被压平
        for (const it of cands) { const v = vecOf(it); if (v) out.set(it.id, lv.cosine(qv, v)) }
        return out
      },
    }
    console.log(`\n  === 向量重排臂（${lv.size.toLocaleString()} 行 × ${lv.dim} 维）===`)
    console.log('  α     全场景 P/R        hint-only：提示通道 P (tp/fp)   hint-only 召回')
    const sweep = []
    for (const alpha of [0, 0.25, 0.5, 0.75, 1]) {
      const rr = alpha === 0 ? null : { ...rerank, alpha }
      const a = measure(POOL, SCENARIOS, rr)
      const b = measure(POOL, HINT_SCENARIOS, rr)
      sweep.push({ alpha, a, b })
      console.log(`  ${String(alpha).padEnd(5)} ${a.precision.toFixed(2)} / ${a.recall.toFixed(2)}          ${b.hintPrecision.toFixed(2)} (${b.hintTp}/${b.hintTp + b.hintFp})              ${b.hintOnlyGot}/${b.hintOnlyExp}`)
    }
    const base = sweep[0]
    const best = sweep.slice(1).reduce((x, y) => (y.b.hintOnlyGot > x.b.hintOnlyGot ? y : x), sweep[1])
    console.log(`  基线（α=0）hint-only 召回 ${base.b.hintOnlyGot}/${base.b.hintOnlyExp} → best α=${best.alpha} 为 ${best.b.hintOnlyGot}/${best.b.hintOnlyExp}`)

    // 决定性的一对数：目标条目自己的余弦 vs **对照场景**（expect 为空）的最高余弦。
    // 若两者重叠，则余弦不能当"该不该出声"的绝对判据（这正是它不能替 hintMinSupport 的原因）。
    const cosOfTarget = (s) => {
      const m2 = rerank.score(s.human, POOL)
      const ranked = [...m2.entries()].sort((a, b) => b[1] - a[1])
      return { target: m2.get(s.expect[0]) ?? null, rank: ranked.findIndex(([id]) => id === s.expect[0]) + 1, top: ranked[0] }
    }
    console.log('  hint-only 目标条目的余弦：')
    for (const s of HINT_SCENARIOS) {
      const t = cosOfTarget(s)
      console.log(`     ${s.name.padEnd(30)} cos=${t.target == null ? '-' : t.target.toFixed(3)}  池内第 ${t.rank} 名  （池内最高 ${t.top[1].toFixed(3)}/${t.top[0]}）`)
    }
    const ctrlF = SCENARIOS.find((s) => !s.expect.length)
    const cf = rerank.score(ctrlF.human, POOL)
    const cTop = [...cf.entries()].sort((a, b) => b[1] - a[1])[0]
    console.log(`     对照「${ctrlF.name}」最高 cos=${cTop[1].toFixed(3)}/${cTop[0]}  ← 绝对阈值的可行性下限`)

    // 自然语言对照的最高余弦 = 出声阈值的**上界**（必须比它高才不误出声）
    console.log('  自然语言对照的最高余弦（阈值必须高于这些值）：')
    for (const s of SCENARIOS.filter((x) => !x.expect.length && x.actions.length === 0)) {
      const m2 = rerank.score(s.human, POOL)
      const t = [...m2.entries()].sort((a, b) => b[1] - a[1])[0]
      console.log(`     ${s.name.padEnd(30)} max cos=${t[1].toFixed(3)}/${t[0]}`)
    }

    // item 级余弦地板要用的数：**提示通道实际交付的每一条**的余弦。
    // 若"词法巧合的假阳性"余弦明显低于"真命中"，则地板能把它压掉；若重叠，则不能。
    console.log('\n  === 提示通道交付条目的余弦（定 item 级地板用）===')
    for (const s of [...SCENARIOS, ...HINT_SCENARIOS]) {
      const m2 = rerank.score(s.human, POOL)
      const gotHint = measure(POOL, [s], { ...rerank, alpha: 0.5 }).rows[0].r.hintGot
      for (const id of gotHint) {
        const mark = s.expect.includes(id) ? '✔真命中' : '✘假阳性'
        console.log(`     ${mark}  ${s.name.padEnd(30)} cos=${(m2.get(id) ?? -1).toFixed(3)}  ${id}  ← ${String(POOL.find((p) => p.id === id)?.title || '').slice(0, 30)}`)
      }
    }
    // 全部 expect 条目的余弦（对照用）：看真命中的下界在哪
    const expCos = []
    for (const s of [...SCENARIOS, ...HINT_SCENARIOS]) {
      const m2 = rerank.score(s.human, POOL)
      for (const id of s.expect) if (m2.has(id)) expCos.push({ id, s: s.name, cos: m2.get(id) })
    }
    expCos.sort((a, b) => a.cos - b.cos)
    console.log(`     expect 条目余弦：最低 5 个 ${expCos.slice(0, 5).map((x) => `${x.cos.toFixed(2)}/${x.id}`).join('  ')}`)

    console.log('\n  === 语义救援扫描（speakMin 替代通道级 support 沉默；α=0 只开救援不改排序）===')
    console.log('  speakMin  α     全场景 P/R    hint-only 召回   自然语言对照注入   被救援的步')
    for (const speakMin of [0.4, 0.45, 0.5, 0.55]) {
      for (const alpha of [0, 0.5]) {
        const rr = { ...rerank, alpha, speakMin }
        const a = measure(POOL, SCENARIOS, rr)
        const b = measure(POOL, HINT_SCENARIOS, rr)
        const ctrls = a.rows.filter(({ s }) => !s.expect.length)
        const ctrlInject = ctrls.reduce((n, { r }) => n + r.got.length, 0)
        const rescued = [...a.rows, ...b.rows].filter(({ r }) => (r.candidates || []).some((c) => c.rescue === 1)).length
        console.log(`  ${String(speakMin).padEnd(8)} ${String(alpha).padEnd(5)} ${a.precision.toFixed(2)} / ${a.recall.toFixed(2)}        ${b.hintOnlyGot}/${b.hintOnlyExp}              ${ctrlInject}                ${rescued}`)
        if (alpha === 0 && b.hintOnlyGot > 0) {
          for (const { s, r } of b.rows) console.log(`        · ${s.name.padEnd(28)} hint 交付 ${r.hintGot.join(',') || '（无）'}`)
        }
        if (ctrlInject > 0) {
          for (const { s, r } of ctrls) if (r.got.length) console.log(`        ✘ ${s.name} 误出声 → ${r.got.join(',')}`)
        }
      }
    }

    console.log('\n  === item 级余弦地板扫描（只作用于提示通道；α=0.5）===')
    console.log('  itemMin  全场景 P/R    hint-only 召回   自然语言对照注入   提示通道实际交付')
    for (const itemMin of [0, 0.35, 0.4, 0.45, 0.5, 0.55]) {
      const rr = { ...rerank, alpha: 0.5, itemMin }
      const a = measure(POOL, SCENARIOS, rr)
      const b = measure(POOL, HINT_SCENARIOS, rr)
      const ctrls = a.rows.filter(({ s }) => !s.expect.length)
      const ctrlInject = ctrls.reduce((n, { r }) => n + r.got.length, 0)
      const delivered = [...a.rows, ...b.rows].flatMap(({ s, r }) => r.hintGot.map((id) => `${s.name.split(' ')[0]}:${id}`))
      console.log(`  ${String(itemMin).padEnd(8)} ${a.precision.toFixed(2)} / ${a.recall.toFixed(2)}        ${b.hintOnlyGot}/${b.hintOnlyExp}              ${ctrlInject}                ${delivered.join(' ') || '（无）'}`)
    }
    assert.ok(base.a.precision >= GATE_PRECISION, `向量臂基线精度塌了：${base.a.precision.toFixed(2)}`)
    ok(`向量重排臂：α ∈ {0,.25,.5,.75,1} 共 ${sweep.length} 档已量（best α=${best.alpha}）`)
  }
}

console.log(`\ninjection-scenarios tests: ${passed} passed`)
