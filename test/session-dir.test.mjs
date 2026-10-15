// 会话「当前工作目录」兼容层的测试：node test/session-dir.test.mjs
//
// 背景：dsh 0.2.1 把当前执行目录从 `Session.header.cwd` 拆到了
// `@deepseek-ai/dsh-working-directory` 服务。本插件的全部根解析（索引/检索/懒索引/
// 审计注入/任务桥）都必须跟着这条新权威走，否则用户 `working_directory({cd})` 之后
// 记忆仍落在原项目的 store 上——**不报错，只是静默错根**，所以这里把每条取值路径钉死。
import assert from 'node:assert/strict'
import { sessionWorkingDir } from '../src/util/session-dir.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

/** 造一个宿主 ctx 替身：只有 workingDirectory 一个服务。 */
const hostWith = (dir) => ({ get: (name) => (name === 'workingDirectory' ? { get: () => dir } : undefined) })

// ---- 1. 0.2.1+：服务值优先于 header.cwd（cd 之后两者不同） ----
{
  const session = { id: 's1', header: { cwd: '/orig' } }
  const agent = { session, ctx: hostWith('/moved') }
  assert.equal(sessionWorkingDir(session, { agent }), '/moved')
  ok('0.2.1+：按 workingDirectory 投影取值（cd 后不再是 header.cwd）')
}

// ---- 2. 老宿主：没有该服务 → 回退 header.cwd，行为与升级前逐字一致 ----
{
  const session = { id: 's1', header: { cwd: '/orig' } }
  const agent = { session, ctx: { get: () => undefined } }
  assert.equal(sessionWorkingDir(session, { agent }), '/orig')
  ok('老宿主：服务缺失回退 header.cwd（升级前行为不变）')
}

// ---- 3. 只有 ctx 的路径（任务桥 onSessionEvent 拿不到 agent） ----
{
  const session = { id: 's1', header: { cwd: '/orig' } }
  assert.equal(sessionWorkingDir(session, { ctx: hostWith('/moved') }), '/moved')
  ok('只有 ctx 的调用点（任务桥）也能读到当前目录')
}

// ---- 4. 服务存在但 get 抛错（session 不是宿主认识的 Session）→ 回退，不得带崩调用方 ----
{
  const session = { id: 's1', header: { cwd: '/orig' } }
  const agent = { session, ctx: { get: () => ({ get: () => { throw new Error('not a Session') } }) } }
  assert.equal(sessionWorkingDir(session, { agent }), '/orig')
  ok('服务抛错时回退 header.cwd（软依赖不得带崩审计/注入）')
}

// ---- 5. ctx.get 本身被拒 / 根本没有 ctx ----
{
  const session = { id: 's1', header: { cwd: '/orig' } }
  const denied = { get: () => { throw new Error('denied') } }
  assert.equal(sessionWorkingDir(session, { agent: { session, ctx: denied } }), '/orig')
  assert.equal(sessionWorkingDir(session, {}), '/orig')
  ok('ctx.get 被拒 / 根本没有 ctx 时同样回退')
}

// ---- 6. 空输入不抛（审计与懒索引都在旁路里调它） ----
{
  assert.equal(sessionWorkingDir(null, {}), undefined)
  assert.equal(sessionWorkingDir(undefined), undefined)
  assert.equal(sessionWorkingDir({}, {}), undefined)
  assert.equal(sessionWorkingDir('not-a-session', {}), undefined)
  ok('空输入/畸形输入返回 undefined 且不抛')
}

// ---- 7. 服务返回空值时不采纳，继续回退 ----
{
  const session = { id: 's1', header: { cwd: '/orig' } }
  const agent = { session, ctx: hostWith('') }
  assert.equal(sessionWorkingDir(session, { agent }), '/orig')
  ok('服务返回空串时不采纳，仍回退 header.cwd')
}

// ---- 8. 不传 session 时用 agent.session ----
{
  const session = { id: 's1', header: { cwd: '/orig' } }
  assert.equal(sessionWorkingDir(undefined, { agent: { session } }), '/orig')
  ok('不传 session 时用 agent.session')
}

// ---- 9. 服务给出目录时，header.cwd 缺失也能拿到（不依赖 header 存在） ----
{
  const session = { id: 's1' }
  assert.equal(sessionWorkingDir(session, { ctx: hostWith('/launch-default') }), '/launch-default')
  ok('header.cwd 缺失时服务值仍可用（等价于旧的 process.cwd() 兜底角色）')
}

console.log(`\nsession-dir tests: ${passed} passed`)
