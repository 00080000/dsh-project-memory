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
writeFileSync(path.join(root, '.gitignore'), 'lib/\nde-TODO.md\n')
mkdirSync(path.join(root, 'lib'))
writeFileSync(path.join(root, 'lib', 'bundle.js'), 'function hidden() {}\n')
writeFileSync(path.join(root, 'de-TODO.md'), '# internal\n')
mkdirSync(path.join(root, 'src'))
writeFileSync(path.join(root, 'src', 'a.js'), 'function visible() {}\n')
writeFileSync(path.join(root, 'README.md'), '# doc\n')

const listed = listProjectFiles(root, { maxFiles: 100, maxDepth: 10 })
const rels = listed.files.map((f) => path.relative(root, f).split(path.sep).join('/'))
assert.ok(rels.includes('src/a.js'), 'tracked/untracked source must be listed')
assert.ok(rels.includes('README.md'))
assert.ok(!rels.includes('lib/bundle.js'), 'ignored build output must not be listed')
assert.ok(!rels.includes('de-TODO.md'), 'ignored internal doc must not be listed')
console.log('  ok listProjectFiles honors .gitignore')

const config = { memoryDir: '.dsh-project-memory', maxScanFiles: 100, maxScanDepth: 10, enableTypeScript: false }
await indexRepository({}, config, root)
const store = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
const indexed = Object.keys(store.files)
assert.ok(indexed.includes('src/a.js'))
assert.ok(!indexed.some((rel) => rel.startsWith('lib/') || rel === 'de-TODO.md'))
console.log('  ok index_repo skips ignored files')
console.log('ALL CHECKS PASSED (2 passed)')
