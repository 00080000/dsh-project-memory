// 后台索引失败的可见性（node test/index-failures.test.mjs）：
// watch 的失败过去只有一行日志、懒索引的单文件失败甚至被 `catch {}` 吞掉，于是
// "某些文件一直没进语料"在界面上不可见。账本 + index_repo / memory_stats 必须能报出来。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { _resetIndexFailuresForTest, clearIndexFailure, listIndexFailures, recordIndexFailure } from '../src/index-failures.js'
import { indexFile } from '../src/lazy.js'
import { indexRepository } from '../src/tools/index-repo.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const CONFIG = { memoryDir: '.dsh-project-memory', chunkChars: 3000, maxChunksPerFile: 40, maxFileSizeMb: 10, maxPdfPages: 1000, maxOutputChars: 8000 }

function project() {
  const root = mkdtempSync(path.join(tmpdir(), 'pm-idxfail-'))
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}')
  return root
}

/** 最小合法 PDF（单页一段 ASCII 正文），xref 偏移按实际字节算。 */
function writeMinimalPdf(file, text = 'Hello Index Failure Test') {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
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
}

// --- 1. 账本本身：按根隔离、按最近失败排序、清空、上限 ---------------------------
{
  _resetIndexFailuresForTest()
  const a = project()
  const b = project()
  recordIndexFailure(a, 'x.md', 'boom-1')
  recordIndexFailure(a, 'y.pdf', 'boom-2')
  recordIndexFailure(b, 'z.md', 'other')
  assert.equal(listIndexFailures(a).count, 2, '同一根的失败聚在一起')
  assert.equal(listIndexFailures(b).count, 1, '不同根的失败互不串')
  assert.deepEqual(
    listIndexFailures(a).items.map((i) => i.rel).sort(),
    ['x.md', 'y.pdf'],
  )
  clearIndexFailure(a, 'x.md')
  assert.equal(listIndexFailures(a).count, 1, '修复成功的条目要被清掉')
  clearIndexFailure(a, 'y.pdf')
  assert.equal(listIndexFailures(a).count, 0, '清空后不再报这个根')

  for (let i = 0; i < 60; i++) recordIndexFailure(a, `f${i}.md`, 'boom')
  assert.equal(listIndexFailures(a, 100).count, 50, '上限 50：一次性坏掉上千文件也不吃内存')
  ok('账本：按根隔离 / 清理 / 上限')
}

// --- 2. 懒索引：解析失败要登记，修好之后要自动消失 -------------------------------
{
  _resetIndexFailuresForTest()
  const root = project()
  const pdf = path.join(root, 'broken.pdf')
  writeFileSync(pdf, 'definitely not a pdf payload')

  assert.equal(await indexFile({}, CONFIG, pdf, null, root), false, '坏 PDF 不应索引成功')
  const afterFail = listIndexFailures(root)
  assert.equal(afterFail.count, 1, '懒索引失败必须登记（过去是 catch {}，完全不可见）')
  assert.equal(afterFail.items[0].rel, 'broken.pdf')

  writeMinimalPdf(pdf)
  assert.equal(await indexFile({}, CONFIG, pdf, null, root), true, '修好后的 PDF 应能索引')
  assert.equal(listIndexFailures(root).count, 0, '成功一次后失败记录要清掉')
  ok('懒索引：失败登记、成功后清除')
}

// --- 3. index_repo 的输出要带上后台失败 ------------------------------------------
{
  _resetIndexFailuresForTest()
  const root = project()
  mkdirSync(path.join(root, 'src'), { recursive: true })
  writeFileSync(path.join(root, 'src', 'ok.md'), '# fine\n')
  const broken = path.join(root, 'broken.pdf')
  writeFileSync(broken, 'definitely not a pdf payload')
  recordIndexFailure(root, 'broken.pdf', 'No "GlobalWorkerOptions.workerSrc" specified.')

  const report = await indexRepository({}, CONFIG, root, {})
  assert.match(report, /broken\.pdf/, 'index_repo 结果里要出现失败文件')
  assert.match(report, /background indexing/, '要说明这是后台索引的失败，而不是本次扫描')

  // 文件被删掉后，失败账本不能永久留着这条幽灵记录。
  rmSync(broken)
  await indexRepository({}, CONFIG, root, {})
  assert.equal(listIndexFailures(root).count, 0, '已删除的失败项要清掉')
  ok('index_repo：报告后台失败')
}

console.log(`\n${passed} passed`)
