// v0.5 insight 数据层测试：node test/insight-store.test.mjs
// 覆盖：insights.json 存取往返 / 旧 experience.json 非破坏迁移幂等 / save_lesson 三级写入 /
//       去重合并 / 近重复强化带 / 跨任务 sourceTaskIds 累积与 2 任务提升 project、3 任务提升 global /
//       confidence 闸门 / 归档软删与容量 / 密文过滤 / 种子幂等 / 降级
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { ProjectMemoryStore } from '../src/store.js'
import {
  cfgInsight,
  saveInsight,
  GlobalStore,
  defaultGlobalFile,
  demoteToTask,
  overlapOf,
  pruneItems,
  applyDecay,
  recordHit,
  containsSecretFields,
  removeMemory,
} from '../src/insight-store.js'
import { ensureGlobalInit } from '../src/global-seed.js'
import { normalizedTokenOverlap } from '../src/similarity.js'
import { lessonTool } from '../src/tools/lesson-tools.js'
import { forgetTool } from '../src/tools/forget.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

function newProject(extraCfg = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'insight-'))
  const store = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
  const globalFile = path.join(root, 'global.json')
  const cfg = cfgInsight({ insight: { globalFile, ...extraCfg } })
  return { root, store, globalFile, cfg }
}

function taskOf(store, root, id, title) {
  const now = new Date().toISOString()
  store.addTask({ id, title, projectRoot: root, steps: null, files: [], archived: false, createdAt: now, updatedAt: now, lastActiveAt: now })
  return store.getTask(id)
}

const lesson = (pattern, fix = '用正确做法', conf = 0.8) => ({ title: pattern, kind: 'lesson', pattern, fix, confidence: conf })

// --- 1. insights.json 存取往返（store.commit 事务） ---
{
  const { root, store } = newProject()
  const ins = { id: 'ins_abc', kind: 'lesson', scope: 'project', title: 'JWT 未校验 exp', pattern: 'JWT 未校验 exp', fix: '用 jose', confidence: 0.9, source: 'agent', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  store.replaceInsightItems([ins])
  store.commit(() => 0)
  const store2 = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
  assert.equal(store2.insightItems().length, 1)
  assert.equal(store2.insightItems()[0].id, 'ins_abc')
  assert.ok(existsSync(path.join(root, '.dsh-project-memory', 'insights.json')))
  ok('insights.json 存取往返 + commit 事务落盘')
}

// --- 2. 旧 experience.json → insights.json 统一迁移（导入无损、旧文件归档、幂等） ---
{
  const root = mkdtempSync(path.join(tmpdir(), 'ins-mig-'))
  const dir = path.join(root, '.dsh-project-memory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'experience.json'), JSON.stringify([
    { id: 'legacy-1', problem: 'pdfjs OPS import fails on Node 24', solution: 'import from pdf.mjs', sourceFile: 'src/a.js', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'legacy-2', problem: 'Windows 路径分隔符', solution: '统一 path.join', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
  ]))
  writeFileSync(path.join(dir, 'format.json'), JSON.stringify({ version: 2, layout: 'sharded' }))
  let s1 = new ProjectMemoryStore(dir).load()
  assert.equal(s1.insightItems().length, 2)
  assert.equal(s1.insightItems()[0].kind, 'experience')
  assert.equal(s1.insightItems()[0].source, 'migrate')
  assert.equal(s1.insightItems()[0].id, 'legacy-1')
  assert.equal(s1.insightItems()[0].files[0], 'src/a.js')
  assert.ok(s1.insightsDoc().migratedAt)
  // 统一存储：内容进了 insights.json，旧文件被**归档**（不删，可人工比对），内存里不再留第二份
  assert.ok(!existsSync(path.join(dir, 'experience.json')), '旧文件要被收走，否则永远有第二个真相源')
  assert.ok(existsSync(path.join(dir, 'experience.json.migrated')), '归档副本必须在')
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'experience.json.migrated'), 'utf8')).map((e) => e.id), ['legacy-1', 'legacy-2'])
  assert.equal(s1.experience.length, 0)
  // 幂等：重新加载不重复导入，也不会因为归档过就丢条目
  s1 = new ProjectMemoryStore(dir).load()
  assert.equal(s1.insightItems().length, 2)
  assert.equal(s1.experience.length, 0)
  ok('experience.json 迁移：导入无损、旧文件归档、重复加载幂等')
}

