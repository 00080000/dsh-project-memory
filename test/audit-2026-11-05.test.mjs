// 2026-11-05 审计修复的回归测试：node test/audit-2026-11-05.test.mjs
//
// 覆盖的是"数据/协议层"的可判定失败，不重测已有 956 项：
//   1. legacy 迁移保护（entries.json + 缺 index.json / files 不合法 / format 已写）
//   2. experience 迁移在锁内合并另一进程刚落盘的条目
//   3. 畸形 task.steps / fileMeta 不再让注入与列表抛错
//   4. global.json 缺失时不再把内存里的旧条目清掉
//   5. 锁回收失败时遵守 timeoutMs（不再同步自旋）
//   6. 懒索引的 L2 增强在基础条目落盘之后入队
//   7. 增强队列按 store 身份去重（多项目同名文件不再互相顶掉）
//   8. reinjectItemsAfter 真的会在冷却到期后重发
//   9. 包装器/npm flag/子 shell 的动作识别、流式检索词边界
//  10. 面板删除清 vectors.json、watch interval 回报、scan 深度/忽略口径、truncate/timeAgo
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProjectMemoryStore } from '../src/store.js'
import { GlobalStore, applyUpdate, normalizeInsight } from '../src/insight-store.js'
import { acquireDirLock } from '../src/util/fs.js'
import { truncate } from '../src/util/text.js'
import { timeAgo } from '../src/util/task-view.js'
import { buildInjection, cfgEngine, installAutoInject, isOwnInjection } from '../src/auto-inject.js'
import { classifyShellCommand } from '../src/ops.js'
import { rankEntriesStreaming } from '../src/util/search.js'
import { actInsight } from '../src/commands/insight-actions.js'
import { vectorIndexSummary } from '../src/vector-index.js'
import { watchRepoTool } from '../src/tools/watch-repo.js'
import { listProjectFiles, walkDir } from '../src/util/fs.js'
import { initTypeScript, enqueueEnhance, enhanceQueueStats } from '../src/enhancer.js'
import { indexObservedBatch } from '../src/lazy.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const tmp = (prefix) => mkdtempSync(path.join(tmpdir(), prefix))
let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- 1. legacy 迁移保护 ----
{
  const dir = tmp('legacy-')
  writeFileSync(path.join(dir, 'entries.json'), JSON.stringify({ 'a.js': [{ id: 'a1', relPath: 'a.js', title: 'A' }] }))
  const store = new ProjectMemoryStore(dir).load()
  store.commit(() => {})
  assert.equal(existsSync(path.join(dir, 'format.json')), false, '保护性跳过时不能写 format.json')
  assert.equal(existsSync(path.join(dir, 'entries.json')), true, 'entries.json 必须保留')
  ok('legacy：entries.json + 缺 index.json 时 save 不写 format，旧文件保留')
}
{
  const dir = tmp('legacy2-')
  writeFileSync(path.join(dir, 'entries.json'), JSON.stringify({ 'a.js': [{ id: 'a1', relPath: 'a.js', title: 'A' }] }))
  writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1 }))
  new ProjectMemoryStore(dir).load()
  assert.equal(existsSync(path.join(dir, 'entries.json')), true, 'files 非对象时也要保护 entries.json')
  assert.equal(existsSync(path.join(dir, 'format.json')), false, 'files 非对象时不能写 format.json')
  ok('legacy：index.json 缺 files 时按保护路径处理，不写 0 shard 再删旧文件')
}
{
  const dir = tmp('legacy3-')
  writeFileSync(path.join(dir, 'entries.json'), JSON.stringify({ 'a.js': [{ id: 'a1', relPath: 'a.js', title: 'A' }] }))
  writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
    version: 1,
    files: { 'a.js': { sha256: 'h', size: 1, indexedAt: '2026-01-01T00:00:00.000Z' } },
  }))
  const store = new ProjectMemoryStore(dir).load()
  assert.equal(existsSync(path.join(dir, 'entries.json')), false)
  const format = JSON.parse(readFileSync(path.join(dir, 'format.json'), 'utf8'))
  assert.equal(format.migratedFrom, 'legacy', '成功迁移要留下标记，下一次 load 才能安全清理')
  assert.equal(store.allEntries().length, 1)
  ok('legacy：index.json 合法时正常迁移、删旧文件并写 migratedFrom')
}
{
  // 旧版已经写坏的状态：format.json 没有 migratedFrom，entries.json 还在 —— load 必须保住旧库。
  const dir = tmp('legacy4-')
  writeFileSync(path.join(dir, 'entries.json'), JSON.stringify({ 'a.js': [{ id: 'a1', relPath: 'a.js', title: 'A' }] }))
  writeFileSync(path.join(dir, 'format.json'), JSON.stringify({ version: 2, layout: 'sharded' }))
  new ProjectMemoryStore(dir).load()
  assert.equal(existsSync(path.join(dir, 'entries.json')), true, '没有 migratedFrom 的 format 不能触发删除')
  ok('legacy：format 已存在但没有迁移标记时不清旧库')
}

