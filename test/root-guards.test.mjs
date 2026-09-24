// 危险根护栏回归测试（GitHub issue #5：插件在家目录 / /opt/homebrew 建索引把内存打满）。
//
// 覆盖四件事，缺一条护栏就等于没修：
//   1. 判定：哪些目录永远不能当项目记忆根；
//   2. 入口：每个会写盘/扫描的入口都真的被挡住（工具、watch、auto-index、auto-inject、任务桥）；
//   3. 自愈：历史遗留（家目录已写进 watch.json）会在下次启动被摘掉；
//   4. 有界：扫描超限只截断，绝不把"没扫到"当成"已删除"。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import {
  assertSafeRoot,
  collectUnsafeRoots,
  collectUnsafeRootSets,
  isUnsafeRoot,
  resolveSafeIndexRoot,
  resolveIndexRoot,
  walkDir,
} from '../src/util/fs.js'
import { indexRepository, indexRepoTool } from '../src/tools/index-repo.js'
import { indexDocTool } from '../src/tools/index-doc.js'
import { watchRepoTool } from '../src/tools/watch-repo.js'
import { WatchManager } from '../src/watch.js'
import { findProjectRoot, indexFile } from '../src/lazy.js'
import { ProjectMemoryStore } from '../src/store.js'
import { NO_PROJECT_ROOT_NOTE, projectRootFor, taskStoreFor } from '../src/setup/taskbridge.js'
import { installAutoInject } from '../src/auto-inject.js'
import { memoryRootFor } from '../src/util/fs.js'

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

const HOME = os.homedir()
const TMP = os.tmpdir()

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

function tempProject(prefix = 'pm-guard-') {
  const dir = mkdtempSync(path.join(TMP, prefix))
  writeFileSync(path.join(dir, 'package.json'), '{"name":"guard-fixture"}')
  return dir
}

console.log('\n== unsafe root classification ==')
{
  const fsRoot = path.parse(process.cwd()).root
  // 系统前缀是**按平台**的：POSIX 用 /usr、/opt、/opt/homebrew…，Windows 用
  // %SystemRoot%/%ProgramFiles%/%ProgramData%。断言必须跟着平台走，否则在 windows-latest
  // 上会拿 `/usr` 去问一个 Windows 进程（那本来就是 "C:\\usr"，一个正常目录）。
  const systemPrefixes = process.platform === 'win32'
    ? [process.env.SystemRoot, process.env.windir, process.env.ProgramFiles, process.env.ProgramData]
    : ['/opt/homebrew', '/opt/local', '/opt', '/usr', '/usr/local', '/home/linuxbrew', '/nix']
  const safe = [tempProject(), path.join(TMP, 'pm-guard-child')]
  check('filesystem root is unsafe', isUnsafeRoot(fsRoot))
  check('home directory is unsafe', isUnsafeRoot(HOME))
  check('shared temp directory is unsafe', isUnsafeRoot(TMP))
  const notDenied = systemPrefixes.filter((p) => p && !isUnsafeRoot(p))
  if (notDenied.length) console.error(`       not denied: ${notDenied.join(', ')}`)
  check(`platform system / package-manager prefixes are unsafe (${process.platform})`, notDenied.length === 0)
  check('a project directory and its subdirectories are safe', safe.every((p) => !isUnsafeRoot(p)))
  check('empty / non-string input is unsafe', isUnsafeRoot('') && isUnsafeRoot(null))
}