// --- 2b. 已迁移过的老 store（migratedAt 已存在、旧文件还在）也要被收走 ---
{
  const root = mkdtempSync(path.join(tmpdir(), 'ins-mig2-'))
  const dir = path.join(root, '.dsh-project-memory')
  mkdirSync(dir, { recursive: true })
  // 0.5/0.6 用户的形态：insights.json 里已经是导入过的 experience 条目，experience.json 却还在
  writeFileSync(path.join(dir, 'insights.json'), JSON.stringify({
    version: 2,
    migratedAt: '2026-01-03T00:00:00.000Z',
    items: [{ id: 'legacy-9', kind: 'experience', scope: 'project', title: '旧笔记', problem: '旧笔记', solution: 'x', source: 'migrate', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  }))
  writeFileSync(path.join(dir, 'experience.json'), JSON.stringify([{ id: 'legacy-9', problem: '旧笔记', solution: 'x' }]))
  writeFileSync(path.join(dir, 'format.json'), JSON.stringify({ version: 2, layout: 'sharded' }))
  const s = new ProjectMemoryStore(dir).load()
  assert.equal(s.insightItems().length, 1, '已导入过就不许再导一遍')
  assert.equal(s.experience.length, 0)
  assert.ok(!existsSync(path.join(dir, 'experience.json')), '旧文件必须被收走')
  assert.ok(existsSync(path.join(dir, 'experience.json.migrated')))
  ok('老 store（已 migratedAt）也归档旧文件，且不重复导入')
}

// --- 2c. 旧版 store 形态：只有 experience.json（v0.4/0.5.0，没有 insights.json） ---
{
  const root = mkdtempSync(path.join(tmpdir(), 'ins-mig3-'))
  const dir = path.join(root, '.dsh-project-memory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'experience.json'), JSON.stringify([{ id: 'e-old', problem: '老库里的问题', solution: '老库里的解法' }]))
  writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify([{ id: 'tsk_old', title: '老任务', insights: [{ id: 'ti-1', kind: 'lesson', scope: 'task', title: '任务级老教训', pattern: 'p', fix: 'f' }] }]))
  const s = new ProjectMemoryStore(dir).load()
  assert.equal(s.insightItems().length, 1, '没有 insights.json 也能建出来')
  assert.equal(s.insightItems()[0].kind, 'experience')
  assert.equal(s.getTask('tsk_old').insights.length, 1, '任务级内容不受影响')
  assert.ok(existsSync(path.join(dir, 'insights.json')), '导入要落盘')
  ok('旧版 store（无 insights.json、有 tasks.json）直接升级')
}

// --- 2d. 空根只 load() 必须零副作用（不建目录、不凭空写 insights.json）---
// 审计靠 `auditDirReady` 的"目录已存在"放行，auto-inject 靠 `store.hasContent` 决定要不要
// save()。load() 若为一个从没被索引过的空根建目录，这两道闸门同时失效，容器目录会被
// resolveProjectMemoryRoot 当成项目根（issue #5 同类）。回归：修前这一条必失败。
{
  const root = mkdtempSync(path.join(tmpdir(), 'ins-empty-'))
  const dir = path.join(root, '.dsh-project-memory')
  const s = new ProjectMemoryStore(dir).load()
  assert.equal(s.insightItems().length, 0)
  assert.ok(!existsSync(dir), '全新空根 load() 后目录必须**不存在**')

  // 已有目录、但没有旧经验文件可导入：也不许凭空造一份 insights.json。
  const root2 = mkdtempSync(path.join(tmpdir(), 'ins-noexp-'))
  const dir2 = path.join(root2, '.dsh-project-memory')
  mkdirSync(dir2, { recursive: true })
  writeFileSync(path.join(dir2, 'watch.json'), JSON.stringify([]))
  new ProjectMemoryStore(dir2).load()
  assert.ok(!existsSync(path.join(dir2, 'insights.json')), '没有旧经验可导入时不写 insights.json')
  ok('空根 load() 零副作用：不建目录、不凭空写 insights.json')
}

// --- 3. saveInsight 三级写入 + project 内去重合并 ---
{
  const { store, globalFile, cfg } = newProject()
  const gs = new GlobalStore(globalFile).load()
  store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('JWT 未校验 exp', '用 jose 校验'), scope: 'project', cfg }))
  const r2 = store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('JWT 未校验 exp', '改用 jose 库校验全部声明'), scope: 'project', cfg }))
  assert.equal(r2.action, 'merged')
  const items = store.insightItems()
  assert.equal(items.length, 1)
  assert.equal(items[0].confidence, 0.8)
  assert.equal(items[0].hitCount, 1)
  // global 写入
  const rg = store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('WSL npm publish 官方源步骤'), scope: 'global', cfg }))
  assert.equal(rg.action, 'created')
  assert.equal(gs.items().length, 1)
  assert.equal(gs.items()[0].scope, 'global')
  ok('三级写入 + project 去重合并（merge/hitCount）')
}

