// 审计 #17 回归：编辑/合并正文后 must 重算 triggerDerived，旧派生词不得继续参与提示通道召回。
//   node test/fix-2026-11-10-trigger-derived-refresh.test.mjs
//
// 语义：派生源（MERGE_FIELDS + steps，即 deriveTrigger 实际读取的字段）真的变了才重算；
// 只改元数据（confidence/files/tags/hitCount/lastHitAt）不重算；作者手写的 trigger 永不被动；
// 重算结果三个数组全空时**删除** triggerDerived —— 宁可不召回，也不用过期词召回。
import assert from 'node:assert/strict'

import { applyUpdate, mergeInto, normalizeInsight } from '../src/insight-store.js'
import { backfillDerivedTriggers, deriveTrigger } from '../src/readiness.js'
import { insightToEntry } from '../src/recall.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const mk = (raw) => normalizeInsight(raw, { scope: 'project', source: 'agent' })
const NOW = '2026-11-10T00:00:00.000Z'

// 1) applyUpdate 改标题/fix → 新关键词出现、旧关键词消失；authored trigger 原样保留。
{
  const it = mk({ title: '旧标题', kind: 'lesson', pattern: '旧坑', fix: '旧改法' })
  const authored = { when: { ops: ['git-push'] }, prevents: '手写注入面不能被派生逻辑改写' }
  it.trigger = authored
  it.triggerDerived = { keywords: ['旧坑'], actions: [], paths: [] }

  const replaced = applyUpdate(it, { title: '提交前先删除旧构建产物', fix: '删除 build 目录后重新提交，README 同步' })

  assert.ok(replaced.includes('title') && replaced.includes('fix'))
  assert.ok(it.triggerDerived, '正文改了就必须重新派生')
  assert.deepEqual(it.triggerDerived.keywords, ['提交', '删除', '构建', 'README'])
  assert.deepEqual(it.triggerDerived.actions, ['git-commit', 'delete'])
  assert.ok(!it.triggerDerived.keywords.includes('旧坑'), '旧派生词必须消失')
  assert.deepEqual(it.triggerDerived, deriveTrigger(it), '派生结果必须与 deriveTrigger 一致')
  assert.deepEqual(it.trigger, authored, 'authored trigger 不能被重算或覆盖')
  // 提示通道的检索词立刻用新词、不再含旧词。
  const entry = insightToEntry(it)
  assert.ok(entry.keywords.includes('提交') && entry.keywords.includes('delete'))
  assert.ok(!entry.keywords.includes('旧坑'))
  ok('applyUpdate：改标题/fix 后刷新派生词，旧词不再进召回')
}

// 2) mergeInto 合并新正文 → 同样刷新（旧关键词消失、新关键词与动作出现）。
{
  const it = mk({ title: '发布流程', kind: 'lesson', body: '发布到 npm 前先打 tag' })
  const authored = { when: { intents: ['deploy'] } }
  it.trigger = authored
  it.triggerDerived = { keywords: ['发布'], actions: ['npm-publish'], paths: ['scripts/release.mjs'] }

  const { replaced } = mergeInto(it, { title: '迁移后重新提交', body: '迁移 build 脚本后删除旧产物，再提交 README' }, {}, NOW)

  assert.ok(replaced.includes('title') && replaced.includes('body'))
  assert.deepEqual(it.triggerDerived.keywords, ['提交', '迁移', '删除', 'README'])
  assert.deepEqual(it.triggerDerived.actions, ['git-commit', 'delete', 'migrate'])
  assert.ok(!it.triggerDerived.keywords.includes('发布'))
  assert.ok(!it.triggerDerived.actions.includes('npm-publish'))
  assert.deepEqual(it.triggerDerived, deriveTrigger(it))
  assert.deepEqual(it.trigger, authored, 'authored trigger 不能被合并逻辑连带重算')
  assert.equal(it.hitCount, 1, '元数据照常记账')
  assert.equal(it.lastHitAt, NOW)
  ok('mergeInto：合并新正文后刷新派生词，旧词不再进召回')
}

