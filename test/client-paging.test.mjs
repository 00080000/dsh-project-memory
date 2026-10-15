// 记忆列表分页窗口的纯函数测试：node test/client-paging.test.mjs
//
// 为什么单独测这个模块：客户端的 React 测试替身里 `useState` 的 setter 是 no-op、
// `useEffect` 由测试手动触发（见 test/client-toolview.test.mjs），它验证不了
// "滚到底 → 追加渲染"。所以分页的**决策**被抽到 src/client/paging.js，
// 边界在这里直接钉住；组件只负责把结果接到渲染上。
import assert from 'node:assert/strict'
import { PAGE_SIZE, PREFETCH_MARGIN, SPINNER_DELAY_MS, appendUnique, createRequestGate, insightListLine, normalizeWindow, progressCounts, reloadWindowRequest } from '../src/client/paging.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

// ---- 1. 参数本身是契约的一部分（宿主 INSIGHT_PAGE_MAX=200 是防滥用封顶） ----
{
  assert.equal(PAGE_SIZE, 30, '每页 30 条：首屏够看，又不会一次渲染几百行')
  assert.ok(SPINNER_DELAY_MS >= 100, '延迟显示阈值不能太小，否则本地的快请求会闪一下')
  assert.match(PREFETCH_MARGIN, /px/, '预取提前量必须有像素值，否则哨兵只有真正进入视口才触发')
  ok('常量契约：PAGE_SIZE=30、预取提前量、加载指示延迟阈值')
}

// ---- 2. 命令行协议（与宿主 src/commands/insight-actions.js 的 list 分支一一对应） ----
{
  assert.equal(insightListLine('project', 0, 30), '/tasks insight list project 0 30')
  assert.equal(insightListLine('global', 30, 30), '/tasks insight list global 30 30')
  assert.equal(insightListLine('task', 0, 5), '/tasks insight list task 0 5')
  ok('命令行协议：/tasks insight list <scope> <offset> <limit>')
}

// ---- 3. 追加去重：重复行 = 重复按钮 = 误删入口 ----
{
  const prev = [{ id: 'a' }, { id: 'b' }]
  assert.deepEqual(appendUnique(prev, [{ id: 'b' }, { id: 'c' }]).map((r) => r.id), ['a', 'b', 'c'])
  assert.deepEqual(appendUnique([], [{ id: 'x' }]).map((r) => r.id), ['x'])
  // 去重后顺序必须保持：新条目永远追加在末尾（时间序）
  assert.deepEqual(appendUnique([{ id: 'a' }], [{ id: 'c' }, { id: 'b' }]).map((r) => r.id), ['a', 'c', 'b'])
  ok('追加去重：已渲染过的 id 不会出现第二次，且顺序保持追加序')
}

// ---- 4. 无新增时返回同一引用（避免无意义重渲染） ----
{
  const prev = [{ id: 'a' }]
  assert.equal(appendUnique(prev, [{ id: 'a' }]), prev, '全是重复项时应原样返回')
  assert.equal(appendUnique(prev, []), prev, '空页应原样返回')
  assert.equal(appendUnique(prev, null), prev, '畸形页不得抛错')
  ok('无新增/空页/畸形页时原样返回同一引用，不触发无意义重渲染')
}

// ---- 5. 动作后的重放窗口：重取前缀，不重置成第一页 ----
{
  assert.deepEqual(reloadWindowRequest(0), { offset: 0, limit: PAGE_SIZE }, '还没加载时要至少取一页')
  assert.deepEqual(reloadWindowRequest(30), { offset: 0, limit: 30 })
  assert.deepEqual(reloadWindowRequest(75), { offset: 0, limit: 75 }, '已加载 75 条就重放 75 条')
  assert.deepEqual(reloadWindowRequest(-5), { offset: 0, limit: PAGE_SIZE }, '负数是畸形输入')
  assert.deepEqual(reloadWindowRequest(NaN), { offset: 0, limit: PAGE_SIZE })
  ok('动作后重放 0..已加载条数 的前缀（用户不会被打回顶部）')
}