// --- 4. 相似度与强化带 ---
{
  assert.equal(normalizedTokenOverlap('完全相同的文本 a b c', '完全相同的文本 a b c'), 1)
  assert.equal(normalizedTokenOverlap('abc def ghi', 'xxx yyy zzz'), 0)
  const m = normalizedTokenOverlap('JWT 未校验 exp 时间', 'JWT 未校验 exp')
  assert.ok(m > 0.65 && m < 1, `partial overlap in band: ${m}`)
  assert.ok(overlapOf('a b c d', 'a b c e') > 0.5)
  ok('归一化双向 overlap：同文=1 / 无交=0 / 部分在带内')
}

// --- 5. 密文过滤 ---
{
  const { store, globalFile, cfg } = newProject()
  const gs = new GlobalStore(globalFile).load()
  const r = store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('leak', 'key = sk-abcdefghijklmnopqrstuvwxyz123456'), scope: 'project', cfg }))
  assert.equal(r.ok, false)
  assert.match(r.error, /拒绝写入|密钥|token/i)
  assert.equal(store.insightItems().length, 0)
  assert.ok(containsSecretFields({ fix: '-----BEGIN RSA PRIVATE KEY-----\nabc' }))
  assert.ok(!containsSecretFields({ fix: '用 jose 校验 exp' }))
  ok('写盘前密文过滤：token/私钥形态拒绝，正常内容放行')
}

// --- 6. 跨任务累积 → 2 任务提升 project、3 任务提升 global ---
{
  const { root, store, globalFile, cfg } = newProject()
  const gs = new GlobalStore(globalFile).load()
  taskOf(store, root, 'tsk_a', 'A')
  taskOf(store, root, 'tsk_b', 'B')
  taskOf(store, root, 'tsk_c', 'C')
  store.commit(() => 0)

  const ra = store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('JWT 未校验 exp', '用 jose', 0.8), scope: 'task', taskId: 'tsk_a', cfg }))
  assert.equal(ra.action, 'created')
  // 第二个任务命中同一条 → 合并 sourceTaskIds，2 任务命中自动升 project
  const rb = store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('JWT 未校验 exp', '用 jose', 0.8), scope: 'task', taskId: 'tsk_b', cfg }))
  assert.equal(rb.action, 'merged')
  const pj = store.insightItems()
  assert.equal(pj.length, 1, '2 任务命中 → 自动提升 project')
  assert.equal((pj[0].sourceTaskIds || []).length, 2)
  assert.equal(pj[0].scope, 'project')
  const tasksAfter = store.getTasks()
  assert.ok(tasksAfter.every((t) => !(t.insights || []).length), 'task 层副本已移除')
  // 第三个任务命中 project 级 → 3 任务命中自动升 global
  const rc = store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('JWT 未校验 exp', '用 jose', 0.8), scope: 'task', taskId: 'tsk_c', cfg }))
  assert.equal(rc.action, 'linked-project')
  assert.equal(store.insightItems().length, 0, 'project 条目已移动')
  assert.equal(gs.items().length, 1, '3 任务命中 → 自动提升 global')
  assert.equal((gs.items()[0].sourceTaskIds || []).length, 3)
  assert.equal(gs.items()[0].movedFrom.scope, 'project')
  ok('跨任务累积 sourceTaskIds：2 任务→project，3 任务→global（无双写）')
}

// --- 7. confidence 闸门：2 任务命中但置信不足 → 不提升 ---
{
  const { root, store, globalFile, cfg } = newProject()
  const gs = new GlobalStore(globalFile).load()
  taskOf(store, root, 'tsk_a', 'A')
  taskOf(store, root, 'tsk_b', 'B')
  store.commit(() => 0)
  store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('JWT 未校验 exp', 'x', 0.5), scope: 'task', taskId: 'tsk_a', cfg }))
  store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('JWT 未校验 exp', 'x', 0.5), scope: 'task', taskId: 'tsk_b', cfg }))
  assert.equal(store.insightItems().length, 0, '置信不足不提升 project')
  const holder = store.getTasks().find((t) => (t.insights || []).length)
  assert.ok(holder && holder.insights[0].sourceTaskIds.length === 2, '留在 task 层且成员累积')
  ok('confidence 闸门：<0.7 不自动提升')
}

