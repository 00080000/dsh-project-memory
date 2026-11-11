// 2026-11-10 审计回归：读失败不覆盖、rewrite 不复活跨进程删除、重复副本取新、扩桶不抖动、懒索引相对路径、git 空清单保护、空文档快路径。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, chmodSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProjectMemoryStore, _clearStoreCacheForTest } from '../src/store.js'
import { GlobalStore, cfgInsight, normalizeInsight, pruneItems, promoteProjectToGlobal, saveInsight } from '../src/insight-store.js'
import { actInsight, editMemoryItem } from '../src/commands/insight-actions.js'
import { listProjectFiles } from '../src/util/fs.js'
import { indexObservedBatch } from '../src/lazy.js'
import { docEntriesNeedBackfill } from '../src/doc-index.js'
import { classifyShellCommand } from '../src/ops.js'
import { shardItem, shardItems } from './shard-format.mjs'

let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }
const tmp = (p) => path.join(mkdtempSync(path.join(tmpdir(), p)), 'mem')

function seed(store, rels) {
  for (const rel of rels) {
    store.markFile(rel, { sha256: `h-${rel}`, size: 1, type: 'code', indexedAt: new Date().toISOString() })
    store.setEntries(rel, [{ id: `${rel}#1`, type: 'code', title: rel, sourcePath: rel, sourceLine: 1 }])
  }
}

// 1. 读失败（EISDIR）→ readOnly，save 不写、不删
{
  const dir = tmp('audit-read-')
  const store = new ProjectMemoryStore(dir).load()
  seed(store, ['src/a.js'])
  store.save()
  _clearStoreCacheForTest()
  const bucket = path.join(dir, 'shards', readdirSync(path.join(dir, 'shards'))[0])
  // insights.json 换成目录，模拟 EISDIR 读失败
  mkdirSync(path.join(dir, 'insights.json'))
  const loaded = new ProjectMemoryStore(dir).load()
  loaded.replaceInsightItems([{ id: 'new', kind: 'lesson', scope: 'project', title: 'new' }])
  assert.equal(loaded.save(), false, '读失败时 save 必须返回 false')
  assert.equal(loaded._readOnly, true)
  assert.ok(readdirSync(path.join(dir, 'insights.json')).length === 0, '不能覆盖不可读的 insights.json')
  ok('读失败 → readOnly，save 不写不覆盖')
  assert.ok(bucket)
}

// 2. 跨进程删除不被 rewrite 复活
{
  const dir = tmp('audit-resurrect-')
  const a = new ProjectMemoryStore(dir).load()
  seed(a, ['src/a.js', 'src/b.js', 'src/c.js'])
  a.save()
  _clearStoreCacheForTest()
  const b = new ProjectMemoryStore(dir).load()
  b.removeFile('src/a.js')
  b.save()
  _clearStoreCacheForTest()
  a.markFile('big.js', { sha256: 'big', size: 1, type: 'code', indexedAt: new Date().toISOString() })
  a.setEntries('big.js', [{ id: 'big#1', type: 'code', title: 'big', sourcePath: 'big.js', sourceLine: 1 }])
  a._needsShardRewrite = true
  a.save()
  assert.equal(shardItem(dir, 'src/a.js'), undefined, '另一进程删掉的文件不能被 rewrite 复活')
  assert.ok(shardItem(dir, 'big.js'))
  ok('rewrite 不复活跨进程删除')
}

