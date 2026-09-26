// storeCache 的驻留估算与 LRU 驱逐：node test/store-cache.test.mjs
//
// 动机：`storeCache` 此前**零测试覆盖**——`test/` 下只有两处提到它
// （`store-gitignore.test.mjs`、`run-test.mjs`），且都是为了"绕开缓存"，没有一处测缓存本身。
// 而这条路径一旦失准，代价是 Windows 上反复数秒的冷加载：估算把 store 判成超预算 →
// 逐出 → 下一步 `load()` 重读全部分片（11698 分片 = 11701 次 open）。
//
// 覆盖四件事：
//   1. 估算口径：物化 `searchText` 必须让估算上升（旧实现量的是读盘文本量，此时纹丝不动）；
//   2. 增量口径：`load()` 之后 `setEntries` 写进来的条目必须计入（旧实现只让常数那条腿动）；
//   3. 驱逐行为：超预算时最旧的真的被丢掉，刚加载的 keepKey 被**有意**豁免且不静默；
//   4. 记忆化：版本没变不重算（`evictStoreCache` 是对整个缓存求和，不记忆化就是每次冷加载重数全缓存）。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ProjectMemoryStore,
  _estimateResidentBytes as estimate,
  _setStoreCacheBudgetForTest as setCacheBudget,
  _storeCacheKeysForTest as cacheKeys,
} from '../src/store.js'
import { WatchManager } from '../src/watch.js'
import { memoryRootFor } from '../src/util/fs.js'

let passed = 0
let failed = 0
function check(name, cond) {
  if (cond) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    console.error(`FAIL  ${name}`)
  }
}

/**
 * 内存里的 store：估算只依赖对象图，所以这里完全不碰磁盘（构造器会把
 * files/experience/tasks/insights/watchlist/binding 都初始化好）。
 */
function memoryStore(entries = {}) {
  const store = new ProjectMemoryStore(path.join(tmpdir(), 'pm-store-cache-unused'))
  store.entries = entries
  return store
}

console.log('\n== 估算口径：物化 searchText 必须让它上升 ==')
{
  const payload = 'x'.repeat(4000)
  const store = memoryStore({
    'a.md': [{ id: '1', relPath: 'a.md', title: '标题', summary: payload, terms: '内存 估算' }],
  })
  const before = estimate(store)
  check('物化前估算是正数', before > 0)
  store.allEntries() // 首次读取时物化 searchText
  const after = estimate(store)
  check('物化 searchText 后估算上升（旧实现在这里返回同一个数）', after > before)
  check('上升量与新物化的 searchText 同量级', after - before >= payload.length)
}

console.log('\n== 增量口径：load 之后 setEntries 写进来的条目必须计入 ==')
{
  const store = memoryStore({})
  const before = estimate(store)
  const payload = 'y'.repeat(50000)
  store.setEntries('big.js', [{ id: '2', relPath: 'big.js', title: 'big', summary: payload }])
  const after = estimate(store)
  check('新增条目后估算增长', after > before)
  // 旧实现这里只涨一个常数（1 × 2500），与新增内容的真实体积无关 —— 这条断言就是为它写的。
  check('增量反映新增内容的真实体积，而不是条目数换算', after - before >= payload.length)
}

console.log('\n== 写路径的失效键：setEntries / removeFile 必须 bump 版本 ==')
{
  const store = memoryStore({})
  estimate(store)
  const stamp0 = store._residentStamp
  // removeFile 只对"markFile 记过的文件"生效（生产路径就是 markFile → setEntries → removeFile）。
  store.markFile('a.js', { sha256: 'h', size: 1, type: 'code' })
  store.setEntries('a.js', [{ id: '3', relPath: 'a.js', title: 'a', summary: 'z'.repeat(2000) }])
  const withEntry = estimate(store)
  check('setEntries 让版本戳变化（估算随之失效）', store._residentStamp !== stamp0 && withEntry > 0)
  store.removeFile('a.js')
  const afterRemove = estimate(store)
  check('removeFile 后估算回落到只剩骨架', afterRemove < withEntry)
}

