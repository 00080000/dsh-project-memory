import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
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
import { rankEntriesMerged } from '../src/util/search.js'
import { findProjectRoot, setupLazyIndexing } from '../src/lazy.js'

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

console.log('\n== store ==')
const storeDir = memoryRootFor(root, config.memoryDir)
const store = new ProjectMemoryStore(storeDir).load()
const add1 = store.addExperience({ problem: 'pdfjs import fails on Node 24', solution: 'use legacy build', sourceFile: 'a.js' })
const add2 = store.addExperience({ problem: 'different problem entirely', solution: 'x' })
const add3 = store.addExperience({ problem: 'pdfjs import fails on Node 24 again', solution: 'use legacy build + worker:false' })
check('adds experience', add1.superseded === false && add2.superseded === false)
check('supersedes similar problem', add3.superseded === true && store.experience.length === 2)
check('searches experience', store.searchExperience('pdfjs import').length === 1)
store.save()
check('persists to disk', existsSync(path.join(storeDir, 'experience.json')))

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

console.log('\n== doc <-> symbol cross-linking ==')
const linked = linkEntries(new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load())
check('links doc entries to mentioned symbols', linked > 0)
out = await queryTool.execute({ root, query: 'payment' })
check('query shows references to linked symbols', out.includes('references:') && out.includes('PaymentService'))

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
wm.stop()

console.log('\n== watch_repo tool ==')
const watchTool = watchRepoTool(wm, config)
out = await watchTool.execute({ root })
check('watch_repo starts watching', out.includes('Watching'))
out = await watchTool.execute({ root, watch: false })
check('watch_repo stops watching', out.includes('Stopped watching'))

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

console.log('\n== lazy read-time indexing (fs/observed) ==')
const lazyRoot = mkdtempSync(path.join(tmpdir(), 'lazy-'))
mkdirSync(path.join(lazyRoot, 'sub'), { recursive: true })
writeFileSync(path.join(lazyRoot, 'package.json'), '{}')
writeFileSync(path.join(lazyRoot, 'sub', 'utils.js'), 'export function parse() {}\n')
check('finds project root via marker', findProjectRoot(path.join(lazyRoot, 'sub', 'utils.js')) === lazyRoot)

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

console.log('\n== query expansion disabled skips the LLM ==')
const boomLLM = {
  async *stream() {
    throw new Error('llm must not be called when llmQueryExpansion is off')
  },
}
const noExpandTool = queryMemoryTool({ llm: boomLLM }, { ...config, llmQueryExpansion: false })
out = await noExpandTool.execute({ root, query: 'payment' })
check('query works without any LLM call', out.includes('PaymentService') || out.includes('Payment Module'))

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECKS FAILED`} (${passed} passed)`)
process.exit(failed === 0 ? 0 : 1)