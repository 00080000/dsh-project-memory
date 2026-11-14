// 记忆 kind 展示名的语义回归：node test/client-kind-label.test.mjs
//
// 背景：这块逻辑原先在两个组件里各写一份（TaskComponents.tsx 的 insightKindLabel 与
// MemoryView.tsx 的 kindText），逐字相同。收敛到 src/client/kind-label.js 后，语义必须
// 由一条测试钉住，否则"新增 kind 只改一处"的收益会变成"两个界面显示不同标签"的漂移。
//
// 钉住四件事：
//   1. 四个合法 kind 都走 `mem.kind.*` 词典（中英两份都存在，否则渲染出的是 key 本身）；
//   2. 服务端 INSIGHT_KINDS 与 client 的映射集合**完全一致**（少一个 = 该类型在界面上裸奔）；
//   3. 非法 kind 原样字符串化，绝不回退到默认 kind、也不抛错；
//   4. 原型链上的键（`__proto__` / `constructor`）当非法值处理 —— 旧实现用
//      `map[kind] ?? kind` 查表，这两个键会命中原型成员（对象/函数），React 渲染对象
//      会直接抛 "Objects are not valid as a React child"。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { KIND_LABEL_KEYS, insightKindLabel } from '../src/client/kind-label.js'
import { INSIGHT_KINDS } from '../src/insight-store.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

/** 记录被查询的 key，并返回可辨认的标签（不依赖真实词典内容）。 */
const t = (key) => {
  asked.push(key)
  return `label:${key}`
}
let asked = []

// ---- 1. 四个合法 kind：key 映射固定、逐个走翻译函数 ----
{
  asked = []
  assert.deepEqual(
    Object.keys(KIND_LABEL_KEYS).sort(),
    [...INSIGHT_KINDS].sort(),
    'client 的 kind 标签集合必须与服务端 INSIGHT_KINDS 一致（新增 kind 时两处一起改）',
  )
  for (const kind of INSIGHT_KINDS) {
    assert.equal(insightKindLabel(kind, t), `label:mem.kind.${kind}`, `${kind} 走 mem.kind.${kind} 词典`)
  }
  assert.deepEqual(asked.sort(), [...INSIGHT_KINDS].map((k) => `mem.kind.${k}`).sort(),
    '每个 kind 恰好查一次词典（不重复查、不查别的 key）')
  ok('四个合法 kind 各自走 mem.kind.* 词典，且与服务端 INSIGHT_KINDS 一致')
}

// ---- 2. 词典里中英两份都有这些 key（漏一份就会把 key 直接渲染给用户） ----
{
  const locales = readFileSync(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
  for (const key of Object.values(KIND_LABEL_KEYS)) {
    const hits = locales.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []
    assert.equal(hits.length, 2, `${key} 必须在 zh 与 en 两份词典里各出现一次（实际 ${hits.length} 次）`)
  }
  ok('mem.kind.* 词典键在中英两份词典里都存在')
}

// ---- 3. 非法/缺失 kind：原样字符串化，不抛错 ----
{
  for (const [kind, want] of [['insight', 'insight'], ['', ''], [undefined, ''], [null, '']]) {
    assert.equal(insightKindLabel(kind, t), want, `${String(kind)} → 原样回显，不改写成某个默认 kind`)
  }
  assert.equal(insightKindLabel(42, t), '42', '数字 kind 也字符串化（不把对象/数字丢给 React）')
  assert.equal(insightKindLabel({ kind: 'lesson' }, t), '[object Object]', '对象 kind 字符串化而不是原样返回对象')
  ok('非法/缺失 kind 原样字符串化（绝不回退默认 kind，也绝不把对象交给渲染层）')
}

// ---- 4. 原型链键：旧实现会返回 Object.prototype / 函数 ----
{
  for (const kind of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const got = insightKindLabel(kind, t)
    assert.equal(typeof got, 'string', `${kind} 必须返回字符串（旧实现返回原型成员）`)
    assert.equal(got, kind, `${kind} 是非法 kind：原样回显，不吃原型链`)
  }
  ok('原型链键当非法值处理：返回字符串而不是原型成员')
}

console.log(`\nclient kind-label tests: ${passed} passed`)
