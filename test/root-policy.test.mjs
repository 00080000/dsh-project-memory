// 可配置根名单回归测试（issue #8）：
//   roots.allow   —— 精确放行内置名单里的目录（文件系统根除外）
//   roots.deny    —— 精确拒绝某个目录本身，子目录仍可成根
//   roots.exclude —— 子树前缀拒绝，里面的文件一律不进索引
// 覆盖：优先级、~ 展开、相对路径告警、Windows 大小写、所有生效面（工具 / 懒索引 /
// watch / 会话审计 / 任务桥）以及 watch.json 的启动自愈。
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import {
  assertSafeRoot,
  compileRootPolicy,
  excludedEntryForPath,
  isUnsafeRoot,
  listProjectFiles,
  resolveSafeIndexRoot,
  rootRejection,
} from '../src/util/fs.js'
import { indexRepository } from '../src/tools/index-repo.js'
import { indexDocTool } from '../src/tools/index-doc.js'
import { WatchManager } from '../src/watch.js'
import { findProjectRoot, indexFile } from '../src/lazy.js'
import { ProjectMemoryStore } from '../src/store.js'
import { memoryRootFor } from '../src/util/fs.js'
import { projectRootFor, taskStoreFor } from '../src/setup/taskbridge.js'
import { Config } from '../src/index.js'

let passed = 0
let failed = 0
function check(name, cond) {
  if (cond) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    console.error(`FAIL  ${name}`)
  }
}

const TMP = os.tmpdir()
const HOME = os.homedir()
const CONFIG = {
  memoryDir: '.dsh-project-memory',
  chunkChars: 3000,
  maxChunksPerFile: 40,
  maxFileSizeMb: 50,
  maxOutputChars: 8000,
  maxPdfPages: 1000,
  lazyIndexing: false,
  autoIndexOnFirstUse: false,
  watch: false,
  watchInterval: 15,
  enableTypeScript: false,
  autoContext: {},
}

function tempDir(prefix = 'pm-policy-') {
  return mkdtempSync(path.join(TMP, prefix))
}

function tempProject(prefix = 'pm-policy-') {
  const dir = tempDir(prefix)
  writeFileSync(path.join(dir, 'package.json'), '{"name":"policy-fixture"}')
  return dir
}

console.log('\n== schema declares the three root knobs ==')
{
  const declared = Config.dict.roots.dict
  check(
    'roots.allow / roots.deny / roots.exclude are declared',
    ['allow', 'deny', 'exclude'].every((key) => Object.hasOwn(declared, key)),
  )
  check('each list defaults to an empty array', ['allow', 'deny', 'exclude'].every((key) => {
    const def = declared[key].meta?.default
    return Array.isArray(def) && def.length === 0
  }))
}

console.log('\n== deny is exact; subdirectories are independent roots ==')
{
  const denied = tempProject('pm-policy-deny-')
  const child = path.join(denied, 'packages', 'child')
  mkdirSync(child, { recursive: true })
  writeFileSync(path.join(child, 'package.json'), '{"name":"child-fixture"}')
  writeFileSync(path.join(denied, 'root.js'), 'export function root() {}\n')
  writeFileSync(path.join(child, 'child.js'), 'export function child() {}\n')

  const cfg = { ...CONFIG, roots: { deny: [denied] } }
  check('the denied directory itself is refused', rootRejection(denied, cfg)?.kind === 'deny')
  check('a subdirectory of a denied directory is still allowed', rootRejection(child, cfg) === null)
  check('a sibling is unaffected', rootRejection(denied + '-sibling', cfg) === null)
  check('findProjectRoot does not use the denied directory as a root', findProjectRoot(path.join(denied, 'root.js'), { config: cfg }) === null)
  check('a project marker inside an allowed subdirectory still wins', findProjectRoot(path.join(child, 'child.js'), { config: cfg }) === child)
}