console.log('\n== the deny list is built per platform (simulated, runs everywhere) ==')
{
  // 这条用例的意义：Windows 分支必须在 ubuntu 上也能被验证。第一版把 /usr、/opt 只塞进
  // POSIX 分支，却拿它们去断言 Windows，CI 才在 windows-latest 上红。
  const win = collectUnsafeRoots({
    platform: 'win32',
    pathApi: path.win32,
    home: 'C:\\Users\\me',
    tmp: 'C:\\Users\\me\\AppData\\Local\\Temp',
    env: {
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramData: 'C:\\ProgramData',
    },
  })
  const hasWin = (p) => win.has(p.toLowerCase())
  check(
    'win32: drive root, home + ancestors, AppData and temp are denied',
    ['C:\\', 'C:\\Users', 'C:\\Users\\me', 'C:\\Users\\me\\AppData', 'C:\\Users\\me\\AppData\\Local\\Temp'].every(hasWin),
  )
  check(
    'win32: %SystemRoot% / %ProgramFiles% / %ProgramData% are denied',
    ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'].every(hasWin),
  )
  check('win32: POSIX-style names are NOT denied (C:\\opt is a normal user directory)', !hasWin('C:\\opt') && !hasWin('C:\\usr'))
  check(
    'win32: %SystemRoot%\\Temp is denied even though only C:\\Windows was in the prefix list',
    ['C:\\Windows\\Temp', 'C:\\Users\\me\\AppData\\Local\\Temp'].every(hasWin),
  )

  const posix = collectUnsafeRoots({ platform: 'linux', pathApi: path.posix, home: '/home/me', tmp: '/tmp', env: {} })
  check(
    'posix: system and package-manager prefixes are denied',
    ['/usr', '/usr/local', '/opt', '/opt/homebrew', '/etc', '/var', '/home/linuxbrew', '/nix'].every((p) => posix.has(p)),
  )
  check('posix: home + ancestors and temp are denied', ['/home/me', '/home', '/tmp'].every((p) => posix.has(p)))
  check('posix: a project path is not denied', !posix.has('/home/me/project'))
  check('posix: a project inside the temp dir is not denied (exact match only)', !posix.has('/tmp/myproject'))

  // issue #5 的现场复核发现：macOS 的 os.tmpdir() 是 /var/folders/…/T（每用户私有），
  // 共享的 /tmp 是**另一个**路径，0.5.9 之前不在名单里 → `cd /tmp && dsh` 仍会全量扫 /tmp。
  const darwin = collectUnsafeRootSets({
    platform: 'darwin',
    pathApi: path.posix,
    home: '/Users/charlee',
    tmp: '/var/folders/zz/abc/T',
    env: {},
  })
  const hasMac = (p) => darwin.unsafe.has(p.toLowerCase()) // darwin 上 storeKey 会小写化
  check(
    'darwin: shared temp dirs are denied alongside the per-user one',
    ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp', '/var/folders', '/var/folders/zz/abc/T'].every(hasMac),
  )
  check(
    'darwin: home / Homebrew / /usr/local are denied, a project under the temp dir is not',
    ['/Users/charlee', '/opt/homebrew', '/usr/local'].every(hasMac) && !hasMac('/var/folders/zz/abc/T/myproject'),
  )
  check(
    'darwin: /tmp itself is classified as the shared temp directory',
    darwin.sharedTemp.has('/tmp') && darwin.sharedTemp.has('/var/folders/zz/abc/t'),
  )

  if (process.platform !== 'win32') {
    check('the shared /tmp is denied on this POSIX host too', isUnsafeRoot('/tmp'))
  }
}

console.log('\n== a marker inside a denied prefix must not win (the /opt/homebrew case) ==')
{
  // issue #5 的现场结论：/opt/homebrew 是被 STRONG_MARKERS 的 `.git` **主动选中**的
  // （ARM Mac 的 Homebrew 是 git clone），不是兜底误判。所以"拒绝前缀"必须能压过
  // "合法项目标记"——这条输入很反直觉，用一个临时目录 + 注入判定来复现。
  const fakeBrew = mkdtempSync(path.join(TMP, 'pm-brew-'))
  mkdirSync(path.join(fakeBrew, '.git'), { recursive: true })
  mkdirSync(path.join(fakeBrew, 'bin', 'deep'), { recursive: true })
  const brewFile = path.join(fakeBrew, 'bin', 'brew.js')
  writeFileSync(brewFile, 'export function brew() {}\n')
  const deepFile = path.join(fakeBrew, 'bin', 'deep', 'x.js')
  writeFileSync(deepFile, 'export function x() {}\n')

  // 控制组：没有前缀拒绝时，`.git` 确实会让它当选 —— 证明这条用例测的是"前缀 > 标记"。
  check('control: a bare .git WOULD make this directory the project root', findProjectRoot(brewFile) === fakeBrew)
  const denyBrew = (d) => path.resolve(d) === path.resolve(fakeBrew)
  check('a .git inside a denied prefix does not win', findProjectRoot(brewFile, { isUnsafe: denyBrew }) === null)
  check('the denied boundary also stops the upward walk', findProjectRoot(deepFile, { isUnsafe: denyBrew }) === null)
  check(
    'a sibling project outside the denied prefix is unaffected',
    findProjectRoot(path.join(tempProject('pm-outside-'), 'a.js'), { isUnsafe: denyBrew }) !== null,
  )
}

