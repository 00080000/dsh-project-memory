// 文档索引的结构化词项：索引期不调用模型 + 检索词项与注入摘要分离。
//   node test/doc-index.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildDocEntries } from '../src/doc-pipeline.js'
import { extractTerms, extractKeywords, extractTermText, MAX_TERMS } from '../src/doc-index.js'
import { weightedFieldText, rankEntriesMergedScored } from '../src/util/search.js'
import { summarizeText } from '../src/util/text.js'
import { indexDocTool } from '../src/tools/index-doc.js'
import { indexRepository } from '../src/tools/index-repo.js'
import { ProjectMemoryStore } from '../src/store.js'
import { memoryRootFor, sha256OfFile } from '../src/util/fs.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

/** 造一个单 chunk 文档：罕见词放在 300 字符之后（旧 fallback 的检索盲区内）。 */
function makeDoc(root, rare = 'zzztokenq') {
  const md = path.join(root, 'spec.md')
  writeFileSync(md, `# Section\n\n${'filler words '.repeat(200)} ${rare} `)
  return md
}

const CONFIG = { memoryDir: '.dsh-project-memory', chunkChars: 3000, maxChunksPerFile: 40, maxFileSizeMb: 50, maxPdfPages: 10, maxOutputChars: 8000 }

// ---- 1. 注入摘要仍然短，检索词项覆盖整个 chunk ----
{
  const root = mkdtempSync(path.join(tmpdir(), 'pm-di-'))
  const md = makeDoc(root)
  const entries = await buildDocEntries('spec.md', md, { chunkChars: 3000, maxChunks: 40 })
  assert.equal(entries.length, 1)
  const e = entries[0]
  assert.ok(e.summary.length <= 300)
  assert.ok(!e.summary.includes('zzztokenq'), '注入摘要看不到 300 字符之后的词（保持小预算）')
  assert.ok(e.terms.includes('zzztokenq'), 'terms 覆盖整个 chunk')
  assert.ok(weightedFieldText(e).includes('zzztokenq'))
  ok('summary 保持 ≤300 字符；terms 覆盖 300 字符之后的正文')
}

// ---- 2. 检索真的能命中 300 字符之后的词（修 A 前这里是 0 分） ----
{
  const root = mkdtempSync(path.join(tmpdir(), 'pm-di-rank-'))
  const md = makeDoc(root)
  const entries = await buildDocEntries('spec.md', md, { chunkChars: 3000, maxChunks: 40 })
  const hits = rankEntriesMergedScored(entries, ['zzztokenq'], 5)
  assert.equal(hits.length, 1)
  assert.ok(hits[0].score > 0)
  assert.equal(hits[0].entry.terms.includes('zzztokenq'), true)
  ok('BM25 命中 300 字符之后的词（旧 fallback 检索盲区已消除）')
}

// ---- 3. 索引期零 LLM：即使传了 llm 与带路由的 exec，也不会调用 ----
{
  const root = mkdtempSync(path.join(tmpdir(), 'pm-di-nollm-'))
  const md = makeDoc(root)
  let calls = 0
  const boomLLM = {
    async *stream() {
      calls++
      throw new Error('index-time LLM must not be called')
    },
  }
  const tool = indexDocTool({ llm: boomLLM }, CONFIG)
  const exec = { agent: { session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-flash' } }) } } }
  await tool.execute({ file_path: md, root }, exec)

  assert.equal(calls, 0, '索引期不得有任何 LLM 调用')
  const store = new ProjectMemoryStore(memoryRootFor(root, CONFIG.memoryDir)).load()
  const doc = store.allEntries().find((e) => e.type === 'doc')
  assert.ok(doc)
  assert.equal(doc.blindSpots, '')
  assert.ok(doc.terms.includes('zzztokenq'))
  ok('索引期零 LLM（签名里没有 llm；带路由的 exec 也不触发调用）')
}

// ---- 4. 纯规则、确定性、有上限 ----
{
  const text = `${'alpha beta gamma delta '.repeat(100)} uniqueone uniquetwo`
  const a = extractTerms(text)
  const b = extractTerms(text)
  assert.deepEqual(a, b, '确定性')
  assert.ok(a.length <= MAX_TERMS)
  assert.ok(a.includes('uniqueone') && a.includes('uniquetwo'))
  assert.ok(!a.includes('the') && !a.includes('12345'.slice(0, 2)), '停用词/纯数字被过滤')
  assert.equal(typeof extractTermText(text), 'string')
  ok('extractTerms：确定性、去停用词、有上限')

  const kw = extractKeywords('Payment Fees', `${'filler '.repeat(50)} gateway refund`)
  assert.ok(kw.length <= 8)
  assert.ok(kw.includes('payment'), '标题词进关键词')
  ok('extractKeywords：规则化关键词（标题加权 + body 词项）')
}

// ---- 5. 旧 store 回填：缺 terms 的 doc 条目即使哈希未变也重抽一次 ----
{
  const root = mkdtempSync(path.join(tmpdir(), 'pm-di-backfill-'))
  const md = makeDoc(root, 'backfillterm')
  const rel = 'spec.md'
  const { hash } = await sha256OfFile(md)
  const memoryDir = memoryRootFor(root, CONFIG.memoryDir)
  const seed = new ProjectMemoryStore(memoryDir).load()
  seed.commit((s) => {
    s.markFile(rel, { sha256: hash, size: 20, type: 'doc', indexedAt: new Date().toISOString() })
    // 旧形状：没有 terms
    s.setEntries(rel, [{ id: 'old#0', type: 'doc', sourcePath: rel, sourceLine: 1, title: 'Old', summary: 'old shape', keywords: ['old'] }])
  })
  const report = await indexRepository({}, CONFIG, root, {})
  assert.ok(/docs indexed: 1/.test(report), `expected a backfill re-index, got: ${report}`)
  const after = new ProjectMemoryStore(memoryDir).load()
  assert.ok(after.entries[rel][0].terms.includes('backfillterm'))
  ok('旧 store 的 doc 条目缺 terms 时自动回填（哈希未变也不跳过）')
}

// ---- 6. summarizeText 仍是纯函数且封顶 ----
{
  assert.ok(summarizeText('x'.repeat(900)).length <= 300)
  assert.equal(summarizeText('  a   b  '), 'a b')
  ok('summarizeText：无 LLM、封顶 300、压平空白')
}

console.log(`\ndoc-index tests: ${passed} passed`)