// ---- 2. experience 迁移在锁内合并 diskDoc ----
{
  const dir = tmp('exp-')
  writeFileSync(path.join(dir, 'experience.json'), JSON.stringify([{ id: 'exp_old', problem: 'p', solution: 's' }]))
  const held = acquireDirLock(dir, { timeoutMs: 1000 })
  assert.equal(typeof held, 'function')
  const store = new ProjectMemoryStore(dir).load() // 等锁前加载（此时 experience 尚未迁移）
  held()
  const iso = new Date().toISOString()
  writeFileSync(path.join(dir, 'insights.json'), JSON.stringify({
    version: 1, migratedAt: null, items: [{ id: 'ins_p2', kind: 'lesson', scope: 'project', title: 'P2', createdAt: iso, updatedAt: iso }],
  }))
  store._migrateExperienceToInsights()
  const ids = JSON.parse(readFileSync(path.join(dir, 'insights.json'), 'utf8')).items.map((it) => it.id)
  assert.deepEqual(ids.sort(), ['exp_old', 'ins_p2'], '另一进程已落盘的 ins_p2 不能被整份覆盖')
  ok('experience 迁移：锁内重读的 disk items 与 legacy 合并，不丢并发写入')
}

// ---- 3. 畸形 task.steps / fileMeta ----
{
  const dir = tmp('steps-')
  const now = new Date().toISOString()
  writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify([{
    id: 't1', title: 'T', steps: { a: 1 }, files: ['a.ts'], fileMeta: { 'a.ts': 'oops' },
    archived: false, createdAt: now, updatedAt: now, lastActiveAt: now,
  }]))
  writeFileSync(path.join(dir, 'binding.json'), JSON.stringify({ s1: 't1' }))
  const store = new ProjectMemoryStore(dir).load()
  const task = store.getTask('t1')
  assert.deepEqual(task.steps, [])
  assert.deepEqual(task.fileMeta['a.ts'], {})
  assert.doesNotThrow(() => buildInjection({
    query: 'x', task, store, globalStore: null, cfg: cfgEngine({}),
    readiness: { humanText: 'x', ops: [], targets: [] },
  }))
  ok('task 形状：非数组 steps / 非对象 fileMeta 被归一，注入不再抛')
}

// ---- 4. global.json 缺失时保留内存条目 ----
{
  const dir = tmp('global-')
  const file = path.join(dir, 'global.json')
  const iso = '2026-01-01T00:00:00.000Z'
  writeFileSync(file, JSON.stringify({ version: 3, items: [{ id: 'g1', title: 'one', updatedAt: iso }, { id: 'g2', title: 'two', updatedAt: iso }] }))
  const gs = new GlobalStore(file).load()
  unlinkSync(file)
  gs.markDirty()
  gs.items().push({ id: 'g3', title: 'three', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  gs.commit(() => undefined)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).items.map((it) => it.id), ['g1', 'g2', 'g3'])
  ok('global：文件缺失/不可读不再被当成“对端删光”，保留内存条目')
}

