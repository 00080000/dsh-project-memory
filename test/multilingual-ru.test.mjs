// 俄语（西里尔）检索支持 —— issue #9 的验收面。
//   node test/multilingual-ru.test.mjs
//
// 修前红：`tokenizeRaw('что там с сервером приложений')` 返回 []，整条俄文链路（BM25 / 提示通道 /
// 关键词 / 去重）都是空的。这里按"分词 → 闸门 → 检索 → 去重 → 迁移"逐层钉住。
// 夹具一律用中性占位（сервер / город），不引用任何真实项目名。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { tokenizeRaw, TOKENIZER_VERSION } from '../src/util/search.js'
import { stemRu, RU_STOPWORDS, normalizeRuWord } from '../src/util/ru.js'
import { isIntentWord, matchIntent } from '../src/readiness.js'
import { normalizedTokenOverlap } from '../src/similarity.js'
import { docEntriesNeedBackfill, extractTermText } from '../src/doc-index.js'
import { indexRepository } from '../src/tools/index-repo.js'
import { ProjectMemoryStore } from '../src/store.js'
import { memoryRootFor } from '../src/util/fs.js'
import { queryMemoryTool } from '../src/tools/query-memory.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const CONFIG = {
  memoryDir: '.dsh-project-memory',
  chunkChars: 3000,
  maxChunksPerFile: 40,
  maxFileSizeMb: 50,
  maxPdfPages: 10,
  maxOutputChars: 8000,
  llmQueryExpansion: false,
}
const exec0 = (root) => ({ agent: { session: { id: 'sess_ru', header: { cwd: root } } } })

// ---- 1. 分词：切词 + 去虚词 + 词干 ----
console.log('\n== 分词：俄语不再产出空 token ==')
{
  const t = tokenizeRaw('что там с сервером приложений')
  assert.ok(t.length > 0, `俄文查询必须切出 token，实际 ${JSON.stringify(t)}`)
  assert.deepEqual(t, ['сервер', 'приложен'], `虚词应被去掉、词干应归一：${JSON.stringify(t)}`)
  ok('整句俄文查询切出内容 token（修前是 []）')

  assert.deepEqual(tokenizeRaw('мост'), tokenizeRaw('мостом'))
  assert.deepEqual(tokenizeRaw('мост'), tokenizeRaw('моста'))
  assert.deepEqual(tokenizeRaw('мост'), tokenizeRaw('мосты'))
  ok('词形归一：мост / мостом / моста / мосты 同 token')

  assert.deepEqual(tokenizeRaw('не и в на что это'), [])
  ok('俄语虚词不进 token 流')

  assert.deepEqual(tokenizeRaw('еще'), tokenizeRaw('ещё'))
  ok('ё 与 е 归一（同一词的两种拼写命中）')

  const mixed = tokenizeRaw('pwsh не стартует 0xC0000142')
  assert.deepEqual(mixed, ['pwsh', '0xc0000142', 'старт'])
  ok('中英混排不互相污染：拉丁标识符原样、俄文只切自己的词')
}

// ---- 2. 词干与参考实现一致（Snowball Russian） ----
console.log('\n== 词干：与 snowballstemmer 的词形对照 ==')
{
  // 期望值取自参考实现（snowballstemmer 3.1.1, russian）。
  const pairs = [
    ['мостом', 'мост'], ['приложения', 'приложен'], ['кнопкой', 'кнопк'],
    ['песочнице', 'песочниц'], ['перезапуск', 'перезапуск'], ['токенизатор', 'токенизатор'],
    ['миграция', 'миграц'], ['объединение', 'объединен'], ['остров', 'остр'],
    ['гость', 'гост'], ['длинный', 'длин'], ['сильнейший', 'сильн'],
    ['сделавшись', 'сдела'], ['моющий', 'моющ'], ['радость', 'радост'],
  ]
  for (const [w, want] of pairs) assert.equal(stemRu(w), want, `${w} 的词干应为 ${want}`)
  ok(`${pairs.length} 个词形与参考实现逐个一致`)

  // 参考实现的边界：无元音的词不动（RV 区域为空时 tidy 也不许削 ь）
  assert.equal(stemRu('брь'), 'брь')
  ok('无元音词不被误削')
}

// ---- 3. 召回闸门：短西里尔词不被当成"短拉丁噪声"丢掉 ----
console.log('\n== 闸门：短西里尔词与意图词 ==')
{
  assert.deepEqual(tokenizeRaw('ии'), ['ии'])
  ok('两字母实义词（ИИ）保留在查询词里')
  assert.equal(isIntentWord('мост'), true)
  assert.equal(isIntentWord('код'), true)
  assert.equal(isIntentWord('город'), true)
  ok('4 字母俄文实义词可作意图词（拉丁规则是 ≥5，直接套会误杀）')
  assert.equal(isIntentWord('не'), false)
  assert.equal(isIntentWord('это'), false)
  ok('俄语虚词不作意图词')

  assert.equal(matchIntent('город', 'Настрой город сегодня'), true)
  ok('意图词在俄文句子里命中')
  assert.equal(matchIntent('город', 'городской мост'), false)
  ok('不做词内命中：город 不命中 городской')
  assert.equal(matchIntent('пуш', 'сделай git push'), false)
  ok('界限没有放宽到拉丁：俄文意图词不误配英文子串')
}

