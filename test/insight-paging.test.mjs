// 记忆列表排序 + 分页的宿主侧测试：node test/insight-paging.test.mjs
//
// 分页做错的方式都很安静：相邻两页重叠（同一条渲染两次 → 重复按钮）或漏条
// （用户以为"就这些"）。所以这里既钉**排序是全序**，也钉**逐页拼起来等于全量**。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { ProjectMemoryStore } from '../src/store.js'
import { GlobalStore } from '../src/insight-store.js'
import { listInsights, INSIGHT_PAGE_MAX } from '../src/commands/insight-actions.js'
import { HOST_PAGE_MAX } from '../src/client/paging.js'
import { workflowCommandDefinition } from '../src/commands/workflow.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

/**
 * 7 条 project 条目，时间戳**故意造出两处并列**：
 *  - C/D 的 updatedAt 与 createdAt 完全相同 → 只能靠 id 兜底定序；
 *  - B 与 C/D 的 updatedAt 相同但 createdAt 更早 → createdAt 是第一层兜底。
 * 期望顺序：F(12月) → C,D(9月/9月) → B(9月/8月) → G(6月) → A(5月) → E(1月)
 */
const SPEC = [
  ['ins_a', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'],
  ['ins_b', '2026-09-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'],
  ['ins_c', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
  ['ins_d', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
  ['ins_e', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
  ['ins_f', '2026-12-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z'],
  ['ins_g', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'],
]
const EXPECTED = ['ins_f', 'ins_c', 'ins_d', 'ins_b', 'ins_g', 'ins_a', 'ins_e']

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'inspg-'))
  const memoryDir = '.dsh-project-memory'
  const store = new ProjectMemoryStore(path.join(root, memoryDir)).load()
  store.replaceInsightItems(SPEC.map(([id, updatedAt, createdAt]) => ({
    id, kind: 'lesson', scope: 'project', title: `标题 ${id}`, fix: `做法 ${id}`,
    confidence: 0.8, files: [], symbols: [], sourceTaskIds: [], createdAt, updatedAt,
  })))
  store.commit(() => 0)
  const globalFile = path.join(root, 'global.json')
  const gs = new GlobalStore(globalFile).load()
  const config = { memoryDir, insight: { globalFile }, tasklist: { enabled: true, syncHostOnAdopt: false } }
  const invocation = (rawInput) => ({
    commandId: 'cmd-test',
    agent: { id: 'sess_pg', session: { id: 'sess_pg', header: { cwd: root } } },
    rawInput,
    attachments: [],
  })
  return { root, store, gs, config, invocation, definition: workflowCommandDefinition(config, {}) }
}

/** 取出命令输出尾部的 JSON 围栏载荷（面板解析的就是它）。 */
function payloadOf(text) {
  const m = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  assert.ok(m, `输出里必须有 JSON 围栏：${String(text).slice(0, 200)}`)
  return JSON.parse(m[1])
}

// ---- 1. 排序：新 → 旧，且并列时有确定次序 ----
{
  const { store, gs } = fixture()
  const all = listInsights(store, gs, 'project')
  assert.deepEqual(all.items.map((r) => r.id), EXPECTED, '期望 updatedAt↓ → createdAt↓ → id↑')
  assert.equal(all.total, 7)
  assert.equal(all.count, 7, 'count 保留为总数（旧客户端/旧测试仍读它）')
  assert.equal(all.nextOffset, null, '不分页时没有下一页')
  ok('排序：updatedAt↓ → createdAt↓ → id↑（并列也有确定次序）')
}

// ---- 2. 排序不得就地打乱 store 自己的数组 ----
{
  const { store, gs } = fixture()
  const before = store.insightItems().map((i) => i.id)
  listInsights(store, gs, 'project')
  assert.deepEqual(store.insightItems().map((i) => i.id), before,
    'store.insightItems() 返回的是活数组；排序若就地做会把新顺序写回 store')
  ok('排序不就地修改 store 自己的条目数组')
}

// ---- 3. 分页窗口：逐页拼起来必须等于全量（不重叠、不漏条） ----
{
  const { store, gs } = fixture()
  const seen = []
  let offset = 0
  let pages = 0
  for (;;) {
    const page = listInsights(store, gs, 'project', { offset, limit: 3 })
    assert.equal(page.total, 7, '每一页都要回报总数')
    assert.equal(page.offset, offset)
    seen.push(...page.items.map((r) => r.id))
    pages++
    if (page.nextOffset === null) break
    assert.equal(page.nextOffset, offset + page.items.length, 'nextOffset 必须是已消费条数')
    offset = page.nextOffset
  }
  assert.equal(pages, 3, '7 条 / 每页 3 条 = 3 页')
  assert.deepEqual(seen, EXPECTED, '逐页拼接必须与全量逐字相同（无重叠、无漏条）')
  ok('分页：逐页拼接等于全量，nextOffset 递进正确')
}

// ---- 4. 越界与边界 ----
{
  const { store, gs } = fixture()
  const past = listInsights(store, gs, 'project', { offset: 99, limit: 3 })
  assert.deepEqual(past.items, [], '越界返回空页')
  assert.equal(past.total, 7, '越界也要如实回报总数')
  assert.equal(past.nextOffset, null, '越界不得谎报还有下一页（否则客户端会无限请求）')

  const exact = listInsights(store, gs, 'project', { offset: 6, limit: 3 })
  assert.deepEqual(exact.items.map((r) => r.id), ['ins_e'])
  assert.equal(exact.nextOffset, null, '最后一页取满后 nextOffset 必须是 null')

  const lastFull = listInsights(store, gs, 'project', { offset: 4, limit: 3 })
  assert.equal(lastFull.nextOffset, null, '恰好取到末尾时 also null')
  ok('边界：越界空页、恰好取满末尾，都不会谎报"还有下一页"')
}

// ---- 5. 省略 limit = 旧行为（返回全部），老客户端 bundle 不会被升级打断 ----
{
  const { store, gs } = fixture()
  const legacy = listInsights(store, gs, 'project')
  assert.equal(legacy.items.length, 7)
  assert.equal(legacy.nextOffset, null)
  const legacyOffsetOnly = listInsights(store, gs, 'project', { offset: 2 })
  assert.deepEqual(legacyOffsetOnly.items.map((r) => r.id), EXPECTED.slice(2), '只给 offset 时从其到末尾')
  ok('省略 limit 保持既有行为（老客户端拿到的仍是一次性全量）')
}

// ---- 6. 命令面：分页参数真的从命令行透到载荷 ----
{
  const { definition, invocation } = fixture()
  const res = definition.handler(invocation(' insight list project 0 3'))
  assert.equal(res.kind, 'success')
  const payload = payloadOf(res.text)
  assert.deepEqual(payload.items.map((r) => r.id), EXPECTED.slice(0, 3), '命令行 offset/limit 生效')
  assert.equal(payload.total, 7)
  assert.equal(payload.nextOffset, 3)
  assert.ok(res.text.includes('显示 3/7'), `人类可读段应报告进度：${res.text.split('\n')[0]}`)

  const second = payloadOf(definition.handler(invocation(' insight list project 3 3')).text)
  assert.deepEqual(second.items.map((r) => r.id), EXPECTED.slice(3, 6))
  assert.equal(second.nextOffset, 6)
  ok('命令面：/tasks insight list <scope> <offset> <limit> 透传并回报 total/nextOffset')
}

// ---- 7. 不带分页参数的旧调用仍走通 ----
{
  const { definition, invocation } = fixture()
  const payload = payloadOf(definition.handler(invocation(' insight list project')).text)
  assert.equal(payload.items.length, 7)
  assert.equal(payload.nextOffset, null)
  ok('不带分页参数的旧调用（老 bundle）仍然走通')
}

// ---- 8. 畸形参数必须显式报错，不能静默当成 0/全部 ----
{
  const { definition, invocation } = fixture()
  const badOffset = definition.handler(invocation(' insight list project -1 3'))
  assert.equal(badOffset.kind, 'error', '负 offset 必须报错')
  const badLimit = definition.handler(invocation(' insight list project 0 0'))
  assert.equal(badLimit.kind, 'error', 'limit=0 必须报错（否则面板会以为"到底了"）')
  const nanLimit = definition.handler(invocation(' insight list project 0 abc'))
  assert.equal(nanLimit.kind, 'error', '非数字 limit 必须报错')
  ok('畸形分页参数显式报错（不静默降级成 0/全部）')
}

// ---- 9. 单页上限封顶：一次请求不得把整个池子拉成超大载荷 ----
{
  const { definition, invocation } = fixture()
  const payload = payloadOf(definition.handler(invocation(` insight list project 0 ${INSIGHT_PAGE_MAX + 500}`)).text)
  assert.ok(payload.items.length <= INSIGHT_PAGE_MAX, `单页不得超过 ${INSIGHT_PAGE_MAX} 条`)
  assert.equal(payload.items.length, 7, '本例总数小于上限，所以拿到全部')
  ok(`单页上限：limit 被夹到 ${INSIGHT_PAGE_MAX}`)
}

// ---- 9b. 客户端那份单页上限必须与宿主相等（浏览器 bundle 不能 import 服务端模块） ----
// 两边漂移的后果不是报错，而是"客户端以为能要 300、宿主只回 200"——动作后的替换式重放
// 会静默把列表打回窄窗口。这份常量只能手抄，所以用一条断言把它钉住。
{
  assert.equal(HOST_PAGE_MAX, INSIGHT_PAGE_MAX, 'src/client/paging.js 的 HOST_PAGE_MAX 与宿主 INSIGHT_PAGE_MAX 漂移了')
  ok('契约：客户端 HOST_PAGE_MAX === 宿主 INSIGHT_PAGE_MAX')
}

// ---- 10. global scope 同样排序分页 ----
{
  const { store, gs } = fixture()
  gs.doc.items.push(
    { id: 'g_old', kind: 'lesson', scope: 'global', title: '旧', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'g_new', kind: 'lesson', scope: 'global', title: '新', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
  )
  gs.commit(() => 0)
  const page = listInsights(store, gs, 'global', { offset: 0, limit: 1 })
  assert.deepEqual(page.items.map((r) => r.id), ['g_new'], 'global 也要新→旧')
  assert.equal(page.total, 2)
  assert.equal(page.nextOffset, 1)
  ok('global scope 同样按新→旧排序并分页')
}

console.log(`\ninsight-paging tests: ${passed} passed`)
