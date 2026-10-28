// Windows 语义回归：node test/windows-compat.test.mjs
//
// 这里的判据都能在 Linux/macOS 上跑：Windows 的路径形态、命令形态与"重启后 pid 被复用"
// 都是**字符串/时间**层面的事实，不需要真的在 win32 上执行。
//
// 覆盖的是 2026-10-28 审计里的四条：
//   1. 锁的 pid 复用检测只读 `/proc`（Windows 恒为 null）→ 重启后残留锁被当成活锁，写入永久静默失败；
//   2. `when.writes` / `guard.paths` 只认 `/` 与"项目相对"，Windows 的 `D:\…` / `src\…` 一律不命中；
//   3. 动作面认不出 `npm.cmd` / `node scripts\bench.mjs` / `del` / `copy` / `pwsh -Command` / `cmd /c`，
//      全部退化成兜底 op `shell-run`；
//   4. 原生 Windows 的 `pwsh.exe` / `cmd.exe` 被标成 `hosts: ['wsl']`（guard.hosts 收窄反了）。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir, uptime } from 'node:os'
import path from 'node:path'

import { acquireDirLock, inspectDirLock, storeKey } from '../src/util/fs.js'
import { extractPathTokens } from '../src/util/path-token.js'
import { buildReadinessContext, matchTrigger } from '../src/readiness.js'
import { classifyShellCommand, classifyToolCall } from '../src/ops.js'
import { ProjectMemoryStore, _storeCacheKeysForTest } from '../src/store.js'
import { parseSkillFile } from '../src/skill.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}
const tmp = () => mkdtempSync(path.join(tmpdir(), 'wincompat-'))
const lockFile = (d) => path.join(d, '.write.lock')
const bootMs = () => Date.now() - uptime() * 1000
const writeLock = (d, meta, ageMs = 0) => {
  mkdirSync(d, { recursive: true })
  writeFileSync(lockFile(d), JSON.stringify(meta))
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs)
    utimesSync(lockFile(d), t, t)
  }
}

// --- 1. 跨开机的残留锁：pid 存活也不再等于"持有者还在" -------------------------------
// Windows 没有 /proc，processStartMs() 恒为 null；重启后旧 pid 会被系统服务复用，
// 旧实现于是把几小时前的锁当成活锁，一直拒绝写入。
{
  const d = tmp()
  writeLock(d, {
    pid: process.ppid, // 一个确定存活的 pid（父进程）
    host: hostname(),
    token: 'from-previous-boot',
    at: new Date(bootMs() - 3 * 3600_000).toISOString(),
  })
  const started = Date.now()
  const release = acquireDirLock(d, { timeoutMs: 600 })
  assert.ok(release, '写于上次开机之前的锁必须立即回收（哪怕 pid 还活着）')
  assert.ok(Date.now() - started < 400, '回收应当立即发生，而不是等满 timeout')
  release()
  ok('跨开机残留锁：pid 存活也回收（Windows 无 /proc 的兜底）')
}

// --- 1b. 锁自带 boot 标记与本次不符：时钟被改过时 at 不可信，boot 仍可判 --------------
{
  const d = tmp()
  writeLock(d, {
    pid: process.ppid,
    host: hostname(),
    token: 'other-boot',
    at: new Date().toISOString(),
    boot: bootMs() - 6 * 3600_000,
  })
  assert.equal(inspectDirLock(d).stale, true, 'boot 标记不符应判 stale')
  const release = acquireDirLock(d, { timeoutMs: 600 })
  assert.ok(release, 'boot 标记不符的锁必须能回收')
  release()
  ok('boot 标记不符的锁判 stale（防系统时钟回拨）')
}

// --- 1c. 同一次启动内的活锁：默认仍然不被抢（不能误伤真正在写的进程） ----------------
{
  const d = tmp()
  writeLock(d, { pid: process.ppid, host: hostname(), token: 'live-now', at: new Date().toISOString() })
  assert.equal(inspectDirLock(d).stale, false)
  assert.equal(acquireDirLock(d, { timeoutMs: 120 }), null, '刚写的活锁不能被抢')
  // 显式给了持有上限：超过上限才回收（store.save() 传 10 分钟）
  assert.equal(inspectDirLock(d, { maxHoldMs: 60_000 }).stale, false)
  const aged = tmp()
  writeLock(aged, { pid: process.ppid, host: hostname(), token: 'live-old', at: new Date().toISOString() }, 5 * 60_000)
  assert.equal(inspectDirLock(aged, { maxHoldMs: 60_000 }).stale, true, '超过 maxHoldMs 就视为残留')
  const release = acquireDirLock(aged, { timeoutMs: 600, maxHoldMs: 60_000 })
  assert.ok(release, 'maxHoldMs 到期的活锁必须能回收')
  release()
  ok('同一次启动内的活锁默认不被抢；maxHoldMs 到期才回收')
}