// --- 8. 归档软删、衰减与容量 ---
{
  const { store } = newProject()
  const now = new Date().toISOString()
  const old = Date.now() - 200 * 86400000
  const items = [
    { id: 'i1', title: '久置零命中', confidence: 0.8, hitCount: 0, lastHitAt: new Date(old).toISOString(), createdAt: now, updatedAt: now },
    { id: 'i2', title: '活跃', confidence: 0.9, hitCount: 5, lastHitAt: now, createdAt: now, updatedAt: now },
    { id: 'i3', title: '已归档', archived: true, confidence: 0.1, hitCount: 0, createdAt: now, updatedAt: now },
  ]
  applyDecay(items, cfgInsight({ insight: { decayDays: 90 } }), now)
  assert.equal(items[0].archived, true, '久置零命中 → 归档（软删）')
  assert.equal(items[1].archived, undefined)
  const cap = pruneItems([...items], 2, now)
  assert.ok(cap.removed >= 1, '超限优先物理删已归档条目')
  const store2 = new ProjectMemoryStore(store.dir).load()
  assert.equal(store2.insightItems().length, 0)
  ok('归档软删 + 衰减 + 容量溢出只删归档区')
}

// --- 8b. 使用记账：注入/检索命中算活跃度（v0.5.8 修的缺陷） ---
{
  // 复现缺陷：条目建于 200 天前、从未被重写（updatedAt 停在创建时），但最近被注入过。
  // 旧实现判活跃度只看 lastHitAt||updatedAt||createdAt，而 lastHitAt 只由"模型重复写了
  // 相近知识"写 → 它一路退到 updatedAt，于是天天被注入的条子在 decayDays 后被归档。
  const now = new Date().toISOString()
  const old = new Date(Date.now() - 200 * 86400000).toISOString()
  const items = [
    { id: 'used', title: '天天被注入但没人重写', confidence: 0.9, hitCount: 12, lastHitAt: now, createdAt: old, updatedAt: old },
    { id: 'idle', title: '真的没人用', confidence: 0.9, hitCount: 0, createdAt: old, updatedAt: old },
  ]
  applyDecay(items, cfgInsight({ insight: { decayDays: 90 } }), now)
  assert.equal(items[0].archived, undefined, '有命中记录的条目不得被衰减归档')
  assert.equal(items[1].archived, true, '零活动的条目照旧归档')

  // recordHit：只记存在的非归档条目；project 与 global 两条路径都记
  const { store, globalFile } = newProject()
  store.replaceInsightItems([
    { id: 'p1', title: 'p1', hitCount: 0 },
    { id: 'p2', title: 'p2', hitCount: 3, archived: true },
  ])
  const gs = new GlobalStore(globalFile).load()
  gs.doc.items.push({ id: 'g1', title: 'g1', hitCount: 0 }, { id: 'g2', title: 'g2', hitCount: 0 })
  gs.commit(() => 0)
  const n = recordHit({ store, globalStore: gs, ids: ['p1', 'p2', 'g1', 'nope'], nowIso: now })
  assert.equal(n, 2, '只记存在的非归档条目（p2 已归档、nope 不存在）')
  assert.equal(store.insightItems()[0].hitCount, 1)
  assert.equal(store.insightItems()[0].lastHitAt, now)
  assert.equal(gs.items().find((i) => i.id === 'g1').hitCount, 1)
  assert.equal(gs.items().find((i) => i.id === 'g2').hitCount, 0)
  ok('使用记账：注入/命中写 hitCount+lastHitAt，活跃条目不再被衰减归档')
}

// --- 9. 降级 project → task ---
{
  const { root, store, globalFile, cfg } = newProject()
  const gs = new GlobalStore(globalFile).load()
  const r = store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('端口约定 8080'), scope: 'project', cfg }))
  taskOf(store, root, 'tsk_a', 'A')
  const d = store.commit((s) => demoteToTask(s, 'tsk_a', r.id))
  assert.equal(d.ok, true)
  assert.equal(store.getTask('tsk_a').insights.length, 1)
  assert.equal(store.getTask('tsk_a').insights[0].scope, 'task')
  assert.equal(store.insightItems().length, 0)
  ok('降级 project → task')
}

// --- 10. global 种子幂等 ---
{
  const { globalFile } = newProject()
  const seeds = [
    { id: 'proc_npm_publish_wsl', title: 'WSL 发包官方源', steps: ['uname -r', 'npm config set registry'], trigger: { keywords: ['npm publish', '发包'], scope: ['npm'] } },
    { id: 'proc_dsh_plugin_local', title: 'dsh 插件本地开发', steps: ['dsh plugin add'], tags: ['dsh'] },
  ]
  const a = ensureGlobalInit({ insight: { globalFile } }, seeds)
  assert.equal(a.seeded, 2)
  assert.equal(a.store.items().length, 2)
  const b = ensureGlobalInit({ insight: { globalFile } }, seeds)
  assert.equal(b.seeded, 0, '重复初始化只补缺失 id')
  assert.equal(b.store.items().length, 2)
  const store3 = new GlobalStore(globalFile).load()
  assert.equal(store3.items().length, 2, '落盘可再读')
  ok('global 种子：幂等初始化，仅补缺失 id')
}

