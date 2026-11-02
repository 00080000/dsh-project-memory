// tokenizeRaw 的 CJK 切分：从逐字符状态机改成整段正则之后的等价性回归。
//   node test/tokenizer-equivalence.test.mjs
//
// 这次改动的性质是「**不改输出**的性能重写」，所以判据和 test/chunker.test.mjs 一样：
// **与旧实现逐字节一致**，而不是"看起来对"。旧实现原样冻结在下面，它存在的唯一目的
// 就是当标尺 —— 不要修它。
//
// 为什么必须钉住：分词输出会写进磁盘（doc 条目的 `terms`，用 TOKENIZER_VERSION 标版本）。
// 输出一变就必须升版本、触发一次全量回填；没有这条测试，这种变化在线上只表现为
// "某些词静默搜不到"，既不会报错也不会被别的测试发现。
//
// 字符类不冻结：`CJK_RANGE` 是从源码 import 的，它才是"什么算 CJK"的规范 —— 改它就应该
// 同时影响标尺和被测实现。被冻结的是**算法**：怎么切段、怎么产二元组。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CJK_RANGE, tokenizeRaw } from '../src/util/search.js'
import { CYRILLIC_WORD_RE, RU_STOPWORDS, normalizeRuWord, stemRu } from '../src/util/ru.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..')

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

/**
 * 参考实现：2026-11-02 之前 tokenizeRaw 的逐字符版本。**不要动它。**
 * 语义即规范：先把拉丁词、西里尔词收进结果，再按「CJK 连续段」结算 ——
 * 段长 1 产单字，段长 ≥2 产全部相邻二元组。
 */
function refTokenizeRaw(text, { stem = true } = {}) {
  if (!text) return []
  const lower = text.toLowerCase()
  const tokens = []
  let cjkRun = ''
  const flushCjk = () => {
    if (cjkRun.length === 1) {
      tokens.push(cjkRun)
    } else {
      for (let i = 0; i < cjkRun.length - 1; i++) tokens.push(cjkRun.slice(i, i + 2))
    }
    cjkRun = ''
  }
  const latin = lower.match(/[a-z0-9_]+/g) || []
  for (const tok of latin) tokens.push(tok)
  for (const raw of lower.match(CYRILLIC_WORD_RE) || []) {
    const word = normalizeRuWord(raw)
    if (word.length < 2 || RU_STOPWORDS.has(word)) continue
    const token = word.length <= 3 || !stem ? word : stemRu(word)
    if (token.length >= 2) tokens.push(token)
  }
  for (const ch of lower) {
    if (CJK_RANGE.test(ch)) cjkRun += ch
    else flushCjk()
  }
  flushCjk()
  return tokens
}

function assertSame(label, text, opts) {
  assert.deepEqual(
    tokenizeRaw(text, opts),
    refTokenizeRaw(text, opts),
    `${label}：分词输出与参考实现不一致（文本长度 ${text.length}）`,
  )
}

// ---- 1. 契约：若干固定输出（不只是"新旧一致"，还钉住语义本身）----
console.log('\n== 契约：CJK 切分规则 ==')
{
  assert.deepEqual(tokenizeRaw('中'), ['中'], '单字段落产单字')
  assert.deepEqual(tokenizeRaw('中文'), ['中文'], '两字段落产一个二元组')
  assert.deepEqual(tokenizeRaw('中文字'), ['中文', '文字'], '三字段落产两个二元组')
  assert.deepEqual(tokenizeRaw('中文，测试'), ['中文', '测试'], '标点切段')
  assert.deepEqual(tokenizeRaw('a中b'), ['a', 'b', '中'], '拉丁词先入结果，CJK 段后结算')
  assert.deepEqual(tokenizeRaw('中a文a'), ['a', 'a', '中', '文'], '单字被拉丁词隔开时各产一个单字')
  assert.deepEqual(tokenizeRaw('こんにちは'), ['こん', 'んに', 'にち', 'ちは'], '假名同属 CJK 段')
  ok('固定输出：单字 / 二元组 / 标点切段 / 与拉丁词的交错顺序')
}

// ---- 2. 边界输入：两种实现必须逐字节一致 ----
console.log('\n== 边界输入与参考实现逐字节一致 ==')
{
  const cases = [
    ['空串', ''],
    ['纯空格', '   \n\t '],
    ['单个拉丁词', 'payment'],
    ['单个 CJK 字', '中'],
    ['CJK 紧邻拉丁', 'a中b文c'],
    ['CJK 紧邻标点', '中，文。字；'],
    ['标点密集（长）', '中，文，字，'.repeat(500)],
    ['单字 + 空格（最碎）', '中 文 字 '.repeat(500)],
    ['单字 + 字母（最碎，混合）', '中a文a'.repeat(500)],
    ['超长无标点段', '中'.repeat(5000)],
    ['汉字 + 假名 + 谚文混排', '中文字かなカナ한국어'],
    ['emoji 作为分隔符', '中文😀测试'],
    ['BOM 开头的中文', '\uFEFF中文'],
    ['孤立代理对', '\ud800abc\uDC00中文'],
    ['俄文与中文混排', 'сервер 模块 подключение 配置'],
    ['换行切段', '第一行\n第二行\n第三行'],
    ['增补平面 CJK（当前不在字符类内，作为将来扩类的哨兵）', '\u{20000}中文\u{2A6D6}'],
    ['URL 与路径', '见 https://example.com/中文/路径 与 src/模块/index.js'],
  ]
  for (const [label, text] of cases) assertSame(label, text)
  ok(`${cases.length} 个边界串：与参考实现一致`)
}

// ---- 3. 真实语料：仓库自己的中英文档、变更日志、源码 ----
console.log('\n== 真实语料逐字节一致 ==')
{
  const files = ['README.zh-CN.md', 'README.md', 'CHANGELOG.md', 'package.json', 'src/util/search.js']
  for (const rel of files) {
    const text = readFileSync(path.join(repo, rel), 'utf8')
    assertSame(rel, text)
  }
  ok(`${files.length} 个真实文件（含中英混排与长文档）：与参考实现一致`)
}

// ---- 4. 固定种子的模糊测试：随机拼接各书写系统与分隔符 ----
console.log('\n== 固定种子模糊测试 ==')
{
  let seed = 0x5eed
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const pieces = [
    'a', 'Z', '_', '0', '9', '中', '文', '字', '，', '。', ' ', '\n', '\t',
    'п', 'амять', 'ё', '😀', '\uFEFF', '\u{20000}', '-', '/', '.',
  ]
  for (let i = 0; i < 2000; i++) {
    const n = 1 + Math.floor(rand() * 40)
    let text = ''
    for (let k = 0; k < n; k++) text += pieces[Math.floor(rand() * pieces.length)]
    assertSame(`fuzz#${i}`, text)
  }
  ok('2000 组随机拼接：与参考实现一致')
}

// ---- 5. `stem:false` 开关在两条实现上同样生效 ----
console.log('\n== stem 开关 ==')
{
  for (const text of ['память проекта', 'мост мостом', 'сервер 模块']) {
    assertSame(text, text, { stem: false })
    assertSame(text, text, { stem: true })
  }
  ok('stem:true / stem:false 两条路径都与参考实现一致')
}

console.log(`\ntokenizer-equivalence tests: ${passed} passed`)