// --- 1d. 新锁带 boot 字段，跨重启可判 ------------------------------------------------
{
  const d = tmp()
  const release = acquireDirLock(d, { timeoutMs: 500 })
  assert.ok(release, '空目录应能拿到锁')
  const meta = JSON.parse(readFileSync(lockFile(d), 'utf8'))
  assert.ok(Number.isFinite(meta.boot), '锁内容必须带本次开机时刻')
  assert.ok(Math.abs(meta.boot - bootMs()) < 60_000, 'boot 应等于本次开机时刻')
  release()
  ok('锁内容带 boot 标记（跨重启判定的事实来源）')
}

// --- 1e. 不得把"开机时刻"判据套到跨机锁上（既有设计：宁可等也不能双写） --------------
// 网络盘上另一台机器持锁时，它的 `at` 早于本机本次开机是常态。拿它当证据会抢掉一台真正
// 在写的机器——这条是作者刻意的取舍，窗口只对"本机写的锁"成立。
{
  const d = tmp()
  writeLock(d, {
    pid: process.ppid,
    host: 'another-machine',
    token: 'remote-live',
    at: new Date(bootMs() - 3 * 3600_000).toISOString(),
  })
  assert.equal(inspectDirLock(d).stale, false, '跨机锁 mtime 还新时不能判 stale')
  assert.equal(acquireDirLock(d, { timeoutMs: 120 }), null, '不能抢另一台机器的活锁')

  const aged = tmp()
  writeLock(aged, { pid: process.ppid, host: 'another-machine', token: 'remote-old', at: new Date().toISOString() }, 60_000)
  assert.equal(inspectDirLock(aged, { staleMs: 10_000 }).stale, true, '跨机锁仍按 mtime 过期')
  ok('跨机锁仍按 mtime 判过期，没被"开机时刻"判据误伤')
}

// --- 2. when.writes / guard.paths：反斜杠与绝对候选都要命中 ---------------------------
{
  const trig = { when: { writes: ['src/util/fs.js'] } }
  for (const cand of ['src/util/fs.js', 'src\\util\\fs.js', 'D:\\project\\demo\\src\\util\\fs.js', 'D:/project/demo/src/util/fs.js']) {
    assert.match(
      matchTrigger(trig, buildReadinessContext({ targets: [cand] })) || '',
      /^write:/,
      `writes 应命中 ${cand}`,
    )
  }
  // 路径边界不能被放宽：`notlib/a.ts` 不是 `lib/a.ts`
  assert.equal(
    matchTrigger({ when: { writes: ['lib/a.ts'] } }, buildReadinessContext({ targets: ['D:\\proj\\notlib\\a.ts'] })),
    null,
  )
  // glob 同样按分段匹配
  assert.match(
    matchTrigger({ when: { writes: ['src/*.ts'] } }, buildReadinessContext({ targets: ['D:\\proj\\src\\a.ts'] })) || '',
    /^write:/,
  )
  // 人类消息里的反斜杠路径也算"动手前的写意图"（guard 用同一份写目标）
  const human = buildReadinessContext({ humanText: '重构一下 src\\util\\fs.js 的注入逻辑' })
  assert.match(matchTrigger({ when: { intents: ['重构'] }, guard: { paths: ['src/util/fs.js'] } }, human) || '', /^intent:/)
  assert.equal(matchTrigger({ when: { intents: ['重构'] }, guard: { not_paths: ['src/util/fs.js'] } }, human), null)
  ok('when.writes / guard.paths：反斜杠与绝对路径候选都命中，且不放宽路径边界')
}

