// `insight.files` 的写入期约束 + `blindSpots` 死字段清理：node test/citation-paths.test.mjs
//
// 背景（两件都是"schema/文档承诺了、实现里没人管"的形状）：
//   ① `save_lesson` 的 files 参数描述写的是「项目相对路径」，但**没有任何校验** —— 项目外绝对
//      路径会原样落盘，事后只能靠审计发现"查不到"（实测 144 处引用里 3 处项目外、6 处真悬空）；
//   ② `blindSpots` 字段被声明、被读，却**没有任何写入方**：`buildDocEntries` 恒写 `''`，
//      `query-memory` 的读取分支因此永不触发（133 个分片里非空 0）。
//
// 本用例分成三层，缺一层都证明不了"写入路径真的改了"：
//   1. 纯函数 normalizeCitationFiles：保真 / 归一 / 丢弃三种结果；
//   2. 真工具 save_lesson 落盘：项目外绝对路径不得进 store，且丢弃数量必须出现在返回文本里；
//   3. 静态守卫：`blindSpots` 在 `src/` 里归零（写侧与读侧一起）。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeCitationFiles } from '../src/util/fs.js'
import { memoryRootFor } from '../src/util/fs.js'
import { lessonTool } from '../src/tools/lesson-tools.js'
import { ProjectMemoryStore } from '../src/store.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const ROOT = path.resolve('/tmp/cite-root')

// ---- 1. 纯函数：相对路径保真 + 归一 + 去重 ----
{
  const r = normalizeCitationFiles(
    ['./src/a.js', 'src\\b.js', 'src/a.js', '', '   ', null, 42, 'docs/x.md'],
    ROOT,
  )
  assert.deepEqual(r.files, ['src/a.js', 'src/b.js', 'docs/x.md'],
    '相对路径原样保留；`./` 前缀与反斜杠归一；重复与非字符串/空串丢掉')
  assert.deepEqual(r.dropped, [], '这些都不该被丢')
  ok('纯函数：相对路径保真（`./` 归一、反斜杠→`/`、去重、跳过非字符串）')
}

// ---- 2. 纯函数：项目内绝对路径 → 项目相对 ----
{
  const abs = path.join(ROOT, 'src', 'util', 'fs.js')
  const r = normalizeCitationFiles([abs], ROOT)
  assert.deepEqual(r.files, ['src/util/fs.js'], '项目内绝对路径必须转成相对路径落盘')
  assert.deepEqual(r.dropped, [])
  ok('纯函数：项目内绝对路径 → 项目相对路径')
}

// ---- 3. 纯函数：项目外绝对 / 逃出根 → 丢弃并回报 ----
{
  const outside = process.platform === 'win32' ? 'C:\\Windows\\system32\\drivers\\etc\\hosts' : '/etc/hosts'
  const r = normalizeCitationFiles([outside, '../sibling/file.md', 'ok/inside.md', '/', ROOT], ROOT)
  assert.deepEqual(r.files, ['ok/inside.md'], '只有项目内的相对路径留下')
  assert.equal(r.dropped.length, 4, `四个越界值都要回报：${JSON.stringify(r.dropped)}`)
  assert.ok(r.dropped.includes(outside), '项目外绝对路径必须出现在 dropped 里（调用方要能说出来）')
  ok('纯函数：项目外绝对路径 / `..` 逃出根 → 丢弃且回报')
}

// ---- 4. 纯函数：没有 root 时宁缺毋滥（绝对路径不猜） ----
{
  const r = normalizeCitationFiles(['/etc/hosts', 'src/a.js'], undefined)
  assert.deepEqual(r.files, ['src/a.js'], '没有根就无法判定内外，绝对路径一律丢')
  assert.deepEqual(r.dropped, ['/etc/hosts'])
  ok('纯函数：没有 root 时绝对路径丢弃、相对路径保留')
}

// ---- 5. 真工具：save_lesson 落盘的 files 已归一，且丢弃数量写在返回文本里 ----
{
  const root = mkdtempSync(path.join(tmpdir(), 'cite-tool-'))
  const config = { memoryDir: '.dsh-project-memory', insight: { globalFile: path.join(root, 'global.json') } }
  const exec = { agent: { session: { id: 's_cite', header: { cwd: root } } } }
  const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts'
  const text = await lessonTool(config).execute({
    title: '引用路径只在项目内',
    kind: 'lesson',
    fix: '写相对路径',
    files: [path.join(root, 'src', 'a.js'), 'README.md', outside],
  }, exec)
  const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
  const item = store.insightItems()[0]
  assert.ok(item, '条目已写入')
  assert.deepEqual(item.files, ['src/a.js', 'README.md'],
    `落盘的必须是归一后的相对路径，实得 ${JSON.stringify(item.files)}`)
  assert.ok(String(text).includes('已丢弃'), `丢弃必须说出来，实得：${text}`)
  ok('写入路径：save_lesson 归一 files 并把丢弃数量写在返回文本里')
}

// ---- 6. 静态守卫：blindSpots 死字段在 src/ 里归零 ----
{
  const hits = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (!p.endsWith('.js') && !p.endsWith('.mjs')) continue
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (line.includes('blindSpots')) hits.push(`${path.relative(process.cwd(), p)}:${i + 1}`)
      })
    }
  }
  // `URL.pathname` 在 Windows 上是 `/C:/…/src`（前导斜杠），readdir 会去找 `C:\C:\…`；
  // 用 fileURLToPath 取路径才是跨平台的（windows CI 红、ubuntu 绿的原因）。
  walk(fileURLToPath(new URL('../src', import.meta.url)))
  assert.deepEqual(hits, [],
    `声明了却没有任何写入方的字段必须删干净（写侧恒 '' + 读侧永不触发）：\n${hits.join('\n')}`)
  ok('静态守卫：blindSpots 死字段（写侧与读侧）已从 src/ 删除')
}

console.log(`\ncitation-paths tests: ${passed} passed`)
process.exit(0)