// 3) 只改元数据（confidence / files / tags / hitCount）→ 不重算，哨兵值原样保留。
{
  const it = mk({ title: '发布流程', fix: '发布前跑测试' })
  const sentinel = { keywords: ['哨兵派生词'], actions: [], paths: [] }
  it.triggerDerived = sentinel
  applyUpdate(it, { confidence: 0.93 })
  assert.strictEqual(it.triggerDerived, sentinel, '只改 confidence 不能重算')
  applyUpdate(it, { title: it.title }) // 同值写入也不是正文变更
  assert.strictEqual(it.triggerDerived, sentinel, '同值写入不能重算')
  ok('applyUpdate：confidence/同值写入不触发重算')
}
{
  const it = mk({ title: '发布流程', fix: '发布前跑测试' })
  const sentinel = { keywords: ['哨兵派生词'], actions: [], paths: [] }
  it.triggerDerived = sentinel
  mergeInto(it, { files: ['src/recall.js'], tags: ['npm'], confidence: 0.4, sourceTaskIds: ['t1'] }, {}, NOW)
  assert.strictEqual(it.triggerDerived, sentinel, '只并 files/tags/sourceTaskIds 不能重算')
  assert.equal(it.hitCount, 1)
  assert.deepEqual(it.files, ['src/recall.js'])
  ok('mergeInto：只并元数据不触发重算')
}

// 4) 切 kind 清掉旧正文字段（prune）后派生词跟着正文走，authored trigger 仍不动。
{
  const it = mk({ title: '发布', kind: 'lesson', pattern: '旧坑', fix: '删除缓存' })
  const authored = { when: { ops: ['file-delete'] } }
  it.trigger = authored
  it.triggerDerived = deriveTrigger(it)
  assert.ok(it.triggerDerived.keywords.includes('删除'))

  applyUpdate(it, { kind: 'decision', choice: '改用新的清理方式', reason: '旧 fix 已失效' })

  assert.equal(it.fix, undefined, 'lesson 专属字段应被 prune')
  assert.deepEqual(it.triggerDerived.keywords, ['发布', '清理'])
  assert.deepEqual(it.triggerDerived.actions, ['delete'])
  assert.ok(!it.triggerDerived.keywords.includes('删除'), '被 prune 掉的旧正文词不能留在派生里')
  assert.deepEqual(it.trigger, authored)
  ok('applyUpdate：切 kind prune 旧正文后派生词同步')
}

// 5) 重算为空 → 删除旧 triggerDerived，且 backfill 不会把它当"缺失"重新写回过期值。
{
  const it = mk({ title: '带旧词的标题 发布', kind: 'lesson', body: '发布到 npm' })
  it.triggerDerived = { keywords: ['发布'], actions: ['npm-publish'], paths: ['src/old.js'] }
  applyUpdate(it, { title: '平平的说明', body: '一段普通正文' })
  assert.equal(it.triggerDerived, undefined)
  assert.equal('triggerDerived' in it, false, '空派生必须删除，不能留旧词')
  assert.equal(backfillDerivedTriggers({ items: [it] }), false, '空派生不应被回填复活')
  assert.equal('triggerDerived' in it, false)
  ok('applyUpdate：重算为空时清掉旧派生，回填不复活')
}
{
  const it = mk({ title: '普通标题', kind: 'lesson', body: '旧正文' })
  it.triggerDerived = { keywords: ['旧派生'], actions: [], paths: [] }
  mergeInto(it, { title: '另一个标题', body: '一段普通正文' }, {}, NOW)
  assert.equal(it.triggerDerived, undefined)
  assert.equal('triggerDerived' in it, false)
  ok('mergeInto：重算为空时清掉旧派生')
}

console.log(`\n${passed} passed`)
