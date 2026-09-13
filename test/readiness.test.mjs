// 就绪引擎（push 侧）：trigger 推广到所有 insight kind + 两个窗口 + 预算排程 —— PR2
//   node test/readiness.test.mjs
//
// 设计口径：recall 回答"记忆里有什么和这件事有关"，readiness 回答"动手之前必须知道什么"。
// 交付契约：**authored trigger = 确定性注入（优先级 1）；统计信号 = 提示态（优先级 2）**。
// 动机：实测中人类消息"你顺便提交一下"对那条 lesson 的 overlap 只有 0.014（阈值 0.25），
// 所以这次提交之前它从未到达。本文件把那个数字钉成回归。
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

// PR2 新增模块：修前不存在 → 依赖它的断言必须红。
let readiness = null
try {
  readiness = await import('../src/readiness.js')
} catch {
  readiness = null
}

function globalWith(items) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'ready-')), 'global.json')
  const gs = new GlobalStore(file).load()
  gs.doc.items.push(...items)
  return gs
}

const CFG = cfgEngine({ insight: {}, autoContext: { maxTokens: 400 } })

// 动机场景：一条 **lesson**（不是 procedure）+ 人说要提交
const PUBLIC_FACE = {
  id: 'ins_pub',
  kind: 'lesson',
  scope: 'global',
  title: '公开作品仓库的「公开面」不止文件清单',
  fix: '内部文档一律写进 .gitignore；公开前扫描 src/ test/ CHANGELOG',
  trigger: { keywords: ['公开', '内部文档', '泄漏'], actions: ['git-commit'] },
  confidence: 1,
  archived: false,
}

// ---- 1. 动作词典：人类意图也算动作 ----
{
  assert.ok(readiness, 'src/readiness.js 不存在：trigger 还只服务 procedure')
  assert.ok(readiness.detectActions('你顺便提交一下，参考记忆里的提交注意').includes('git-commit'), '意图词"提交"→ git-commit')
  assert.ok(readiness.detectActions('npm publish --access public').includes('npm-publish'))
  assert.ok(readiness.detectActions('先把仓库公开').includes('go-public'))
  assert.equal(readiness.detectActions('今天天气不错').length, 0)
  ok('detectActions：人类意图词与命令都归一成动作 id')
}

// ---- 2. 路径抽取 ----
{
  assert.ok(readiness, 'src/readiness.js 不存在')
  const paths = readiness.extractPaths('git add README.md CHANGELOG.md && npm pack')
  assert.ok(paths.includes('README.md'), `应抽到 README.md：${paths}`)
  assert.ok(paths.includes('CHANGELOG.md'))
  ok('extractPaths：从工具参数里抽路径 token')
}

// ---- 3. matchTrigger：四类判据 + 画像过滤 ----
{
  assert.ok(readiness, 'src/readiness.js 不存在')
  const ctx = readiness.buildReadinessContext({
    humanText: '你顺便提交一下，注意别泄漏内部文档',
    actionText: 'git add README.md && npm pack',
    actions: ['git-commit'],
    paths: ['README.md'],
  })
  assert.match(readiness.matchTrigger({ keywords: ['内部文档'] }, ctx) || '', /keyword/)
  assert.match(readiness.matchTrigger({ actions: ['git-commit'] }, ctx) || '', /action/)
  assert.match(readiness.matchTrigger({ paths: ['README*'] }, ctx) || '', /path/)
  assert.match(readiness.matchTrigger({ symbols: ['npm'] }, ctx) || '', /symbol/)
  assert.equal(readiness.matchTrigger(null, ctx), null)
  assert.equal(readiness.matchTrigger({ keywords: ['zzz'] }, ctx), null)
  ok('matchTrigger：keywords / symbols / actions / paths 四类判据')
}

// ---- 4. 动机回归：lesson 的 authored trigger 必须让人在动手前看到它 ----
{
  const gs = globalWith([PUBLIC_FACE])
  const out = buildInjection({
    query: '你顺便提交一下',
    readiness: { humanText: '你顺便提交一下', actions: ['git-commit'], paths: [], actionText: '' },
    globalStore: gs,
    cfg: CFG,
  })
  assert.ok(out.text.includes('公开面'), `lesson trigger 命中即注入；实际: ${JSON.stringify(out.text)}`)
  assert.ok(out.reasons.some((r) => r.channel === 'trigger'), '必须记录命中通道（可审计）')
  ok('动机回归：lesson 的 trigger 命中，动手前注入（修前 0.014 从未到达）')
}