// ---- 4. 去重：俄文条目之间开始有相似度 ----
console.log('\n== 去重：词形归一后才可比 ==')
{
  const near = normalizedTokenOverlap('Сервер приложений не подключается', 'Сервер приложений не подключается после перезапуска')
  assert.ok(near >= 0.5, `同主题俄文标题应有重叠，实际 ${near}`)
  const far = normalizedTokenOverlap('Сервер приложений не подключается', 'Файл блокировки остался после сбоя')
  assert.equal(far, 0)
  ok('同主题 > 0.5、无关 = 0（修前两者都是 0，俄文去重完全失效）')
}

// ---- 5. doc terms 版本化：旧 store 会触发一次回填 ----
console.log('\n== 迁移：旧 doc 条目触发一次 terms 回填 ==')
{
  assert.equal(docEntriesNeedBackfill([{ type: 'doc', terms: 'x' }]), true)
  ok('旧条目（无 termsVersion）需要回填')
  assert.equal(docEntriesNeedBackfill([{ type: 'doc', terms: 'x', termsVersion: TOKENIZER_VERSION }]), false)
  ok('当前版本条目不再回填')
  assert.equal(docEntriesNeedBackfill([{ type: 'doc', terms: 'x', termsVersion: TOKENIZER_VERSION - 1 }]), true)
  ok('分词契约升版后旧条目重新回填')
  assert.equal(docEntriesNeedBackfill([{ type: 'symbol', name: 'f' }]), false)
  ok('code 条目不需要 terms')

  const terms = extractTermText('Сервер приложений не подключается после перезапуска приложения')
  assert.match(terms, /сервер/)
  assert.match(terms, /перезапуск/)
  assert.doesNotMatch(terms, /\bне\b/)
  ok('doc 的关键词词项串含俄文词干、不含虚词')
}

// ---- 6. 端到端：索引俄文文档后能被俄文查询召回 ----
console.log('\n== 端到端：俄文文档可被俄文查询召回 ==')
{
  const root = mkdtempSync(path.join(tmpdir(), 'pm-ru-'))
  writeFileSync(path.join(root, 'README.md'), '# Проект\n\nАнглийская заметка про сборку.\n')
  mkdirSync(path.join(root, 'docs'), { recursive: true })
  writeFileSync(path.join(root, 'docs', 'most.md'), [
    '# Сервер приложений',
    '',
    'Сервер приложений не подключается после перезапуска приложения.',
    'Нужно проверить файл блокировки и повторить попытку.',
  ].join('\n'))
  writeFileSync(path.join(root, 'docs', 'other.md'), [
    '# Сборка',
    '',
    'Сборка падает на проверке типов в клиентской части.',
  ].join('\n'))

  await indexRepository({}, CONFIG, root, {})

  const tool = queryMemoryTool({}, CONFIG)
  const out = await tool.execute({ query: 'что там с сервером приложений', root, type: 'doc' }, exec0(root))
  assert.match(out, /Сервер приложений/, `俄文查询必须召回俄文文档：${out}`)
  ok('俄文查询召回俄文文档（修前候选集为空）')

  const out2 = await tool.execute({ query: 'сервером приложений', root, type: 'doc' }, exec0(root))
  assert.match(out2, /Сервер приложений/)
  ok('另一种词形（сервером）同样召回（词干生效）')

  // 升级路径：把条目退回"旧版本写的 terms"（无 termsVersion、词项里没有西里尔），
  // 再跑一次索引——文件内容没变，但版本号必须让 terms 被重抽，否则老 store 永远补不上俄文。
  const memDir = memoryRootFor(root, CONFIG.memoryDir)
  const oldStore = new ProjectMemoryStore(memDir).load()
  const rel = 'docs/most.md'
  const legacy = oldStore.entries[rel].map((e) => ({ ...e, terms: 'most astra perezapusk', termsVersion: undefined }))
  oldStore.commit((s) => s.setEntries(rel, legacy))
  oldStore.save()
  await indexRepository({}, CONFIG, root, {})
  const migrated = new ProjectMemoryStore(memDir).load().entries[rel]
  assert.ok(migrated.every((e) => e.termsVersion === TOKENIZER_VERSION), '旧条目应被回填到当前版本')
  assert.ok(migrated.some((e) => /сервер/.test(e.terms || '')), `回填后的 terms 应含俄文词干：${migrated[0].terms}`)
  ok('旧 store 的 doc terms 在下次索引时一次性回填（内容未变也重抽）')
}

console.log(`\nmultilingual-ru tests: ${passed} passed`)
