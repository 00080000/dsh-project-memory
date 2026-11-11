// 工具 schema 预算守卫：每次请求都会带上全部工具描述与参数 schema，
// 它是固定成本，不随会话内容变化。这里钉一个上限，防止描述重新膨胀。
import assert from 'node:assert/strict'
import { toolDefinitions } from '../src/index.js'
import { rootParam } from '../src/tools/output.js'

const config = {}
// 从 apply 的注册表生成，不再手抄：新增第 13 个工具会自动进预算。
const defs = toolDefinitions(config, { llm: null }, {})

let chars = 0
let cjk = 0
for (const def of defs) {
  const text = def.description + JSON.stringify(def.parameters)
  chars += text.length
  cjk += (text.match(/[\u4e00-\u9fff]/g) || []).length
}
// 预算按 **token 估算** 判，不按字符：中文字符约 1 token/字，其余约 4 字符/token。
// 之前只看字符，导致"中文描述省字符"被当成省预算——同样的信息换成英文，字符 +25%、token 反而更少。
// 基线（2026-11）：全英前 5458 字符 / 536 汉字 ≈ 1767 token；全英后 6801 字符 / 0 汉字 ≈ 1700 token。
assert.equal(defs.length, 12, '工具数量变化必须同步检查 schema 预算与注册表')
const tokens = cjk + Math.round((chars - cjk) / 4)
console.log(`  tool schema: ${chars} chars · ${cjk} CJK · ~${tokens} tokens (${defs.length} tools)`)
assert.ok(tokens <= 1800, `tool schema budget exceeded: ~${tokens} tokens (${chars} chars, limit ~1800 tokens)`)

// ---- root 参数：形状与"不传 root 会怎样"的提示只有一处声明 ----
// 十一份手写副本收敛成 rootParam() 之后，这里把每个工具的 root 契约钉死：
// 可选根必须写明默认值（否则模型只能猜），必填根必须真的标 required。
{
  assert.deepEqual(rootParam(), { type: 'string', description: 'project root (session cwd, or its nearest project marker)' })
  assert.deepEqual(rootParam({ required: true }), { type: 'string', required: true, description: 'project root (session cwd, or its nearest project marker)' })
  assert.deepEqual(rootParam({ description: 'custom' }), { type: 'string', description: 'custom' })
  assert.notEqual(rootParam(), rootParam(), '每次返回新对象：工具之间不共享可变的 schema 声明')

  const ROOT_DEFAULT = 'project root (session cwd, or its nearest project marker)'
  const ROOT_REQUIRED = { required: true, description: 'project root (relative: session cwd)' }
  // 描述文本是参数而不是统一句式：index_doc 从 file_path 反推根，index_repo/watch_repo 必须显式给根。
  const expected = {
    query_memory: { required: false, description: ROOT_DEFAULT },
    forget: { required: false, description: ROOT_DEFAULT },
    remember: { required: false, description: ROOT_DEFAULT },
    save_lesson: { required: false, description: ROOT_DEFAULT },
    memory_stats: { required: false, description: ROOT_DEFAULT },
    list_tasks: { required: false, description: ROOT_DEFAULT },
    select_task: { required: false, description: ROOT_DEFAULT },
    archive_task: { required: false, description: ROOT_DEFAULT },
    index_doc: { required: false, description: 'project root (default: session project root)' },
    index_repo: ROOT_REQUIRED,
    watch_repo: ROOT_REQUIRED,
  }
  const seen = new Set()
  for (const def of defs) {
    // defineTool 会把 parameters 归一成 JSON Schema：参数在 properties 下，必填在 required 数组里。
    const param = def.parameters?.properties?.root
    if (!param) continue
    seen.add(def.name)
    const want = expected[def.name]
    assert.ok(want, `${def.name}: 新增了 root 参数但没登记语义（请用 rootParam() 并在此钉住）`)
    assert.equal(param.type, 'string', `${def.name}: root 必须是 string`)
    assert.equal(def.parameters.required?.includes('root') === true, Boolean(want.required), `${def.name}: required 形状`)
    assert.equal(param.description, want.description, `${def.name}: root 描述（不传 root 时模型看到的默认值）`)
  }
  for (const name of Object.keys(expected)) assert.ok(seen.has(name), `${name}: 应当声明 root 参数`)
}

console.log('ALL CHECKS PASSED (2 passed)')
