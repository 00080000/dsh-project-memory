// util/value 与 util/text.textOf 的边缘输入：node test/util-value.test.mjs
// 时间戳只认非空 ISO 字符串，其余（数字、空串、非法串）一律 0。
import assert from 'node:assert/strict'
import { isRecord, isoMs, newerIso } from '../src/util/value.js'
import { textOf } from '../src/util/text.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

assert.equal(isRecord({}), true)
assert.equal(isRecord(Object.create(null)), true)
assert.equal(isRecord([]), false)
assert.equal(isRecord(null), false)
assert.equal(isRecord('x'), false)
assert.equal(isRecord(1), false)
ok('isRecord：普通对象 / null / 数组 / 基本类型')

const ISO = '2026-01-02T03:04:05.000Z'
assert.equal(isoMs(ISO), Date.parse(ISO))
assert.equal(isoMs(''), 0)
assert.equal(isoMs(null), 0)
assert.equal(isoMs(undefined), 0)
assert.equal(isoMs('abc'), 0)
assert.equal(isoMs('not-a-date'), 0)
assert.equal(isoMs(0), 0)
assert.equal(isoMs(Date.parse(ISO)), 0, '只接受字符串')
ok('isoMs：ISO / 空值 / 非法 / 数字归一为 0')

assert.ok(newerIso('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z') > 0)
assert.equal(newerIso('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), 0)
assert.equal(newerIso('', ''), 0)
assert.ok(newerIso('2026-01-01T00:00:00Z', '') > 0, '缺失排最旧')
ok('newerIso：先后 / 相等 / 缺失')

assert.equal(textOf(null), '')
assert.equal(textOf({}), '')
assert.equal(textOf({ content: [] }), '')
assert.equal(textOf({ content: [{ type: 'text', text: 'a' }, null, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb')
assert.equal(textOf({ content: [{ type: 'text', text: 1 }] }), '')
ok('textOf：空消息 / 空块 / 非 text / 多块拼接')

console.log(`\nutil-value tests: ${passed} passed`)
