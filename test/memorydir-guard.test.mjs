// 2026-11-03：`memoryDir` 的落盘位置不能逃出项目根，也不能等于项目根本身。
// 修前会失败：`'.'` 让 `path.join(root, '.')` 等于根，`save()` 的自我忽略随即把内容为 `*`
// 的 `.gitignore` 写进项目根（整个仓库从 git 视角消失）；`'..'` 则把 store 写到根外。
// node test/memorydir-guard.test.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ProjectMemoryStore } from '../src/store.js'
import { DEFAULT_MEMORY_DIR, memoryDirName, memoryRootFor, safeMemoryDirName } from '../src/util/fs.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}
const dir = (p = 'memdir-') => mkdtempSync(path.join(tmpdir(), p))
const atDefault = (root) => path.join(root, DEFAULT_MEMORY_DIR)

// 1. 所有会跑出根外或落到根上的形态都回落到默认目录
{
  const root = dir()
  const silent = () => {}
  for (const bad of ['', '   ', '.', '..', '../x', 'a/../b', '/tmp/elsewhere', 'C:\\store']) {
    assert.equal(safeMemoryDirName(bad, silent), DEFAULT_MEMORY_DIR, `${JSON.stringify(bad)} must fall back`)
    assert.equal(memoryRootFor(root, bad), atDefault(root), `${JSON.stringify(bad)} must not move the store`)
  }
  ok('空/`.`/`..`/含 `..` 段/绝对路径都回落到默认目录')
}

// 2. 根内的嵌套相对目录仍然允许；缺省配置回落默认值
{
  const root = dir()
  assert.equal(memoryRootFor(root, 'nested/store'), path.join(root, 'nested', 'store'))
  assert.equal(memoryDirName({ memoryDir: 'nested/store' }), 'nested/store')
  assert.equal(memoryDirName({}), DEFAULT_MEMORY_DIR)
  assert.equal(memoryDirName(undefined), DEFAULT_MEMORY_DIR)
  ok('嵌套相对目录仍允许；缺省配置回落默认')
}

// 3. 默认告警对同一个坏值只发一次（否则每次读写都吵）
{
  const seen = []
  assert.equal(safeMemoryDirName('..', (v) => seen.push(v)), DEFAULT_MEMORY_DIR)
  assert.equal(safeMemoryDirName('..', (v) => seen.push(v)), DEFAULT_MEMORY_DIR)
  assert.deepEqual(seen, ['..', '..'], '调用方传入的 warn 每条都该被调用')

  const warns = []
  const original = console.warn
  console.warn = (line) => warns.push(String(line))
  try {
    safeMemoryDirName('../once')
    safeMemoryDirName('../once')
  } finally {
    console.warn = original
  }
  assert.equal(warns.length, 1, '默认告警必须去重')
  assert.match(warns[0], /memoryDir "\.\.\/once"/, '告警要点名那个值')
  ok('默认告警对同一个坏值只发一次，且点名该值')
}

// 4. `'.'` 不会把 `*` 写进项目根：store 落在默认目录，自我忽略留在 store 内
{
  const root = dir()
  const store = new ProjectMemoryStore(memoryRootFor(root, '.')).load()
  store.markFile('a.md', { sha256: 'x', size: 1, type: 'doc', indexedAt: new Date().toISOString() })
  store.save()
  assert.equal(existsSync(path.join(root, '.gitignore')), false, '项目根 .gitignore 不能被写成 *')
  const selfIgnore = path.join(atDefault(root), '.gitignore')
  assert.ok(existsSync(selfIgnore), '自我忽略仍要留在 store 目录里')
  assert.match(readFileSync(selfIgnore, 'utf8'), /^\*$/m, 'store 的隐私自我忽略（*）必须保留')
  ok("memoryDir: '.' 不会把 * 写进项目根，store 落在默认目录")
}

console.log(`\nmemorydir-guard tests: ${passed} passed`)