// ---- 5. 锁回收失败遵守 timeout ----
if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
  const dir = tmp('lock-')
  writeFileSync(path.join(dir, '.write.lock'), JSON.stringify({
    pid: 999999, host: (await import('node:os')).hostname(), token: 'x', at: new Date().toISOString(),
  }))
  chmodSync(dir, 0o555)
  const started = Date.now()
  let result
  try {
    result = acquireDirLock(dir, { timeoutMs: 100 })
  } finally {
    chmodSync(dir, 0o755)
  }
  assert.equal(result, null)
  assert.ok(Date.now() - started < 1500, `锁回收失败时必须在 timeout 附近返回（实际 ${Date.now() - started}ms）`)
  ok('锁：stale 但 unlink 失败时不再无限自旋，遵守 timeoutMs')
} else {
  console.log('  skip 锁超时（Windows 或 root：chmod 无法阻止 unlink）')
}

// ---- 6/7. lazy 的 L2 顺序 + 增强队列 store 身份 ----
{
  const config = {
    memoryDir: '.dsh-project-memory', chunkChars: 3000, maxChunksPerFile: 40,
    maxFileSizeMb: 10, maxPdfPages: 1000, enableTypeScript: true,
  }
  const loaded = initTypeScript(config)
  if (!loaded) {
    console.log('  skip L2 增强（typescript 不可用）')
  } else {
    const root = tmp('lazy-l2-')
    writeFileSync(path.join(root, 'package.json'), '{}')
    writeFileSync(path.join(root, 'api.ts'), 'export const api = {\n  async fetchUser(id: string): Promise<string> {\n    return id\n  },\n}\n')
    await indexObservedBatch(config, [{ filePath: path.join(root, 'api.ts'), sessionRoot: root }])
    await wait(500)
    const store = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
    assert.ok((store.entries['api.ts'] || []).some((e) => e.title === 'fetchUser (method)'))
    assert.equal(store.files['api.ts'].enhanced, true)
    ok('lazy：L2 增强在基础条目落盘后入队，entries 与 enhanced 都保留')

    const A0 = tmp('l2a-'), B0 = tmp('l2b-')
    writeFileSync(path.join(A0, 'api.ts'), 'export const a = { m(x: number): string { return String(x) } }\n')
    writeFileSync(path.join(B0, 'api.ts'), 'export const b = { n(y: string): number { return y.length } }\n')
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const fake = (block = false) => ({
      files: { 'api.ts': { sha256: 'x' } }, entries: {},
      setEntries(rel, list) { this.entries[rel] = list },
      commit(fn) { return block ? gate.then(() => fn(this)) : fn(this) },
    })
    const C = fake(true), A = fake(), B = fake()
    enqueueEnhance(C, 'slow.js', path.join(REPO, 'src/llm.js'), 0, config, '/tmp/c')
    const pA = enqueueEnhance(A, 'api.ts', path.join(A0, 'api.ts'), 0, config, A0)
    const pB = enqueueEnhance(B, 'api.ts', path.join(B0, 'api.ts'), 0, config, B0)
    assert.equal(enhanceQueueStats().queued, 2, '不同 store 的同名文件不能互相去重')
    release()
    await Promise.all([pA, pB])
    await wait(300)
    assert.ok((A.entries['api.ts'] || []).some((e) => e.title === 'm (method)'))
    assert.ok((B.entries['api.ts'] || []).some((e) => e.title === 'n (method)'))
    ok('增强队列：按 store 身份去重，多项目同名文件各自增强')
  }
}