// --- 11. save_lesson 工具端到端（三 scope + 任务级 + 密文拒绝） ---
{
  const { root, store } = newProject()
  const config = { memoryDir: '.dsh-project-memory', maxOutputChars: 8000, insight: { globalFile: path.join(root, 'global.json') } }
  store.addTask({ id: 'tsk_e2e', title: '端到端', projectRoot: root, steps: null, files: [], archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() })
  store.commit(() => 0)
  const tool = lessonTool(config)
  const exec = { agent: { session: { header: { cwd: root } } } }
  const outP = await tool.execute({ root, title: '构建脚本 Windows 路径报错', pattern: '构建脚本 Windows 路径报错', fix: '统一 path.join', scope: 'project' }, exec)
  assert.match(outP, /\[scope=project\] action=created/)
  const outT = await tool.execute({ root, title: '本任务内部教训', scope: 'task', task_id: 'tsk_e2e' }, exec)
  assert.match(outT, /\[scope=task\] action=created/)
  const outG = await tool.execute({ root, title: '个人程序 WSL 发包', kind: 'procedure', steps: ['a', 'b'], trigger: { keywords: ['发包'], scope: ['npm'] }, scope: 'global' }, exec)
  assert.match(outG, /\[scope=global\] action=created/)
  const outSecret = await tool.execute({ root, title: '泄漏', fix: 'api_key = sk-abcdefghijklmnopqrstuvwxyz123456', scope: 'project' }, exec)
  assert.match(outSecret, /拒绝写入/)
  // 落盘校验
  const s2 = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
  assert.equal(s2.insightItems().length, 1)
  assert.equal(s2.getTask('tsk_e2e').insights.length, 1)
  const g2 = new GlobalStore(path.join(root, 'global.json')).load()
  assert.equal(g2.items().length, 1)
  assert.equal(g2.items()[0].kind, 'procedure')
  assert.ok(Array.isArray(g2.items()[0].trigger.keywords))
  assert.ok(!defaultGlobalFile().includes(process.cwd()), '默认 global 路径指向用户目录')
  ok('save_lesson 端到端：task/project/global + 密文拒绝 + 落盘')
}

// --- 12. 向量带：≥0.9 自动覆盖（旧值进 prev）/ ≥0.7 提示 / 领先不足不覆盖 / 就地更新 ---
{
  const { root, store, globalFile, cfg } = newProject()
  const gs = new GlobalStore(globalFile).load()
  store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('JWT 未校验 exp', '用 jose 校验'), scope: 'project', cfg }))
  const idA = store.insightItems()[0].id

  // ① 0.95 且领先 → 自动覆盖：正文取新值、旧值进 prev、条目数不变
  const r1 = store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('JWT 未校验 exp', '改用 jose 并校验 aud'), scope: 'project', cfg, cosine: () => new Map([[idA, 0.95]]) }))
  assert.equal(r1.action, 'auto-merged')
  assert.equal(r1.id, idA)
  assert.ok(r1.replaced.includes('fix'), '被覆盖的字段要回报')
  const after1 = store.insightItems()
  assert.equal(after1.length, 1, '自动覆盖不得新增条目')
  assert.equal(after1[0].fix, '改用 jose 并校验 aud')
  assert.equal(after1[0].prev.fix, '用 jose 校验', '旧值必须留在 prev 才能写回')
  assert.equal(after1[0].hitCount, 1)
  ok('向量带：≥0.9 自动覆盖正文，旧值进 prev，不新增条目')

  // ② 0.80 → 不覆盖，只提示近邻 id
  const r2 = store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('端口约定 8080', '写进 .env'), scope: 'project', cfg, cosine: () => new Map([[idA, 0.8]]) }))
  assert.equal(r2.action, 'created')
  assert.equal(r2.near && r2.near.id, idA, '提示带要回报近邻 id')
  const idB = r2.id

  // ③ 0.50 → 连提示都不给
  const r3 = store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('日志轮转策略', '按天切分'), scope: 'project', cfg, cosine: () => new Map([[idA, 0.5]]) }))
  assert.equal(r3.action, 'created')
  assert.equal(r3.near, undefined)

  // ④ 0.95 与 0.93 并列 → 领先不足，不覆盖（只是提示），否则不知道该覆盖谁
  const r4 = store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('并发写同一文件', '用锁文件'), scope: 'project', cfg, cosine: () => new Map([[idA, 0.95], [idB, 0.93]]) }))
  assert.equal(r4.action, 'created')
  assert.equal(r4.near.id, idA)

  // ⑤ id 就地更新：跨层都能找，旧值进 prev，不新增条目
  const rg = store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('WSL 发包步骤'), scope: 'global', cfg }))
  const gid = rg.id
  const ru = store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: { id: gid, fix: '改用 corepack enable' }, cfg }))
  assert.equal(ru.action, 'updated')
  assert.equal(ru.scope, 'global', '更新不能把条目搬离原来的层')
  assert.ok(ru.replaced.includes('fix'))
  assert.equal(gs.items().find((i) => i.id === gid).fix, '改用 corepack enable')
  assert.equal(gs.items().find((i) => i.id === gid).prev.fix, '用正确做法')
  assert.equal(gs.items().length, 1)

  // ⑥ 未知 id → 明确失败，绝不静默新建
  const rx = store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: { id: 'ins_nope', fix: 'x' }, cfg }))
  assert.equal(rx.ok, false)
  assert.match(rx.error, /找不到要更新的条目/)

  // ⑦ prev 要跟着条目跨层移动（promote/demote 走 normalizeInsight 白名单）
  store.addTask({ id: 'tsk_prev', title: 'prev 迁移', projectRoot: root, steps: null, files: [], archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() })
  store.commit((s) => demoteToTask(s, 'tsk_prev', idA))
  const moved = store.getTask('tsk_prev').insights[0]
  assert.equal(moved.prev.fix, '用 jose 校验', '降级后 prev 不能丢')
  ok('向量带：提示带 / 领先不足 / 跨层就地更新 / 未知 id 失败 / prev 跨层保留')
}