// --- 3. 动作面：Windows 命令形态 ------------------------------------------------------
{
  const cases = [
    ['npm.cmd run bench', ['run-bench']],
    ['node scripts\\bench.mjs', ['run-bench']],
    ['del src\\util\\fs.js', ['file-delete']],
    ['erase old.txt', ['file-delete']],
    ['copy a.md b.md', ['file-write']],
    ['move old.ts new.ts', ['file-write']],
    ['Set-Content -Path out.txt -Value x', ['file-write']],
    ['Remove-Item -Recurse dist', ['file-delete']],
    ['pwsh -Command "git push origin main"', ['git-push']],
    ['cmd /c npm publish', ['npm-publish']],
    ['"C:\\Program Files\\nodejs\\npm.cmd" publish', ['npm-publish']],
    ['D:\\tools\\git.exe -C D:\\work push', ['git-push']],
  ]
  for (const [cmd, want] of cases) {
    assert.deepEqual(classifyShellCommand(cmd).ops, want, `ops(${cmd})`)
  }
  // 写目标：反斜杠路径归一成 `/`，`nul` 不当文件
  assert.ok(classifyShellCommand('del src\\util\\fs.js').targets.includes('src/util/fs.js'))
  assert.ok(!classifyShellCommand('git commit -m x 2>nul').targets.some((t) => /^nul$/i.test(t)))
  ok('Windows 命令形态：.cmd/.exe、反斜杠路径、del/copy/move、PowerShell/cmd 包装都能识别')
}

// --- 3b. 主机面：原生 Windows 壳不再是 wsl -----------------------------------------
{
  assert.deepEqual(classifyShellCommand('pwsh.exe -Command "npm publish"').hosts, ['windows'])
  assert.deepEqual(classifyShellCommand('pwsh -Command "git push"').hosts, ['windows'])
  assert.deepEqual(classifyShellCommand('cmd.exe /c npm publish').hosts, ['windows'])
  assert.deepEqual(classifyShellCommand('cd /mnt/c/proj && npm publish').hosts, ['wsl'])
  assert.deepEqual(classifyShellCommand('npm publish').hosts, [])
  // 正文里提到 `cmd` 不是壳签名：hosts 只用于收窄，误判会放行本该被挡住的条目
  assert.deepEqual(classifyShellCommand('grep -rn cmd README.md').hosts, [])
  ok('hosts：pwsh/cmd 标 windows，/mnt/ 路径标 wsl，正文提到 cmd 不算')
}

// --- 3c. 路径 token：反斜杠路径不再只剩裸文件名 -------------------------------------
{
  assert.deepEqual(extractPathTokens('src\\util\\fs.js'), ['src/util/fs.js'])
  assert.deepEqual(extractPathTokens('D:\\proj\\src\\a.ts'), ['proj/src/a.ts'])
  assert.deepEqual(extractPathTokens('看一下 src/util/fs.js'), ['src/util/fs.js'])
  const tool = classifyToolCall('edit', JSON.stringify({ file_path: 'D:\\proj\\src\\a.ts' }))
  assert.ok(tool.targets.includes('proj/src/a.ts'), '结构化写调用的 targets 也要有归一后的相对路径')
  ok('extractPathTokens：反斜杠按分隔符处理并归一成 /')
}

// --- 4. store 缓存键大小写归一 --------------------------------------------------------
{
  const proj = path.join(tmp(), 'Proj')
  mkdirSync(proj, { recursive: true })
  const a = new ProjectMemoryStore(path.join(proj, '.dsh-project-memory')).load()
  const b = new ProjectMemoryStore(path.join(proj.toUpperCase(), '.DSH-PROJECT-MEMORY')).load()
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
  if (caseInsensitive) {
    assert.equal(a, b, '同一物理目录的不同大小写写法必须命中同一个实例')
    const keys = _storeCacheKeysForTest().filter((k) => k.includes('proj'))
    assert.equal(new Set(keys).size, keys.length, '同一个 store 不能有两个缓存键')
  } else {
    assert.notEqual(a, b, '大小写敏感平台上它们是两个目录（键不同才对）')
    assert.equal(storeKey('/A/B'), '/A/B', '大小写敏感平台上 storeKey 不改写')
  }
  ok(`store 缓存键按 storeKey() 归一（本平台${caseInsensitive ? '' : '大小写敏感，'}'同实例'只在 win32/darwin 断言）`)
}

// --- 5. SKILL.md 的 UTF-8 BOM（记事本保存） ------------------------------------------
{
  const { meta, body } = parseSkillFile('\uFEFF---\nname: project-memory\ndescription: demo\n---\n正文\n')
  assert.equal(meta.name, 'project-memory', 'BOM 不得让 frontmatter 失效')
  assert.equal(meta.description, 'demo')
  assert.equal(body.trim(), '正文')
  ok('带 BOM 的 SKILL.md 仍能解析 frontmatter')
}

console.log(`\nwindows-compat tests: ${passed} passed`)
