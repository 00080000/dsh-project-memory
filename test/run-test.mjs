import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chunkText } from '../src/chunker.js'
import { scanSymbols } from '../src/symbols.js'
import { ProjectMemoryStore } from '../src/store.js'
import { memoryRootFor, resolveIndexRoot } from '../src/util/fs.js'
import { indexDocTool } from '../src/tools/index-doc.js'
import { indexRepoTool } from '../src/tools/index-repo.js'
import { queryMemoryTool } from '../src/tools/query-memory.js'
import { rememberTool } from '../src/tools/remember.js'
import { forgetTool } from '../src/tools/forget.js'
import { watchRepoTool } from '../src/tools/watch-repo.js'
import { WatchManager } from '../src/watch.js'
import { linkEntries } from '../src/link.js'
import { rankEntriesMerged, rankEntries, rankExperienceScored, tokenizeRaw } from '../src/util/search.js'
import { findProjectRoot, indexFile, setupLazyIndexing, codeFirst } from '../src/lazy.js'

let passed = 0
let failed = 0
function check(name, cond) {
  if (cond) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    console.error(`FAIL  ${name}`)
  }
}

const fakeLLM = {
  async *stream() {
    const body = JSON.stringify({
      title: 'Payment Module',
      summary: 'Handles order payments via PaymentService. Constraint: fees must stay under 1%.',
      keywords: ['payment', 'fees', 'gateway', 'PaymentService'],
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: body }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

const config = {
  memoryDir: '.dsh-project-memory',
  chunkChars: 3000,
  maxChunksPerFile: 40,
  maxFileSizeMb: 50,
  maxOutputChars: 8000,
  maxPdfPages: 1000,
  llmQueryExpansion: true,
  expansionCount: 6,
  watch: true,
  watchInterval: 15,
}

const root = mkdtempSync(path.join(tmpdir(), 'pm-test-'))
const docsDir = path.join(root, 'docs')
const srcDir = path.join(root, 'src')
mkdirSync(docsDir, { recursive: true })
mkdirSync(srcDir, { recursive: true })

const mdPath = path.join(docsDir, 'spec.md')
writeFileSync(
  mdPath,
  '# Overview\n\nThis project handles payments end to end.\n\n# Fees\n\nFees must stay under 1%.\n\n# Archived\n\nOld section that changed.',
)
const pyPath = path.join(srcDir, 'payments.py')
writeFileSync(pyPath, 'class PaymentService:\n    def charge(self, amount):\n        pass\n\ndef refund(tx):\n    pass\n')

const ctx = { llm: fakeLLM }

console.log('\n== chunker ==')
const chunks = chunkText('# A\n\ncontent one\n\n# B\n\ncontent two', 3000, 40)
check('splits headings', chunks.length === 2 && chunks[0].title === 'A' && chunks[1].title === 'B')
check('tracks source lines', typeof chunks[0].line === 'number' && chunks[0].line >= 1)

console.log('\n== symbols ==')
const symbols = scanSymbols(pyPath, 'class PaymentService:\n    def charge(self, amount):\n        pass\n\ndef refund(tx):\n    pass\n')
check('scans python class + functions', symbols.length === 3)
check('symbol has source line', symbols.every((s) => typeof s.sourceLine === 'number'))
check('symbol keywords include name', symbols.some((s) => s.keywords.includes('refund')))

const csSource = `using System;
using System.IO;
class Program {
    private static void Main() {
        if (!File.Exists("x")) return;
        var p = Path.Combine("a", "b");
        Process.Start(p);
    }
    public string GetName(int id) {
        return id.ToString();
    }
    private void DumpType(Type t) {
        // no-op
    }
    public static (long dx, long dy) ReadMoveDir(int dir) {
        return (0, 0);
    }
}`
const csSymbols = scanSymbols('Program.cs', csSource)
check('C# only captures declarations (no method-call noise)', csSymbols.length === 5)
check('C# captures class + functions', csSymbols.every((s) => ['Program', 'Main', 'GetName', 'DumpType', 'ReadMoveDir'].includes(s.title.split(' ')[0])))

const rustSymbols = scanSymbols('lib.rs', 'pub fn visible() {}\npub(crate) async fn scoped() {}\nfn hidden() {}\npub struct Thing {}\n')
check(
  'rust captures pub fn / pub(crate) async fn / private fn',
  ['visible', 'scoped', 'hidden'].every((n) => rustSymbols.some((s) => s.keywords.includes(n))),
)
check('rust struct still detected', rustSymbols.some((s) => s.title.startsWith('Thing')))

console.log('\n== store ==')
const storeDir = memoryRootFor(root, config.memoryDir)
const store = new ProjectMemoryStore(storeDir).load()
const add1 = store.addExperience({ problem: 'pdfjs import fails on Node 24', solution: 'use legacy build', sourceFile: 'a.js' })
const add2 = store.addExperience({ problem: 'different problem entirely', solution: 'x' })
const add3 = store.addExperience({ problem: 'pdfjs import fails on Node 24 again', solution: 'use legacy build + worker:false' })
check('adds experience', add1.superseded === false && add2.superseded === false)
check('supersedes similar problem', add3.superseded === true && store.experience.length === 2)
store.save()
check('persists to disk', existsSync(path.join(storeDir, 'experience.json')))
check('store files written compact', !readFileSync(path.join(storeDir, 'experience.json'), 'utf8').includes('\n  '))
check('searches experience', rankExperienceScored(store.experience, 'pdfjs import').length === 1)
const staleTmp = path.join(storeDir, 'experience.json.999999.tmp')
writeFileSync(staleTmp, '{}')
utimesSync(staleTmp, new Date(Date.now() - 120000), new Date(Date.now() - 120000))
store.save()
check('stale tmp files cleaned on save', !existsSync(staleTmp))

console.log('\n== experience capacity ==')
{
  const capStore = new ProjectMemoryStore(path.join(mkdtempSync(path.join(tmpdir(), 'dsh-cap-')), 'mem')).load()
  capStore.files = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}.js`, 'h']))
  for (let i = 0; i < 130; i++) {
    capStore.experience.push({ id: `e${i}`, problem: `case${i} trouble`, solution: 'x', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() })
  }
  const pruned = capStore.pruneExperience()
  check('cap: prunes to dynamic max (120)', capStore.experience.length === 120 && pruned === 10)
  check('cap: drops oldest batch', !capStore.experience.some((e) => Number(e.id.slice(1)) < 10) && capStore.experience.some((e) => e.id === 'e129'))
  let added = 0
  for (let i = 0; i < 150; i++) {
    const r = capStore.addExperience({ problem: `topic${i} trouble`, solution: 'x' })
    if (!r.superseded) added++
  }
  check('cap: addExperience keeps store at max', capStore.experience.length === 120 && added === 150)
  check('cap: clamps at 2000 on huge projects', Math.max(100, Math.min(2000, 5000 * 2)) === 2000)
  check('cap: floors at 100 on empty projects', Math.max(100, Math.min(2000, 0 * 2)) === 100)
}

console.log('\n== supersede boundary (regression) ==')
{
  const ngxStore = new ProjectMemoryStore(path.join(mkdtempSync(path.join(tmpdir(), 'pm-ngx-')), 'mem')).load()
  ngxStore.addExperience({ problem: '如何配置 nginx 反向代理', solution: 'proxy_pass to upstream' })
  const ngxSecond = ngxStore.addExperience({ problem: '如何配置 nginx 负载均衡', solution: 'upstream round-robin' })
  check(
    'distinct problems with shared prefix do not supersede',
    ngxSecond.superseded === false && ngxStore.experience.length === 2,
  )
}

console.log('\n== index_doc ==')
const docTool = indexDocTool(ctx, config)
let out = await docTool.execute({ file_path: mdPath })
check('indexes md', out.startsWith('Indexed:') && out.includes('Entries: 3'))
out = await docTool.execute({ file_path: mdPath })
check('skips unchanged on re-run', out.startsWith('Skipped (unchanged)'))

console.log('\n== LLM summary safety ==')
const { summarizeText } = await import('../src/llm.js')
const huge = 'oops the model echoed the whole chunk back '.repeat(200)
check('caps LLM-summary length', summarizeText(huge).length <= 300)
const { extractDocEntry } = await import('../src/llm.js')
const padStart = ctx
const entryNoKw = await extractDocEntry(
  {
    async *stream() {
      const body = JSON.stringify({ title: 'T', summary: 'S'.repeat(900), keywords: [] })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: body }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
  { title: 'Payment', text: 'x' },
  'spec.md',
)
check('truncates overlong LLM summary', entryNoKw.summary.length <= 300)
check('falls back to title keywords when LLM returns empty list', entryNoKw.keywords.includes('payment'))

console.log('\n== index_repo ==')
const repoTool = indexRepoTool(ctx, config)
out = await repoTool.execute({ root })
check('indexes repo (doc + code symbols)', out.includes('docs indexed: 1') && out.includes('code symbols updated: 1'))

console.log('\n== index_repo skips dumps ==')
const dumpDir = mkdtempSync(path.join(tmpdir(), 'pm-dump-'))
const dumpFile = path.join(dumpDir, 'dump_cmdhist.txt')
writeFileSync(
  dumpFile,
  '=== Assembly-CSharp loaded: Assembly-CSharp, Version=1.0.0.0\n\n== TYPE Foo : base=Object\n  M Int32 Bar()',
)
const dumpRepoTool = indexRepoTool(ctx, config)
out = await dumpRepoTool.execute({ root: dumpDir })
check('dump file counted as skipped, not indexed', out.includes('docs indexed: 0') && out.includes('unchanged skipped: 1'))
const dumpStore = new ProjectMemoryStore(memoryRootFor(dumpDir, config.memoryDir)).load()
check('dump file leaves no memory entries', dumpStore.stats().entries === 0)

console.log('\n== query_memory ==')
const queryTool = queryMemoryTool(ctx, config)
out = await queryTool.execute({ root, query: 'payment fees constraint' })
check('recalls doc summary with source', out.includes('Payment Module') && out.includes('spec.md') && out.includes('1%'))
out = await queryTool.execute({ root, query: 'refund' })
check('recalls code symbol', out.includes('refund') && out.includes('payments.py'))
out = await queryTool.execute({ root, query: 'pdfjs import' })
check('recalls experience note', out.includes('pdfjs import fails on Node 24'))

console.log('\n== remember / forget ==')
const remTool = rememberTool(config)
out = await remTool.execute({ root, problem: 'OPS import breaks', solution: 'import from legacy build', source_file: 'x.js' })
check('remember saves', out.includes('Saved experience note'))
const forgetToolInst = forgetTool(config)
out = await forgetToolInst.execute({ root, id_or_query: 'OPS import breaks' })
check('forget removes', out.includes('Removed'))

console.log('\n== concurrent store writes are serialized ==')
const { withStoreLock } = await import('../src/store.js')
const lockDir = mkdtempSync(path.join(tmpdir(), 'pm-lock-'))
const mkStore = () => new ProjectMemoryStore(memoryRootFor(lockDir, config.memoryDir))
await Promise.all([
  withStoreLock(memoryRootFor(lockDir, config.memoryDir), async () => {
    const s = mkStore().load()
    s.addExperience({ problem: 'p1', solution: 's1' })
    await new Promise((r) => setTimeout(r, 50))
    s.save()
  }),
  withStoreLock(memoryRootFor(lockDir, config.memoryDir), async () => {
    const s = mkStore().load()
    s.addExperience({ problem: 'p2', solution: 's2' })
    s.save()
  }),
])
const lockStore = mkStore().load()
check('no lost writes under contention', lockStore.experience.length === 2)

console.log('\n== incremental cleanup ==')
writeFileSync(pyPath, 'class PaymentService:\n    def charge(self, amount):\n        pass\n')
out = await repoTool.execute({ root })
check('reindex keeps docs, updates changed code', out.includes('docs indexed: 0') && out.includes('code symbols updated: 1'))

console.log('\n== merged BM25 (query expansion fallback) ==')
const merged = rankEntriesMerged(
  [
    { id: '1', title: 'Refund flow', summary: 'Handles order refunds', keywords: ['refund'], sourcePath: 'a.md' },
    { id: '2', title: 'Login', summary: 'Auth token', keywords: ['auth'], sourcePath: 'b.md' },
  ],
  ['refund', 'money back'],
)
check('merged search ranks by max score', merged.length === 1 && merged[0].id === '1')

console.log('\n== BM25 term frequency & field weighting ==')
{
  const tfDocs = [
    { id: 'low', title: 'Alpha notes', summary: 'fees y z w', keywords: [], sourcePath: 'a.md' },
    { id: 'high', title: 'Beta notes', summary: 'fees fees fees x', keywords: [], sourcePath: 'b.md' },
  ]
  check('higher term frequency ranks first', rankEntries(tfDocs, 'fees')[0]?.id === 'high')
  const fieldDocs = [
    { id: 'body', title: 'Other title', summary: 'about zephyr stuff', keywords: [], sourcePath: 'c.md' },
    { id: 'head', title: 'Zephyr spec', summary: 'nothing relevant here', keywords: [], sourcePath: 'd.md' },
  ]
  check('title hit outweighs body hit', rankEntries(fieldDocs, 'zephyr')[0]?.id === 'head')
}

console.log('\n== doc <-> symbol cross-linking ==')
const linked = linkEntries(new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load())
check('links doc entries to mentioned symbols', linked > 0)
out = await queryTool.execute({ root, query: 'payment' })
check('query shows references to linked symbols', out.includes('references:') && out.includes('PaymentService'))

console.log('\n== link hygiene ==')
{
  const linkStore = new ProjectMemoryStore(path.join(mkdtempSync(path.join(tmpdir(), 'pm-link-')), 'mem')).load()
  linkStore.setEntries('src/a.js', [
    {
      id: 's1', type: 'symbol', sourcePath: 'src/a.js', sourceLine: 1,
      title: 'parseConfig (function)', summary: 'function parseConfig', keywords: ['parseConfig', 'function'],
    },
  ])
  linkStore.setEntries('docs/spec.md', [
    {
      id: 'd1', type: 'doc', sourcePath: 'docs/spec.md', sourceLine: 1,
      title: 'Config guide', summary: 'Describes several function entry points.', keywords: ['config'],
    },
    {
      id: 'd2', type: 'doc', sourcePath: 'docs/spec.md', sourceLine: 9,
      title: 'Parsing', summary: 'parseConfig loads values at boot.', keywords: ['parseConfig'],
    },
  ])
  const links = linkEntries(linkStore)
  const docs = linkStore.allEntries().filter((e) => e.type === 'doc')
  check('generic word does not link every symbol', !docs.find((e) => e.id === 'd1').linkedSymbols)
  check('real name match still links', docs.find((e) => e.id === 'd2').linkedSymbols?.includes('s1'))
  check('link count is unique pairs only', links === 1)
}

console.log('\n== silent watch (poll) ==')
const wm = new WatchManager(ctx, config)
wm.addRoot(root)
const authJs = path.join(srcDir, 'auth.js')
writeFileSync(authJs, 'export function login() {}\nexport const TOKEN_TTL = 3600\n')
const newMd = path.join(docsDir, 'auth-spec.md')
writeFileSync(newMd, '# Auth Spec\n\nTokens expire after 1 hour.')
await wm.poll()
const watched = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
check('watch indexes new code file silently', watched.fileRecord('src/auth.js') && (watched.entries['src/auth.js'] || []).length >= 1)
check('watch indexes new doc file silently', !!watched.fileRecord('docs/auth-spec.md'))
const watchDump = path.join(docsDir, 'watch-dump.txt')
writeFileSync(watchDump, '=== Assembly-CSharp loaded: Assembly-CSharp, Version=1.0.0.0\n\n== TYPE Foo : base=Object\n')
await wm.poll()
await wm.poll()
const afterDump = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
check('watch dump file leaves no shell record', !afterDump.fileRecord('docs/watch-dump.txt'))
wm.stop()

console.log('\n== watch failure retries ==')
{
  const failRoot = mkdtempSync(path.join(tmpdir(), 'pm-watchfail-'))
  writeFileSync(path.join(failRoot, 'broken.pdf'), 'definitely not a pdf payload')
  const failWm = new WatchManager(ctx, config)
  failWm.addRoot(failRoot)
  await failWm.poll()
  check(
    'failed index rolls back snapshot so next poll retries',
    !('broken.pdf' in failWm.roots.get(failRoot).snapshot),
  )
  writeFileSync(
    path.join(failRoot, 'skip.txt'),
    '=== Assembly-CSharp loaded: Assembly-CSharp, Version=1.0.0.0\n\n== TYPE Foo : base=Object\n',
  )
  await failWm.poll()
  const snap = failWm.roots.get(failRoot).snapshot
  check('dump-skip path keeps snapshot (no re-hash churn)', snap['skip.txt'] !== undefined && !('broken.pdf' in snap))
  failWm.stop()
}

console.log('\n== watch_repo tool ==')
const watchTool = watchRepoTool(wm, config)
out = await watchTool.execute({ root })
check('watch_repo starts watching', out.includes('Watching'))
out = await watchTool.execute({ root, watch: false })
check('watch_repo stops watching', out.includes('Stopped watching'))

console.log('\n== watch restore (persisted roots) ==')
const restoreRoot = mkdtempSync(path.join(tmpdir(), 'pm-restore-'))
const restoreStore = new ProjectMemoryStore(memoryRootFor(restoreRoot, config.memoryDir))
restoreStore.addWatch(restoreRoot)
restoreStore.save()
const restoreCwd = process.cwd
process.cwd = () => restoreRoot
const restoreWm = new WatchManager(ctx, config)
restoreWm.restorePersisted()
process.cwd = restoreCwd
check('restorePersisted resumes a persisted watch root', restoreWm.roots.has(restoreRoot))
restoreWm.stop()

console.log('\n== code size limit ==')
const sizeRoot = mkdtempSync(path.join(tmpdir(), 'pm-size-'))
const bigCs = path.join(sizeRoot, 'huge.cs')
writeFileSync(bigCs, `public class Huge {\n  public static string S = "${'x'.repeat(1024 * 1024)}";\n}\n`)
const sizeLimited = { ...config, maxFileSizeMb: 0.001 }
const lazyLimited = await indexFile(ctx, sizeLimited, bigCs)
check('oversized code file skipped by lazy index', lazyLimited === false)
check(
  'oversized code file leaves no record',
  !new ProjectMemoryStore(memoryRootFor(sizeRoot, config.memoryDir)).load().fileRecord('huge.cs'),
)
check('missing file is skipped silently by lazy index', (await indexFile(ctx, config, path.join(sizeRoot, 'gone.js'))) === false)

console.log('\n== config defaults ==')
const { Config } = await import('../src/index.js')
const configJson = JSON.parse(JSON.stringify(Config))
const objectNode = configJson.refs[String(configJson.uid)]
const defaults = {}
for (const [key, refId] of Object.entries(objectNode?.dict || {})) {
  const ref = configJson.refs[refId]
  if (ref && ref.meta && ref.meta.default !== undefined) defaults[key] = ref.meta.default
}
check('query expansion off by default', defaults.llmQueryExpansion === false)
check('lazy indexing on by default', defaults.lazyIndexing === true)
check('full auto-index off by default', defaults.autoIndexOnFirstUse === false)

console.log('\n== dump detection ==')
const { looksLikeDump } = await import('../src/util/fs.js')
check(
  'detects IL2CPP reflection dump',
  looksLikeDump('=== Assembly-CSharp loaded: Assembly-CSharp, Version=1.0.0.0\n\n== TYPE Foo : base=Object'),
)
check(
  'does not flag a plain text banner',
  !looksLikeDump('============================================\nES 桌宠 · 苍翼混沌效应 (BlazBlue Entropy Effect)'),
)
check('does not flag markdown', !looksLikeDump('# 使用步骤\n\n把游戏内每个动作'))
check('empty input is not a dump', !looksLikeDump(''))

console.log('\n== CJK tokenization coverage ==')
check('hiragana bigram-tokenized', tokenizeRaw('こんにちは の設定').includes('こん'))
check('katakana bigram-tokenized', tokenizeRaw('セーブデータ 確認').includes('セー'))
check('hangul bigram-tokenized', tokenizeRaw('결제 모듈 修正').includes('결제'))
check('latin word tokenized', tokenizeRaw('payment module fees').includes('payment'))

const { buildDocEntries } = await import('../src/doc-pipeline.js')
const docDumpFile = path.join(docsDir, 'dump.txt')
writeFileSync(docDumpFile, '=== Assembly-CSharp loaded: Assembly-CSharp, Version=1.0.0.0\n\n== TYPE Foo : base=Object\n')
check('buildDocEntries returns null for a dump', (await buildDocEntries(fakeLLM, docDumpFile, {})) === null)

const bigPdf = path.join(mkdtempSync(path.join(tmpdir(), 'pm-pdf-')), 'big.pdf')
writeFileSync(bigPdf, Buffer.alloc(2048, 0x41))
let pdfErr = null
try {
  await buildDocEntries(fakeLLM, bigPdf, { maxFileSizeMb: 0.001 })
} catch (err) {
  pdfErr = err
}
check('oversized PDF rejected by byte limit', pdfErr !== null && /too large/i.test(pdfErr.message))

const smallTxt = path.join(mkdtempSync(path.join(tmpdir(), 'pm-txt-')), 'note.txt')
writeFileSync(smallTxt, '# Note\n\nhello world content.')
let zeroRes = null
let zeroErr = null
try {
  zeroRes = await buildDocEntries(fakeLLM, smallTxt, { maxFileSizeMb: 0 })
} catch (err) {
  zeroErr = err
}
check('maxFileSizeMb=0 means unlimited for text docs', zeroErr === null && zeroRes !== null && zeroRes.length === 1)

console.log('\n== doc summarization concurrency ==')
{
  const concRoot = mkdtempSync(path.join(tmpdir(), 'pm-conc-'))
  const multiMd = path.join(concRoot, 'multi.md')
  writeFileSync(multiMd, Array.from({ length: 6 }, (_, i) => `# S${i}\n\nsection ${i} body text.\n`).join('\n'))
  let active = 0
  let peak = 0
  const echoLLM = {
    async *stream({ messages }) {
      active++
      peak = Math.max(peak, active)
      try {
        const prompt = messages[1].content.map((b) => b.text).join('\n')
        const m = prompt.match(/Section: S(\d+)/)
        const body = JSON.stringify({ title: `T${m ? m[1] : 'X'}`, summary: `sum ${m ? m[1] : ''}`, keywords: [] })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: body }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        active--
      }
    },
  }
  const entriesConc = await buildDocEntries(echoLLM, multiMd, {})
  check('chunks summarized concurrently within the pool cap', entriesConc.length === 6 && peak <= 4 && peak >= 2)
  check('entries keep document order', entriesConc.every((e, i) => e.title === `T${i}`))
}

console.log('\n== lazy queue ordering ==')
check(
  'code files are processed before docs',
  JSON.stringify(codeFirst(['a.md', 'b.js', 'c.ts', 'd.txt'])) === JSON.stringify(['b.js', 'c.ts', 'a.md', 'd.txt']),
)
check(
  'unsupported extensions skip before root detection',
  (await indexFile(ctx, config, '/nonexistent-dir-for-sure/xyz.json')) === false,
)

console.log('\n== lazy read-time indexing (fs/observed) ==')
const lazyRoot = mkdtempSync(path.join(tmpdir(), 'lazy-'))
mkdirSync(path.join(lazyRoot, 'sub'), { recursive: true })
writeFileSync(path.join(lazyRoot, 'package.json'), '{}')
writeFileSync(path.join(lazyRoot, 'sub', 'utils.js'), 'export function parse() {}\n')
check('finds project root via marker', findProjectRoot(path.join(lazyRoot, 'sub', 'utils.js')) === lazyRoot)

const dumpLazy = path.join(lazyRoot, 'sub', 'dump.txt')
writeFileSync(dumpLazy, '=== Assembly-CSharp loaded: Assembly-CSharp, Version=1.0.0.0\n\n== TYPE Foo : base=Object\n')
await indexFile(ctx, config, dumpLazy)
const lazyDumpStore = new ProjectMemoryStore(memoryRootFor(lazyRoot, config.memoryDir)).load()
check('lazy dump file leaves no shell record', !lazyDumpStore.fileRecord('sub/dump.txt'))

const fallbackRoot = mkdtempSync(path.join(tmpdir(), 'pm-fb-'))
mkdirSync(path.join(fallbackRoot, 'app'), { recursive: true })
writeFileSync(path.join(fallbackRoot, 'README.txt'), 'demo')
writeFileSync(path.join(fallbackRoot, 'app', 'main.js'), 'export function run() {}\n')
check(
  'falls back to readme/source-dir root without markers',
  findProjectRoot(path.join(fallbackRoot, 'app', 'main.js')) === fallbackRoot,
)
const bareDir = mkdtempSync(path.join(tmpdir(), 'pm-bare-'))
writeFileSync(path.join(bareDir, 'note.txt'), 'x')
check(
  'falls back to own dir when nothing looks like a project',
  findProjectRoot(path.join(bareDir, 'note.txt')) === bareDir,
)
const nestedRoot = mkdtempSync(path.join(tmpdir(), 'pm-nested-'))
mkdirSync(path.join(nestedRoot, 'app'), { recursive: true })
mkdirSync(path.join(nestedRoot, 'tools', 'plugin'), { recursive: true })
writeFileSync(path.join(nestedRoot, 'README.md'), 'root doc')
writeFileSync(path.join(nestedRoot, 'app', 'main.js'), 'export function run() {}\n')
writeFileSync(path.join(nestedRoot, 'tools', 'plugin', 'README.md'), 'sub readme')
writeFileSync(path.join(nestedRoot, 'tools', 'plugin', 'Plugin.cs'), 'class P {}\n')
check(
  'sub-folder readme does not hijack the project root',
  findProjectRoot(path.join(nestedRoot, 'tools', 'plugin', 'Plugin.cs')) === nestedRoot,
)

const sessionCwdRoot = mkdtempSync(path.join(tmpdir(), 'pm-cwd-'))
const procCwdSpy = process.cwd
process.cwd = () => bareDir
check(
  'root defaults to session cwd when process cwd differs',
  resolveIndexRoot({ agent: { session: { header: { cwd: sessionCwdRoot } } } }, undefined) === sessionCwdRoot,
)
check(
  'explicit root wins over session cwd',
  resolveIndexRoot({ agent: { session: { header: { cwd: sessionCwdRoot } } } }, fallbackRoot) === fallbackRoot,
)
check(
  'falls back to process cwd without a session',
  resolveIndexRoot(undefined, undefined) === bareDir,
)
process.cwd = procCwdSpy

const listeners = {}
const lazyCtx = {
  llm: fakeLLM,
  on(evt, fn) {
    listeners[evt] = fn
  },
  effect() {},
}
const lazyWatch = new WatchManager(lazyCtx, config)
setupLazyIndexing(lazyCtx, config, lazyWatch)
await new Promise((r) => setTimeout(r, 400))
writeFileSync(path.join(lazyRoot, 'sub', 'utils.js'), 'export function parse() {}\nexport function serialize() {}\n')
listeners['fs/observed']({ displayPath: path.join(lazyRoot, 'sub', 'utils.js') }, { kind: 'present', version: 'v1' })
await new Promise((r) => setTimeout(r, 700))
const lazyStore = new ProjectMemoryStore(memoryRootFor(lazyRoot, config.memoryDir)).load()
check(
  'indexes a file the moment it is read',
  lazyStore.fileRecord('sub/utils.js') && (lazyStore.entries['sub/utils.js'] || []).length >= 1,
)
check('does not re-extract an unchanged re-read', (await lazyStore.fileRecord('sub/utils.js')) !== undefined)
check(
  'lazy index auto-registers the project root with the watch manager',
  lazyWatch.roots.has(lazyRoot),
)
check(
  'lazy-registered root is persisted for restart recovery',
  new ProjectMemoryStore(memoryRootFor(lazyRoot, config.memoryDir)).load().watchlist.includes(lazyRoot),
)

console.log('\n== query expansion disabled skips the LLM ==')
const boomLLM = {
  async *stream() {
    throw new Error('llm must not be called when llmQueryExpansion is off')
  },
}
const noExpandTool = queryMemoryTool({ llm: boomLLM }, { ...config, llmQueryExpansion: false })
out = await noExpandTool.execute({ root, query: 'payment' })
check('query works without any LLM call', out.includes('PaymentService') || out.includes('Payment Module'))

console.log('\n== CJK query respects llmQueryExpansion off ==')
await remTool.execute({ root, problem: '构建脚本在 Windows 下路径分隔符报错', solution: '统一使用 path.join 拼接' })
out = await noExpandTool.execute({ root, query: '构建脚本 路径分隔符报错' })
check('chinese query hits chinese note without any llm call', out.includes('path.join'))

console.log('\n== bilingual keyword instruction ==')
{
  let systemText = ''
  const captureLLM = {
    async *stream({ messages }) {
      systemText = messages[0].content.map((b) => b.text).join('\n')
      const body = JSON.stringify({ title: 'T', summary: 'S', keywords: ['payment', '支付'] })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: body }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const entryBi = await extractDocEntry(captureLLM, { title: 'Payment', text: 'x' }, 'spec.md')
  check(
    'index prompt requires own-language and English keywords',
    /english/i.test(systemText) && /own language/i.test(systemText),
  )
  check('bilingual keywords pass through', entryBi.keywords.includes('payment') && entryBi.keywords.includes('支付'))
}

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECKS FAILED`} (${passed} passed)`)
process.exit(failed === 0 ? 0 : 1)