console.log('\n== 驱逐：超预算丢掉最旧的，keepKey 豁免且不静默 ==')
{
  const restoreBudget = setCacheBudget(1) // 1 字节：任何 store 都算超预算
  const dirA = mkdtempSync(path.join(tmpdir(), 'pm-store-cache-a-'))
  const dirB = mkdtempSync(path.join(tmpdir(), 'pm-store-cache-b-'))
  const errors = []
  const originalError = console.error
  console.error = (...args) => errors.push(args.join(' '))
  try {
    new ProjectMemoryStore(dirA).load()
    check('第一个 store 进入缓存', cacheKeys().includes(path.resolve(dirA)))
    new ProjectMemoryStore(dirB).load()
    check('超预算时最旧的 store 被逐出', !cacheKeys().includes(path.resolve(dirA)))
    check('刚加载的 keepKey 即使超预算也留下（有意豁免）', cacheKeys().includes(path.resolve(dirB)))
    check(
      '单实例超预算会告警而不是静默（D4）',
      errors.some((line) => line.includes('超过 storeCache 预算')),
    )
  } finally {
    console.error = originalError
    restoreBudget()
  }
}

console.log('\n== 记忆化：版本没变就不重算 ==')
{
  const store = memoryStore({ 'a.md': [{ id: '4', relPath: 'a.md', title: 'a', summary: 'q'.repeat(1000) }] })
  const first = estimate(store)
  const stamp = store._residentStamp
  const second = estimate(store)
  check('重复调用返回同一个数', first === second)
  check('重复调用不改变版本戳（说明没有重算）', store._residentStamp === stamp)
  store.setEntries('b.md', [{ id: '5', relPath: 'b.md', title: 'b', summary: 'r'.repeat(1000) }])
  check('版本变化后才重算', estimate(store) > first && store._residentStamp !== stamp)
}

console.log('\n== watch 根不再钉住 store（0.5.12，附七结论七）==')
{
  const root = mkdtempSync(path.join(tmpdir(), 'pm-watch-pin-'))
  const wm = new WatchManager({}, { memoryDir: '.dsh-project-memory' })
  const dir = memoryRootFor(root, '.dsh-project-memory')
  const before = cacheKeys().length
  check('addRoot 成功登记该根', wm.addRoot(root) === true)
  // 旧实现在 addRoot 里就 load()：几十个 watch 根 = 启动时同步读几十个 store 的全部 shard。
  check('addRoot 不读盘（登记后缓存里没有它的 store）', cacheKeys().length === before)
  // 旧实现把 store 塞进 roots，等于给每个 watch 根加进程级强引用 → 逐出后会出现第二份活实例。
  check('watch 状态里不再持有 store 实例', wm.roots.get(root).store === undefined)
  const a = wm.storeFor(root)
  check('按需取 store：两次拿到同一个缓存实例', wm.storeFor(root) === a)
  check('取的路径就是该根的 memory root', path.resolve(a.dir) === path.resolve(dir))
  check('取过之后才进缓存', cacheKeys().includes(path.resolve(dir)))
  // 逐出后 watcher 必须跟随缓存，而不是继续用一份自己的旧副本。
  const restoreBudget = setCacheBudget(1)
  try {
    new ProjectMemoryStore(mkdtempSync(path.join(tmpdir(), 'pm-watch-evict-'))).load()
  } finally {
    restoreBudget()
  }
  check('逐出后 watcher 不再握有旧副本（唯一实例由缓存决定）', wm.roots.get(root).store === undefined)
  check('逐出后按需取到的是新实例', wm.storeFor(root) !== a)
  wm.stop()
}

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECKS FAILED`} (${passed} passed)`)
process.exit(failed === 0 ? 0 : 1)
