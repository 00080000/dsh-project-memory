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
  containsSecretFields,
} from '../src/insight-store.js'
import { ensureGlobalInit } from '../src/global-seed.js'
import { normalizedTokenOverlap } from '../src/similarity.js'
import { lessonTool } from '../src/tools/lesson-tools.js'

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

// --- 2. 旧 experience.json → insights.json 非破坏迁移（幂等、无损） ---
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
  // 旧文件仍在（非破坏）
  assert.ok(existsSync(path.join(dir, 'experience.json')))
  // 幂等：重新加载不重复导入
  s1 = new ProjectMemoryStore(dir).load()
  assert.equal(s1.insightItems().length, 2)
  ok('experience.json 迁移：非破坏、导入无损、重复加载幂等')
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

console.log(`\ninsight-store tests: ${passed} passed`)
if (!process.env.CI_RUNNING) {
  console.log('(run via: node test/insight-store.test.mjs)')
}
