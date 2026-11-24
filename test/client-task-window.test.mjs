// 任务列表渐进渲染的计数边界：node test/client-task-window.test.mjs
//
// 回归：任务多时面板一次挂全部卡（滚到底、展开都变重）；改成首屏一批 + 哨兵放下一批后，
// 这个"下一批张到哪"的纯函数就是边界所在——算小了放不出来，算大了等于没窗口。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TASK_PAGE_SIZE, TASK_PREFETCH_MARGIN, nextTaskCount } from '../src/client/task-window.js'

let passed = 0
function ok(name) { passed++; console.log('  ok', name) }

// 1) 每批按 TASK_PAGE_SIZE 递增
assert.equal(nextTaskCount(0, 40), TASK_PAGE_SIZE)
assert.equal(nextTaskCount(TASK_PAGE_SIZE, 40), TASK_PAGE_SIZE * 2)
assert.equal(nextTaskCount(TASK_PAGE_SIZE * 2, 40, 5), TASK_PAGE_SIZE * 2 + 5, '可指定批大小')
ok('递增：首屏一批，之后每次再放一批')

// 2) 封顶在总数上，到顶后再调不放大
assert.equal(nextTaskCount(24, 30), 30)
assert.equal(nextTaskCount(30, 30), 30)
assert.equal(nextTaskCount(99, 30), 30, '上限已经越过总数时收回到总数')
assert.equal(nextTaskCount(12, 3), 3, '总数比一批还少时直接到总数')
ok('封顶：不超过活跃任务总数，到顶后不变')

// 3) 非法输入不放大：总数 0/NaN 归 0，current/step 非法按缺省处理
assert.equal(nextTaskCount(12, 0), 0)
assert.equal(nextTaskCount(12, Number.NaN), 0)
assert.equal(nextTaskCount(Number.NaN, 30), TASK_PAGE_SIZE, 'current 非法时从一批起算')
assert.equal(nextTaskCount(-3, 30), TASK_PAGE_SIZE)
assert.equal(nextTaskCount(12, 30, 0), 12 + TASK_PAGE_SIZE, 'step 非法回落默认值')
ok('非法输入：总数归 0、current/step 回落缺省，不会算出负数或倒退')

// 4) 接线守卫：面板必须渲染窗口切片 + 哨兵，别退回“一次挂全部卡”
const panel = readFileSync(new URL('../src/client/TaskPanel.tsx', import.meta.url), 'utf8')
assert.match(panel, /visibleTasks\.map\(/, '列表应渲染切片，而不是全量')
assert.doesNotMatch(panel, /activeTasks\.map\(/, '不得再直接全量渲染')
assert.match(panel, /rootMargin: TASK_PREFETCH_MARGIN/, '哨兵要挂任务自己的预取余量')
assert.equal(TASK_PREFETCH_MARGIN, '0px', '本地数据不预取，否则首屏会一次放出两批')
assert.match(panel, /sentinelRef/, '哨兵没渲染就永远不会放下一批')
assert.match(panel, /nextTaskCount\(n, activeTasks\.length\)/, '放批要按当前总数封顶')
assert.match(panel, /typeof IntersectionObserver === 'undefined'/, '老环境要退化成按钮')
assert.match(panel, /t\('panel.loadMore'\)/, '降级按钮的文案要有个 key')
const locales = readFileSync(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
assert.match(locales, /'panel\.loadMore'/, '中英文案都要有')
assert.match(
  panel,
  /\}, \[ui\.closed, ui\.minimized, view, shownCount, activeTasks\.length\]\)/,
  '收起/隐藏会卸载列表 DOM：effect 必须随 closed/minimized 重跑，否则重新展开后哨兵没人观察',
)
ok('接线：渲染切片 + 哨兵 + 封顶 + 降级按钮，且文案 key 存在')

console.log(`\nclient-task-window tests: ${passed} passed`)
