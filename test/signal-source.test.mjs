// 信号源回归（2026-10-25）：node test/signal-source.test.mjs
//
// 这一组全部来自一次真实会话的审计（作者在插件仓库里跑 30–40 分钟审计，含 4 个子代理）：
//   - 17 次注入 / 8,654 字符，可判定与本步任务无关的 6.2k（72%）；
//   - `find … bench …` → run-bench×4（1777 字符）；
//   - 子代理提示词里的"删除/迁移" → 父会话 file-delete/migrate 连续 8 步；
//   - 子代理报告里的"发布/渲染" → intent:release（1050 字符）/ intent:渲染（1200 字符）。
//
// 验收面故意做成"端到端 + 可判定失败"：真的装 pre-step 监听、真的落 shadow 日志，
// 断言的是注入正文与影子记录的字段，而不是内部函数返回值。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { installAutoInject, isOwnInjection } from '../src/auto-inject.js'
import { shadowFileFor } from '../src/audit.js'
import { GlobalStore } from '../src/insight-store.js'
import { textOf } from '../src/util/text.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const dir = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'signal-'))
  writeFileSync(path.join(d, 'package.json'), '{}')
  return d
}

/** 宿主桩：同时收 agent/pre-step 与 session/event（旧测试桩只收前者，正好漏掉本次修的路径）。 */
function harness({ items = [] } = {}) {
  const root = dir()
  const globalFile = path.join(dir(), 'global.json')
  const gs = new GlobalStore(globalFile).load()
  gs.doc.items.push(...items)
  gs.commit(() => 0)
  let pre = null
  let onEvent = null
  const ctx = {
    on: (event, fn) => {
      if (event === 'agent/pre-step') pre = fn
      if (event === 'session/event') onEvent = fn
    },
  }
  installAutoInject(ctx, { memoryDir: '.dsh-project-memory', autoContext: { enabled: true }, insight: { globalFile } })
  assert.ok(pre && onEvent, '两个监听器都必须装上')
  const session = { id: 'sessSignal', header: { cwd: root } }
  const step = async (messages) => {
    const decision = await pre({ agent: { session }, messages }, async () => ({ kind: 'enter', messages }))
    const blocks = decision.messages.filter((m) => isOwnInjection(m.source)).map((m) => textOf(m))
    const shadowPath = shadowFileFor(path.join(root, '.dsh-project-memory'))
    const line = readFileSync(shadowPath, 'utf8').trim().split('\n').at(-1)
    return { text: blocks.join('\n'), shadow: JSON.parse(line) }
  }
  return { root, session, onEvent, step }
}

const human = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
const notice = (kind, text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind } } })

// --- 1. 通知不是人话：会话中段没有真人消息时，意图回退到本会话最后一条真人消息 ---
{
  const h = harness({
    items: [
      { id: 'ins_refactor', kind: 'lesson', scope: 'global', title: '重构注入引擎时的注意事项', fix: '先跑标注集', trigger: { when: { intents: ['重构'] } }, confidence: 1, archived: false },
      { id: 'ins_purge', kind: 'procedure', scope: 'global', title: '误删文件后的恢复顺序', steps: ['1'], trigger: { when: { ops: ['file-delete'] } }, confidence: 1, archived: false },
    ],
  })
  // 回合开始：真人说了"重构"
  h.onEvent(h.session, human('我们来重构注入引擎'))
  // 本步 delta 里只有子代理报告与 job 通知，没有真人消息
  h.onEvent(h.session, notice('agent-message', '子代理报告：发布、渲染、删除文件都做完了。'))
  const relay = { role: 'user', source: { kind: 'agent-message' }, content: [{ type: 'text', text: '子代理报告：发布、渲染、删除文件都做完了。' }] }
  const { text, shadow } = await h.step([relay])

  assert.ok(text.includes('重构注入引擎时的注意事项'), `意图应回退到真人消息；实际注入：${JSON.stringify(text.slice(0, 200))}`)
  assert.ok(!text.includes('误删文件后的恢复顺序'), '通知里的"删除"不得触发 file-delete')
  assert.equal(shadow.querySource, 'session', 'query 应标注来自会话缓存，而不是本步 delta')
  assert.ok(shadow.query.includes('重构'), `影子记录里的 query 应是真人消息：${shadow.query}`)
  ok('通知 / relay 不再冒充人类意图；意图回退到本会话最后一条真人消息')
}

