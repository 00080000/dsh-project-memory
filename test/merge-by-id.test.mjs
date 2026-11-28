// 跨进程按 id 合并（src/util/merge-by-id.js）：node test/merge-by-id.test.mjs
//
// 这段判据原先在 project insights / global insights / 任务内嵌 insights 三处各抄一份，
// 三份的 in-memory 守卫已经漂移。这里把「哪一条该留下」写成刻意的行为决定：
//   - 磁盘缺、本地不是新建 → 对方删了，不能复活；
//   - 磁盘缺、本地是新建   → 我还没写，要补写；
//   - 两边都有             → updatedAt 新者胜，平手取本地（本地刚改的不能被读回的旧值盖掉）；
//   - 墓碑                 → 无论磁盘有没有，一律不写回；
//   - 脏数据（null/数组/无 id）两边都跳过，不因为一次合并被写进磁盘，也不让合并抛错。
import assert from 'node:assert/strict'
import { mergeById } from '../src/util/merge-by-id.js'

let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }

const at = (h) => `2026-01-0${h}T00:00:00.000Z`
const ids = (list) => list.map((it) => it.id)

// ---- 1. 磁盘不是数组：返回 null，由调用方决定 fail-safe ----
{
  assert.equal(mergeById({ diskItems: null, localItems: [{ id: 'a' }] }), null)
  assert.equal(mergeById({ diskItems: undefined, localItems: [] }), null)
  assert.equal(mergeById({ diskItems: { items: [] }, localItems: [] }), null, '只有数组才算读到磁盘')
  assert.deepEqual(mergeById({ diskItems: [], localItems: [{ id: 'a' }] }), [], '空数组是"读到了、但没条目"')
  ok('diskItems 非数组 → null（缺失/损坏由调用方保留内存副本）')
}

// ---- 2. 两边都有：updatedAt 新者胜，平手取本地 ----
{
  const disk = [{ id: 'a', updatedAt: at(1), v: 'disk' }, { id: 'b', updatedAt: at(3), v: 'disk' }]
  const local = [{ id: 'a', updatedAt: at(2), v: 'local' }, { id: 'b', updatedAt: at(3), v: 'local' }]
  const merged = mergeById({ diskItems: disk, localItems: local })
  assert.deepEqual(ids(merged), ['a', 'b'], '磁盘顺序在前')
  assert.equal(merged[0].v, 'local', '本地更新的一侧胜')
  assert.equal(merged[1].v, 'local', 'updatedAt 平手取本地：写盘前读回旧值不能盖掉这次修改')
  ok('同 id：updatedAt 新者胜，平手取本地')
}

// ---- 3. 时间戳缺失/非法：都按 0 比，平手仍取本地 ----
{
  const merged = mergeById({
    diskItems: [{ id: 'a', v: 'disk' }],
    localItems: [{ id: 'a', v: 'local' }],
  })
  assert.equal(merged[0].v, 'local', '两边都缺 updatedAt → 0 == 0，平手取本地')
  const numeric = mergeById({
    diskItems: [{ id: 'a', updatedAt: 20260101, v: 'disk' }],
    localItems: [{ id: 'a', updatedAt: 20260102, v: 'local' }],
  })
  assert.equal(numeric[0].v, 'local', '数字时间戳不是 ISO，isoMs 一律 0（不按 2026 年解析）')
  ok('缺失/非法 updatedAt：归 0 后平手取本地')
}

// ---- 4. 磁盘缺本地有：只有本进程新建的才补写，否则是对方删了 ----
{
  const disk = [{ id: 'keep', updatedAt: at(1) }]
  const local = [
    { id: 'keep', updatedAt: at(1) },
    { id: 'mine', updatedAt: at(2) }, // createdIds 里有 → 补写
    { id: 'gone', updatedAt: at(2) }, // 磁盘没有且不是新建 → 对方删了
  ]
  const merged = mergeById({
    diskItems: disk,
    localItems: local,
    createdIds: new Set(['mine']),
  })
  assert.deepEqual(ids(merged), ['keep', 'mine'], '新建的按本地顺序追加，对端删掉的不复活')
  ok('磁盘缺：新建的补写，非新建的丢弃（不复活对方删除）')
}

// ---- 5. 墓碑：本地删掉的 id 无论磁盘有没有都不写回 ----
{
  const merged = mergeById({
    diskItems: [{ id: 'del', updatedAt: at(3) }, { id: 'keep', updatedAt: at(1) }],
    localItems: [{ id: 'keep', updatedAt: at(1) }, { id: 'del', updatedAt: at(3) }],
    deletedIds: new Set(['del']),
  })
  assert.deepEqual(ids(merged), ['keep'], '本地删掉的条目不能被磁盘副本复活')
  const removedLocally = mergeById({
    diskItems: [{ id: 'del' }, { id: 'keep' }],
    localItems: [{ id: 'keep' }], // 原地 splice 后本地数组里已看不到 del
    deletedIds: new Set(['del']),
  })
  assert.deepEqual(ids(removedLocally), ['keep'], '本地数组已移除的墓碑也要从磁盘结果里删掉')
  ok('墓碑：删掉的 id 不写回（含本地数组已移除的情况）')
}

// ---- 6. 脏数据：两边都跳过，不写盘、不抛错 ----
{
  const merged = mergeById({
    diskItems: [null, ['id'], { nope: 1 }, { id: 'ok', updatedAt: at(1) }, 'str'],
    localItems: [null, ['id'], { nope: 2 }, { id: 'ok', updatedAt: at(1) }, undefined],
  })
  assert.deepEqual(ids(merged), ['ok'], 'null/数组/无 id 的条目一律跳过')
  ok('脏数据（null / 数组 / 无 id）：跳过且不抛错')
}

// ---- 7. 重复 id：按 updatedAt 取新，而不是"数组里最后一条" ----
{
  const merged = mergeById({
    diskItems: [{ id: 'a', updatedAt: at(1), v: 'disk' }],
    localItems: [
      { id: 'a', updatedAt: at(3), v: 'newer' },
      { id: 'a', updatedAt: at(1), v: 'older' },
    ],
  })
  assert.equal(merged[0].v, 'newer', '同 id 重复出现时保留时间更新的一条（唯一 id 是写入期不变量）')
  ok('重复 id：按 updatedAt 取新')
}

// ---- 8. 不改入参：返回新数组 ----
{
  const disk = [{ id: 'a', updatedAt: at(1) }]
  const local = [{ id: 'b', updatedAt: at(2) }]
  const merged = mergeById({ diskItems: disk, localItems: local, createdIds: new Set(['b']) })
  assert.notEqual(merged, disk)
  assert.notEqual(merged, local)
  assert.deepEqual(ids(disk), ['a'])
  assert.deepEqual(ids(local), ['b'])
  assert.deepEqual(mergeById({ diskItems: [] }), [], 'localItems 缺失按空处理')
  ok('纯函数：不改入参；缺失集合/数组有默认值')
}

console.log(`\nmerge-by-id: ${passed} 项通过`)