// --- 13. save_lesson 端到端带 id：就地更新 + 用返回的旧值写回 ---
{
  const { root, store } = newProject()
  const config = { memoryDir: '.dsh-project-memory', maxOutputChars: 8000, insight: { globalFile: path.join(root, 'global.json') } }
  store.commit(() => 0)
  const tool = lessonTool(config)
  const exec = { agent: { session: { header: { cwd: root } } } }
  const out1 = await tool.execute({ root, title: '构建脚本 Windows 路径报错', pattern: '构建脚本 Windows 路径报错', fix: '统一 path.join', scope: 'project' }, exec)
  assert.match(out1, /action=created/)
  const s1 = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
  const id = s1.insightItems()[0].id
  const out2 = await tool.execute({ root, id, fix: '统一 path.join 且用 fileURLToPath' }, exec)
  assert.match(out2, /action=updated/)
  assert.match(out2, /已就地更新/)
  const s2 = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
  assert.equal(s2.insightItems().length, 1, '就地更新不得新增条目')
  assert.equal(s2.insightItems()[0].fix, '统一 path.join 且用 fileURLToPath')
  assert.equal(s2.insightItems()[0].prev.fix, '统一 path.join')
  // 写回：拿 prev 再写一次
  const out3 = await tool.execute({ root, id, fix: s2.insightItems()[0].prev.fix }, exec)
  assert.match(out3, /action=updated/)
  const s3 = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
  assert.equal(s3.insightItems()[0].fix, '统一 path.join')
  assert.equal(s3.insightItems()[0].prev.fix, '统一 path.join 且用 fileURLToPath')
  // 未知 id：只说失败，不偷偷新建
  const out4 = await tool.execute({ root, id: 'ins_nope', fix: 'x' }, exec)
  assert.match(out4, /找不到要更新的条目/)
  assert.equal(new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load().insightItems().length, 1)
  // 只给 id + 一个字段：不再要求 title/pattern/choice
  const out5 = await tool.execute({ root, id, confidence: 0.95 }, exec)
  assert.match(out5, /action=updated/)
  ok('save_lesson 端到端：带 id 就地更新 / prev 写回 / 未知 id 明确失败')
}

