// insight kind ↔ 字段归属的语义回归：node test/insight-fields.test.mjs
//
// 背景：面板「提交正文到哪个字段」（MemoryView.submitNew）、「编辑时从哪个字段预填」
// （MemoryView.rowToForm）、记忆列表摘要取哪个字段当正文（insight-actions.insSummary）
// 原先各写一份 if/else 链，三处互为逆运算。收敛到 src/util/insight-fields.js 后，
// 语义必须由测试钉住，否则「少改一处」就变成编辑后正文搬家（写进 A 字段、再打开却从 B 读）。
//
// 钉住四件事：
//   1. 三个非 procedure 的 kind 各自的 [症状, 解答] 配对固定，procedure 没有单字段正文；
//   2. 这份映射与 pruneKindFields 的 KIND_CONTENT **同源**：切 kind 后保留下来的字段
//      必须覆盖 titleFieldOf / bodyFieldOf 返回的字段（新增 kind 时两处一起改，漏一处就报错）；
//   3. 脏 kind（缺失/非字符串/大小写不符）一律落到通用 body / null，不抛错；
//   4. 原型链上的键（`__proto__` / `constructor`）当非法值处理 —— 查表若用
//      `map[kind] || 'body'` 会返回原型成员（对象/函数），下游拿它当字段名就写不进东西。
import assert from 'node:assert/strict'
import { INSIGHT_KINDS } from '../src/insight-store.js'
import { bodyFieldOf, pruneKindFields, titleFieldOf } from '../src/util/insight-fields.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

// ---- 1. 配对固定：KIND_CONTENT 里每对 [症状, 解答]，解答即正文 ----
{
  const want = {
    lesson: ['pattern', 'fix'],
    decision: ['choice', 'reason'],
    experience: ['problem', 'solution'],
  }
  assert.deepEqual(Object.keys(want).sort(), INSIGHT_KINDS.filter((k) => k !== 'procedure').sort(),
    '服务端每新增一个非 procedure 的 kind，本测试与 insight-fields.js 都要跟着改')
  for (const [kind, [titleField, bodyField]] of Object.entries(want)) {
    assert.equal(titleFieldOf(kind), titleField, `${kind} 的标题镜像是 ${titleField}`)
    assert.equal(bodyFieldOf(kind), bodyField, `${kind} 的正文是 ${bodyField}`)
  }
  assert.equal(bodyFieldOf('procedure'), 'body', 'procedure 的正文由 steps 表达，写侧落通用 body')
  assert.equal(titleFieldOf('procedure'), null, 'procedure 没有与正文配对的标题镜像字段')
  ok('三个 kind 的 [症状, 解答] 配对固定；procedure 没有单字段正文')
}

// ---- 2. 与 pruneKindFields 同源：切 kind 后留下的字段必须覆盖映射返回的字段 ----
{
  for (const kind of INSIGHT_KINDS) {
    const item = { kind, pattern: 'p', fix: 'f', choice: 'c', reason: 'r', problem: 'pb', solution: 's', body: 'b', steps: ['x'] }
    pruneKindFields(item, 'from-other-kind')
    const titleField = titleFieldOf(kind)
    const bodyField = bodyFieldOf(kind)
    if (titleField) assert.ok(titleField in item, `${kind}: titleFieldOf 返回 ${titleField}，但它会被 pruneKindFields 删掉`)
    if (kind !== 'procedure') assert.ok(bodyField in item, `${kind}: bodyFieldOf 返回 ${bodyField}，但它会被 pruneKindFields 删掉`)
    // 反向：映射没点到的「解答」字段必须被清掉，否则切 kind 后旧正文会残留成幽灵字段。
    for (const f of ['fix', 'reason', 'solution']) {
      if (f === bodyField) continue
      assert.ok(!(f in item), `${kind}: ${f} 不属于该 kind，pruneKindFields 应清掉（否则切 kind 后旧正文残留）`)
    }
  }
  ok('映射与 pruneKindFields 的 KIND_CONTENT 同源（漏改一处就报错）')
}

// ---- 3. 脏值：缺失/非字符串/大小写不符一律回落，不抛错 ----
{
  for (const kind of [undefined, null, '', 0, 42, false, {}, [], ['lesson'], 'Lesson', ' lesson ']) {
    assert.equal(bodyFieldOf(kind), 'body', `${JSON.stringify(kind)} 落到通用 body`)
    assert.equal(titleFieldOf(kind), null, `${JSON.stringify(kind)} 没有标题镜像字段`)
  }
  ok('脏/缺失 kind 回落到 body / null（大小写敏感是刻意的：kind 只认小写枚举）')
}

// ---- 4. 原型链键：查表吃原型就会返回对象/函数，下游会把它当字段名 ----
{
  for (const kind of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    const bodyField = bodyFieldOf(kind)
    assert.equal(typeof bodyField, 'string', `${kind}: 必须返回字符串字段名（旧写法会返回原型成员）`)
    assert.equal(bodyField, 'body', `${kind} 是非法 kind，落 body`)
    assert.equal(titleFieldOf(kind), null, `${kind} 是非法 kind，没有标题镜像字段`)
  }
  ok('原型链键当非法值处理：返回 body / null 而不是原型成员')
}

console.log(`\ninsight-fields tests: ${passed} passed`)
