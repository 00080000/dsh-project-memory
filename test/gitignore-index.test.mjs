// .gitignore 感知：索引不得把构建产物 / 内部文档收进语料。
// git 可用时走 `git ls-files`，不可用时回退 walkDir（本测试跳过）。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { listProjectFiles } from '../src/util/fs.js'
import { indexRepository } from '../src/tools/index-repo.js'
import { ProjectMemoryStore } from '../src/store.js'

try {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
} catch {
  console.log('SKIP: git not available')
  process.exit(0)
}

const root = mkdtempSync(path.join(tmpdir(), 'pm-gitignore-'))
execFileSync('git', ['init', '-q', root], { stdio: 'ignore' })
writeFileSync(path.join(root, '.gitignore'), 'lib/\ninternal-notes.md\n')
mkdirSync(path.join(root, 'lib'))
writeFileSync(path.join(root, 'lib', 'bundle.js'), 'function hidden() {}\n')
writeFileSync(path.join(root, 'internal-notes.md'), '# internal\n')
mkdirSync(path.join(root, 'src'))
writeFileSync(path.join(root, 'src', 'a.js'), 'function visible() {}\n')
writeFileSync(path.join(root, 'README.md'), '# doc\n')
// 隐藏路径：git 清单里有（`.github/**` 默认可跟踪），但扫描口径必须与非 git 目录一致。
mkdirSync(path.join(root, '.github'))
writeFileSync(path.join(root, '.github', 'CONTRIBUTING.md'), '# hidden dir doc\n')
writeFileSync(path.join(root, '.env'), 'SECRET=do-not-index\n')

const listed = listProjectFiles(root, { maxFiles: 100, maxDepth: 10 })
const rels = listed.files.map((f) => path.relative(root, f).split(path.sep).join('/'))
assert.ok(rels.includes('src/a.js'), 'tracked/untracked source must be listed')
assert.ok(rels.includes('README.md'))
assert.ok(!rels.includes('lib/bundle.js'), 'ignored build output must not be listed')
assert.ok(!rels.includes('internal-notes.md'), 'ignored internal doc must not be listed')
assert.ok(!rels.includes('.github/CONTRIBUTING.md'), 'hidden directories must not be listed')
assert.ok(!rels.includes('.env'), 'hidden files must not be listed')
console.log('  ok listProjectFiles honors .gitignore and skips hidden paths')

// 非 git 目录走 walkDir，隐藏路径口径必须与 git 分支一致（否则 git init 前后语料会变）。
const plainRoot = mkdtempSync(path.join(tmpdir(), 'pm-plain-scan-'))
mkdirSync(path.join(plainRoot, '.github'))
writeFileSync(path.join(plainRoot, '.github', 'CONTRIBUTING.md'), '# hidden dir doc\n')
writeFileSync(path.join(plainRoot, '.env'), 'SECRET=do-not-index\n')
writeFileSync(path.join(plainRoot, 'visible.md'), '# visible\n')
const plainRels = listProjectFiles(plainRoot, { maxFiles: 100, maxDepth: 10, gitAware: false })
  .files.map((f) => path.relative(plainRoot, f).split(path.sep).join('/'))
assert.deepEqual(plainRels, ['visible.md'], 'walk fallback applies the same hidden filter')
console.log('  ok walk fallback skips hidden paths too')

const config = { memoryDir: '.dsh-project-memory', maxScanFiles: 100, maxScanDepth: 10, enableTypeScript: false }
await indexRepository({}, config, root)
const store = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
const indexed = Object.keys(store.files)
assert.ok(indexed.includes('src/a.js'))
assert.ok(!indexed.some((rel) => rel.startsWith('lib/') || rel === 'internal-notes.md'))
console.log('  ok index_repo skips ignored files')
console.log('ALL CHECKS PASSED (3 passed)')
