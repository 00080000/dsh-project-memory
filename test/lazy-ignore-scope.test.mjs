// 懒索引与 index_repo / watch 共用同一套扫描 ignore 口径（ROADMAP §6-15）：
//   1. 非 git 根：`node_modules` / `dist` / `vendor` 等内置忽略目录下的文件，不因模型读了一次就入库；
//   2. 项目根是某个 git 仓库的子目录：父仓 `.gitignore` 仍生效（向上找 `.git`，`git -C root`）；
//   3. 隐藏路径 / `roots.exclude` 的既有行为不回归；
//   4. 显式 `index_doc` 不受扫描口径影响（它不走懒索引）。
// 夹具全部落在 os.tmpdir() 下的 mkdtemp 子目录，不依赖 `/tmp` 本身。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { indexObservedBatch } from '../src/lazy.js'
import { ProjectMemoryStore } from '../src/store.js'
import { WatchManager } from '../src/watch.js'
import { isDefaultIgnoredRel, isGitIgnored, isGitIgnoredBatch } from '../src/util/fs.js'
import { indexDocTool } from '../src/tools/index-doc.js'

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

/** 临时项目（带 package.json，根推导不依赖 process.cwd()）。 */
function project(prefix = 'lazy-ignore-') {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}')
  return root
}

function storeOf(root) {
  return new ProjectMemoryStore(path.join(root, config.memoryDir)).load()
}

/** store 里的相对键固定是 `/` 分隔；从真实路径算出来，避免在断言里写死分隔符。 */
const relOf = (root, abs) => path.relative(root, abs).split(path.sep).join('/')
const storeRel = (root, abs) => relOf(root, abs).toLowerCase()

// ---------------------------------------------------------------------------
// 0. isDefaultIgnoredRel 只作用于目录段（跨 `/` 与 `\`）
// ---------------------------------------------------------------------------
{
  assert.equal(isDefaultIgnoredRel(path.posix.join('node_modules', 'pkg', 'a.js')), true)
  assert.equal(isDefaultIgnoredRel(path.win32.join('src', 'vendor', 'a.js')), true)
  assert.equal(isDefaultIgnoredRel(path.posix.join('dist', 'x.js')), true)
  assert.equal(isDefaultIgnoredRel(path.posix.join('src', 'a.js')), false)
  // 最后一段是文件名：根目录下一个叫 `build` 的普通文件仍然要收（与 listProjectFiles 同口径）。
  assert.equal(isDefaultIgnoredRel('build'), false, 'a file named build is not a directory hit')
  assert.equal(isDefaultIgnoredRel(path.posix.join('src', 'build')), false)
  assert.equal(isDefaultIgnoredRel(path.posix.join('src', 'build', 'a.js')), true)
  ok('isDefaultIgnoredRel only inspects directory segments, across both separators')
}

// ---------------------------------------------------------------------------
// 1. 非 git 根：默认忽略目录不进懒索引，同根源码正常入库
// ---------------------------------------------------------------------------
{
  const root = project('lazy-ignore-plain-')
  const ignored = [
    path.join(root, 'node_modules', 'pkg', 'a.js'),
    path.join(root, 'dist', 'x.js'),
    path.join(root, 'vendor', 'y.js'),
  ]
  const good = path.join(root, 'src', 'a.js')
  for (const dir of [['node_modules', 'pkg'], ['dist'], ['vendor'], ['src']]) {
    mkdirSync(path.join(root, ...dir), { recursive: true })
  }
  for (const file of ignored) writeFileSync(file, 'export function hiddenBuild(){ return 1 }\n')
  writeFileSync(good, 'export function visible(){ return 1 }\n')

  const items = [...ignored, good].map((filePath) => ({ filePath, sessionRoot: root }))
  const results = await indexObservedBatch(config, items, null)
  for (const file of ignored) assert.equal(results.get(file), false, `${path.basename(path.dirname(file))} must be skipped`)
  assert.equal(results.get(good), true, 'src/a.js should be indexed')

  const store = storeOf(root)
  for (const file of ignored) assert.equal(store.fileRecord(storeRel(root, file)), undefined, 'ignored build output must not enter the store')
  assert.ok(store.fileRecord(storeRel(root, good)), 'ordinary source must enter the store')
  ok('non-git root: node_modules / dist / vendor are skipped, src still indexed')
}

// ---------------------------------------------------------------------------
// 2. 显式 index_doc 不受默认忽略口径影响（它不走懒索引）
// ---------------------------------------------------------------------------
{
  const root = project('lazy-ignore-explicit-')
  const doc = path.join(root, 'dist', 'kept.md')
  mkdirSync(path.dirname(doc), { recursive: true })
  writeFileSync(doc, '# kept\n\nexplicitly requested\n')

  const out = await indexDocTool({}, config).execute({ file_path: doc, root })
  assert.match(out, /^Indexed:/, `unexpected index_doc output: ${out}`)
  const store = storeOf(root)
  assert.ok(store.fileRecord(storeRel(root, doc)), 'index_doc is the explicit escape hatch for ignored paths')
  ok('explicit index_doc still indexes a default-ignored file')
}

