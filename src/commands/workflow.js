/**
 * 单一用户命令 `/tasks`：把合并前的三条宿主命令（`/tasks`、`/task`、`/insight`）收成一条，
 * 其余动作作为「子动词」由面板按钮经 `remote.commands.execute` 直接驱动。
 *
 * 为什么合并：宿主命令**只要注册就会出现在 `/` 菜单的「指令」组里** —— `commands.list()`
 * 与 `commands.execute()` 读同一个视图，`CommandDefinition` 也没有 hidden 字段，插件无法隐藏
 * 自己的宿主命令（见 client/slash.ts 的长注释）。三条命令 = 三行去不掉的原始行；而用户可见
 * 入口已经收进自建的「工作流」组，于是同一批能力在菜单里出现两遍。合并后只剩一行。
 *
 * 为什么**不**声明 `input`：声明了就是 leadingInput —— 手敲 `/tasks` 回车时，
 * `ui-commands.matchEnter` 对带 input 的命令一律返回 claim（回填 `/tasks ` 并要求再按一次
 * 回车）。不声明时裸 `/tasks` 回车立刻执行，与合并前完全一致。
 * 代价：手敲 `/tasks switch x` 这类带参数的行不再被认作命令（会作为普通消息发给模型）。
 * 这些动作的入口本来就是面板按钮，不需要用户手敲。
 *
 * 子动词约定：
 *   /tasks                                   → 任务清单快照（等价于合并前的 /tasks）
 *   /tasks switch|archive|unbind|rename|todos …  → 任务动作（等价于 /task …）
 *   /tasks insight list|confirm|promote|… …      → 记忆动作（等价于 /insight …）
 */
import { tasksCommandDefinition } from './tasks.js'
import { taskCommandDefinition } from './task-actions.js'
import { insightCommandDefinition } from './insight-actions.js'

/** 记忆动作的分派前缀；也是 `/tasks` 之后第一个 token。 */
const INSIGHT_VERB = 'insight'

/**
 * 造出唯一的用户命令定义。
 * @param {object} config - 插件配置
 * @param {object} ctx - 宿主上下文
 * @returns {{name: string, description: string, handler: Function}}
 */
export function workflowCommandDefinition(config, ctx) {
  const snapshot = tasksCommandDefinition(config, ctx)
  const taskAction = taskCommandDefinition(config, ctx)
  const insightAction = insightCommandDefinition(config, ctx)
  return {
    name: 'tasks',
    description: '工作流面板：任务清单与项目经验（切换/归档/审核等动作由面板按钮驱动）',
    handler: (invocation) => {
      const raw = (invocation?.rawInput || '').trim()
      const verb = raw === '' ? '' : raw.split(/\s+/)[0]
      // 裸 /tasks：任务清单快照（保持合并前的行为与文案）
      if (verb === '') return snapshot.handler(invocation)
      // /tasks insight …：把前缀剥掉后原样交给记忆动作处理器（它自己 trim + 分词）
      if (verb === INSIGHT_VERB) {
        return insightAction.handler({ ...invocation, rawInput: raw.slice(INSIGHT_VERB.length) })
      }
      // 其余一律当任务动作（switch / archive / unbind / rename / todos）
      return taskAction.handler(invocation)
    },
  }
}
