// 懒索引的三条加速（node test/lazy-batch.test.mjs）：
//   1. `record.mtimeMs` 快路径：重复读同一个已索引文件不读盘、不哈希、不问 git；
//   2. mtime 变了但内容没变（touch / checkout 还原）时把新 mtime 记回去，否则快路径永远命不中；
//   3. 一次 flush 只 commit 一次、只起一次 `git check-ignore`。
//
// 第 1 条是有意的取舍：mtime + size 都没变就当"内容没变"，因此**把 mtime 还原回去的改动察觉不到**
// （rsync -t / tar 的还原就是这种形状）。这里把这条取舍写成断言，免得以后被当成 bug"修掉"而
// 悄悄把每次读文件都变成一次整读 + sha256。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { indexFile, indexObservedBatch } from '../src/lazy.js'
import { ProjectMemoryStore } from '../src/store.js'
import { isGitIgnored, isGitIgnoredBatch } from '../src/util/fs.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const config = {
  memoryDir: '.dsh-project-memory',
  chunkChars: 3000,
  maxChunksPerFile: 40,
  maxFileSizeMb: 10,
  maxPdfPages: 1000,
  enableTypeScript: false,
}

function project() {
  const root = mkdtempSync(path.join(tmpdir(), 'lazybatch-'))
  // 有项目标记才推得出根；也不依赖 process.cwd()。
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}')
  mkdirSync(path.join(root, 'src'), { recursive: true })
  return root
}

function storeOf(root) {
  return new ProjectMemoryStore(path.join(root, config.memoryDir)).load()
}

const countSaves = (store) => {
  let n = 0
  const orig = store.save.bind(store)
  store.save = (...args) => {
    n++
    return orig(...args)
  }
  return () => n
}

// ---------------------------------------------------------------------------
// 1. mtime 快路径
// ---------------------------------------------------------------------------
{
  const root = project()
  const file = path.join(root, 'src', 'a.js')
  writeFileSync(file, 'export function a(){ return 1 }\n')

  assert.equal(await indexFile({}, config, file, null, root), true, '首次索引应写入')
  const store = storeOf(root)
  const rec = store.fileRecord('src/a.js')
  assert.equal(typeof rec.mtimeMs, 'number', '写入时应记下 mtimeMs')
  const sha = rec.sha256

  // 未变更的重复读：返回 false（没有新写入），条目不重建。
  assert.equal(await indexFile({}, config, file, null, root), false, '未变更的重复读不应写入')
  assert.equal(store.fileRecord('src/a.js').sha256, sha, '未变更时不应重建条目')
  ok('未变更的重复读走 mtime 快路径（不写入、不改条目）')

  // 有意取舍：mtime + size 都没变时按未变更处理 —— 需要时用 index_repo reindex。
  // 直接改写记录里的 mtime，不依赖 utimes() 还原：部分文件系统（如 NTFS）上 JS 无法逐位还原。
  writeFileSync(file, 'export function a(){ return 2 }\n')
  store.refreshMtime('src/a.js', statSync(file).mtimeMs)
  store.commit(() => {})
  assert.equal(await indexFile({}, config, file, null, root), false, 'mtime+size 都没变时按未变更处理')
  assert.equal(store.fileRecord('src/a.js').sha256, sha, '这就是 mtime 快路径的代价（文档已写明）')
  ok('mtime 被还原的同尺寸改动察觉不到（与 make/tsc 同一取舍）')
}

// ---------------------------------------------------------------------------
// 2. 内容没变、mtime 变了 → 记回新 mtime
// ---------------------------------------------------------------------------
{
  const root = project()
  const file = path.join(root, 'src', 'b.js')
  writeFileSync(file, 'export function b(){ return 1 }\n')
  await indexFile({}, config, file, null, root)
  const store = storeOf(root)
  const before = store.fileRecord('src/b.js').mtimeMs

  const later = (Date.now() + 60_000) / 1000
  utimesSync(file, later, later)
  assert.equal(await indexFile({}, config, file, null, root), false, '内容未变，不该写入条目')
  const after = store.fileRecord('src/b.js').mtimeMs
  assert.notEqual(after, before, '新 mtime 应被记回去，否则快路径永远命不中')
  assert.equal(after, statSync(file).mtimeMs, 'mtime 必须是 stat 的原值（不经任何取整）')
  ok('touch 后内容未变 → 只刷新 mtimeMs，不重写条目')
}

// ---------------------------------------------------------------------------
// 3. 一批一次 commit
// ---------------------------------------------------------------------------
{
  const root = project()
  const items = []
  for (let i = 0; i < 8; i++) {
    const file = path.join(root, 'src', `m${i}.js`)
    writeFileSync(file, `export function m${i}(){ return ${i} }\n`)
    items.push({ filePath: file, sessionRoot: root })
  }
  const store = storeOf(root)
  const saves = countSaves(store)

  const results = await indexObservedBatch(config, items, null)
  assert.equal([...results.values()].filter(Boolean).length, 8, '8 个新文件都应写入')
  assert.equal(saves(), 1, `一批 8 个文件应只 save 一次，实际 ${saves()} 次`)
  for (let i = 0; i < 8; i++) assert.ok(store.fileRecord(`src/m${i}.js`), `m${i}.js 应进 store`)
  ok('一批 8 个文件只落盘一次')
}

// ---------------------------------------------------------------------------
// 4. 批内 gitignore 只起一次 git（语义与逐个判定一致）
// ---------------------------------------------------------------------------
{
  const root = project()
  writeFileSync(path.join(root, '.gitignore'), 'ignored.js\nbuild/\n')
  const files = ['a.js', 'ignored.js', 'sub/c.js']
  mkdirSync(path.join(root, 'src', 'sub'), { recursive: true })
  for (const rel of files) writeFileSync(path.join(root, 'src', rel), 'export const x = 1\n')
  let gitOk = false
  try {
    execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' })
    gitOk = true
  } catch {
    // 没有 git 的环境：跳过 git 那半组（会在结尾打印，而不是静默当成通过）
    console.log('  skip gitignore batch (no git)')
  }
  if (gitOk) {
    const rels = files.map((f) => `src/${f}`)
    const batch = isGitIgnoredBatch(root, rels)
    for (const rel of rels) assert.equal(batch.has(rel), isGitIgnored(root, path.join(root, rel)), `${rel} 批量与逐个判定必须一致`)
    assert.equal(batch.has('src/ignored.js'), true, 'ignored.js 应被判为忽略')
    assert.equal(batch.has('src/a.js'), false, 'a.js 不应被忽略')
    ok('批量 check-ignore 与逐个判定一致')
  }

  const items = [
    { filePath: path.join(root, 'src', 'a.js'), sessionRoot: root },
    { filePath: path.join(root, 'src', 'ignored.js'), sessionRoot: root },
  ]
  const results = await indexObservedBatch(config, items, null)
  assert.equal(results.get(path.join(root, 'src', 'a.js')), true, 'a.js 应被索引')
  assert.equal(results.get(path.join(root, 'src', 'ignored.js')), false, '被忽略的文件不应被索引')
  const store = storeOf(root)
  assert.ok(store.fileRecord('src/a.js'), 'a.js 应在 store 里')
  assert.equal(store.fileRecord('src/ignored.js'), undefined, 'ignored.js 不应进 store')
  ok('批内 gitignore 生效且不污染其它文件')
}

console.log(`\nlazy-batch tests: ${passed} passed`)
