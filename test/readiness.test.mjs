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

// ---- 3. matchTrigger：准入化后的三类判据（op / write / intent）+ 旧 trigger 不再触发 ----
{
  assert.ok(readiness, 'src/readiness.js 不存在')
  const ctx = readiness.buildReadinessContext({
    humanText: '你顺便提交一下，注意别泄漏内部文档',
    actionText: 'edit {"file_path":"/repo/README.md"}',
    ops: ['git-commit'],
    targets: ['README.md'],
  })
  // when 的三类判据（取或）
  assert.match(readiness.matchTrigger({ when: { ops: ['git-commit'] } }, ctx) || '', /^op:/)
  assert.match(readiness.matchTrigger({ when: { writes: ['README.md'] } }, ctx) || '', /^write:/)
  assert.match(readiness.matchTrigger({ when: { intents: ['内部文档'] } }, ctx) || '', /^intent:/)
  // guard 只能收窄
  assert.equal(readiness.matchTrigger({ when: { ops: ['git-commit'] }, guard: { paths: ['package.json'] } }, ctx), null)
  assert.equal(readiness.matchTrigger({ when: { ops: ['git-commit'] }, guard: { not_paths: ['README.md'] } }, ctx), null)
  assert.match(readiness.matchTrigger({ when: { ops: ['git-commit'] }, guard: { paths: ['README.md'] } }, ctx) || '', /^op:/)
  // 扩展名/泛名 glob 在 writes 里被硬性忽略（它们只能撒谎）
  assert.equal(readiness.matchTrigger({ when: { writes: ['*.pptx'] } }, ctx), null)
  assert.equal(readiness.matchTrigger({ when: { writes: ['README*'] } }, ctx), null)
  // 旧 trigger（没有 when）不再触发任何东西——这是 S2 的核心语义变更
  assert.equal(readiness.matchTrigger({ keywords: ['内部文档'] }, ctx), null)
  assert.equal(readiness.matchTrigger({ actions: ['git-commit'] }, ctx), null)
  assert.equal(readiness.matchTrigger({ paths: ['README.md'] }, ctx), null)
  // 意图词看的是**剥离引用后**的人类消息，且拉丁词要过词边界
  assert.equal(readiness.matchTrigger({ when: { intents: ['ppt'] } }, readiness.buildReadinessContext({ humanText: '看看这个 pptx' })), null)
  assert.equal(readiness.matchTrigger({ when: { intents: ['调研'] } }, readiness.buildReadinessContext({ humanText: '把这个 "石啸天-记忆方向调研.pptx" 的时间改一下' })), null)
  assert.match(readiness.matchTrigger({ when: { intents: ['调研'] } }, readiness.buildReadinessContext({ humanText: '帮我做一份记忆方向调研' })) || '', /^intent:/)
  assert.equal(readiness.matchTrigger(null, ctx), null)
  ok('matchTrigger：op / write / intent 三类判据；guard 只收窄；旧 trigger 与坏 glob 不再触发')
}

// ---- 3b. normalizeTrigger：旧 trigger → 新 schema（幂等、纯函数）----
{
  const legacy = {
    id: 'x',
    trigger: { keywords: ['ppt', 'VaporTok', '内部文档'], actions: ['npm-pack', 'interview-prep'], paths: ['*.pptx', 'src/a.js'], scope: ['npm'] },
  }
  const n = readiness.normalizeTrigger(legacy)
  assert.deepEqual(n.trigger.when.ops.sort(), ['npm-publish'])
  assert.deepEqual(n.trigger.when.writes, ['src/a.js'])
  assert.deepEqual(n.trigger.when.intents.sort(), ['VaporTok', '内部文档'].sort())
  assert.deepEqual(n.trigger.guard, { tags: ['npm'] })
  assert.ok(n.triggerNormalized.dropped.includes('path:*.pptx'))
  assert.ok(n.triggerNormalized.dropped.includes('action:interview-prep'))
  assert.equal(readiness.normalizeTrigger(n).trigger, n.trigger, '幂等：已是新 schema 就原样返回')
  assert.equal(legacy.trigger.when, undefined, '纯函数：不改原对象')
  ok('normalizeTrigger：actions→ops、具体 paths→writes、keywords→intents、坏 glob 丢弃')
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

// ---- 11. 就绪查询只取真人消息（注入块不得成为查询） ----
{
  const { lastUserText } = await import('../src/auto-inject.js')
  const human = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你顺便提交一下' }] }
  const injected = { role: 'user', source: { kind: 'plugin', plugin: 'dsh-project-memory' }, content: [{ type: 'text', text: '[Memory Inject] auto-context\n任务: x\n进度: 8 步' }] }
  assert.equal(lastUserText([human, injected]), '你顺便提交一下', '上一步的注入块不得成为这一步的查询（自激）')
  assert.equal(lastUserText([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]), 'hi', '无 source 的消息仍兜底（老宿主/测试）')
  ok('就绪查询只取真人消息，注入块不参与（防自激）')
}

// ---- 12. 1–2 字符拉丁缩写不作为提示证据 ----
{
  assert.ok(readiness, 'src/readiness.js 不存在')
  const acronym = { id: 'ins_pr', kind: 'lesson', scope: 'global', title: '自动安全 PR 扫描：横向越权', fix: 'authz 检查', confidence: 1, archived: false }
  const content = { id: 'ins_pub2', kind: 'lesson', scope: 'global', title: '公开作品仓库的公开面', fix: '内部文档写进 .gitignore', confidence: 1, archived: false }
  const gs = globalWith([acronym, content])
  const human = 'PR 提交前检查公开面'
  const out = buildInjection({ query: human, readiness: { humanText: human, actionText: '' }, globalStore: gs, cfg: CFG })
  const ids = out.reasons.map((r) => r.id)
  assert.ok(ids.includes('ins_pub2'), `内容命中必须进：${JSON.stringify(out.reasons)}`)
  assert.ok(!ids.includes('ins_pr'), '仅靠 "PR" 这种缩写命中的条目不得作为提示注入')
  assert.equal(readiness.hintQueryText('PR src/a.js 提交'), 'src/a.js 提交', '只剔除独立缩写，路径 token 原样保留')
  ok('提示证据：1–2 字符拉丁缩写被忽略，避免缩写巧合命中')
}

// ---- 13. 预算塞不下"有用前缀"时宁可丢弃，也不输出 stub ----
{
  const { fitBody } = await import('../src/auto-inject.js')
  assert.equal(fitBody('x'.repeat(300), 100, 120), null, '剩余预算 < 最小可用长度 → 丢弃')
  assert.equal(fitBody('short body', 200, 120), 'short body', '放得下就原样')
  assert.equal(fitBody('y'.repeat(500), 400, 120).length, 400, '截断不超过剩余预算')
  const many = []
  for (let i = 0; i < 4; i++) many.push({ id: `ins_stub_${i}`, kind: 'lesson', scope: 'global', title: '公开面检查清单', fix: 'x'.repeat(280), confidence: 1, archived: false })
  const gs = globalWith(many)
  const out = buildInjection({ query: '公开面', globalStore: gs, cfg: cfgEngine({ insight: {}, autoContext: { maxTokens: 200 } }) })
  for (const line of out.text.split('\n')) {
    if (!line.startsWith('- [')) continue
    assert.ok(line.length >= 120, `提示正文不得是 stub：${JSON.stringify(line)}`)
  }
  ok('预算压力下：宁可丢弃也不输出无意义的截断 stub')
}

console.log(`\nreadiness tests: ${passed} passed`)
