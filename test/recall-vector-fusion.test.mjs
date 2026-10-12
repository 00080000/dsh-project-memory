// 经验/洞察层的**可选向量融合**回归（不需要 leanvec：用假 rerank 注入余弦）。
//
// 要钉住的三件事：
//   ① 不传 rerank → 输出与纯词法路径**逐字段一致**（可选依赖没装时的行为）；
//   ② `alpha: 0` → 也是 no-op（融合的边界）；
//   ③ 向量层返回空 Map / 抛异常 → 一律降级成纯词法，绝不影响召回。
// 以及融合本身该有的语义：α 够高时，BM25 排在末尾但语义很近的条目能升到前面（这就是向量唯一的收益）。
import assert from 'node:assert/strict'
import { recallItems } from '../src/recall.js'

let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }

// 池子必须让**每条**都命中 ≥2 个查询词——`recallItems` 现在有最小相关性闸门
// （min(2, 查询词数)），只命中 1 个片段的条目会被挡掉（见 ⑦）。
const POOL = [
  { id: 'e1', problem: 'alpha beta gamma delta', solution: 's1' }, // 命中 4 个
  { id: 'e2', problem: 'alpha beta gamma zeta', solution: 's2' }, // 3 个
  { id: 'e3', problem: 'alpha beta theta iota', solution: 's3' }, // 2 个
  { id: 'e4', problem: 'alpha beta kappa mu', solution: 's4' }, // 2 个
]
const Q = 'alpha beta gamma delta'
const base = (extra = {}) => recallItems({
  store: { experience: POOL }, queries: [Q], layers: ['experience'], limit: 4, ...extra,
})
const idsOf = (r) => r.layers[0].hits.map((h) => h.item.id)

// ---- ① 基线 ----
const b = base()
assert.deepEqual([...idsOf(b)].sort(), ['e1', 'e2', 'e3', 'e4'], `基线应召回全部 4 条，实得 ${idsOf(b)}`)
assert.equal(idsOf(b)[0], 'e1', '命中 4 个查询词的应排第 1')
assert.equal(idsOf(b)[idsOf(b).length - 1], 'e4', '命中最少的应排最后')
ok(`纯词法基线：${idsOf(b).join(' > ')}`)

// ---- ② 不传 rerank / 空 Map / 抛异常 → 必须与基线**逐字段一致**（原对象原样返回）----
const same = (got, label) => {
  assert.deepEqual(got, b, `${label} 下输出必须与纯词法路径逐字段一致`)
  ok(`${label}：与基线逐字段一致`)
}
same(base({ rerank: null }), '不传 rerank')
same(base({ rerank: { alpha: 0.9, score: () => new Map() } }), '向量返回空 Map（查询无法编码）')
same(base({ rerank: { alpha: 0.9, score: () => { throw new Error('vector down') } } }), '向量层抛异常')
same(base({ rerank: { alpha: 0.9, score: () => null } }), '向量层返回 null')

// ---- ②b alpha:0 是融合的边界：顺序与 rel 必须与基线一致（分数被整体归一，数值会变）----
{
  const r = base({ rerank: { alpha: 0, score: () => new Map(POOL.map((it) => [it.id, it.id === 'e4' ? 1 : 0])) } })
  assert.deepEqual(idsOf(r), idsOf(b), `alpha:0 顺序应与基线一致，实得 ${idsOf(r)}`)
  const relOf = (x) => x.layers[0].hits.map((h) => Number(h.rel.toFixed(6)))
  assert.deepEqual(relOf(r), relOf(b), 'alpha:0 的 rel 应与基线一致（尺度无关）')
  ok('alpha: 0：顺序与 rel 与基线一致（融合边界正确）')
}

// ---- ③ 融合语义：α 高 + 语义高 → 把 BM25 末尾的条目升上来 ----
{
  const r = base({ rerank: { alpha: 0.9, score: () => new Map(POOL.map((it) => [it.id, it.id === 'e4' ? 1 : 0])) } })
  assert.equal(idsOf(r)[0], 'e4', `α=0.9 时 e4 应升到第 1，实得 ${idsOf(r).join(' > ')}`)
  assert.equal(r.layers[0].hits[0].vector, 1, 'hits 上应带 vector 分')
  ok(`融合生效：${idsOf(r).join(' > ')}（e4 从末尾升到第 1）`)
}