// 3. 重复副本取 indexedAt 新者
{
  const dir = tmp('audit-dupe-')
  mkdirSync(path.join(dir, 'shards'), { recursive: true })
  writeFileSync(path.join(dir, 'format.json'), JSON.stringify({ version: 3, layout: 'bucket', bucketSize: 32768, bucketCount: 2 }))
  const oldItem = { relPath: 'src/a.js', record: { sha256: 'OLD', size: 1, type: 'code', indexedAt: '2026-01-01T00:00:00.000Z' }, entries: [] }
  const newItem = { relPath: 'src/a.js', record: { sha256: 'NEW', size: 1, type: 'code', indexedAt: '2026-02-01T00:00:00.000Z' }, entries: [] }
  writeFileSync(path.join(dir, 'shards', 'legacy.json'), JSON.stringify(oldItem))
  writeFileSync(path.join(dir, 'shards', 'bucket-00000.json'), JSON.stringify({ version: 3, bucket: 0, items: [newItem] }))
  _clearStoreCacheForTest()
  const store = new ProjectMemoryStore(dir).load()
  assert.equal(store.files['src/a.js'].sha256, 'NEW', '加载取最新副本')
  store.save()
  assert.equal(shardItem(dir, 'src/a.js').record.sha256, 'NEW', 'rewrite 后仍是新副本')
  ok('同 rel 重复副本按 indexedAt 取新')
}

// 4. 逐文件增长不反复全量重写
{
  const dir = tmp('audit-grow-')
  const store = new ProjectMemoryStore(dir).load()
  let rewrites = 0
  const orig = store._rewriteAllBuckets.bind(store)
  store._rewriteAllBuckets = (...args) => { rewrites++; return orig(...args) }
  for (let i = 0; i < 120; i++) {
    const rel = `src/f${i}.js`
    store.markFile(rel, { sha256: `g${i}`, size: 1, type: 'code', indexedAt: new Date().toISOString() })
    store.setEntries(rel, [{ id: `${rel}#1`, type: 'code', title: rel, sourcePath: rel, sourceLine: 1, text: 'x'.repeat(900) }])
    store.save()
  }
  const format = JSON.parse(readFileSync(path.join(dir, 'format.json'), 'utf8'))
  assert.ok(format.bucketCount > 1)
  assert.ok(rewrites <= 3, `逐文件增长不应反复全量重写：${rewrites}`)
  ok('逐文件增长：桶数扩展但不反复全量重写')
}

