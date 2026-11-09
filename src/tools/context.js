// 工具执行入口的项目上下文：根解析/校验、记忆目录、store 加载、insight 配置。
// 校验必须在建目录之前：否则一个拼错的 root 会被 mkdir 成字面量目录。
import { assertIndexRoot, memoryRootFor, resolveSafeIndexRoot } from '../util/fs.js'
import { ProjectMemoryStore } from '../store.js'
import { cfgInsight } from '../insight-store.js'

export function openProjectContext(exec, args, config) {
  const root = resolveSafeIndexRoot(exec, args.root, config)
  assertIndexRoot(root, args.root || root)
  const memoryDir = memoryRootFor(root, config.memoryDir)
  const store = new ProjectMemoryStore(memoryDir).load()
  const cfg = cfgInsight(config)
  return { root, memoryDir, store, cfg }
}