console.log('\n== assertSafeRoot / resolveSafeIndexRoot ==')
{
  let err = null
  try {
    assertSafeRoot(HOME)
  } catch (e) {
    err = e
  }
  check('assertSafeRoot throws UnsafeRootError for the home directory', err?.name === 'UnsafeRootError' && /home directory/.test(err.message))
  check('assertSafeRoot passes a project directory through', assertSafeRoot(tempProject()) !== undefined)
  check('allowUnsafe bypasses the guard explicitly', assertSafeRoot(HOME, { allowUnsafe: true }) === HOME)

  const exec = { agent: { session: { header: { cwd: HOME } } } }
  let resolved = null
  try {
    resolveSafeIndexRoot(exec, undefined, CONFIG)
  } catch (e) {
    resolved = e
  }
  check('resolveSafeIndexRoot refuses a session whose cwd is the home directory', resolved?.name === 'UnsafeRootError')
  const project = tempProject()
  check(
    'resolveSafeIndexRoot passes an explicit safe root through',
    resolveSafeIndexRoot(exec, project, CONFIG) === project,
  )
  check(
    'allowUnsafeRoots lets an explicit unsafe root through (opt-in only)',
    resolveSafeIndexRoot(exec, HOME, { ...CONFIG, allowUnsafeRoots: true }) === HOME,
  )
  check(
    'raw resolveIndexRoot stays a pure resolver (no throwing)',
    resolveIndexRoot(exec, undefined) === HOME,
  )
}

console.log('\n== watch manager ==')
{
  const wm = new WatchManager({}, CONFIG)
  check('addRoot refuses the home directory', wm.addRoot(HOME) === false)
  check('addRoot refuses the shared temp directory', wm.addRoot(TMP) === false)
  check('addRoot refuses the filesystem root', wm.addRoot(path.parse(process.cwd()).root) === false)
  const project = tempProject()
  check('addRoot accepts a project directory', wm.addRoot(project) === true)
  check('rootContaining finds the registered ancestor', wm.rootContaining(path.join(project, 'src', 'a.js')) === project)
  check('rootContaining ignores unrelated paths', wm.rootContaining(path.join(TMP, 'pm-unrelated', 'a.js')) === null)
}

console.log('\n== restorePersisted self-heals a polluted watchlist ==')
{
  const project = tempProject('pm-heal-')
  const store = new ProjectMemoryStore(memoryRootFor(project, CONFIG.memoryDir))
  store.addWatch(project)
  store.addWatch(HOME)
  store.addWatch('/opt/homebrew')
  store.save()

  const cwd = process.cwd
  process.cwd = () => project
  const wm = new WatchManager({}, CONFIG)
  wm.restorePersisted()
  process.cwd = cwd

  check('a legitimate persisted root is restored', wm.roots.has(project))
  check('a persisted home-directory root is dropped', !wm.roots.has(HOME))
  const after = new ProjectMemoryStore(memoryRootFor(project, CONFIG.memoryDir)).load()
  check('the home-directory root is removed from watch.json', !after.watchlist.includes(HOME))
  check('the package-manager root is dropped too', !after.watchlist.includes('/opt/homebrew'))
  wm.stop()
}