// ---------------------------------------------------------------------------
// 3. 父仓 .gitignore：项目根是仓库子目录时仍生效
// ---------------------------------------------------------------------------
{
  const repo = mkdtempSync(path.join(tmpdir(), 'lazy-ignore-parent-'))
  let gitOk = false
  try {
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
    gitOk = true
  } catch {
    // 与 test/gitignore-index.test.mjs 同风格：明确打印 skip，而不是静默当成通过。
    console.log('  SKIP parent-repo checks: git not available')
  }

  if (gitOk) {
    writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n')
    const sub = path.join(repo, 'sub')
    mkdirSync(path.join(sub, 'src'), { recursive: true })
    mkdirSync(path.join(sub, 'ignored'), { recursive: true })
    writeFileSync(path.join(sub, 'package.json'), '{"name":"sub-fixture"}')
    const ignoredJs = path.join(sub, 'ignored', 'a.js')
    const goodJs = path.join(sub, 'src', 'a.js')
    const ignoredDoc = path.join(sub, 'ignored', 'note.md')
    writeFileSync(ignoredJs, 'export function nope(){ return 1 }\n')
    writeFileSync(goodJs, 'export function yes(){ return 1 }\n')
    writeFileSync(ignoredDoc, '# ignored by parent repo\n')

    const ignoredRel = relOf(sub, ignoredJs)
    const goodRel = relOf(sub, goodJs)
    // 单条与批量两条分支都必须以 root 为 cwd 解释 rel（父仓的 .gitignore 在 sub 之上）。
    assert.equal(isGitIgnored(sub, ignoredJs), true, 'single check-ignore must see the parent repo')
    assert.equal(isGitIgnored(sub, goodJs), false, 'tracked source next to it is not ignored')
    assert.equal(isGitIgnoredBatch(sub, [ignoredRel]).has(ignoredRel), true, 'single-rel batch branch')
    const batch = isGitIgnoredBatch(sub, [ignoredRel, goodRel])
    assert.equal(batch.has(ignoredRel), true, 'multi-rel batch must see the parent repo')
    assert.equal(batch.has(goodRel), false, 'multi-rel batch must not over-match')

    // 显式 watch 根让 sub 成为项目根（否则最近的 VCS 标记是父仓 repo）。
    const wm = new WatchManager({}, config)
    assert.equal(wm.addRoot(sub), true, 'fixture: sub must be registerable as a watch root')
    const results = await indexObservedBatch(config, [
      { filePath: ignoredJs, sessionRoot: sub },
      { filePath: goodJs, sessionRoot: sub },
    ], wm)
    wm.stop()

    assert.equal(results.get(ignoredJs), false, 'parent-repo-ignored file must not be indexed')
    assert.equal(results.get(goodJs), true, 'src/a.js must still be indexed')
    const store = storeOf(sub)
    assert.equal(store.fileRecord(storeRel(sub, ignoredJs)), undefined)
    assert.ok(store.fileRecord(storeRel(sub, goodJs)))
    ok('parent repo: .gitignore above the project root is honored (single + batch check-ignore)')

    // 显式 index_doc 仍可入库（它不查 gitignore；只有 roots.exclude 是否能决）。
    const out = await indexDocTool({}, config).execute({ file_path: ignoredDoc, root: sub })
    assert.match(out, /^Indexed:/, `unexpected index_doc output: ${out}`)
    assert.ok(storeOf(sub).fileRecord(storeRel(sub, ignoredDoc)), 'explicit index_doc bypasses the scan scope')
    ok('explicit index_doc still indexes a gitignored file')
  }
}

// ---------------------------------------------------------------------------
// 4. 隐藏路径既有行为不回归
// ---------------------------------------------------------------------------
{
  const root = project('lazy-ignore-hidden-')
  mkdirSync(path.join(root, '.claude'), { recursive: true })
  const env = path.join(root, '.env')
  const hiddenDoc = path.join(root, '.claude', 'note.md')
  writeFileSync(env, 'SECRET=do-not-index\n')
  writeFileSync(hiddenDoc, '# hidden\n')

  const results = await indexObservedBatch(config, [
    { filePath: env, sessionRoot: root },
    { filePath: hiddenDoc, sessionRoot: root },
  ], null)
  assert.equal(results.get(env), false)
  assert.equal(results.get(hiddenDoc), false)
  const store = storeOf(root)
  assert.equal(store.fileRecord(storeRel(root, env)), undefined)
  assert.equal(store.fileRecord(storeRel(root, hiddenDoc)), undefined)
  ok('hidden paths still stay out of lazy indexing')
}

// ---------------------------------------------------------------------------
// 5. roots.exclude 既有行为不回归（子树前缀否定先于一切）
// ---------------------------------------------------------------------------
{
  const root = project('lazy-ignore-exclude-')
  const secretDir = path.join(root, 'private')
  mkdirSync(secretDir, { recursive: true })
  mkdirSync(path.join(root, 'src'), { recursive: true })
  const secret = path.join(secretDir, 'secret.js')
  const open = path.join(root, 'src', 'open.js')
  writeFileSync(secret, 'export function secret(){ return 1 }\n')
  writeFileSync(open, 'export function open(){ return 1 }\n')

  const cfg = { ...config, roots: { exclude: [secretDir] } }
  const results = await indexObservedBatch(cfg, [
    { filePath: secret, sessionRoot: root },
    { filePath: open, sessionRoot: root },
  ], null)
  assert.equal(results.get(secret), false)
  assert.equal(results.get(open), true)
  const store = storeOf(root)
  assert.equal(store.fileRecord(storeRel(root, secret)), undefined)
  assert.ok(store.fileRecord(storeRel(root, open)))
  ok('roots.exclude still wins over the lazy path')
}

console.log(`\nlazy-ignore-scope tests: ${passed} passed`)