// --- 14. forget 全层：精确 id / 关键词 / 上限保护 / 经验笔记 / 工具端到端 ---
{
  const { root, store, globalFile, cfg } = newProject()
  const gs = new GlobalStore(globalFile).load()
  const rp = store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('依赖安装脚本改了 PATH 顺序', '显式指定包管理器路径'), scope: 'project', cfg }))
  const rg = store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('文本抽取正则漏了跨行标记', '补上跨行匹配标志'), scope: 'global', cfg }))
  store.addTask({ id: 'tsk_f', title: 'forget 用', projectRoot: root, steps: null, files: [], archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() })
  const rt = store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson('任务内私有坑', '先看绑定'), scope: 'task', taskId: 'tsk_f', cfg }))
  // 经验笔记现在就是 kind:'experience' 的 insight（remember 写出来就是它）
  const rexp = store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: { title: 'OPS import breaks on Node 24', kind: 'experience', problem: 'OPS import breaks on Node 24', solution: 'import from legacy build' }, scope: 'project', cfg }))
  store.commit(() => 0)
  assert.equal(store.insightItems().length, 2, 'project 级：lesson + experience')

  // ① 精确 id：project 层，删掉且只删一条
  const d1 = store.commit((s) => removeMemory({ store: s, globalStore: gs, idOrQuery: rp.id }))
  assert.equal(d1.ok, true)
  assert.equal(d1.removed.length, 1)
  assert.equal(d1.removed[0].home, 'project')
  assert.equal(store.insightItems().length, 1)

  // ② 精确 id：global 层（要落到 global.json）
  const d2 = store.commit((s) => removeMemory({ store: s, globalStore: gs, idOrQuery: rg.id }))
  assert.equal(d2.removed[0].home, 'global')
  assert.equal(gs.items().length, 0)
  const gs2 = new GlobalStore(globalFile).load()
  assert.equal(gs2.items().length, 0, 'global 删除要落盘')

  // ③ 精确 id：task 层内嵌
  const d3 = store.commit((s) => removeMemory({ store: s, globalStore: gs, idOrQuery: rt.id }))
  assert.equal(d3.removed[0].home, 'task')
  assert.equal(store.getTask('tsk_f').insights.length, 0)

  // ④ 关键词命中经验笔记（沿用旧口径——查询侧覆盖率，不是两侧取大）
  const d4 = store.commit((s) => removeMemory({ store: s, globalStore: gs, idOrQuery: 'OPS import breaks' }))
  assert.equal(d4.removed.length, 1)
  assert.equal(d4.removed[0].id, rexp.id)
  assert.equal(d4.removed[0].home, 'project')
  assert.equal(store.insightItems().length, 0)

  // ⑤ 关键词命中上限：超了一条都不删，只回报候选
  for (const t of ['zzcap 一', 'zzcap 二', 'zzcap 三']) store.commit((s) => saveInsight({ store: s, globalStore: gs, raw: lesson(t, 'x'), scope: 'project', cfg }))
  const d5 = store.commit((s) => removeMemory({ store: s, globalStore: gs, idOrQuery: 'zzcap', maxMatches: 2 }))
  assert.equal(d5.ok, false)
  assert.equal(d5.tooMany, true)
  assert.equal(d5.matches.length, 3)
  assert.equal(store.insightItems().length, 3, '超上限时一条都不许删')
  const d6 = store.commit((s) => removeMemory({ store: s, globalStore: gs, idOrQuery: 'zzcap', maxMatches: 10 }))
  assert.equal(d6.removed.length, 3)
  assert.equal(store.insightItems().length, 0)

  // ⑥ 无匹配：不炸、不删
  const d7 = store.commit((s) => removeMemory({ store: s, globalStore: gs, idOrQuery: '完全不存在的主题 xyzzy' }))
  assert.equal(d7.ok, true)
  assert.equal(d7.removed.length, 0)
  ok('forget 全层：精确 id（project/global/task）/ 关键词（旧经验层）/ 上限保护 / 无匹配')

  // ⑦ 工具端到端：全层删除的回报要说出删了什么
  const tool = lessonTool({ memoryDir: '.dsh-project-memory', insight: { globalFile: path.join(root, 'global.json') } })
  const fTool = forgetTool({ memoryDir: '.dsh-project-memory', insight: { globalFile: path.join(root, 'global.json'), maxForgetMatches: 10 } })
  const exec = { agent: { session: { header: { cwd: root } } } }
  await tool.execute({ root, title: '工具层删不掉的条目', pattern: '工具层删不掉的条目', fix: '用 forget', scope: 'project' }, exec)
  const s1 = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
  const id = s1.insightItems()[0].id
  const outF = await fTool.execute({ root, id_or_query: id }, exec)
  assert.match(outF, /Removed 1/)
  assert.ok(outF.includes(id), `回报要带 id：${outF}`)
  assert.ok(outF.includes('deleted.json'), `回报要给出留痕文件路径，模型才能自己去找回：${outF}`)
  assert.equal(new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load().insightItems().length, 0)
  const outNone = await fTool.execute({ root, id_or_query: 'zzz 不存在' }, exec)
  assert.match(outNone, /No matching memory found/)
  ok('forget 工具端到端：全层删除 + 回报带 id + 留痕路径 + 无匹配明确说')

  // ⑧ 删除留痕：删除仍是真删，但最近 5 条以**完整条目**留在同目录 deleted.json（滚动淘汰）
  {
    const p = newProject()
    const gs3 = new GlobalStore(p.globalFile).load()
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf']
    // 每条用一个只属于它的 token，避免被写入侧去重/强化带合并（那会让"删 7 条"变成"删 1 条"）。
    const ids = words.map((w, i) => p.store.commit((s) => saveInsight({
      store: s, globalStore: gs3,
      raw: lesson(`${w}only${i} topic`, `${w}only${i} fix`),
      scope: 'project', cfg: p.cfg,
    })).id)
    assert.equal(p.store.insightItems().length, words.length, '7 条各自独立（没被去重合并）')
    let last
    for (const one of ids) last = p.store.commit((s) => removeMemory({ store: s, globalStore: gs3, idOrQuery: one }))
    assert.equal(p.store.insightItems().length, 0, '删除仍然是真删')
    const file = path.join(p.root, '.dsh-project-memory', 'deleted.json')
    assert.ok(existsSync(file), `留痕要落在 store 同目录：${file}`)
    assert.deepEqual(last.keptIn, [file], '回报要给出实际写入的留痕文件')
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(doc.items.length, 5, '只保留最近 5 条')
    assert.equal(doc.items[0].id, ids[6], '最新删除的排最前')
    assert.ok(!doc.items.some((x) => x.id === ids[0]), '更早的被滚动淘汰')
    assert.equal(doc.items[0].home, 'project')
    // 正文必须完整：只要 id/标题就没法"找回来再存一次"
    const kept = doc.items[0]
    assert.ok(kept.fix && kept.fix.includes('golf') && kept.pattern, `留痕要带完整正文：${JSON.stringify(kept)}`)
    assert.ok(kept.deletedAt, '带删除时间')

    // global 层删到 global 文件同目录，与项目层互不覆盖
    const gsId = p.store.commit((s) => saveInsight({
      store: s, globalStore: gs3,
      raw: lesson('global 留痕条目', 'global 正文'),
      scope: 'global', cfg: p.cfg,
    })).id
    gs3.commit()
    const resG = p.store.commit((s) => removeMemory({ store: s, globalStore: gs3, idOrQuery: gsId }))
    const globalFile = path.join(p.root, 'deleted.json')
    assert.deepEqual(resG.keptIn, [globalFile], 'global 条目的留痕在 global 文件同目录')
    const gdoc = JSON.parse(readFileSync(globalFile, 'utf8'))
    assert.equal(gdoc.items[0].id, gsId)
    assert.equal(gdoc.items[0].home, 'global')
    assert.equal(gdoc.items.length, 1, 'global 与 project 各留各的，不互相挤')
    ok('删除留痕：真删 + 最近 5 条完整条目可找回（按层分文件、滚动淘汰）')
  }
}

