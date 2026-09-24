// store 目录自我忽略：node test/store-gitignore.test.mjs
//
// 动机：让用户手动把 `.dsh-project-memory/` 写进自己的 .gitignore，忘一次就是一次误提交，
// 而插件也不该去改用户的文件。正确做法是 store 目录里自带一个内容为 `*` 的 `.gitignore`——
// git 会读工作区里任意目录下的 .gitignore，`*` 连它自己一起命中，于是整棵树从
// `git status` / `git add -A` 里消失，用户一个字都不用写。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProjectMemoryStore } from '../src/store.js'

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

const git = spawnSync('git', ['--version'], { encoding: 'utf8' })
if (git.status !== 0) {
  // 没有 git 就跳过（本地极简环境）；CI 三个平台都带 git。
  console.log('  --  git not available, skipping')
  console.log('\nALL CHECKS PASSED (0 passed)')
  process.exit(0)
}

// safe.directory=*：容器/CI 里仓库属主与运行用户不一致时 git 会拒绝操作。
const GIT = ['-c', 'safe.directory=*']

function gitRepo(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  const init = spawnSync('git', [...GIT, 'init', '-q', '.'], { cwd: dir, encoding: 'utf8' })
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`)
  return dir
}

function status(dir) {
  const res = spawnSync('git', [...GIT, 'status', '--porcelain'], { cwd: dir, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git status failed: ${res.stderr}`)
  return res.stdout.trim().split('\n').filter(Boolean)
}

function seed(store) {
  store.commit((s) => {
    s.markFile('a.js', { sha256: 'hash-a', size: 3, type: 'code', indexedAt: new Date().toISOString() })
    s.setEntries('a.js', [
      { id: 'a#1', sourcePath: 'a.js', sourceLine: 1, type: 'symbol', title: 'a (function)', keywords: ['a'], text: 'a()' },
    ])
  })
}

console.log('\n== the store ignores itself ==')
{
  const root = gitRepo('pm-selfignore-')
  const userIgnore = '# mine\nnode_modules/\n'
  writeFileSync(path.join(root, '.gitignore'), userIgnore)
  writeFileSync(path.join(root, 'a.js'), 'x\n')

  const storeDir = path.join(root, '.dsh-project-memory')
  seed(new ProjectMemoryStore(storeDir).load())

  const selfIgnore = path.join(storeDir, '.gitignore')
  check('the store writes its own .gitignore', existsSync(selfIgnore))
  check('its rule ignores everything in the store', /^\*\s*$/m.test(readFileSync(selfIgnore, 'utf8')))
  check("the user's .gitignore is untouched", readFileSync(path.join(root, '.gitignore'), 'utf8') === userIgnore)

  const lines = status(root)
  check(
    'git status shows only the user\'s own files, never the store',
    !lines.some((l) => l.includes('.dsh-project-memory')) && lines.includes('?? a.js'),
  )

  // git clean -fd 只删未跟踪且未被忽略的文件；被忽略的 store 因此是安全的。
  spawnSync('git', [...GIT, 'clean', '-fd'], { cwd: root, encoding: 'utf8' })
  check('git clean -fd does not delete the store', existsSync(path.join(storeDir, 'shards')) || existsSync(selfIgnore))

  // 幂等：再次写入不会覆盖/重写这个文件。
  const before = readFileSync(selfIgnore, 'utf8')
  seed(new ProjectMemoryStore(storeDir).load())
  check('repeated saves leave the file unchanged', readFileSync(selfIgnore, 'utf8') === before)
}

console.log('\n== a legacy store gets the file on first load ==')
{
  const root = gitRepo('pm-selfignore-legacy-')
  const storeDir = path.join(root, '.dsh-project-memory')
  // 手工造一个 0.5.9 时代留下的 store（有 format.json 与分片、没有 .gitignore）。
  // 手工构造而不是先用本插件建：storeCache 会让同进程内的第二次 load 命中缓存，
  // 那样测的就不是"load 补写"了。
  mkdirSync(path.join(storeDir, 'shards'), { recursive: true })
  writeFileSync(path.join(storeDir, 'format.json'), JSON.stringify({ version: 2, layout: 'sharded' }))
  writeFileSync(
    path.join(storeDir, 'shards', 'deadbeef.json'),
    JSON.stringify({ relPath: 'a.js', record: { sha256: 'h', size: 1, type: 'code' }, entries: [] }),
  )
  check('the legacy fixture has no .gitignore', !existsSync(path.join(storeDir, '.gitignore')))

  const fresh = new ProjectMemoryStore(storeDir)
  fresh.load()
  check('load() alone heals a legacy store', existsSync(path.join(storeDir, '.gitignore')))
  check('the healed store is still readable', Object.keys(fresh.files).includes('a.js'))
}

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECKS FAILED`} (${passed} passed)`)
process.exit(failed === 0 ? 0 : 1)
