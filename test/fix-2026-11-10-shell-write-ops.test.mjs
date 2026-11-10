// 修复审计 #16 的回归测试：POSIX shell 写操作不产 `file-write` op。
// 跑法：node test/fix-2026-11-10-shell-write-ops.test.mjs
//
// 背景：WRITE_HEADS 早就有 touch / cp / mv / tee / truncate / mkdir，isWriteSegment() 也认
// sed -i 与重定向，但 classifyCommand() 只在写段收集 targets、从不 push file-write，
// opsOfHead() 又只映射 rm 与 Windows 写命令。于是这些命令只剩兜底 shell-run，
// `when.ops: ['file-write']` 的 trigger 永远命不中。
//
// 本文件钉住的契约：
//   1. 写段（isWriteSegment 为真）且本段不是删除 → file-write；
//   2. 删除（rm / git rm / del / Remove-Item）仍是 file-delete，不得升级成写；
//   3. 不写盘的段（sed -n、无重定向的 echo、普通命令）仍是 shell-run；
//   4. ops 去重、顺序按段出现顺序稳定；
//   5. targets（when.writes 的匹配面）语义不变；
//   6. `bash -c` / pwsh / cmd 包裹的写命令同样归一。
import assert from 'node:assert/strict'

import { activityFromCalls, classifyShellCommand, classifyToolCall } from '../src/ops.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}
const ops = (cmd) => classifyShellCommand(cmd).ops

// ---- 1. 正向：POSIX 写命令 / 重定向 / sed -i 现在产 file-write ----
{
  const cases = [
    'touch a.ts',
    'echo hi > a.ts',
    'echo hi >> a.ts',
    'sed -i s/a/b/ a.ts',
    'cp a.ts b.ts',
    'cp -r src dist',
    'mv a.ts b.ts',
    'tee out.txt',
    'truncate -s 0 a.log',
    'mkdir -p dist',
  ]
  for (const cmd of cases) {
    assert.deepEqual(ops(cmd), ['file-write'], `ops(${cmd}) 应只有 file-write`)
    // 审计复现用的是 classifyToolCall('bash', …)：trigger 走的那条路径也要一致。
    assert.deepEqual(
      classifyToolCall('bash', JSON.stringify({ command: cmd })).ops,
      ['file-write'],
      `classifyToolCall(bash, ${cmd}) 应只有 file-write`,
    )
  }
  // 显式确认兜底 shell-run 已不再出现：这是刻意的语义变更（详见报告）。
  assert.ok(!ops('touch a.ts').includes('shell-run'))
  ok('写段补 file-write：touch / 重定向 / sed -i / cp / mv / tee / truncate / mkdir')
}

// ---- 2. 删除仍是 file-delete，且不会被升级成 file-write ----
{
  const cases = [
    ['rm a.ts', ['file-delete']],
    ['rm -rf build/', ['file-delete']],
    ['git rm a.ts', ['file-delete']],
    ['del a.ts', ['file-delete']],
    ['erase old.txt', ['file-delete']],
    ['Remove-Item -Recurse dist', ['file-delete']],
  ]
  for (const [cmd, want] of cases) {
    assert.deepEqual(ops(cmd), want, `删除命令 ${cmd} 不得变成 file-write`)
    assert.ok(!ops(cmd).includes('file-write'), `${cmd} 不该产 file-write`)
  }
  // 同一段删除 + 重定向（`rm a > log`）仍按删除处理，不额外升级成写。
  assert.ok(!ops('rm -f a.ts > /tmp/log').includes('file-write'))
  ok('删除不升级：rm / git rm / del / erase / Remove-Item 仍是 file-delete')
}

// ---- 3. 边界：不写盘的命令仍是 shell-run ----
{
  for (const cmd of [
    'sed -n p a.ts',
    'sed -n "s/a/b/p" a.ts',
    'echo hi',
    'grep -rn foo src',
    'cat a.ts',
    'plain-command',
    'echo "a > b"', // 引号里的 > 是正文
    'ls a.ts 2>/dev/null', // 丢输出的重定向不是写盘
  ]) {
    assert.deepEqual(ops(cmd), ['shell-run'], `ops(${cmd}) 仍是 shell-run`)
  }
  // git checkout / restore 本来就走 opsOfHead 的 file-write，不受本修复影响。
  assert.deepEqual(ops('git checkout a.ts'), ['file-write'])
  assert.deepEqual(ops('git restore a.ts'), ['file-write'])
  ok('边界：sed -n / 无重定向 echo / 普通命令仍 shell-run；git checkout 仍 file-write')
}

