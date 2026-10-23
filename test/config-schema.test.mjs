// 配置 Schema 的声明完整性：node test/config-schema.test.mjs
//
// 为什么单测这个：README / types.js 写了、运行时也读了的旋钮，只要没进 `Config`，它在
// cordis.patch.yml 里能不能活到代码就取决于宿主是否按 `additionalProperties: false` 校验
// ——无论哪种，文档与 Schema 已经不一致（0.5.8 给 autoContext 补声明、0.6.x 给 insight 补，
// 是同一类问题）。这里把不变量钉死：凡 `cfgInsight()` 会算出的数值键，`Config.insight`
// 必须声明，且默认值以 cfgInsight 的兜底值为权威。
import assert from 'node:assert/strict'
import { Config } from '../src/index.js'
import { cfgInsight } from '../src/insight-store.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

// --- 1. cfgInsight 的每个数值旋钮都要在 Config.insight 里声明，且默认值一致 ---
{
  const declared = Config.dict?.insight?.dict
  assert.ok(declared && typeof declared === 'object', 'Config.insight 必须是 object schema（否则无法枚举声明键）')
  const nums = Object.entries(cfgInsight({})).filter(([, v]) => typeof v === 'number')
  assert.ok(nums.length >= 11, `cfgInsight 至少应有 11 个数值旋钮，实际 ${nums.length}（读取侧被改过？）`)
  for (const [key, value] of nums) {
    assert.ok(Object.hasOwn(declared, key), `insight.${key} 在 cfgInsight 里生效，却没在 Config 里声明`)
    assert.equal(declared[key].meta?.default, value, `insight.${key} 的 Schema 默认值必须等于 cfgInsight 的兜底值`)
  }
  ok(`Schema ↔ cfgInsight 一致：${nums.length} 个数值旋钮都已声明且默认值相同`)
}

// --- 2. 0.6.x 新加的四个旋钮（回归：修前这四条断言失败）---
{
  const declared = Config.dict.insight.dict
  assert.equal(declared.autoMergeCos.meta.default, 0.9)
  assert.equal(declared.autoMergeMargin.meta.default, 0.05)
  assert.equal(declared.hintCos.meta.default, 0.7)
  assert.equal(declared.maxForgetMatches.meta.default, 10)
  ok('autoMergeCos / autoMergeMargin / hintCos / maxForgetMatches 已在 Schema 声明')
}

// --- 3. 可配置根名单：issue #8 的三个键必须都在 Schema 里（否则文档/代码生效、配置却不生效）---
{
  const declared = Config.dict?.roots?.dict
  assert.ok(declared && typeof declared === 'object', 'Config.roots 必须是 object schema（否则无法枚举声明键）')
  for (const key of ['allow', 'deny', 'exclude']) {
    assert.ok(Object.hasOwn(declared, key), `roots.${key} 必须在 Config 里声明`)
    assert.deepEqual(declared[key].meta?.default, [], `roots.${key} 的默认值必须是空数组`)
  }
  ok('roots.allow / roots.deny / roots.exclude 已在 Schema 声明且默认 []')
}

console.log(`\nconfig-schema tests: ${passed} passed`)
console.log('(run via: node test/config-schema.test.mjs)')
