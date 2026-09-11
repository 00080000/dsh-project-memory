// PR 1b 反思管线测试：node test/reflection-pipeline.test.mjs
// 覆盖：默认关零 LLM、开启后写 task 草稿(source=reflect/draft)、摘要未变跳过、冷却跳过、失败静默
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { ProjectMemoryStore } from '../src/store.js'
import { reflectTaskAfter, isReflectDue, taskDigest } from '../src/reflection-pipeline.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

function llmReturning(jsonText, counter) {
  return {
    async *stream() {
      if (counter) counter.calls = (counter.calls || 0) + 1
      const body = jsonText
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: body }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

function newProject() {
  const root = mkdtempSync(path.join(tmpdir(), 'reflect-'))
  const store = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
  const now = new Date().toISOString()
  store.addTask({ id: 'tsk_r', title: '重构 auth JWT', projectRoot: root, steps: [{ content: '接 jose', status: 'in_progress' }], files: ['src/auth/jwt.ts'], archived: false, createdAt: now, updatedAt: now, lastActiveAt: now })
  store.commit(() => 0)
  return { root, store }
}

const JSON_BODY = JSON.stringify({
  lessons: [{ pattern: 'JWT 未校验 exp', fix: '用 jose 校验 exp/nbf/iss', files: ['src/auth/jwt.ts'], symbols: ['parseToken'], confidence: 0.8 }],
  decisions: [{ topic: '认证库选型', choice: 'jose', reason: 'RFC 7519 合规、零依赖', confidence: 0.9 }],
})

// D4：辅助 LLM 调用需要显式路由（真实路径来自会话 requestHeader / config.llm）
const ROUTE = { provider: 'test', model: 'test-model' }

// --- 1. 默认关：零 LLM、零写入 ---
{
  const { root, store } = newProject()
  const counter = {}
  const config = { memoryDir: '.dsh-project-memory', reflection: { enabled: false }, insight: { globalFile: path.join(root, 'global.json') } }
  const res = await reflectTaskAfter({ config, llm: llmReturning(JSON_BODY, counter), root, taskId: 'tsk_r' })
  assert.equal(res.skipped, 'disabled')
  assert.equal(counter.calls || 0, 0)
  assert.equal(store.getTask('tsk_r').insights, undefined)
  ok('默认关：零 LLM 调用、零草稿写入')
}

// --- 2. 开启：写 task 级草稿 + 进度标记 ---
{
  const { root } = newProject()
  const counter = {}
  const config = { memoryDir: '.dsh-project-memory', reflection: { enabled: true, cooldownMs: 3600000 }, insight: { globalFile: path.join(root, 'global.json') } }
  const res = await reflectTaskAfter({ config, llm: llmReturning(JSON_BODY, counter), root, taskId: 'tsk_r', reason: 'archive', route: ROUTE })
  assert.equal(res.ok, true)
  assert.equal(res.written.length, 2)
  assert.equal(counter.calls, 1)
  const store = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
  const task = store.getTask('tsk_r')
  const drafts = task.insights || []
  assert.equal(drafts.length, 2)
  const lesson = drafts.find((i) => i.kind === 'lesson')
  assert.equal(lesson.source, 'reflect')
  assert.equal(lesson.draft, true)
  assert.equal(lesson.scope, 'task')
  assert.equal(lesson.pattern, 'JWT 未校验 exp')
  assert.equal(lesson.fix, '用 jose 校验 exp/nbf/iss')
  assert.ok(task.reflection && task.reflection.lastAt)
  assert.equal(task.reflection.digest, taskDigest(task))
  ok('开启后：task 草稿(source=reflect/draft) + reflection 进度标记')
}

// --- 3. 摘要未变 → 跳过（即使无冷却命中） ---
{
  const { root } = newProject()
  const counter = {}
  const config = { memoryDir: '.dsh-project-memory', reflection: { enabled: true, cooldownMs: 0 }, insight: { globalFile: path.join(root, 'global.json') } }
  await reflectTaskAfter({ config, llm: llmReturning(JSON_BODY, counter), root, taskId: 'tsk_r', route: ROUTE })
  const again = await reflectTaskAfter({ config, llm: llmReturning(JSON_BODY, counter), root, taskId: 'tsk_r', route: ROUTE })
  assert.equal(again.skipped, 'unchanged')
  assert.equal(counter.calls, 1, '摘要未变不再调 LLM')
  const store = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
  assert.equal((store.getTask('tsk_r').insights || []).length, 2, '不重复写')
  ok('摘要未变 → 跳过，不重复调 LLM/不重复写')
}

// --- 4. 冷却：摘要变了但在 cooldownMs 内 → 跳过 ---
{
  const { root, store } = newProject()
  const counter = {}
  const config = { memoryDir: '.dsh-project-memory', reflection: { enabled: true, cooldownMs: 3600000 }, insight: { globalFile: path.join(root, 'global.json') } }
  await reflectTaskAfter({ config, llm: llmReturning(JSON_BODY, counter), root, taskId: 'tsk_r', route: ROUTE })
  store.updateTask('tsk_r', { steps: [{ content: '接 jose', status: 'completed' }, { content: '补失效 token 测试', status: 'pending' }] })
  store.commit(() => 0)
  const gate = isReflectDue(config, store.getTask('tsk_r'))
  assert.equal(gate.reason, 'cooldown')
  const res = await reflectTaskAfter({ config, llm: llmReturning(JSON_BODY, counter), root, taskId: 'tsk_r', route: ROUTE })
  assert.equal(res.skipped, 'cooldown')
  assert.equal(counter.calls, 1)
  ok('冷却：摘要已变但未过冷却期 → 跳过')
}

// --- 5. LLM 不可用/异常 → 静默跳过不抛 ---
{
  const { root } = newProject()
  const config = { memoryDir: '.dsh-project-memory', reflection: { enabled: true }, insight: { globalFile: path.join(root, 'global.json') } }
  const boom = { async *stream() { throw new Error('network down') } }
  const res = await reflectTaskAfter({ config, llm: boom, root, taskId: 'tsk_r', route: ROUTE })
  assert.equal(res.ok, false)
  assert.ok(['error', 'unparsable'].includes(res.skipped) || res.skipped === 'error')
  const res2 = await reflectTaskAfter({ config, llm: null, root, taskId: 'tsk_r' })
  assert.equal(res2.skipped, 'no-llm')
  ok('LLM 异常/缺失 → 静默跳过，不抛')
}

console.log(`\nreflection-pipeline tests: ${passed} passed`)