console.log('\n== index_repo guards ==')
{
  await assert.rejects(() => indexRepository({}, CONFIG, TMP, {}), /Refusing to use/)
  await assert.rejects(() => indexRepoTool({}, CONFIG).execute({ root: TMP }), /Refusing to use/)

  const project = tempProject('pm-guard-repo-')
  writeFileSync(path.join(project, 'a.js'), 'export function a() {}\n')
  const report = await indexRepoTool({}, CONFIG).execute({ root: project })
  check('a safe project still indexes normally', report.includes('Indexed project:') && report.includes('code symbols updated: 1'))
}

console.log('\n== index_doc refuses documents outside a project ==')
{
  const bare = mkdtempSync(path.join(TMP, 'pm-guard-bare-'))
  const note = path.join(bare, 'note.md')
  writeFileSync(note, '# Note\n\ncontent')
  const out = await indexDocTool({}, CONFIG).execute({ file_path: note })
  check('a marker-less document is refused with an actionable message', out.startsWith('Not indexed:') && /Pass root explicitly/.test(out))
  check('no store is created next to the refused document', !existsSync(path.join(bare, '.dsh-project-memory')))

  const project = tempProject('pm-guard-doc-')
  writeFileSync(path.join(project, 'package.json'), '{"name":"doc-fixture"}')
  const docPath = path.join(project, 'spec.md')
  writeFileSync(docPath, '# Spec\n\nbody text here.')
  const indexed = await indexDocTool({}, CONFIG).execute({ file_path: docPath })
  check('a document inside a project still indexes', indexed.startsWith('Indexed:'))
}

console.log('\n== watch_repo guards ==')
{
  const wm = new WatchManager({}, CONFIG)
  const out = await watchRepoTool(wm, CONFIG).execute({ root: TMP }, {})
  check('watch_repo refuses the shared temp directory', out.includes('Refusing to use') && out.startsWith('Not watching:'))
  const homeOut = await watchRepoTool(wm, CONFIG).execute({ root: HOME }, {})
  check('watch_repo refuses the home directory', homeOut.includes('Refusing to use') && /home directory/.test(homeOut))

  // 停止监听也必须走安全路径：旧实现会 load()/commit() 危险根的 store —— 读历史遗留的
  // 超大 store 能 OOM，写则会在家目录造出 .dsh-project-memory。
  const homeStoreExisted = existsSync(path.join(HOME, '.dsh-project-memory'))
  const stopOut = await watchRepoTool(wm, CONFIG).execute({ root: HOME, watch: false }, {})
  check('watch_repo can stop an unsafe root without touching its store', stopOut === `Stopped watching: ${HOME}`)
  check(
    'stopping an unsafe root does not create its memory directory',
    homeStoreExisted || !existsSync(path.join(HOME, '.dsh-project-memory')),
  )
}

console.log('\n== restorePersisted short-circuits on an unsafe cwd ==')
{
  const cwd = process.cwd
  process.cwd = () => HOME
  const wm = new WatchManager({}, CONFIG)
  wm.restorePersisted()
  process.cwd = cwd
  check('an unsafe cwd never restores (or loads) a store', wm.roots.size === 0)
  wm.stop()
}

console.log('\n== a safe marker-less working directory is still a memory root ==')
{
  const bare = mkdtempSync(path.join(TMP, 'pm-session-'))
  const file = path.join(bare, 'notes.js')
  writeFileSync(file, 'export function note() {}\n')
  check('sessionRoot is the last-resort root for a file inside it', findProjectRoot(file, { sessionRoot: bare }) === bare)
  check('sessionRoot does not apply to files outside it', findProjectRoot(path.join(TMP, 'pm-elsewhere.js'), { sessionRoot: bare }) === null)
  check('an unsafe sessionRoot is never used', findProjectRoot(path.join(HOME, 'notes.js'), { sessionRoot: HOME }) === null)

  // 标记优先于会话 cwd：monorepo 里 cwd 是子包，记忆仍应落在 repo 根（与懒索引一致）。
  const mono = tempProject('pm-mono-')
  const sub = path.join(mono, 'packages', 'foo')
  mkdirSync(sub, { recursive: true })
  const subFile = path.join(sub, 'x.js')
  writeFileSync(subFile, 'export function x() {}\n')
  check('a marker above the cwd still wins', findProjectRoot(subFile, { sessionRoot: sub }) === mono)

  // 懒索引：安全但无标记的 cwd → 记忆建在 cwd，并自动登记给 watcher。
  const wm = new WatchManager({}, CONFIG)
  const ok = await indexFile({}, CONFIG, file, wm, bare)
  check('lazy indexing works in a marker-less safe cwd', ok === true && wm.roots.has(bare))
  const store = new ProjectMemoryStore(memoryRootFor(bare, CONFIG.memoryDir)).load()
  check('the inferred root really holds the entries', (store.entries['notes.js'] || []).length >= 1)
  wm.stop()

  // 工具侧与懒索引同一套解析：cwd 是子包时写到 repo 根的 store。
  const exec = { agent: { session: { header: { cwd: sub } } } }
  check('resolveSafeIndexRoot prefers the marker root over the raw cwd', resolveSafeIndexRoot(exec, null, CONFIG) === mono)
  check('memory_stats-style reads and writes agree on one root', resolveSafeIndexRoot(exec, undefined, CONFIG) === mono)
}