// 5. git 祖先仓把整棵子树全忽略：空清单必须标 truncated
{
  const repo = mkdtempSync(path.join(tmpdir(), 'audit-git-'))
  let gitOk = true
  try { execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' }) } catch { gitOk = false }
  if (gitOk) {
    writeFileSync(path.join(repo, '.gitignore'), '*\n')
    const sub = path.join(repo, 'proj')
    mkdirSync(path.join(sub, 'src'), { recursive: true })
    writeFileSync(path.join(sub, 'package.json'), '{"name":"x"}')
    writeFileSync(path.join(sub, 'src', 'a.js'), 'export const a=1\n')
    const out = listProjectFiles(sub, { config: { memoryDir: '.dsh-project-memory' } })
    assert.equal(out.files.length, 0)
    assert.equal(out.truncated, true, '祖先 .gitignore 全忽略时不能把空清单当删除')
  } else {
    console.log('  SKIP git not available')
  }
  ok('git 空清单（祖先 ignore）标 truncated')
}

// 6. 懒索引：相对 displayPath 按 sessionRoot 解析
{
  const root = mkdtempSync(path.join(tmpdir(), 'audit-lazy-'))
  writeFileSync(path.join(root, 'package.json'), '{"name":"lazy"}')
  mkdirSync(path.join(root, 'src'), { recursive: true })
  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
  const config = { memoryDir: '.dsh-project-memory', maxFileSizeMb: 10, enableTypeScript: false }
  const results = await indexObservedBatch(config, [{ filePath: 'src/a.ts', sessionRoot: root }])
  assert.equal(results.get('src/a.ts'), true, '相对路径应按 sessionRoot 解析')
  assert.ok(new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load().fileRecord('src/a.ts'))
  ok('懒索引相对路径按 sessionRoot 解析')
}

// 7. 空文档不再永久打穿 mtime 快路径
assert.equal(docEntriesNeedBackfill([]), false)
assert.equal(docEntriesNeedBackfill([{ type: 'doc', terms: 'x', termsVersion: 0 }]), true)
ok('空文档不需要 terms 回填')

// 8. git 写族 op 与 targets 一致
{
  const co = classifyShellCommand('git checkout -- src/a.ts')
  assert.deepEqual(co.ops, ['file-write'])
  assert.ok(co.targets.includes('src/a.ts'))
  assert.deepEqual(classifyShellCommand('git clean -fdx').ops, ['file-delete'])
  ok('git checkout/clean：op 与 targets 同口径')
}

// 9. 密钥形态放进 trigger.prevents 也必须被拒
{
  const dir = tmp('audit-secret-')
  const store = new ProjectMemoryStore(dir).load()
  const cfg = cfgInsight({})
  const raw = { title: '密钥检查', fix: '正常内容', trigger: { prevents: 'api_key = "sk-abcdefghijklmnopqrstuvwx123456"' } }
  const res = saveInsight({ store, raw, scope: 'project', cfg })
  assert.equal(res.ok, false, 'trigger 内的密钥形态也要被密文过滤拦住')
  ok('密文过滤覆盖 trigger')
}

// 10. 畸形 raw 不能抛 / 不能落 (untitled)
{
  const dir = tmp('audit-raw-')
  const store = new ProjectMemoryStore(dir).load()
  const cfg = cfgInsight({})
  assert.equal(saveInsight({ store, raw: null, scope: 'project', cfg }).ok, false)
  assert.equal(saveInsight({ store, raw: [], scope: 'project', cfg }).ok, false)
  ok('畸形 raw 返回错误而不是抛/落脏条目')
}

// 11. 容量裁剪保护刚移动的条目
{
  const items = [{ id: 'old', updatedAt: '2020-01-01T00:00:00.000Z' }, { id: 'mid', updatedAt: '2021-01-01T00:00:00.000Z' }, { id: 'moved', updatedAt: '2022-01-01T00:00:00.000Z' }]
  pruneItems(items, 2, '2026-01-01T00:00:00.000Z', { protectedIds: new Set(['moved']) })
  assert.ok(items.some((i) => i.id === 'moved'), '被移动的条目不能被容量收口删掉')
  ok('prune 保护移动中的条目')
}

// 12. 降级后不会被下一次无关写入自动升回
{
  const dir = tmp('audit-hold-')
  const gfile = path.join(dir, 'global.json')
  const store = new ProjectMemoryStore(dir).load()
  const gs = new GlobalStore(gfile).load()
  const now = new Date().toISOString()
  const ins = normalizeInsight({ title: '降级后别回来', kind: 'lesson', fix: 'x', sourceTaskIds: ['t1', 't2', 't3'] }, { scope: 'global', nowIso: now })
  ins.id = 'ins_demote'
  gs.items().push(ins); gs.markDirty()
  const res = actInsight({ store, gs, action: 'demote', scope: 'global', id: 'ins_demote', cfg: { maxProject: 100, globalPromoteTasks: 3 } })
  assert.equal(res.ok, true)
  saveInsight({ store, globalStore: gs, raw: { title: '无关新知识', pattern: '无关', fix: 'x' }, scope: 'project', cfg: cfgInsight({}) })
  assert.ok(store.insightItems().some((i) => i.id.startsWith('ins_demote')), '降级条目应留在 project')
  assert.equal(globalStoreHas(gs, 'ins_demote'), false, '不能被无关写入自动升回 global')
  ok('降级后不会被无关写入自动升回')
  function globalStoreHas(g, id) { return g.items().some((i) => i.id === id) }
}

// 13. 面板编辑正文后派生词刷新
{
  const dir = tmp('audit-edit-derive-')
  const store = new ProjectMemoryStore(dir).load()
  const item = normalizeInsight({ title: '旧标题', kind: 'lesson', pattern: '旧坑', fix: '旧改法' }, { scope: 'project' })
  item.triggerDerived = { keywords: ['旧坑'], actions: [], paths: [] }
  store.replaceInsightItems([item])
  const res = editMemoryItem({ store, gs: null, scope: 'project', id: item.id, fields: { title: '全新标题', pattern: '发布前要跑测试', fix: '先跑 npm test' } })
  assert.equal(res.ok, true)
  const edited = store.insightItems().find((i) => i.id === item.id)
  assert.ok(edited.triggerDerived, '编辑正文后必须重新派生')
  assert.ok(!edited.triggerDerived.keywords.includes('旧坑'), '旧派生词必须消失')
  ok('面板编辑后派生词刷新')
}

// 14. 全量重排用“实际写过的桶”清理：缩桶后空桶里的已删条目不能复活
{
  const dir = tmp('audit-stale-bucket-')
  const store = new ProjectMemoryStore(dir).load()
  const rels = Array.from({ length: 200 }, (_, i) => `src/f${i}.js`)
  seed(store, rels)
  store.save()
  const bucketCount = JSON.parse(readFileSync(path.join(dir, 'format.json'), 'utf8')).bucketCount
  assert.ok(bucketCount > 1, '前提：测试数据要跨桶')
  const inBucket = (rel, n) => (parseInt(createHash('sha256').update(rel).digest('hex').slice(0, 8), 16) % n)
  // 缩到 2 桶：只保留会落 bucket-0 的文件，bucket-1 里的条目全部删除。
  const keep = rels.filter((rel) => inBucket(rel, 2) === 0)
  const drop = rels.filter((rel) => inBucket(rel, 2) === 1)
  assert.ok(keep.length && drop.length, '前提：两个桶都有文件')
  for (const rel of drop) store.removeFile(rel)
  writeFileSync(path.join(dir, 'format.json'), JSON.stringify({ version: 3, layout: 'bucket', bucketSize: 32768, bucketCount: 2 }))
  store._bucketCount = 2
  store._needsShardRewrite = true
  assert.equal(store.save(), true)
  assert.ok(!readdirSync(path.join(dir, 'shards')).includes('bucket-00001.json'), '缩桶后的空桶必须删掉')
  _clearStoreCacheForTest()
  const reread = new ProjectMemoryStore(dir).load()
  assert.equal(Object.keys(reread.files).length, keep.length, '已删除的条目不能从残留桶复活')
  ok('缩桶重排：空桶里的已删条目不再复活')
}

// 15. 加载后读失败：合并读不到时不能继续写，否则覆盖另一进程的条目
if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
  const dir = tmp('audit-merge-read-')
  const a = new ProjectMemoryStore(dir).load()
  a.replaceInsightItems([{ id: 'a', kind: 'lesson', scope: 'project', title: 'a' }])
  a.save()
  _clearStoreCacheForTest()
  const b = new ProjectMemoryStore(dir).load()
  b.replaceInsightItems([...b.insightItems(), { id: 'b', kind: 'lesson', scope: 'project', title: 'b' }])
  b.save()
  const file = path.join(dir, 'insights.json')
  chmodSync(file, 0o000)
  try {
    a.replaceInsightItems([...a.insightItems(), { id: 'c', kind: 'lesson', scope: 'project', title: 'c' }])
    assert.equal(a.save(), false, '锁内读到 EACCES 时必须放弃写入')
  } finally {
    chmodSync(file, 0o644)
  }
  const ids = JSON.parse(readFileSync(file, 'utf8')).items.map((i) => i.id)
  assert.ok(ids.includes('b'), '另一进程刚写的条目不能被旧快照覆盖')
  ok('锁内读失败：save 返回 false，保留对方写入')
}

// 16. format.json 读失败：不能按旧桶数 cleanup 掉另一进程的新桶
if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
  const dir = tmp('audit-layout-read-')
  const store = new ProjectMemoryStore(dir).load()
  seed(store, ['src/a.js'])
  store.save()
  const before = readdirSync(path.join(dir, 'shards')).sort()
  const formatFile = path.join(dir, 'format.json')
  chmodSync(formatFile, 0o000)
  try {
    store.markFile('src/b.js', { sha256: 'h-b', size: 1, type: 'code', indexedAt: new Date().toISOString() })
    assert.equal(store.save(), false, '读不到 layout 时 save 必须失败')
  } finally {
    chmodSync(formatFile, 0o644)
  }
  assert.deepEqual(readdirSync(path.join(dir, 'shards')).sort(), before, 'layout 读失败不得 cleanup 桶')
  ok('layout 读失败：save 返回 false，不删任何桶')
}

console.log(`\naudit-2026-11-10 tests: ${passed} passed`)
