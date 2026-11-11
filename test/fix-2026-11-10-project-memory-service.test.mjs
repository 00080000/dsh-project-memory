// D3-1 原生 seam 回归：node test/fix-2026-11-10-project-memory-service.test.mjs
//
// 验收面（施工图 PLAN-2026-11-03-d2-d3-execution.md §3 D3-1）：
//   1. `installProjectMemoryService` 用假 ctx 把 api 注册到 `projectMemory`，api 只有四个动词；
//   2. remember → recall（标题词）拿到非空结果，`citation` 字段存在；没有来源时为空串；
//   3. 带 `sourcePath` + `sourceLine` 的召回条目给出 `path:line` 形状的 citation（不是只断言字符串）；
//   4. stats 有 files / entries；forget 返回被删 id 且之后召回不到；
//   5. 老宿主 / 测试桩没有 `ctx.provide` 时返回 null、不抛。
//
// 隔离：临时项目根（含 package.json）+ 临时 global.json，不读写用户家目录；
// 结束时 mkdtemp 目录整体清理。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { installProjectMemoryService } from '../src/project-memory-service.js'
import { ProjectMemoryStore } from '../src/store.js'
import { memoryRootFor, UnsafeRootError } from '../src/util/fs.js'
import { inject as pluginInject } from '../src/index.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const root = mkdtempSync(path.join(tmpdir(), 'pm-service-'))
const config = {
  memoryDir: '.dsh-project-memory',
  // global 也落在临时根里：默认路径是 ~/.config/...，测试不该碰用户的真实 global 池。
  insight: { globalFile: path.join(root, 'global.json') },
}

