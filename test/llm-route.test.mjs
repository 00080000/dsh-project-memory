// 召回期可选 LLM 的路由测试（索引期零 LLM 见 test/doc-index.test.mjs）
//   node test/llm-route.test.mjs
import assert from 'node:assert/strict'
import { chatText, expandQuery } from '../src/llm.js'
import { resolveRoute, rememberRoute, resetRouteState, degradedList } from '../src/llm-route.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const ROUTE = { provider: 'deepseek', model: 'deepseek-flash' }

function strictLLM(seen, body = JSON.stringify(['payment', 'fees', '支付费用'])) {
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

// ---- 1. chatText 必须把 provider/model 交给宿主 ----
{
  resetRouteState()
  const seen = []
  const text = await chatText(strictLLM(seen, 'hello'), 'sys', 'user', { route: ROUTE })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].provider, ROUTE.provider)
  assert.equal(seen[0].model, ROUTE.model)
  assert.equal(text, 'hello')
  ok('chatText 透传 provider/model（宿主不再抛 NO_ADAPTER）')
}

// ---- 2. chatText 缺路由时显式失败（不静默） ----
{
  const seen = []
  await assert.rejects(() => chatText(strictLLM(seen), 'sys', 'user', {}), /provider\/model route/)
  assert.equal(seen.length, 0)
  ok('chatText 无路由时显式抛错，不尝试裸调用')
}

// ---- 3. expandQuery：有路由走 LLM，无路由返回原查询 ----
{
  resetRouteState()
  const seen = []
  const variants = await expandQuery(strictLLM(seen), 'payment fees', 6, { route: ROUTE })
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

// ---- 4. resolveRoute 优先级 / request-header hint ----
{
  resetRouteState()
  const execSession = { agent: { session: { requestHeader: () => ({ config: { provider: 'sp', model: 'sm' } }) } } }
  const configured = resolveRoute(execSession, { llm: { provider: 'cfgp', model: 'cfgm' } })
  assert.equal(configured.provider, 'cfgp')
  assert.equal(configured.source, 'config')
  assert.equal(resolveRoute(execSession, {}).provider, 'sp')
  assert.equal(resolveRoute({ agent: { options: { provider: 'ap', model: 'am' } } }, {}).provider, 'ap')
  assert.equal(resolveRoute(undefined, { llm: { provider: 'only-provider' } }), null, '半配置不算路由')

  rememberRoute({ requestHeader: () => ({ config: { provider: 'hp', model: 'hm' } }) })
  const hinted = resolveRoute(undefined, {})
  assert.equal(hinted.provider, 'hp')
  assert.equal(hinted.source, 'session-hint')
  ok('resolveRoute：config > 会话 > agent options > request/header hint')
}

console.log(`\nllm-route tests: ${passed} passed`)