console.log('\n== exclude is a subtree prefix; files and inferred roots are refused ==')
{
  const project = tempProject('pm-policy-exclude-')
  const secret = path.join(project, 'private')
  mkdirSync(secret, { recursive: true })
  const secretDoc = path.join(secret, 'note.md')
  writeFileSync(secretDoc, '# private\n\nbody')
  writeFileSync(path.join(secret, 'secret.js'), 'export function secret() {}\n')
  writeFileSync(path.join(project, 'open.js'), 'export function open() {}\n')

  const cfg = { ...CONFIG, roots: { exclude: [secret] } }
  check('the excluded directory itself cannot be a root', rootRejection(secret, cfg)?.kind === 'exclude')
  check('a directory below it is also excluded', rootRejection(path.join(secret, 'nested'), cfg)?.kind === 'exclude')
  check('a path sharing the prefix but not a boundary is unaffected', rootRejection(secret + '-other', cfg) === null)
  check('excludedEntryForPath reports the matching config entry', excludedEntryForPath(path.join(secret, 'nested', 'x.js'), cfg)?.raw === secret)
  check('findProjectRoot refuses a file in the excluded subtree', findProjectRoot(path.join(secret, 'secret.js'), { config: cfg, sessionRoot: project }) === null)
  check('the same file resolves normally without the rule', findProjectRoot(path.join(secret, 'secret.js'), { sessionRoot: project }) === project)

  const out = await indexDocTool({}, cfg).execute({ file_path: secretDoc })
  check(
    'index_doc refuses an excluded file with an actionable message',
    out.startsWith('Not indexed:') && out.includes('roots.exclude') && out.includes('- id: project-memory'),
  )
  check('the refused index_doc does not create a store', !existsSync(path.join(project, cfg.memoryDir)))
}

console.log('\n== allow opens the built-in list, but never the filesystem root ==')
{
  const fsRoot = path.parse(process.cwd()).root
  const cfg = { ...CONFIG, roots: { allow: [TMP] } }
  check('an exact allow entry releases the built-in temp directory', rootRejection(TMP, cfg) === null)
  check('allowUnsafeRoots still does not permit the filesystem root', isUnsafeRoot(fsRoot, { ...CONFIG, allowUnsafeRoots: true }) === true)
  check('roots.allow cannot permit the filesystem root', isUnsafeRoot(fsRoot, { roots: { allow: [fsRoot] } }) === true)
  check('assertSafeRoot accepts an allowed built-in directory', assertSafeRoot(TMP, { config: cfg }) === TMP)

  const exec = { agent: { session: { header: { cwd: TMP } } } }
  check('the session root follows the same allow list', resolveSafeIndexRoot(exec, null, cfg) === TMP)
}

console.log('\n== priority: exclude > deny > allow > built-in ==')
{
  const dir = tempProject('pm-policy-priority-')
  const builtin = TMP
  const both = { ...CONFIG, roots: { allow: [dir], deny: [dir] } }
  check('deny beats allow for the same exact path', rootRejection(dir, both)?.kind === 'deny')
  const excludedAndDenied = { ...CONFIG, roots: { deny: [dir], exclude: [dir] } }
  check('exclude beats deny', rootRejection(dir, excludedAndDenied)?.kind === 'exclude')
  check('allowUnsafeRoots opens ordinary built-ins', rootRejection(HOME, { ...CONFIG, allowUnsafeRoots: true }) === null)
  check(
    'allowUnsafeRoots does not open roots.deny',
    rootRejection(dir, { ...CONFIG, allowUnsafeRoots: true, roots: { deny: [dir] } })?.kind === 'deny',
  )
  check(
    'allowUnsafeRoots does not open roots.exclude',
    rootRejection(builtin, { ...CONFIG, allowUnsafeRoots: true, roots: { exclude: [builtin] } })?.kind === 'exclude',
  )
}

console.log('\n== rejection messages name the rule and the config field ==')
{
  const denied = tempProject('pm-policy-msg-deny-')
  let denyErr = null
  try {
    assertSafeRoot(denied, { config: { ...CONFIG, roots: { deny: [denied] } } })
  } catch (err) {
    denyErr = err
  }
  check(
    'a roots.deny rejection is an UnsafeRootError naming roots.deny',
    denyErr?.name === 'UnsafeRootError' && denyErr?.code === 'deny' && /roots\.deny/.test(denyErr.message),
  )
  check('the message names the config entry point', /- id: project-memory/.test(denyErr.message) && /config:/.test(denyErr.message))

  let homeErr = null
  try {
    assertSafeRoot(HOME, { config: CONFIG })
  } catch (err) {
    homeErr = err
  }
  check(
    'a built-in rejection suggests roots.allow and still says why',
    /home directory/.test(homeErr?.message) && /roots\.allow/.test(homeErr?.message),
  )

  const excluded = tempProject('pm-policy-msg-exclude-')
  let excludeErr = null
  try {
    assertSafeRoot(path.join(excluded, 'sub'), { config: { ...CONFIG, roots: { exclude: [excluded] } } })
  } catch (err) {
    excludeErr = err
  }
  check(
    'an exclude rejection names the matching entry',
    excludeErr?.code === 'exclude' && excludeErr?.entry === excluded && /roots\.exclude/.test(excludeErr.message),
  )
}