try {
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pm-service-fixture', version: '0.0.0' }))

  // ---- 1. 注册与 api 形状 ----
  let capturedName = null
  let captured = null
  const ctx = {
    provide(name, api) {
      capturedName = name
      captured = api
    },
  }
  const api = installProjectMemoryService(ctx, config)
  assert.equal(capturedName, 'projectMemory')
  assert.equal(captured, api)
  assert.deepEqual(Object.keys(api).sort(), ['forget', 'recall', 'remember', 'stats'])
  assert.deepEqual(pluginInject, ['llm', 'tools'], 'D3-1 是纯加法：顶层 inject 不得改动')
  ok('install 注册 projectMemory，api 恰好四个动词，顶层 inject 未变')

  // ---- 2. 老宿主安全跳过 ----
  assert.equal(installProjectMemoryService({}, config), null)
  assert.equal(installProjectMemoryService(undefined, config), null)
  assert.equal(installProjectMemoryService(null, config), null)
  ok('ctx 无 provide（含 undefined/null）时 install 返回 null 且不抛')

  // ---- 3. 写入口的根护栏：remember / forget 拒绝家目录，且不能创建 store ----
  const home = homedir()
  const homeStore = path.join(home, '.dsh-project-memory')
  const isUnsafeRejection = (err) => err instanceof UnsafeRootError && /Refusing/.test(err.message)
  assert.throws(() => api.remember({ kind: 'lesson', title: 'home write' }, { root: home }), isUnsafeRejection)
  assert.throws(() => api.forget('anything', { root: home }), isUnsafeRejection)
  assert.equal(existsSync(homeStore), false, '被根护栏拒绝的写入口不得在家目录创建 .dsh-project-memory')
  ok('remember / forget 在家目录上抛 UnsafeRootError，且未创建 store')

  // ---- 4. remember → recall ----
  const remembered = api.remember(
    {
      kind: 'lesson',
      title: 'quux frobnicator calibration guard',
      pattern: 'frobnicator calibration drifts when the release step skips it',
      fix: 'run frobnicator calibration before every release',
      confidence: 0.9,
    },
    { root },
  )
  assert.match(remembered.id, /^ins_/)
  assert.ok(['created', 'merged', 'reinforced', 'auto-merged'].includes(remembered.action), `unexpected action: ${remembered.action}`)

  const recalled = api.recall('frobnicator', { root })
  assert.ok(recalled.results.length >= 1, 'remember 之后 recall 必须拿到非空结果')
  const hit = recalled.results.find((r) => r.id === remembered.id)
  assert.ok(hit, `recall 结果里应有 ${remembered.id}`)
  assert.match(hit.title, /frobnicator/i)
  assert.equal(typeof hit.snippet, 'string')
  assert.ok(hit.snippet.length > 0)
  // 这条 lesson 没给 files → 没有来源 → citation 空串（不是 undefined / '(untitled)'）。
  assert.equal(hit.citation, '')
  assert.ok(api.recall('frobnicator', { root, limit: 1 }).results.length <= 1, 'limit 应生效')
  assert.deepEqual(api.recall('', { root }), { results: [] }, '空查询返回空结果而不是全部')
  ok('remember → recall 标题词命中，snippet/citation 字段形状符合契约')

  // ---- 5. 带来源的条目给出 path:line ----
  mkdirSync(path.join(root, 'notes'), { recursive: true })
  writeFileSync(path.join(root, 'notes', 'seed.md'), '# widgetspanner calibration runbook\n')
  const seedStore = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
  seedStore.setEntries('notes/seed.md', [
    {
      id: 'doc:notes/seed.md#0',
      type: 'doc',
      relPath: 'notes/seed.md',
      sourcePath: 'notes/seed.md',
      sourceLine: 7,
      title: 'widgetspanner calibration runbook',
      summary: 'widgetspanner calibration must follow the guarded procedure',
    },
  ])
  seedStore.markFile('notes/seed.md', { sha256: 'deadbeef', size: 42, indexedAt: new Date().toISOString() })
  seedStore.save()

  const docHits = api.recall('widgetspanner', { root, layers: ['doc'], limit: 5 })
  assert.equal(docHits.results.length, 1, 'layers=[doc] 只返回文档层')
  const [doc] = docHits.results
  assert.equal(doc.id, 'doc:notes/seed.md#0')
  assert.match(doc.citation, /:\d+$/, `citation 应是 path:line，实际 ${doc.citation}`)
  assert.equal(doc.citation, `${path.join(root, 'notes', 'seed.md')}:7`)
  assert.ok(existsSync(doc.citation.replace(/:\d+$/, '')), 'citation 的路径必须真实存在')
  ok('来源条目 citation 是 path:line，且路径指向真实文件')

  // ---- 6. stats ----
  const stats = api.stats({ root })
  assert.equal(stats.files, 1)
  assert.equal(stats.entries, 1)
  assert.equal(stats.insights, 1)
  assert.equal(stats.global, 0)
  assert.equal(stats.experience, 0)
  assert.equal(typeof stats.latest, 'string')
  ok('stats 返回 files / entries / insights / global 的最小对象')

  // ---- 7. forget：删条目 + 顺手清 vectors.json 行 ----
  const memoryDir = memoryRootFor(root, config.memoryDir)
  const vectorFile = path.join(memoryDir, 'vectors.json')
  const stride = 256
  const floats = new Float32Array(2 * stride)
  floats[0] = 0.5
  writeFileSync(vectorFile, JSON.stringify({
    version: 1,
    model: 'test-embed',
    dim: stride,
    ids: [remembered.id, 'ins_keep'],
    hashes: ['h-remembered', 'h-keep'],
    blob: Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64'),
  }))
  assert.deepEqual(api.forget(remembered.id, { root }), { deleted: [remembered.id] })
  const vectorDoc = JSON.parse(readFileSync(vectorFile, 'utf8'))
  assert.deepEqual(vectorDoc.ids, ['ins_keep'], 'vectors.json 里被删条目的行必须清掉')
  assert.equal(vectorDoc.ids.includes(remembered.id), false)
  const after = api.recall('frobnicator', { root })
  assert.equal(after.results.some((r) => r.id === remembered.id), false, 'forget 之后不能再召回')
  assert.deepEqual(api.forget('no-such-id-or-query', { root }), { deleted: [] })
  ok('forget 返回被删 id，清理 vectors.json 行，删除后召回不到，未命中返回空数组')

  // ---- 8. 损坏的向量缓存不影响删除承诺 ----
  const survivor = api.remember({ kind: 'lesson', title: 'corrupt vector cache survivor', fix: 'deletion still works' }, { root })
  writeFileSync(vectorFile, '{ this is not valid json')
  assert.deepEqual(api.forget(survivor.id, { root }), { deleted: [survivor.id] })
  assert.equal(api.stats({ root }).insights, 0)
  ok('vectors.json 损坏时 forget 不抛，条目仍被删除')

  // ---- 9. 非法 scope / 缺 taskId / 非对象 entry 的明确错误 ----
  assert.throws(() => api.remember({ kind: 'lesson', title: 'task scoped' }, { root, scope: 'task' }), /requires taskId/)
  assert.throws(() => api.remember({ kind: 'lesson', title: 'bad scope' }, { root, scope: 'nope' }), /非法 scope/)
  assert.throws(() => api.remember(null, { root }), /entry must be an object/)
  ok("scope='task' 缺 taskId、非法 scope、非对象 entry 都抛出明确错误")

  // ---- 4b. 写入期路径约束：与 save_lesson 一样只收项目内相对路径 ----
  const withFiles = api.remember(
    {
      kind: 'lesson',
      title: 'citation guard probe',
      pattern: 'citation guard keeps only project-relative files',
      files: ['src/inside.ts', '../outside.ts', '/etc/passwd', 'C:\\win\\x.ts'],
    },
    { root },
  )
  const storedWithFiles = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir))
    .load()
    .insightItems()
    .find((i) => i.id === withFiles.id)
  assert.ok(storedWithFiles, '带 files 的条目应已落盘')
  assert.deepEqual(storedWithFiles.files, ['src/inside.ts'], '项目外 / 绝对 / 盘符路径必须被丢弃')
  ok('remember 的 files 走 normalizeCitationFiles：项目外路径被丢弃')
  // ---- 10. recall/stats 也过根护栏；task 级写入能用 taskId 读回来 ----
  const deniedRoot = mkdtempSync(path.join(tmpdir(), 'pm-service-denied-'))
  try {
    writeFileSync(path.join(deniedRoot, 'package.json'), '{}')
    const deniedApi = installProjectMemoryService({ provide() {} }, { ...config, roots: { deny: [deniedRoot] } })
    assert.throws(() => deniedApi.stats({ root: deniedRoot }), UnsafeRootError, 'stats 必须拒绝 deny 根')
    assert.throws(() => deniedApi.recall('anything', { root: deniedRoot }), UnsafeRootError, 'recall 必须拒绝 deny 根')
    assert.equal(existsSync(path.join(deniedRoot, '.dsh-project-memory')), false, '只读动词不得顺手建 store')
  } finally {
    rmSync(deniedRoot, { recursive: true, force: true })
  }
  const now = new Date().toISOString()
  const taskStore = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
  taskStore.addTask({
    id: 'tsk_service_task', projectHash: 'x', projectRoot: root, title: 'service task',
    steps: [], files: [], fileMeta: {}, archived: false, insights: [],
    createdAt: now, updatedAt: now, lastActiveAt: now,
  })
  taskStore.save()
  const taskSaved = api.remember(
    { kind: 'lesson', title: 'task scoped quokka', pattern: 'task-only memory is readable with taskId' },
    { root, scope: 'task', taskId: 'tsk_service_task' },
  )
  assert.ok(taskSaved.id)
  assert.equal(api.recall('quokka', { root }).results.length, 0, '未绑定任务时不召回 task 条目')
  assert.ok(api.recall('quokka', { root, taskId: 'tsk_service_task' }).results.length >= 1, '传 taskId 能读回 task 条目')
  assert.equal(api.stats({ root }).taskInsights, 1, 'stats 必须单列 task 级条目，否则 remember(scope:task) 在统计里消失')
  assert.throws(() => api.recall('quokka', { root, layers: 'doc' }), /layers must be an array/)
  const missingRoot = path.join(root, 'does-not-exist')
  assert.throws(() => api.remember({ title: 'typo root' }, { root: missingRoot }), /does not exist/, '拼错的 root 不能建 store')
  assert.throws(() => api.recall('x', { root: missingRoot }), /does not exist/)
  assert.throws(() => api.stats({ root: missingRoot }), /does not exist/)
  assert.equal(existsSync(path.join(missingRoot, '.dsh-project-memory')), false)
  ok('recall/stats 过根护栏；task 级写入可通过 taskId 召回；layers 非法即报错')

  // ---- 11. forget 命中超 cap：必须能区分“没命中”与“命中太多、拒绝删” ----
  const capApi = installProjectMemoryService({ provide() {} }, {
    ...config,
    insight: { ...config.insight, maxForgetMatches: 1 },
  })
  const capStore = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
  capStore.replaceInsightItems([
    ...capStore.insightItems(),
    { id: 'ins_zebra1', kind: 'lesson', scope: 'project', title: 'zebra one', pattern: 'zebra pattern one' },
    { id: 'ins_zebra2', kind: 'lesson', scope: 'project', title: 'zebra two', pattern: 'zebra pattern two' },
  ])
  capStore.save()
  const capped = capApi.forget('zebra', { root })
  assert.deepEqual(capped.deleted, [], '超 cap 不删任何条目')
  assert.equal(capped.tooMany, true)
  assert.equal(capped.matched, 2, '匹配数必须可读，否则与“没命中”无法区分')
  ok('forget 超 cap 返回 tooMany/matched，不再与没命中同形')

} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\nproject-memory-service tests: ${passed} passed`)