// ---- 8. reinjectItemsAfter ----
{
  const root = tmp('reinject-')
  writeFileSync(path.join(root, 'package.json'), '{}')
  const gf = path.join(tmp('reinject-g-'), 'g.json')
  const gs = new GlobalStore(gf).load()
  gs.doc.items.push({ id: 'a', kind: 'lesson', scope: 'global', title: '阈值 经验', fix: 'x', trigger: { when: { intents: ['阈值'] } }, confidence: 1 })
  gs.commit(() => 0)
  let handler
  installAutoInject({ on: (event, fn) => { if (event === 'agent/pre-step') handler = fn } }, {
    memoryDir: '.dsh-project-memory',
    autoContext: { enabled: true, maxTokens: 400, gateCooldownSteps: 0, reinjectItemsAfter: 2 },
    insight: { globalFile: gf },
  })
  const step = async () => {
    const payload = {
      agent: { session: { id: 's1', header: { cwd: root } } },
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '阈值要改' }] }],
    }
    const decision = await handler(payload, async () => ({ kind: 'enter', messages: payload.messages }))
    const last = decision.messages.at(-1)
    return Boolean(last && isOwnInjection(last.source))
  }
  const seq = [await step(), await step(), await step(), await step()]
  assert.deepEqual(seq, [true, false, true, false], '回合冷却到期后要重发，不能被块级指纹短路')
  ok('reinjectItemsAfter：冷却到期真的重发（不再是死开关）')
}

// ---- 9. 动作识别 + 流式检索词边界 ----
{
  const ops = (s) => classifyShellCommand(s).ops
  assert.deepEqual(ops('sudo -E rm -rf a.ts'), ['file-delete'])
  assert.deepEqual(ops('nice -n 10 npm publish'), ['npm-publish'])
  assert.deepEqual(ops('time -p npm publish'), ['npm-publish'])
  assert.deepEqual(ops('stdbuf -oL npm publish'), ['npm-publish'])
  assert.deepEqual(ops('npm --registry https://registry.npmjs.org publish'), ['npm-publish'])
  assert.deepEqual(ops('npm --otp 123456 publish'), ['npm-publish'])
  assert.deepEqual(ops('(rm -rf a.ts)'), ['file-delete'])
  assert.deepEqual(ops('{ rm -rf a.ts; }'), ['file-delete'])
  assert.deepEqual(ops('if true; then rm a.ts; fi'), ['file-delete'])
  assert.deepEqual(ops('npm run bench'), ['run-bench'])
  ok('ops：包装器选项 / npm 前置 flag / 子 shell 都能识别')

  const entry = { id: 'd1', type: 'doc', title: 'concatenate strings', summary: '', terms: '', keywords: [], sourcePath: 'a.md' }
  assert.equal(rankEntriesStreaming([entry], ['cat'], {}, 8).length, 0, 'cat 不能命中 concatenate')
  const positive = { ...entry, id: 'd2', title: 'cat food' }
  assert.equal(rankEntriesStreaming([positive], ['cat'], {}, 8).length, 1)
  ok('search：拉丁词项按词边界计数，流式 TF 不再子串假命中')
}

// ---- 10. 面板删除清 vectors.json ----
{
  const dir = tmp('vec-')
  const store = new ProjectMemoryStore(dir).load()
  store.replaceInsightItems([{ id: 'ins_x', kind: 'lesson', scope: 'project', title: 't', fix: 'f' }])
  store.save()
  writeFileSync(path.join(dir, 'vectors.json'), JSON.stringify({
    version: 1, model: 'm', dim: 3, ids: ['ins_x'], hashes: ['h'],
    blob: Buffer.from(new Float32Array([1, 2, 3]).buffer).toString('base64'),
  }))
  const before = vectorIndexSummary({ dir, items: store.insightItems() })
  assert.equal(before.stale, 0)
  actInsight({ store, gs: null, action: 'delete', scope: 'project', id: 'ins_x', cfg: {} })
  store.commit(() => 0)
  const after = vectorIndexSummary({ dir, items: store.insightItems() })
  assert.equal(after.rows, 0, '删除后 vectors.json 里不能留下被删条目')
  assert.equal(after.stale, 0)
  ok('面板删除：与 forget 一样清 vectors.json 的对应行')
}