// ---- 4. 去重与顺序稳定（pushUnique 现有行为） ----
{
  assert.deepEqual(ops('touch a.ts && touch b.ts'), ['file-write'], '多个写段只留一个 file-write')
  assert.deepEqual(ops('cp a b && mv b c'), ['file-write'])
  assert.deepEqual(ops('echo x > a && echo y > b'), ['file-write'])
  assert.deepEqual(ops('rm a.ts && touch b.ts'), ['file-delete', 'file-write'], '跨段混合按出现顺序')
  assert.deepEqual(ops('touch a.ts && rm b.ts'), ['file-write', 'file-delete'])
  // 每段各自判断删除身份：前一段的 file-delete 不能吞掉后一段的写。
  assert.ok(ops('rm -rf dist && mkdir dist').includes('file-write'), 'rm 后的 mkdir 仍要算写')
  ok('去重/顺序：重复写段只留一个 op，混合段按出现顺序；前段删除不吞后段写')
}

// ---- 5. targets（when.writes 匹配面）语义不变 ----
{
  assert.deepEqual(classifyShellCommand('touch a.ts').targets, ['a.ts'])
  assert.deepEqual(classifyShellCommand('echo hi > a.ts').targets, ['a.ts'])
  assert.deepEqual(classifyShellCommand('echo hi >> a.ts').targets, ['a.ts'])
  assert.deepEqual(classifyShellCommand('sed -i s/a/b/ a.ts').targets, ['a.ts'])
  assert.deepEqual(classifyShellCommand('cp a.ts b.ts').targets, ['a.ts', 'b.ts'])
  assert.deepEqual(classifyShellCommand('mv a.ts b.ts').targets, ['a.ts', 'b.ts'])
  assert.deepEqual(classifyShellCommand('rm -f a.ts').targets, ['a.ts'], '删除仍抽 targets')
  assert.deepEqual(classifyShellCommand('sed -n p a.ts').targets, [], '只读 sed 不抽写目标')
  ok('targets 不变：写目标照旧能抽到，只读段不产目标')
}

// ---- 6. 壳递归：bash -c / pwsh -Command / cmd /c 里的写命令 ----
{
  assert.deepEqual(ops('bash -c "touch a.ts"'), ['file-write'])
  assert.ok(classifyShellCommand('bash -c "touch a.ts"').targets.includes('a.ts'))
  assert.deepEqual(ops('bash -lc "cp a.ts b.ts"'), ['file-write'])
  assert.deepEqual(ops('bash -c "rm -rf a.ts"'), ['file-delete'], '壳里的删除仍是 file-delete')
  assert.deepEqual(ops('pwsh -Command "Set-Content -Path a.txt -Value x"'), ['file-write'])
  assert.deepEqual(ops('cmd /c "copy a.md b.md"'), ['file-write'])
  assert.deepEqual(ops('sudo touch a.ts'), ['file-write'], '包装器后的写命令也要认')
  ok('壳递归/包装器：bash -c、pwsh、cmd、sudo 里的写命令都归一成 file-write')
}

// ---- 7. 真实调用链：结构化 bash 调用 → activityFromCalls（auto-inject 的 trigger 输入） ----
{
  const activity = activityFromCalls([
    { name: 'bash', arguments: JSON.stringify({ command: 'touch a.ts' }) },
    { name: 'bash', arguments: JSON.stringify({ command: 'echo hi > b.ts' }) },
  ])
  assert.deepEqual(activity.ops, ['file-write'], 'when.ops:["file-write"] 的 trigger 现在能命中')
  assert.deepEqual(activity.targets, ['a.ts', 'b.ts'])
  ok('activityFromCalls：shell 写调用产出 file-write，targets 不丢')
}

console.log(`\nshell-write-ops tests: ${passed} passed`)
