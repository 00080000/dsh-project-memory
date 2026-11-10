// watch 根在运行期消失：保留索引 + 只告警一次（ROADMAP §6-18）
//
// 根被删除/rename/挂载点掉线时，轮询**不能**继续走到 storeFor() → save()：save() 会把
// !formatWritten 当脏并 mkdirSync，把删掉的根重新创建成一个空目录，用户的旧索引也就跟着
// 被这份空 store 覆盖。这里的契约是：
//   1. 首次发现根不存在 → console.warn 一条（前缀 [dsh-project-memory]），之后同一根不刷屏；
//   2. 根恢复存在 → 清掉「已告警」标记，下一次再消失还会再告警一次；
//   3. 全程不动 roots / snapshot / entries / watch.json（不 removeRoot、不清状态）；
//   4. 全程不重建目录。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WatchManager } from '../src/watch.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

/** 收集 fn() 期间 console.warn 的每一行（结束后一定还原，失败也不污染其它用例）。 */
async function captureWarn(fn) {
  const lines = []
  const original = console.warn
  console.warn = (...args) => { lines.push(args.join(' ')) }
  try {
    await fn()
  } finally {
    console.warn = original
  }
  return lines
}

// ---- 1. 根消失：一次告警 + 状态原样保留 + 不重建目录 ----
{
  const base = mkdtempSync(path.join(tmpdir(), 'watch-missing-root-'))
  const root = path.join(base, 'project')
  mkdirSync(root)
  rmSync(root, { recursive: true, force: true })
  try {
    const wm = new WatchManager({}, { memoryDir: '.dsh-project-memory' })
    const snapshot = { 'src/a.js': '111:22', 'README.md': '222:33' }
    const state = { snapshot, failures: new Map() }
    wm.roots.set(root, state)

    const first = await captureWarn(() => wm.pollRoot(root, state))
    assert.equal(first.length, 1, '首次发现根不存在：有且只有 1 条告警')
    assert.ok(first[0].startsWith('[dsh-project-memory]'), '告警带插件前缀，宿主日志里能认出来源')
    assert.ok(first[0].includes(root), '告警里要带具体根路径，多根时能分清是哪一个')
    assert.match(first[0], /does not exist/, '说明根不存在')
    assert.match(first[0], /keeping its existing index/i, '说明索引被保留、等根回来')
    assert.match(first[0], /not recreated/i, '说明不会重建目录/store')

    const second = await captureWarn(() => wm.pollRoot(root, state))
    assert.equal(second.length, 0, '同一根第二次消失轮询：不再刷屏')

    // 状态保留：登记还在、快照引用与内容都没被清。
    assert.equal(wm.roots.has(root), true, '不 removeRoot：根仍登记着，回来即可继续扫')
    assert.equal(wm.roots.get(root), state, 'roots 里的 state 仍是同一个引用')
    assert.equal(state.snapshot, snapshot, 'snapshot 引用未被替换')
    assert.deepEqual(state.snapshot, { 'src/a.js': '111:22', 'README.md': '222:33' }, 'snapshot 内容原样保留')

    // 不重建目录。
    assert.equal(existsSync(root), false, '缺失期间不得 mkdir 出根目录')

    ok('根消失：只告警一次，状态保留，不重建目录')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

// ---- 2. 根恢复后再次消失：重新告警一次（标记会随恢复清掉） ----
{
  const base = mkdtempSync(path.join(tmpdir(), 'watch-missing-root-'))
  const root = path.join(base, 'project')
  mkdirSync(root)
  try {
    const wm = new WatchManager({}, { memoryDir: '.dsh-project-memory' })
    const state = { snapshot: {}, failures: new Map() }
    wm.roots.set(root, state)

    // 第一次消失 → 1 条。
    rmSync(root, { recursive: true, force: true })
    const firstGone = await captureWarn(() => wm.pollRoot(root, state))
    assert.equal(firstGone.length, 1, '第一次消失：1 条告警')

    // 根回来 → 正常分支，不告警，并清掉「已告警」标记。
    mkdirSync(root)
    const back = await captureWarn(() => wm.pollRoot(root, state))
    assert.equal(back.length, 0, '根恢复后正常轮询：不告警')
    assert.equal(wm._missingWarned.has(root), false, '根恢复后清掉告警标记')
    assert.equal(existsSync(root), true, '根存在时正常扫描')

    // 再次消失 → 又恰好 1 条（旧标记没被留下）。
    rmSync(root, { recursive: true, force: true })
    const goneAgain = await captureWarn(() => wm.pollRoot(root, state))
    assert.equal(goneAgain.length, 1, '再次消失：重新告警 1 条')
    assert.ok(goneAgain[0].includes(root), '再次告警同样带根路径')

    // 依然只告警一次，状态仍在。
    const third = await captureWarn(() => wm.pollRoot(root, state))
    assert.equal(third.length, 0, '再次消失后的下一轮：仍不刷屏')
    assert.equal(wm.roots.has(root), true, '始终不 removeRoot')
    assert.equal(existsSync(root), false, '缺失期间始终不重建目录')

    ok('根恢复后再次消失：重新告警一次，且仍不刷屏')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

console.log(`\nwatch-missing-root-warn tests: ${passed} passed`)