// ---- 11. watch interval 回报 ----
{
  const dir = tmp('watch-')
  const started = []
  const wm = { addRoot() {}, removeRoot() {}, start(ms) { started.push(ms) } }
  const text0 = await watchRepoTool(wm, { memoryDir: '.dsh-project-memory', watchInterval: 0 })
    .execute({ root: dir }, {})
  assert.match(text0, /interval 1s/)
  assert.equal(started.at(-1), 1000)
  const text30 = await watchRepoTool(wm, { memoryDir: '.dsh-project-memory', watchInterval: 30 })
    .execute({ root: dir }, {})
  assert.match(text30, /interval 30s/)
  assert.equal(started.at(-1), 30000)
  ok('watch_repo：回报的 interval 与真实定时器一致（0 被 clamp 成 1s）')
}

// ---- 12. git/walkDir 扫描口径 ----
{
  if (process.platform === 'win32') {
    console.log('  skip scan 口径（Windows 没有 git 时无法构造）')
  } else {
    const dir = tmp('scan-')
    mkdirSync(path.join(dir, 'a'))
    writeFileSync(path.join(dir, 'a', 'b.js'), 'x')
    writeFileSync(path.join(dir, 'top.js'), 'y')
    writeFileSync(path.join(dir, 'build'), 'z')
    const opts = { maxDepth: 1, maxFiles: 100 }
    const nonGit = walkDir(dir, opts)
    let gitList = null
    try {
      execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' })
      gitList = listProjectFiles(dir, opts)
    } catch {
      console.log('  skip scan 口径（git 不可用）')
    }
    if (gitList) {
      const rel = (files) => files.map((f) => f.slice(dir.length + 1)).sort()
      assert.deepEqual(rel(gitList.files), rel(nonGit.files))
      assert.equal(gitList.capped, nonGit.capped)
    }
    ok('scan：git init 前后 maxDepth / DEFAULT_IGNORE 的文件名口径一致')
  }
}

// ---- 13. save_lesson 改 kind 清旧字段；空 store 不落 format ----
{
  const item = normalizeInsight({ title: 'T', kind: 'lesson', pattern: '旧坑', fix: '旧改法' }, { scope: 'project', source: 'agent' })
  applyUpdate(item, { kind: 'decision', choice: '新选择', reason: '新理由' })
  assert.equal(item.kind, 'decision')
  assert.equal(item.pattern, undefined)
  assert.equal(item.fix, undefined, 'lesson→decision 后旧 fix 不能继续盖在 choice 前面')
  assert.equal(item.choice, '新选择')
  assert.equal(item.reason, '新理由')
  const proc = normalizeInsight({ title: 'P', kind: 'procedure', body: '通用正文', steps: ['a'] }, { scope: 'project', source: 'agent' })
  applyUpdate(proc, { kind: 'lesson', pattern: 'p', fix: 'f' })
  assert.equal(proc.body, undefined, 'procedure→lesson 清掉不再属于 lesson 的 body')
  ok('save_lesson 改 kind：清旧 kind 专属字段（与面板 editMemoryItem 同语义）')

  const dir = path.join(tmp('empty-'), 'not-created')
  new ProjectMemoryStore(dir).load().commit(() => {})
  assert.equal(existsSync(dir), false, '空提交不能创建 store 目录 / format.json')
  ok('空提交：没有内容时不创建 store（global-only 写入不再留空目录）')
}

// ---- 14. truncate / timeAgo 的非法输入 ----
{
  assert.equal(truncate('abcdef', undefined), 'abcdef')
  assert.equal(truncate('abcdef', null), 'abcdef')
  assert.equal(timeAgo(undefined), '未知')
  assert.equal(timeAgo('not-a-date'), '未知')
  ok('truncate/timeAgo：缺配置与非法时间不再输出 undefined / NaN')
}

console.log(`\naudit-2026-11-05 tests: ${passed} passed`)
