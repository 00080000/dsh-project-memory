// D4 回归测试（PLAN-v0.6.0 附录 C 步骤 1/3 + §2.5 H2）
// 覆盖：辅助 LLM 调用必须带 provider/model 路由；拿不到路由时明确走非 LLM 回退并记 degraded，
//       而不是调用宿主后 catch 掉 NO_ADAPTER（修前那条路径从未生效，见附录 A.3）。
//   node test/llm-route.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { chatText, extractDocEntry, expandQuery } from '../src/llm.js'
import { resolveRoute, rememberRoute, resetRouteState, degradedList } from '../src/llm-route.js'
import { buildDocEntries } from '../src/doc-pipeline.js'
import { indexDocTool } from '../src/tools/index-doc.js'
import { ProjectMemoryStore } from '../src/store.js'
import { memoryRootFor } from '../src/util/fs.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const ROUTE = { provider: 'deepseek', model: 'deepseek-flash' }

/**
 * 严格宿主 stub：provider/model 缺失即抛 NO_ADAPTER（复刻 LlmRuntime 行为），
 * 齐全时返回给定的 JSON 文本。记录每次收到的 options。
 */
function strictLLM(seen, body = JSON.stringify({ title: 'Routed Summary', summary: 'Routed summary body.', blindSpots: '未覆盖：部署细节', keywords: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'] })) {
  return {
    async *stream(options) {
      seen.push(options)
      if (!options?.provider || !options?.model) {
        const err = new Error('NO_ADAPTER: no adapter registered for provider "undefined"')
        err.code = 'NO_ADAPTER'
        throw err
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: body }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

const CHUNK = { title: 'Payment', text: 'Payment module handles fees under 1%.' }

// ---- 1. chatText 必须把 provider/model 交给宿主 ----
{
  resetRouteState()
  const seen = []
  const text = await chatText(strictLLM(seen), 'sys', 'user', { route: ROUTE })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].provider, ROUTE.provider)
  assert.equal(seen[0].model, ROUTE.model)
  assert.ok(text.includes('Routed Summary'))
  ok('chatText 透传 provider/model（宿主不再抛 NO_ADAPTER）')
}

// ---- 2. chatText 缺路由时显式失败（不静默） ----
{
  const seen = []
  await assert.rejects(() => chatText(strictLLM(seen), 'sys', 'user', {}), /provider\/model route/)
  assert.equal(seen.length, 0)
  ok('chatText 无路由时显式抛错，不尝试裸调用')
}

// ---- 3. extractDocEntry：有路由 → LLM 形状（修前这里退化成 fallback 指纹） ----
{
  resetRouteState()
  const seen = []
  const entry = await extractDocEntry(strictLLM(seen), CHUNK, 'spec.md', { route: ROUTE })
  assert.equal(entry.title, 'Routed Summary')
  assert.equal(entry.blindSpots, '未覆盖：部署细节')
  assert.equal(entry.keywords.length, 6)
  assert.equal(seen[0].provider, ROUTE.provider)
  ok('extractDocEntry 有路由：blindSpots 非空 + keywords > 5（LLM 指纹）')
}

// ---- 4. extractDocEntry：无路由 → 截断 fallback + degraded，且不调用宿主 ----
{
  resetRouteState()
  const seen = []
  const entry = await extractDocEntry(strictLLM(seen), CHUNK, 'spec.md')
  assert.equal(entry.blindSpots, '')
  assert.deepEqual(entry.keywords, ['payment'])
  assert.equal(seen.length, 0, '拿不到路由时不应尝试裸调用 LLM')
  assert.ok(degradedList().some((d) => d.code === 'llm.doc.no-route'))
  ok('extractDocEntry 无路由：显式 fallback + degraded 记录（修前是静默 catch）')
}

// ---- 5. expandQuery：有路由走 LLM，无路由返回原查询 ----
{
  resetRouteState()
  const seen = []
  const variants = await expandQuery(strictLLM(seen, JSON.stringify(['payment', 'fees', '支付费用'])), 'payment fees', 6, { route: ROUTE })
  assert.deepEqual(variants, ['payment', 'fees', '支付费用'])
  assert.equal(seen[0].model, ROUTE.model)

  resetRouteState()
  const seen2 = []
  const raw = await expandQuery(strictLLM(seen2), 'payment fees', 6)
  assert.deepEqual(raw, ['payment fees'])
  assert.equal(seen2.length, 0)
  assert.ok(degradedList().some((d) => d.code === 'llm.expand.no-route'))
  ok('expandQuery：有路由展开，无路由原样返回 + degraded')
}

// ---- 6. resolveRoute 优先级 / 后台 hint ----
{
  resetRouteState()
  const execSession = { agent: { session: { requestHeader: () => ({ config: { provider: 'sp', model: 'sm' } }) } } }
  assert.deepEqual(
    { provider: resolveRoute(execSession, { llm: { provider: 'cfgp', model: 'cfgm' } }).provider, source: resolveRoute(execSession, { llm: { provider: 'cfgp', model: 'cfgm' } }).source },
    { provider: 'cfgp', source: 'config' },
  )
  assert.equal(resolveRoute(execSession, {}).provider, 'sp')
  assert.equal(resolveRoute({ agent: { options: { provider: 'ap', model: 'am' } } }, {}).provider, 'ap')
  assert.equal(resolveRoute(undefined, { llm: { provider: 'only-provider' } }), null, '半配置不算路由')

  rememberRoute({ requestHeader: () => ({ config: { provider: 'hp', model: 'hm' } }) })
  const hinted = resolveRoute(undefined, {})
  assert.equal(hinted.provider, 'hp')
  assert.equal(hinted.source, 'session-hint')
  ok('resolveRoute：config > 会话 > agent options > request/header hint')
}

// ---- 7. buildDocEntries 把路由透传到每个 chunk ----
{
  resetRouteState()
  const root = mkdtempSync(path.join(tmpdir(), 'pm-route-'))
  const md = path.join(root, 'doc.md')
  writeFileSync(md, '# A\n\nalpha body\n\n# B\n\nbeta body\n')
  const seen = []
  const entries = await buildDocEntries(strictLLM(seen), 'doc.md', md, { chunkChars: 3000, maxChunks: 40, maxFileSizeMb: 50, maxPdfPages: 10, route: ROUTE })
  assert.equal(entries.length, 2)
  assert.ok(entries.every((e) => e.blindSpots === '未覆盖：部署细节'))
  assert.ok(seen.every((o) => o.provider === ROUTE.provider && o.model === ROUTE.model))
  ok('buildDocEntries 逐 chunk 带上 provider/model')
}

// ---- 8. 端到端干净复现：index_doc 经会话路由产出 LLM 形状条目 ----
{
  resetRouteState()
  const root = mkdtempSync(path.join(tmpdir(), 'pm-d4-'))
  mkdirSync(path.join(root, 'docs'), { recursive: true })
  const md = path.join(root, 'docs', 'spec.md')
  writeFileSync(md, '# Overview\n\nPayments end to end.\n')
  const seen = []
  const config = { memoryDir: '.dsh-project-memory', chunkChars: 3000, maxChunksPerFile: 40, maxFileSizeMb: 50, maxPdfPages: 10, maxOutputChars: 8000 }
  const tool = indexDocTool({ llm: strictLLM(seen) }, config)
  const exec = { agent: { session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-flash' } }) } } }
  await tool.execute({ file_path: md, root }, exec)

  const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
  const doc = store.allEntries().find((e) => e.type === 'doc')
  assert.ok(doc, 'doc entry written')
  assert.equal(doc.title, 'Routed Summary')
  assert.equal(doc.blindSpots, '未覆盖：部署细节')
  assert.ok(doc.keywords.length > 5)
  ok('干净复现：index_doc 走会话路由 → blindSpots 非空 + keywords > 5（修前必失败）')
}

// ---- 9. 无会话且无配置的 index_doc：非 LLM 回退 + 可见 degraded ----
{
  resetRouteState()
  const root = mkdtempSync(path.join(tmpdir(), 'pm-d4-noroute-'))
  const md = path.join(root, 'spec.md')
  writeFileSync(md, '# Overview\n\nPayments end to end.\n')
  const config = { memoryDir: '.dsh-project-memory', chunkChars: 3000, maxChunksPerFile: 40, maxFileSizeMb: 50, maxPdfPages: 10, maxOutputChars: 8000 }
  const seen = []
  const tool = indexDocTool({ llm: strictLLM(seen) }, config)
  await tool.execute({ file_path: md, root })
  const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
  const doc = store.allEntries().find((e) => e.type === 'doc')
  assert.equal(doc.blindSpots, '')
  assert.equal(seen.length, 0)
  assert.ok(degradedList().some((d) => d.code === 'llm.doc.no-route'))
  ok('无会话无配置：index_doc 走非 LLM 回退并留下 degraded（不静默）')
}

console.log(`\nllm-route tests: ${passed} passed`)
