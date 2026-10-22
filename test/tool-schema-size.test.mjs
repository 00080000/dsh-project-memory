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
for (const def of defs) {
  chars += def.description.length + JSON.stringify(def.parameters).length
}
console.log(`  tool schema: ${chars} chars (${defs.length} tools)`)
// 2026-10 的基线：压缩前约 9100 字符，压缩后约 5200。留一点余量，但不再回到 6k 以上。
assert.ok(chars <= 5600, `tool schema budget exceeded: ${chars} chars (limit 5600)`)
console.log('ALL CHECKS PASSED (1 passed)')