console.log('\n== ~ expansion, relative-path warning, Windows case folding ==')
{
  const homePolicy = compileRootPolicy(
    { roots: { exclude: ['~/scratch'] } },
    { platform: 'linux', pathApi: path.posix, home: '/home/example', tmp: '/tmp', env: {} },
  )
  check(
    '~ expands against the configured home directory',
    excludedEntryForPath('/home/example/scratch/a.js', homePolicy)?.raw === '~/scratch',
  )

  const messages = []
  const relative = `relative-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const opts = { warn: (line) => messages.push(line) }
  compileRootPolicy({ roots: { deny: [relative] } }, opts)
  compileRootPolicy({ roots: { deny: [relative] } }, opts)
  check('a relative entry is ignored and warned exactly once', messages.length === 1 && /not an absolute path/.test(messages[0]))
  check('the ignored relative entry has no effect', rootRejection(path.resolve(relative), { roots: { deny: [relative] } }) === null)

  const win = compileRootPolicy(
    { roots: { deny: ['C:\\Shared\\Work'], exclude: ['C:\\Shared\\Archive'] } },
    { platform: 'win32', pathApi: path.win32, home: 'C:\\Users\\example', tmp: 'C:\\Temp', env: {} },
  )
  check('win32: deny matches case-insensitively', rootRejection('c:\\shared\\work', win)?.kind === 'deny')
  check('win32: deny is still exact, a child is allowed', rootRejection('C:\\Shared\\Work\\child', win) === null)
  check('win32: exclude matches case-insensitively across separators', rootRejection('c:/shared/archive/x.js', win)?.kind === 'exclude')

  const winAllow = compileRootPolicy(
    { roots: { allow: ['C:\\Temp'] } },
    { platform: 'win32', pathApi: path.win32, home: 'C:\\Users\\example', tmp: 'C:\\Temp', env: {} },
  )
  check('win32: an allow entry releases the built-in temp directory', rootRejection('C:\\Temp', winAllow) === null)
  check('win32: the drive root can never be allowed', rootRejection('C:\\', winAllow)?.kind === 'filesystem-root')
}

console.log('\n== indexing filters excluded files and removes stale copies ==')
{
  const project = tempProject('pm-policy-index-')
  const secret = path.join(project, 'private')
  mkdirSync(secret, { recursive: true })
  writeFileSync(path.join(project, 'open.js'), 'export function open() {}\n')
  writeFileSync(path.join(secret, 'secret.js'), 'export function secret() {}\n')
  writeFileSync(path.join(secret, 'notes.md'), '# private notes\n')

  await indexRepository({}, CONFIG, project, {})
  const store = () => new ProjectMemoryStore(memoryRootFor(project, CONFIG.memoryDir)).load()
  check('the baseline index contains the later-excluded files', 'private/secret.js' in store().files)

  const cfg = { ...CONFIG, roots: { exclude: [secret] } }
  await indexRepository({}, cfg, project, {})
  check(
    'a full index with roots.exclude drops the excluded subtree from the store',
    !Object.keys(store().files).some((rel) => rel.startsWith('private/')) && 'open.js' in store().files,
  )
  await assert.rejects(() => indexRepository({}, cfg, secret, {}), /roots\.exclude|excluded by/)

  const listing = listProjectFiles(project, { maxFiles: 100, maxDepth: 10, config: cfg })
  const rels = listing.files.map((f) => path.relative(project, f).split(path.sep).join('/'))
  check('listProjectFiles (walk fallback) omits the excluded subtree', !rels.some((rel) => rel.startsWith('private/')) && rels.includes('open.js'))

  // git 工作树走的是另一条分支（git ls-files），exclude 必须同样生效。
  try {
    execFileSync('git', ['init', '-q', project], { stdio: 'ignore' })
    const gitListing = listProjectFiles(project, { maxFiles: 100, maxDepth: 10, config: cfg })
    const gitRels = gitListing.files.map((f) => path.relative(project, f).split(path.sep).join('/'))
    check(
      'listProjectFiles (git branch) omits the excluded subtree too',
      !gitRels.some((rel) => rel.startsWith('private/')) && gitRels.includes('open.js'),
    )
    // 回归：exclude 必须在 maxDepth 之前判定。否则"被排除的深层文件"会把整轮扫描
    // 标成 truncated，调用方于是跳过旧条目清理——排除规则反而让旧索引留在盘上。
    const shallow = listProjectFiles(project, { maxFiles: 100, maxDepth: 1, config: cfg })
    const shallowRels = shallow.files.map((f) => path.relative(project, f).split(path.sep).join('/'))
    check(
      'excluded files deeper than maxDepth do not truncate the scan',
      shallow.capped === false && shallowRels.includes('open.js') && !shallowRels.some((rel) => rel.startsWith('private/')),
    )
  } catch {
    console.log('  --  git unavailable, git branch check skipped')
  }
}

console.log('\n== lazy indexing, watch, session root and task bridge share the rules ==')
{
  const project = tempProject('pm-policy-shared-')
  const secret = path.join(project, 'private')
  mkdirSync(secret, { recursive: true })
  const lazyFile = path.join(secret, 'lazy.js')
  writeFileSync(lazyFile, 'export function lazy() {}\n')
  const openFile = path.join(project, 'open.js')
  writeFileSync(openFile, 'export function open() {}\n')

  const cfg = { ...CONFIG, roots: { exclude: [secret] } }
  const wm = new WatchManager({}, cfg)
  check('lazy indexing skips an excluded file', (await indexFile({}, cfg, lazyFile, wm, project)) === false)
  check('lazy indexing still indexes a file outside the rule', (await indexFile({}, cfg, openFile, wm, project)) === true)

  const denied = tempProject('pm-policy-watch-')
  const watchCfg = { ...CONFIG, roots: { deny: [denied], exclude: [secret] } }
  const wm2 = new WatchManager({}, watchCfg)
  check('watchManager.addRoot refuses a roots.deny directory', wm2.addRoot(denied) === false)
  check('watchManager.addRoot refuses a directory inside roots.exclude', wm2.addRoot(secret) === false)
  wm2.stop()

  check('the session root is refused when it is inside roots.exclude', projectRootFor(secret, cfg) === null)
  const task = taskStoreFor(secret, cfg)
  check('the task bridge gets no store when the session root is excluded', task.root === null && task.store === null)

  const exec = { agent: { session: { header: { cwd: secret } } } }
  let sessionErr = null
  try {
    resolveSafeIndexRoot(exec, null, cfg)
  } catch (err) {
    sessionErr = err
  }
  check(
    'an excluded session cwd is refused with the exclude reason',
    sessionErr?.name === 'UnsafeRootError' && sessionErr?.code === 'exclude',
  )
}

console.log('\n== restorePersisted removes denied and excluded roots ==')
{
  const project = tempProject('pm-policy-heal-')
  const denied = tempProject('pm-policy-heal-deny-')
  const excluded = tempProject('pm-policy-heal-exclude-')
  const cfg = { ...CONFIG, roots: { deny: [denied], exclude: [excluded] } }

  const store = new ProjectMemoryStore(memoryRootFor(project, cfg.memoryDir))
  store.addWatch(project)
  store.addWatch(denied)
  store.addWatch(excluded)
  store.save()

  const cwd = process.cwd
  process.cwd = () => project
  const wm = new WatchManager({}, cfg)
  wm.restorePersisted()
  process.cwd = cwd
  wm.stop()

  check('a legitimate persisted root is restored', wm.roots.has(project))
  check('a roots.deny root is not restored', !wm.roots.has(denied))
  check('a roots.exclude root is not restored', !wm.roots.has(excluded))
  const after = new ProjectMemoryStore(memoryRootFor(project, cfg.memoryDir)).load()
  check(
    'watch.json is self-healed on startup',
    after.watchlist.includes(project) && !after.watchlist.includes(denied) && !after.watchlist.includes(excluded),
  )
}

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECKS FAILED`} (${passed} passed)`)
process.exit(failed === 0 ? 0 : 1)