console.log('\n== the inferred root is announced to the model, once ==')
{
  const makeHarness = (root, autoContext = {}) => {
    const globalFile = path.join(mkdtempSync(path.join(TMP, 'pm-notice-g-')), 'global.json')
    let handler
    const ctx = { on: (event, fn) => { if (event === 'agent/pre-step') handler = fn }, effect() {} }
    installAutoInject(ctx, { memoryDir: '.dsh-project-memory', autoContext, insight: { globalFile } })
    return async (text, sessionId = 'sessNotice') => {
      const payload = {
        agent: { session: { id: sessionId, header: { cwd: root } } },
        messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
      }
      const decision = await handler(payload, async () => ({ kind: 'enter', messages: payload.messages }))
      const appended = decision.messages.length > payload.messages.length ? decision.messages.at(-1) : null
      return appended ? appended.content.map((b) => b.text).join('') : ''
    }
  }

  const bare = mkdtempSync(path.join(TMP, 'pm-notice-'))
  const step = makeHarness(bare)
  const first = await step('开始干活')
  check('the first step announces the inferred memory root', first.includes(`memory root: ${bare}`) && /no project marker found/.test(first))
  check('the announcement says how to change it', /pass `root: <dir>`/.test(first) && /restart dsh/.test(first))
  const second = await step('继续')
  check('the announcement is not repeated on later steps', !second.includes('memory root:'))

  const marked = tempProject('pm-notice-marked-')
  const markedStep = makeHarness(marked)
  check('a declared project root is never announced', !(await markedStep('开始干活')).includes('memory root:'))

  const mutedStep = makeHarness(bare, { rootNotice: false })
  check('rootNotice: false silences it', !(await mutedStep('开始干活')).includes('memory root:'))
}

console.log('\n== the audit trail follows the same root as lazy indexing ==')
{
  const mono = tempProject('pm-audit-root-')
  const sub = path.join(mono, 'packages', 'foo')
  mkdirSync(sub, { recursive: true })
  const globalFile = path.join(mkdtempSync(path.join(TMP, 'pm-audit-g-')), 'global.json')
  let handler
  const ctx = { on: (event, fn) => { if (event === 'agent/pre-step') handler = fn }, effect() {} }
  installAutoInject(ctx, { memoryDir: '.dsh-project-memory', autoContext: {}, insight: { globalFile } })
  const payload = {
    agent: { session: { id: 'sessAuditRoot', header: { cwd: sub } } },
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }],
  }
  await handler(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  check(
    'the session store lands on the repo root, not on the subdirectory',
    existsSync(path.join(mono, '.dsh-project-memory')) && !existsSync(path.join(sub, '.dsh-project-memory')),
  )
}