// ---- 6. 载荷归一：新宿主分页 / 省略 limit / 老宿主"一次给全" ----
{
  const paged = normalizeWindow({ items: [{ id: 'x' }], total: 70, offset: 30, nextOffset: 60 }, 0)
  assert.equal(paged.total, 70)
  assert.equal(paged.offset, 30)
  assert.equal(paged.nextOffset, 60)

  // 新宿主但调用方省略了 limit：nextOffset 为 null，表示"到底了"
  const all = normalizeWindow({ scope: 'project', count: 2, items: [{ id: 'x' }, { id: 'y' }], offset: 0, nextOffset: null }, 0)
  assert.equal(all.total, 2)
  assert.equal(all.nextOffset, null)
  assert.equal(all.items.length, 2)

  // 老宿主：没有 total/nextOffset → 按"一次给全"降级，绝不能变成"永远还有下一页"
  const legacy = normalizeWindow({ scope: 'project', count: 1, items: [{ id: 'x' }] }, 0)
  assert.equal(legacy.total, 1)
  assert.equal(legacy.nextOffset, null)
  assert.equal(legacy.offset, 0, '载荷没给 offset 时用请求时的 offset')

  // 畸形载荷不抛
  const broken = normalizeWindow(undefined, 7)
  assert.deepEqual(broken, { items: [], total: 0, offset: 7, nextOffset: null })
  ok('载荷归一：分页/不分页/老宿主三种形态，畸形载荷不抛')
}

// ---- 7. 页脚计数：总数不得小于已显示数（否则出现"已显示 70 / 30"） ----
{
  assert.deepEqual(progressCounts(30, 70), { loaded: 30, total: 70 })
  assert.deepEqual(progressCounts(70, 70), { loaded: 70, total: 70 })
  assert.deepEqual(progressCounts(100, 50), { loaded: 100, total: 100 })
  assert.deepEqual(progressCounts(NaN, NaN), { loaded: 0, total: 0 })
  ok('页脚计数归一：total 永远不小于 loaded')
}

// ---- 8. 请求闸门：切 scope 的新请求**不得**被在途请求挡住（开发中真踩到的 bug） ----
// 早期实现用一个布尔量做并发守卫（"有在途请求就 return"）。于是上一页还在飞的时候切
// scope，新请求被直接丢掉，而过期响应又被作用域检查丢掉 → 新列表永远空白，只能手动刷新。
{
  const gate = createRequestGate()
  const a = gate.begin('project|0|30|false')
  assert.equal(typeof a, 'number', '首个请求必须放行')
  assert.equal(gate.begin('project|0|30|false'), false, '同一个 key 正在飞时必须去重（哨兵连续触发）')

  const b = gate.begin('global|0|30|false')
  assert.equal(typeof b, 'number', '切 scope 的新请求必须放行——不能因为旧请求在飞就把它丢掉')

  assert.ok(gate.isStale(a, 'project', 'project'), '被更新请求取代的响应必须丢弃')
  assert.equal(gate.isStale(b, 'global', 'global'), false, '最新请求且作用域未变 → 允许落状态')
  assert.equal(gate.isStale(b, 'global', 'project'), true, '作用域已切换 → 即使是最新请求也必须丢弃')

  assert.equal(gate.end('project|0|30|false', a), false, '过期请求结束时不得回落加载标志')
  assert.equal(gate.end('global|0|30|false', b), true, '最后一次请求结束时才回落加载标志')

  // 闸门释放后，同一个 key 可以再次发起（否则翻页只能成功一次）
  assert.equal(typeof gate.begin('global|0|30|false'), 'number', '请求结束后同一 key 必须能再发')
  ok('请求闸门：切 scope 的新请求照发、过期响应必丢、同一 key 去重')
}

console.log(`\nclient-paging tests: ${passed} passed`)
