// 动作平面测试（PLAN S1）：node test/ops.test.mjs
// 验收（PLAN §8 S1）：喂本会话那 7 次真实工具调用，输出里不许出现 `dcterms` 这类标识符。
import assert from 'node:assert/strict'

import {
  FALLBACK_OPS,
  OP_IDS,
  WEAK_OPS,
  activityFromCalls,
  activityFromText,
  classifyShellCommand,
  classifyToolCall,
  opForLegacyAction,
} from '../src/ops.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

// --- 1. 工具名 → op，写目标必须是**值**不是键名（曾把 file_path 当成路径） ---
{
  const w = classifyToolCall('edit', '{"file_path":"src/readiness.js"}')
  assert.deepEqual(w.ops, ['file-write'])
  assert.deepEqual(w.targets, ['src/readiness.js'])
  const read = classifyToolCall('read', '{"file_path":"src/readiness.js"}')
  assert.deepEqual(read.ops, [], '读不是写：不产出 op（也不产出写目标）')
  assert.deepEqual(read.targets, [])
  assert.deepEqual(classifyToolCall('read_image', '{"file_path":"a.png"}').ops, ['read-image'])
  assert.deepEqual(classifyToolCall('index_repo', '{"root":"/x"}').ops, ['index-doc'])
  assert.deepEqual(classifyToolCall('web_fetch', '{"url":"https://x"}').ops, ['fetch-web'])
  ok('classifyToolCall：写/读/索引/取网页各自归一，写目标取参数值')
}

// --- 2. shell 命令 → op：只认渲染器，不认扩展名 ---
{
  assert.ok(classifyShellCommand('npm publish --access public').ops.includes('npm-publish'))
  assert.ok(classifyShellCommand('git tag v0.5.6').ops.includes('release'))
  assert.ok(classifyShellCommand('git commit -am x').ops.includes('git-commit'))
  assert.ok(classifyShellCommand('rm -rf build/').ops.includes('file-delete'))
  assert.ok(classifyShellCommand('node scripts/bench.mjs').ops.includes('run-bench'))
  assert.deepEqual(classifyShellCommand('soffice --headless --convert-to pdf').ops, ['render-doc'])
  assert.deepEqual(classifyShellCommand('npx pptxgenjs build.js').ops, ['render-doc'])
  // 关键回归：只是"提到一个 .pptx"（改时间戳那次就是这么干的）绝不能算 render-doc
  assert.deepEqual(classifyShellCommand('ls -la /mnt/c/x/deck.pptx').ops, ['shell-run'])
  assert.deepEqual(classifyShellCommand('python3 - <<PY zipfile deck.pptx TotalTime PY').ops, ['shell-run'])
  ok('classifyShellCommand：渲染器才算 render-doc，扩展名不算')
}

// --- 3. 写目标只从会写盘的命令里取；读列目录不产目标 ---
{
  assert.deepEqual(classifyShellCommand('ls -la de-TODO.md').targets, [])
  assert.deepEqual(classifyShellCommand('rm -f de-TODO.md').targets, ['de-TODO.md'])
  const wsl = classifyShellCommand('powershell.exe -Command SetFileTime /mnt/c/x/a.pptx')
  assert.deepEqual(wsl.hosts, ['wsl'], '命令里出现 /mnt/* 或 powershell.exe → host=wsl')
  ok('写目标只来自写盘命令；WSL 主机可被识别')
}

// --- 4. 本会话那 7 次真实调用的回归：不产出标识符类噪音 ---
{
  const sessionCalls = [
    { name: 'bash', arguments: '{"command":"date; ls -la --time-style=full-iso \\"/mnt/c/Users/33880/OneDrive/桌面/石啸天-LLM记忆方向调研.pptx\\""}' },
    { name: 'bash', arguments: '{"command":"which powershell.exe pwsh.exe"}' },
    { name: 'bash', arguments: '{"command":"powershell.exe -NoProfile -Command \\"$f.CreationTime = ...\\" -Filter \\"*LLM*.pptx\\""}' },
    { name: 'bash', arguments: '{"command":"python3 - <<\'PY\'\\nimport zipfile, re\\napp = zin.read(\'docProps/app.xml\')\\ndcterms = None\\nPY"}' },
    { name: 'bash', arguments: '{"command":"ls -la /tmp/pptx-backup.pptx"}' },
    { name: 'bash', arguments: '{"command":"node --test test/insight-store.test.mjs"}' },
    { name: 'read', arguments: '{"file_path":"/home/sxt/project/dsh-project-memory/de-TODO.md"}' },
  ]
  const a = activityFromCalls(sessionCalls)
  const dump = JSON.stringify(a)
  // 这些字符串出现过，但它们不是动作、也不是写目标——出现过不等于做过
  for (const noise of ['dcterms', 'rm', 'pptx"', 'docProps']) {
    assert.ok(!dump.includes(noise), `动作平面不该出现 ${noise}：${dump}`)
  }
  assert.ok(a.ops.every((op) => OP_IDS.includes(op)), `op 必须落在闭集内：${a.ops}`)
  assert.ok(a.targets.every((t) => /[./]/.test(t)), `写目标应当是路径形态：${a.targets}`)
  assert.ok(a.hosts.includes('wsl'))
  ok(`本会话 7 次调用的动作平面：ops=${JSON.stringify(a.ops)} targets=${JSON.stringify(a.targets)}`)
}

// --- 5. actionText 兜底：能解析 `edit {json}` 与裸命令 ---
{
  const a = activityFromText('edit {"file_path":"src/a.js"}\ngit commit -m x\nnpm publish')
  assert.ok(a.ops.includes('file-write') && a.ops.includes('git-commit') && a.ops.includes('npm-publish'))
  assert.ok(a.targets.includes('src/a.js'))
  // 纯文本行不该退化成 shell-run（那是噪音源）
  assert.ok(!activityFromText('这是一句普通的话').ops.includes('shell-run'))
  ok('activityFromText：工具调用行与裸命令都能读，纯文本不产生 shell-run')
}

// --- 6. 旧 action → op 映射：死值显式返回 null（供自检报出来）---
{
  assert.equal(opForLegacyAction('npm-pack'), 'npm-publish')
  assert.equal(opForLegacyAction('generate-pptx'), 'render-doc')
  assert.equal(opForLegacyAction('benchmark'), 'run-bench')
  assert.equal(opForLegacyAction('cleanup'), 'file-delete')
  assert.equal(opForLegacyAction('recover'), null)
  assert.equal(opForLegacyAction('interview-prep'), null)
  assert.equal(opForLegacyAction('git-commit'), 'git-commit')
  assert.ok(WEAK_OPS.has('git-commit') && WEAK_OPS.has('shell-run'))
  assert.ok(FALLBACK_OPS.has('file-write') && !FALLBACK_OPS.has('git-commit'))
  ok('opForLegacyAction：旧值有归宿，死值返回 null 交给自检')
}

console.log(`\nops tests: ${passed} passed`)