console.log('\n== project root resolution for tasks ==')
{
  check('projectRootFor returns null for the home directory', projectRootFor(HOME) === null)
  check('taskStoreFor returns a null store when there is no project root', taskStoreFor(HOME, CONFIG).store === null)
  const bare = mkdtempSync(path.join(TMP, 'pm-guard-bare2-'))
  check('a marker-less but safe cwd still works as a task root', projectRootFor(bare) === bare)
  const project = tempProject('pm-guard-task-')
  const nested = path.join(project, 'packages', 'x')
  mkdirSync(nested, { recursive: true })
  check('a marker above the cwd wins (monorepo session)', projectRootFor(nested) === project)
  check('NO_PROJECT_ROOT_NOTE is a non-empty user-facing string', typeof NO_PROJECT_ROOT_NOTE === 'string' && NO_PROJECT_ROOT_NOTE.length > 10)
}

console.log('\n== auto-inject is inert when the session cwd is unsafe ==')
{
  const homeStoreExisted = existsSync(path.join(HOME, '.dsh-project-memory'))
  const handlers = {}
  const ctx = {
    on(event, fn) {
      ;(handlers[event] ||= []).push(fn)
    },
    effect() {},
  }
  installAutoInject(ctx, CONFIG)
  const preStep = (handlers['agent/pre-step'] || [])[0]
  check('auto-inject registers a pre-step listener', typeof preStep === 'function')

  const decision = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }
  const stderr = []
  const origError = console.error
  console.error = (...args) => stderr.push(args.join(' '))
  let unsafeResult
  let safeResult
  try {
    unsafeResult = await preStep(
      { agent: { session: { id: 'sess-unsafe', header: { cwd: HOME } } } },
      async () => decision,
    )
    // 正对照：安全根不走上面那条早退分支（证明静默是"根"判定的结果，不是整条链路坏了）。
    const project = tempProject('pm-guard-inject-')
    safeResult = await preStep(
      { agent: { session: { id: 'sess-safe', header: { cwd: project } } } },
      async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }),
    )
    check(
      'a safe project root does not trigger the unsafe-root warning',
      !stderr.some((line) => line.includes(`${project} is not a project root`)),
    )
  } finally {
    console.error = origError
  }
  check('an unsafe session root returns the host decision untouched', unsafeResult === decision)
  check(
    'the unsafe session root is reported once, with the reason',
    stderr.some((line) => line.includes(`${HOME} is not a project root`)),
  )
  check(
    'no .dsh-project-memory is created in the home directory by the audit log',
    homeStoreExisted || !existsSync(path.join(HOME, '.dsh-project-memory')),
  )
  check('a safe project root still produces a valid enter decision', safeResult?.kind === 'enter')
}

console.log('\n== bounded scans never delete unseen files ==')
{
  const project = tempProject('pm-guard-bound-')
  for (const n of ['a', 'b', 'c', 'd', 'e']) {
    writeFileSync(path.join(project, `${n}.js`), `export function ${n}() {}\n`)
  }

  await indexRepository({}, CONFIG, project, {})
  const store = () => new ProjectMemoryStore(memoryRootFor(project, CONFIG.memoryDir)).load()
  check('a full scan indexes every source file', Object.keys(store().files).length === 5)

  const capped = { ...CONFIG, maxScanFiles: 2 }
  const report = await indexRepository({}, capped, project, {})
  check('a truncated scan says so in its report', /scan truncated at the safety limit/.test(report))
  check(
    'a truncated scan does not delete the files it never reached',
    Object.keys(new ProjectMemoryStore(memoryRootFor(project, CONFIG.memoryDir)).load().files).length === 5,
  )

  rmSync(path.join(project, 'e.js'))
  await indexRepository({}, CONFIG, project, {})
  check(
    'a complete scan still removes genuinely deleted files',
    !('e.js' in store().files) && Object.keys(store().files).length === 4,
  )
}

console.log('\n== walkDir stays bounded ==')
{
  const dir = mkdtempSync(path.join(TMP, 'pm-guard-walk-'))
  for (let i = 0; i < 10; i++) writeFileSync(path.join(dir, `f${i}.js`), 'x')
  const capped = walkDir(dir, { maxFiles: 3 })
  check('maxFiles caps the result', capped.files.length === 3 && capped.truncated === true)
  const full = walkDir(dir)
  check('without a cap the whole (small) tree is returned', full.files.length === 10 && full.truncated === false)
}

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECKS FAILED`} (${passed} passed)`)
process.exit(failed === 0 ? 0 : 1)
