// PDF 解析在 Electron 宿主里的回归：node test/pdfjs-host.test.mjs
//
// 宿主进程里 `isNodeJS` 为假（Electron 且 process.type !== 'browser'），pdf.js 因此跳过
// `workerSrc ||= './pdf.worker.mjs'` 这段默认值，取 workerSrc 时直接抛
// `No "GlobalWorkerOptions.workerSrc" specified` → 该进程里所有 PDF 索引失败。
//
// 关键在于**纯 Node 跑测试永远看不见**（isNodeJS 为真，pdf.js 自己补默认值）。所以这里必须
// 在子进程里冒充宿主：先改 process.type / process.versions.electron，再动态 import 解析器。
// 判据取 PDF 正文（只存在于内容流里），「解析没抛错」不足以证明真的解码了字节。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.dirname(here)
const parserUrl = pathToFileURL(path.join(repoRoot, 'src/parsers/pdfjs-parser.js')).href

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

/** 写一个最小合法 PDF（单页、一段 ASCII 正文），xref 偏移按实际字节算。 */
function writeFixturePdf() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-pdfjs-'))
  const file = path.join(dir, 'fixture.pdf')
  const text = 'BT /F1 24 Tf 72 720 Td (Hello PDF Index Test 2026) Tj ET'
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  for (const [i, body] of bodies.entries()) {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  }
  const xrefAt = out.length
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  writeFileSync(file, out, 'latin1')
  return file
}

/** 在子进程里解析一次，返回 { status, pageCount?, markdown?, error? }。 */
function parseIn({ asHost }) {
  const file = writeFixturePdf()
  const script = `
    if (${asHost}) {
      process.type = 'renderer'
      process.versions.electron = '0.0.0-sim'
    }
    const { parsePdf } = await import(${JSON.stringify(parserUrl)})
    try {
      const r = await parsePdf(${JSON.stringify(file)})
      console.log('RESULT ' + JSON.stringify({ pageCount: r.pageCount, markdown: r.markdown }))
    } catch (e) {
      console.log('ERROR ' + JSON.stringify({ error: e.message }))
    }
  `
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  const line = (run.stdout || '')
    .split('\n')
    .find((l) => l.startsWith('RESULT ') || l.startsWith('ERROR '))
  assert.ok(line, `子进程没有输出结果：stdout=${run.stdout} stderr=${run.stderr}`)
  const payload = JSON.parse(line.slice(line.indexOf(' ') + 1))
  return { status: run.status, ...payload }
}

// --- 1. 纯 Node：对照组，确认修改没有破坏原本能跑的路径 -----------------------------
{
  const r = parseIn({ asHost: false })
  assert.equal(r.error, undefined, `纯 Node 下解析失败：${r.error}`)
  assert.equal(r.pageCount, 1)
  assert.match(r.markdown, /Hello PDF Index Test 2026/)
  ok('纯 Node（isNodeJS 为真）：PDF 正文解析正常')
}

// --- 2. 冒充 Electron 宿主：issue #10 的现场 --------------------------------------
{
  const r = parseIn({ asHost: true })
  assert.equal(
    r.error,
    undefined,
    `宿主形态下解析失败（workerSrc 未被兜底解析？）：${r.error}`,
  )
  assert.equal(r.pageCount, 1)
  // 只断言"没抛错"会放过"返回了空正文"的假成功：这段文字只存在于 PDF 内容流里
  assert.match(r.markdown, /Hello PDF Index Test 2026/)
  ok('Electron 宿主（isNodeJS 为假）：workerSrc 自动兜底，正文可解析')
}

console.log(`\n${passed} passed`)
