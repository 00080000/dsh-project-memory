// Client 提示信息开关回归测试：node test/client-hints.test.mjs
// 背景：面板头部的「隐藏提示信息」（? 按钮）只接了 2 个 title，其它悬停提示全部无视它，
// 导致开关看起来完全没用。这里用一个静态扫描锁住契约：
//   1. client 里每一个 title=（悬停提示）必须受 showHints 控制；
//   2. 开关状态必须落在 UI store 且可持久化（有 toggleHints + 默认 true）。
// 允许豁免：错误边界兜底按钮（崩溃恢复入口）与开关自身的 title（否则关掉后找不回来）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

// 提示开关自身与错误兜底按钮不随开关变化。
const EXEMPT = [/boundaryFallback/, /panel\.hints-off/]

const FILES = [
  'src/client/TaskPanel.tsx',
  'src/client/TaskComponents.tsx',
  'src/client/MemoryView.tsx',
]

for (const file of FILES) {
  const lines = read(file).split('\n')
  const ungated = []
  lines.forEach((line, i) => {
    if (!line.includes('title=')) return
    if (line.includes('showHints')) return
    if (EXEMPT.some((re) => re.test(line))) return
    ungated.push(`${file}:${i + 1}  ${line.trim()}`)
  })
  assert.equal(
    ungated.length,
    0,
    `以下 title 悬停提示未接 showHints（关掉提示后仍会弹出）：\n${ungated.join('\n')}`,
  )
}
ok('client 所有 title 悬停提示均受 showHints 控制（开关自身/错误兜底除外）')

const store = read('src/client/task-ui-store.ts')
assert.match(store, /showHints:\s*true/, 'UI store 默认应显示提示（showHints: true）')
assert.match(store, /parsed\.showHints\s*!==\s*false/, 'UI store 应从 localStorage 恢复 showHints')
assert.match(store, /toggleHints\(\)/, 'UI store 应提供 toggleHints()')
ok('showHints 落在 UI store：默认开、可持久化、可切换')

console.log(`\nclient-hints tests: ${passed} passed`)
