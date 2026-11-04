// 工具 schema 预算守卫：每次请求都会带上全部工具描述与参数 schema，
// 它是固定成本，不随会话内容变化。这里钉一个上限，防止描述重新膨胀。
import assert from 'node:assert/strict'
import { lessonTool } from '../src/tools/lesson-tools.js'
import { queryMemoryTool } from '../src/tools/query-memory.js'
import { forgetTool } from '../src/tools/forget.js'
import { rememberTool } from '../src/tools/remember.js'
import { indexRepoTool } from '../src/tools/index-repo.js'
import { indexDocTool } from '../src/tools/index-doc.js'
import { watchRepoTool } from '../src/tools/watch-repo.js'
import { statsTool } from '../src/tools/stats.js'
import { listTasksTool, selectTaskTool, archiveTaskTool, showTaskPanelTool } from '../src/tools/task-tools.js'

const config = {}
const defs = [
  lessonTool(config),
  queryMemoryTool({}, config),
  forgetTool(config),
  rememberTool(config),
  indexRepoTool({}, config),
  indexDocTool({}, config),
  watchRepoTool({}, config),
  statsTool(config),
  listTasksTool(config),
  selectTaskTool(config, {}),
  archiveTaskTool(config, {}),
  showTaskPanelTool(config),
]

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
const tokens = cjk + Math.round((chars - cjk) / 4)
console.log(`  tool schema: ${chars} chars · ${cjk} CJK · ~${tokens} tokens (${defs.length} tools)`)
assert.ok(tokens <= 1800, `tool schema budget exceeded: ~${tokens} tokens (${chars} chars, limit ~1800 tokens)`)
console.log('ALL CHECKS PASSED (1 passed)')