// --- 14. 只给 pattern / choice 的写入也要进向量比对（查询文本 = 落盘标题）---
// 事故形状：`save_lesson` 允许 title / pattern / choice 三选一；旧 vectorText 只认
// title/problem/body，于是 pattern-only 的写入把空串当查询文本，`vectorNear` 直接返回 null
// —— 0.9 自动覆盖 / 0.7 近邻提示两条带对这种最常用的 lesson 形状**整体失效**。
{
  const { store, globalFile, cfg } = newProject()
  const gs = new GlobalStore(globalFile).load()
  const r0 = store.commit((s) => saveInsight({
    store: s, globalStore: gs,
    raw: { kind: 'lesson', pattern: 'pnpm 不跑 postinstall', fix: 'approve-builds' },
    scope: 'project', cfg,
  }))
  const seeded = store.insightItems()[0]
  assert.equal(seeded.title, 'pnpm 不跑 postinstall', '没有 title 时标题由 pattern 推导')

  const seen = []
  const cosine = (text, items) => { seen.push(text); return new Map(items.map((it) => [it.id, 0.95])) }
  const r1 = store.commit((s) => saveInsight({
    store: s, globalStore: gs,
    raw: { kind: 'lesson', pattern: 'pnpm 不跑 postinstall', fix: '用 approve-builds 放行' },
    scope: 'project', cfg, cosine,
  }))
  assert.deepEqual(seen, ['pnpm 不跑 postinstall'], `只给 pattern 的写入必须带可比对文本，实得 ${JSON.stringify(seen)}`)
  assert.equal(r1.action, 'auto-merged', '同一条知识应自动覆盖，而不是再存一条')
  assert.equal(r1.id, r0.id)
  assert.equal(store.insightItems().length, 1)

  // 只给 choice 的 decision：标题必须能认出它（旧行为是 `(untitled)`）
  const r2 = store.commit((s) => saveInsight({
    store: s, globalStore: gs,
    raw: { kind: 'decision', choice: '选 leancache 而不是 redis', reason: '免运维' },
    scope: 'project', cfg, cosine: () => new Map(),
  }))
  const dec = store.insightItems().find((it) => it.id === r2.id)
  assert.equal(dec.title, '选 leancache 而不是 redis', '只给 choice 时标题必须是 choice')
  ok('向量带：只给 pattern/choice 的写入也进比对（查询文本 = 落盘标题）')
}

console.log(`\ninsight-store tests: ${passed} passed`)
if (!process.env.CI_RUNNING) {
  console.log('(run via: node test/insight-store.test.mjs)')
}