// ---- ④ 全量融合：BM25 的 top-limit 之外的条目也能进来（先截断再重排就做不到）----
{
  const r = recallItems({
    store: { experience: POOL }, queries: [Q], layers: ['experience'], limit: 2,
    rerank: { alpha: 0.9, score: () => new Map(POOL.map((it) => [it.id, it.id === 'e4' ? 1 : 0])) },
  })
  assert.equal(r.layers[0].hits.length, 2, 'limit 仍必须生效（返回条数不膨胀）')
  assert.ok(idsOf(r).includes('e4'), `BM25 排第 4 的 e4 应能进 limit=2 的结果，实得 ${idsOf(r)}`)
  ok(`全量融合 + limit 生效：${idsOf(r).join(' > ')}（返回仍只有 2 条）`)
}

// ---- ⑤ 洞察层同样支持（键用 insightId）；两条都必须有词法分，否则融合够不着 ----
{
  const insightEntries = [
    { id: 'insight:i1', insightId: 'i1', type: 'insight', title: 'alpha beta gamma', summary: 'gamma', keywords: [], terms: '' },
    { id: 'insight:i2', insightId: 'i2', type: 'insight', title: 'alpha beta 另一个主题', summary: 'zzz', keywords: [], terms: '' },
  ]
  const r0 = recallItems({ entries: insightEntries, queries: [Q], layers: ['insight'], limit: 2 })
  assert.deepEqual(r0.layers[0].hits.map((h) => h.item.insightId), ['i1', 'i2'], '纯词法：i1 在前')
  const r1 = recallItems({
    entries: insightEntries, queries: [Q], layers: ['insight'], limit: 2,
    rerank: { alpha: 0.9, score: () => new Map([['i1', 0.1], ['i2', 1]]) },
  })
  assert.deepEqual(r1.layers[0].hits.map((h) => h.item.insightId), ['i2', 'i1'], `i2 应升到第 1，实得 ${JSON.stringify(r1.layers[0].hits.map((h) => h.item.insightId))}`)
  ok('洞察层融合同样生效（向量键用 insightId）')
}

// ---- ⑥ 边界：零词重叠的条目**不会**被融合拉进来（那是并集的活，本实现明确不做）----
{
  const r = recallItems({
    store: { experience: [...POOL, { id: 'e9', problem: 'zzz unrelated words', solution: 'x' }] },
    queries: [Q], layers: ['experience'], limit: 9,
    rerank: { alpha: 0.9, score: () => new Map([['e9', 1], ['e1', 0.1], ['e2', 0.1], ['e3', 0.1], ['e4', 0.1]]) },
  })
  assert.ok(!idsOf(r).includes('e9'), `零词重叠的 e9 不该出现（融合只能重排），实得 ${idsOf(r)}`)
  ok('边界：零词重叠条目不会被拉进结果（融合 ≠ 并集）')
}

// ---- ⑦ 最小相关性闸门：只命中 1 个查询片段（≥2 个查询词时）的条目不许出现 ----
// 真实事故：`zzz-no-such-topic-xyz` 被 `-` 切成 5 个片段，其中 `no` 是某条经验里的真实 token
// （来自 `git commit --amend --no-edit`），于是单片段就命中了一条无关经验（3.13 分）。
{
  const withWeak = [...POOL, { id: 'e_weak', problem: 'alpha only-one-hit', solution: 'x' }]
  const r = recallItems({ store: { experience: withWeak }, queries: [Q], layers: ['experience'], limit: 9 })
  assert.ok(!idsOf(r).includes('e_weak'), `只命中 1/4 个查询词的条目应被闸门挡掉，实得 ${idsOf(r)}`)
  ok('最小相关性闸门：单片段命中（1/4 词）被挡掉')
  // 单词查询不受影响：need = min(2, 1) = 1
  const r1 = recallItems({ store: { experience: withWeak }, queries: ['alpha'], layers: ['experience'], limit: 9 })
  assert.ok(idsOf(r1).includes('e_weak'), `单词查询不该被闸门影响，实得 ${idsOf(r1)}`)
  ok('最小相关性闸门：单词查询不受影响（need = min(2,1) = 1）')
  // ⚠ 有向量时闸门**不生效**：向量救回来的正是"词法弱到不足 2 个命中"的那批，
  //   用词法的尺子筛等于砍掉向量的全部价值（同查询集 A/B 实测：融合 hit@10 72% → 64%）。
  const r2 = recallItems({
    store: { experience: withWeak }, queries: [Q], layers: ['experience'], limit: 9,
    rerank: { alpha: 0.5, score: () => new Map([['e_weak', 1]]) },
  })
  assert.ok(idsOf(r2).includes('e_weak'), `有向量时不该用词法闸门挡住语义强的条目，实得 ${idsOf(r2)}`)
  ok('闸门只在无向量时生效：有向量时词法弱的条目仍可被语义分带出')
}

console.log(`\nrecall-vector-fusion tests: ${passed} passed`)