// --- 2. subagent 的参数不参与动作判定（它曾经让父会话连吃 8 步 file-delete/migrate） ---
{
  const h = harness({
    items: [
      { id: 'ins_purge', kind: 'procedure', scope: 'global', title: '误删文件后的恢复顺序', steps: ['1'], trigger: { when: { ops: ['file-delete'] } }, confidence: 1, archived: false },
      { id: 'ins_migrate', kind: 'procedure', scope: 'global', title: '数据库迁移前的备份', steps: ['1'], trigger: { when: { ops: ['migrate'] } }, confidence: 1, archived: false },
    ],
  })
  h.onEvent(h.session, human('帮我审计这个插件的召回链路'))
  h.onEvent(h.session, {
    type: 'tool/call',
    data: { name: 'subagent', arguments: '{"prompt":"修复删除后的悬空状态，并处理 localStorage 版本迁移"}' },
  })
  const { text, shadow } = await h.step([{ role: 'user', source: { kind: 'agent-message' }, content: [{ type: 'text', text: '子代理已结束' }] }])

  assert.deepEqual(shadow.ops, [], 'subagent 参数不得产生 op')
  assert.ok(!text.includes('误删文件'), 'subagent 提示词里的"删除"不得触发恢复 procedure')
  assert.ok(!text.includes('数据库迁移'), 'subagent 提示词里的"迁移"不得触发迁移 procedure')
  ok('subagent / 其它工具的参数不再变成父会话的动作')
}

// --- 3. 目录名 / grep pattern 不是动作：`find … bench …` 不得变成 run-bench ---
{
  const h = harness({
    items: [
      { id: 'ins_bench', kind: 'procedure', scope: 'global', title: '性能基线的跑法', steps: ['1'], trigger: { when: { ops: ['run-bench'] } }, confidence: 1, archived: false },
    ],
  })
  h.onEvent(h.session, { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"find src client test scripts bench docs -type f | head -100"}' } })
  const { text, shadow } = await h.step([{ role: 'user', source: { kind: 'tool-jobs' }, content: [{ type: 'text', text: 'job finished' }] }])

  assert.deepEqual(shadow.ops, ['shell-run'], `目录名 bench 不得产生 run-bench：${JSON.stringify(shadow.ops)}`)
  assert.ok(!text.includes('性能基线的跑法'), '不得注入基准 procedure')
  ok('命令里的路径 / pattern 不再是动作')
}

// --- 4. 真人消息里的"删除"仍只进 intentOps（遥测可见），但不触发全文注入 ---
{
  const h = harness({
    items: [
      { id: 'ins_purge', kind: 'procedure', scope: 'global', title: '误删文件后的恢复顺序', steps: ['1'], trigger: { when: { ops: ['file-delete'] } }, confidence: 1, archived: false },
    ],
  })
  h.onEvent(h.session, human('清理一下 README 的措辞，把过时的段落删掉'))
  const { text, shadow } = await h.step([{ role: 'user', source: { kind: 'tool-jobs' }, content: [{ type: 'text', text: 'job finished' }] }])

  assert.deepEqual(shadow.ops, [], '散文里的删除不得进 ops')
  assert.ok(shadow.opsIntent.includes('file-delete'), `但要留在 opsIntent 里供离线重放：${JSON.stringify(shadow.opsIntent)}`)
  assert.ok(!text.includes('误删文件'), '不得因为"清理措辞"注入 1200 字符的恢复 procedure')
  ok('散文动作词分级：记录但不触发')
}

// --- 5. 迁移前 `{ plugin }` 形状的自注入不得被当成人类消息 ---
// `isOwnInjection()` 认这个旧形状（没有 kind）；observer 只判 kind 会把它塞进 humanText，
// 下一步就拿注入正文当 query 再检索（自激）。
{
  const h = harness({
    items: [
      { id: 'ins_commit', kind: 'lesson', scope: 'global', title: '提交前先跑测试', fix: 'npm test', trigger: { when: { ops: ['git-commit'] } }, confidence: 1, archived: false },
    ],
  })
  h.onEvent(h.session, {
    type: 'user/message',
    data: {
      content: [{ type: 'text', text: 'git commit 之前要小心' }],
      source: { plugin: 'dsh-project-memory' }, // 迁移前内存里的旧形状：没有 kind
    },
  })
  const { text, shadow } = await h.step([{ role: 'user', source: { kind: 'tool-jobs' }, content: [{ type: 'text', text: 'job finished' }] }])

  assert.equal(shadow.querySource, 'none', '自注入不得成为会话意图')
  assert.equal(shadow.query, '', `自注入正文不得被当成 query：${JSON.stringify(shadow.query)}`)
  assert.ok(!text.includes('提交前先跑测试'), '不得因为自己的注入块触发全文注入')
  ok('旧 source 形状的自注入不进入 humanText')
}

console.log(`\nsignal-source tests: ${passed} passed`)
