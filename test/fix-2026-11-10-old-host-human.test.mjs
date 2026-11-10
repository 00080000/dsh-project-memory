// 审计缺陷 #23 回归：node test/fix-2026-11-10-old-host-human.test.mjs
//
// 老宿主 / 测试里的 `user/message` 没有 `source`，taskbridge 只认
// `source.kind === 'user'`，于是真人消息既不记 firstHuman 也不刷新 lastHumanAt；
// 而 auto-inject 的 lastUserText() 把「role=user 且（kind==='user' 或无 source）」
// 当人话。两侧判据必须一致，否则任务卡的「模型自维护不回声」判断会永远停在旧值。
//
// 这里同时钉住现有语义：文本为空仍刷新 lastHumanAt；firstHuman 只在首次有文本时写入；
// 非人类来源（agent-message / 本插件注入 / assistant role）一律不动戳记。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProjectMemoryStore } from '../src/store.js'
import { onSessionEvent } from '../src/setup/taskbridge.js'
import { SOURCE_KIND } from '../src/auto-inject.js'

const config = { memoryDir: '.dsh-project-memory', tasklist: { enabled: true } }
const BASELINE = '2026-01-01T00:00:00.000Z'
const roots = []
let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

/** 新建一个独立项目根并把 t1 绑定到 sessionId；任务预先带一个旧戳记便于断言"没动"。 */
function newProject(sessionId) {
  const root = mkdtempSync(path.join(tmpdir(), 'pm-old-host-'))
  roots.push(root)
  const store = new ProjectMemoryStore(path.join(root, '.dsh-project-memory')).load()
  store.commit((s) => {
    s.addTask({
      id: 't1',
      title: 'T',
      steps: [],
      files: [],
      archived: false,
      createdAt: BASELINE,
      updatedAt: BASELINE,
      lastActiveAt: BASELINE,
      lastHumanAt: BASELINE,
    })
    s.setBinding(sessionId, 't1')
  })
  return { root, store, meta: new Map(), session: { id: sessionId, header: { cwd: root } } }
}

/** 造一条 user/message：source / role 只在显式给出时才存在（模拟老宿主缺字段）。 */
function ev({ text = 'hello', source, role } = {}) {
  const data = { content: [{ type: 'text', text }] }
  if (source !== undefined) data.source = source
  if (role !== undefined) data.role = role
  return { type: 'user/message', data }
}

try {
  // 1. 老宿主：没有 source 的人类消息 → firstHuman 与 lastHumanAt 都更新（缺陷本体）
  {
    const p = newProject('s1')
    onSessionEvent(config, p.session, ev({ text: 'hello' }), p.meta, null)
    assert.equal(p.meta.get('s1')?.firstHuman, 'hello', '无 source 的人类消息应记 firstHuman')
    assert.notEqual(p.store.getTask('t1').lastHumanAt, BASELINE, '无 source 的人类消息应刷新 lastHumanAt')
    assert.notEqual(p.store.getTask('t1').lastHumanAt, undefined)
    ok('无 source 的老宿主人类消息 → firstHuman / lastHumanAt 都更新')
  }

  // 2. 新宿主显式 kind:'user' → 仍然更新（不回归）
  {
    const p = newProject('s2')
    onSessionEvent(config, p.session, ev({ text: 'hello', source: { kind: 'user' } }), p.meta, null)
    assert.equal(p.meta.get('s2')?.firstHuman, 'hello')
    assert.notEqual(p.store.getTask('t1').lastHumanAt, BASELINE)
    ok("source.kind === 'user' → 更新")

  // 2b. 空字符串 kind 与缺 kind 同义：auto-inject 的判据是 `if (kind && kind !== 'user')`。
  {
    const p = newProject('s2b')
    onSessionEvent(config, p.session, ev({ text: 'hello', source: { kind: '' } }), p.meta, null)
    assert.equal(p.meta.get('s2b')?.firstHuman, 'hello')
    assert.notEqual(p.store.getTask('t1').lastHumanAt, BASELINE)
    ok("source.kind === '' 与缺 kind 同义 → 更新")
  }
  }

  // 3. 子代理消息不是人话 → 不更新
  {
    const p = newProject('s3')
    onSessionEvent(config, p.session, ev({ text: '子代理报告', source: { kind: 'agent-message' } }), p.meta, null)
    assert.equal(p.meta.get('s3'), undefined, '非人类来源不得写 firstHuman')
    assert.equal(p.store.getTask('t1').lastHumanAt, BASELINE, '非人类来源不得刷新 lastHumanAt')
    ok("source.kind === 'agent-message' → 不更新")
  }

  // 4. role 不是 user（如 assistant）→ 不更新，即便没有 source
  {
    const p = newProject('s4')
    onSessionEvent(config, p.session, ev({ text: '模型的话', role: 'assistant' }), p.meta, null)
    assert.equal(p.meta.get('s4'), undefined)
    assert.equal(p.store.getTask('t1').lastHumanAt, BASELINE)
    ok('role 非 user（assistant）→ 不更新')
  }

  // 5. 本插件注入的 kind（也是 role=user）→ 不更新；迁移前 { plugin } 旧形状同样排除
  {
    const p = newProject('s5')
    onSessionEvent(config, p.session, ev({ text: '[Memory Inject] 任务卡', source: { kind: SOURCE_KIND } }), p.meta, null)
    assert.equal(p.meta.get('s5'), undefined, '本插件注入不得记 firstHuman')
    assert.equal(p.store.getTask('t1').lastHumanAt, BASELINE, '本插件注入不得刷新 lastHumanAt')

    onSessionEvent(config, p.session, ev({ text: '[Memory Inject] 旧形状', source: { plugin: 'dsh-project-memory' } }), p.meta, null)
    assert.equal(p.store.getTask('t1').lastHumanAt, BASELINE, '迁移前旧形状（无 kind）也不得刷新')
    ok('本插件注入 kind（含旧 { plugin } 形状）→ 不更新')
  }

  // 6. 语义保持：空文本仍是人类消息 → 刷新 lastHumanAt，但不写 firstHuman
  {
    const p = newProject('s6')
    onSessionEvent(config, p.session, ev({ text: '   ' }), p.meta, null)
    assert.equal(p.meta.get('s6')?.firstHuman, undefined, '空文本不得写 firstHuman')
    assert.notEqual(p.store.getTask('t1').lastHumanAt, BASELINE, '空文本仍要刷新 lastHumanAt（现有语义）')
    ok('空文本：刷新 lastHumanAt、不写 firstHuman（语义不变）')
  }
} finally {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响断言结果 */
    }
  }
}

console.log(`\nold-host human message tests: ${passed} passed`)