// ---- 5. 反应窗口：观察到的动作走同一个匹配器 ----
{
  const gs = globalWith([PUBLIC_FACE])
  const out = buildInjection({
    query: '继续',
    readiness: { humanText: '继续', actions: [], paths: [], actionText: 'git commit -m "docs: x"' },
    globalStore: gs,
    cfg: CFG,
  })
  assert.ok(out.text.includes('公开面'), 'actionText 里的 git commit 也应命中 trigger.actions')
  ok('反应窗口：已观察到的动作同样触发注入')
}

// ---- 6. 精度护栏：无 trigger + 无关内容 → 不注入 ----
{
  const unrelated = { id: 'ins_jwt', kind: 'lesson', scope: 'global', title: 'JWT 未校验 exp', fix: '用 jose 校验 exp/nbf', confidence: 1, archived: false }
  const gs = globalWith([unrelated])
  const out = buildInjection({
    query: '你顺便提交一下',
    readiness: { humanText: '你顺便提交一下', actions: ['git-commit'], paths: [] },
    globalStore: gs,
    cfg: CFG,
  })
  assert.equal(out.text, '', '无关 lesson 不得被注入（相对阈值 + 零分过滤）')
  ok('精度护栏：无关 lesson 不注入')
}

// ---- 7. 提示通道：没有 trigger，但语义相关也能进来（标记为 hint）----
{
  const lesson = { id: 'ins_reg', kind: 'lesson', scope: 'global', title: 'npm 发包要过官方源', fix: '设置 registry 为官方源', confidence: 1, archived: false }
  const gs = globalWith([lesson])
  const out = buildInjection({
    query: 'npm 发包总是失败，官方源怎么配',
    readiness: { humanText: 'npm 发包总是失败，官方源怎么配', actions: [], paths: [] },
    globalStore: gs,
    cfg: CFG,
  })
  assert.ok(out.text.includes('官方源'), `相关 lesson 应作为提示注入；实际: ${JSON.stringify(out.text)}`)
  assert.ok(out.reasons.some((r) => r.channel === 'hint'), '提示通道要能被审计')
  ok('提示通道：无 trigger 的相关 lesson 作为 hint 注入')
}

// ---- 8. 预算排程：trigger 命中先于 hint ----
{
  const hit = { ...PUBLIC_FACE }
  const hint = { id: 'ins_reg2', kind: 'lesson', scope: 'global', title: 'npm 发包要过官方源', fix: '设置 registry 为官方源', confidence: 1, archived: false }
  const gs = globalWith([hint, hit])
  const out = buildInjection({
    query: '你顺便提交一下，npm 发包也要注意',
    readiness: { humanText: '你顺便提交一下，npm 发包也要注意', actions: ['git-commit'], paths: [] },
    globalStore: gs,
    cfg: CFG,
  })
  assert.equal(out.reasons[0].channel, 'trigger', '预算排程：确定性命中优先于统计信号')
  ok('预算排程：trigger 命中排在 hint 之前')
}

// ---- 9. 相对阈值：与语料同尺度，不再是长度敏感的魔法常量 ----
{
  assert.ok(readiness, 'src/readiness.js 不存在')
  const scored = [{ id: 'a', score: 10 }, { id: 'b', score: 4 }, { id: 'c', score: 0 }]
  assert.deepEqual(readiness.relativeHits(scored, { ratioMin: 0.5 }).map((r) => r.id), ['a'])
  assert.deepEqual(readiness.relativeHits(scored, { ratioMin: 0.3 }).map((r) => r.id), ['a', 'b'])
  assert.deepEqual(readiness.relativeHits([], { ratioMin: 0.5 }), [])
  ok('relativeHits：按层内最高分取相对阈值，零分恒被剔除')
}

// ---- 10. 兼容：显式 relevanceMin 时仍走旧的绝对 overlap 判据 ----
{
  const lesson = { id: 'ins_reg3', kind: 'lesson', scope: 'global', title: 'npm 发包要过官方源', fix: '设置 registry 为官方源', confidence: 1, archived: false }
  const gs = globalWith([lesson])
  const strict = cfgEngine({ insight: {}, autoContext: { maxTokens: 400, relevanceMin: 0.9 } })
  const out = buildInjection({ query: '发包', globalStore: gs, cfg: strict })
  assert.equal(out.text, '', '显式 relevanceMin=0.9 时，overlap 不足的老行为必须保留')
  ok('兼容：显式 relevanceMin 仍走绝对 overlap 判据')
}

console.log(`\nreadiness tests: ${passed} passed`)
