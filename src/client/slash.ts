/**
 * 自建 `/` 触发器源：把工作流的三个视图入口收进一个带图标和小节标题的「工作流」组。
 *
 * 为什么必须自建源：`/` 菜单里的「分组」就是触发器源（ui-input-trigger 的 roster），
 * 而宿主 ui-commands 给目录行装配外观时只认第一方 definitionId 白名单
 * （presentation.ts 的 HOST_FACES / SECTION_ROWS），且宿主 CommandDescriptor 只有
 * name/description/input —— 没有 icon、没有分组、没有隐藏开关。第三方宿主命令因此
 * 永远只是「指令」小节末尾一行纯文字。
 *
 * 两个宿主约束决定了这里的写法：
 *  1. **分组标题走候选的 `section`，不走 `slash.menu` 词典。** 组标题查的是 `slash.menu`
 *     namespace，而它由 ui-input-trigger 独占：`register('slash.menu','zh')` 会抛
 *     "already has locale"，未知 key 则原样回显源名。MenuView 在「组内任一行带 section」时
 *     干脆不渲染组标题行，只渲染 section 标题 —— 于是标题文案回到我们手里，还能按语言切换。
 *  2. **只做增量，不抢宿主的分发。** 这里不实现 matchSpace / matchEnter，所以手敲 `/tasks`、
 *     面板调 remote.commands.execute 全部走宿主原有路径。本源只是往菜单里多添一组行。
 *
 * 与「指令」组的重复：合并前插件注册了 /tasks、/task、/insight 三条宿主命令，菜单里就是三行
 * 去不掉的原始行 —— 宿主命令只要注册就会出现在目录里，`commands.list()` 与
 * `commands.execute()` 读同一个视图，`CommandDefinition` 也没有 hidden 字段，插件无法隐藏。
 * 现在宿主只剩一条 /tasks（见 src/commands/workflow.js），重复降到一行；那一行也是插件
 * 执行宿主侧工作的唯一通道（插件没有自己的 client→host RPC）。
 */
import type { ComponentType } from 'react'
import { createTranslate, en, zh } from './locales.ts'
import { IconChecklistOutline16, IconGlobeOutline16, IconLightOutline16 } from './icons.ts'

/** 源的稳定标识：同一 trigger 内唯一，重复注册会抛错。 */
export const SLASH_SOURCE_NAME = 'project-memory'

/**
 * 组的排序权重（越小越靠前，未设时默认 0）。
 * 宿主内置源都取默认 0，所以 1 = 一定排在「指令 / 技能 / 子智能体」之后。
 * 没有能同时满足「在宿主之后」与「在所有其他插件之前」的取值：其他插件若也留默认 0
 * 就会排在我们前面。1 是最接近的折中，且不会去抢宿主主位置。
 */
export const SLASH_SOURCE_ORDER = 1

/** 一行候选：候选 name 与标题同源（本地化文本），名称即身份、即标题。 */
interface SlashRow {
  /** 词典 key：既作候选 name（组内唯一身份）也作行标题。 */
  readonly labelKey: string
  /** 行描述词典 key。 */
  readonly descriptionKey: string
  /** 行图标；图标名按宿主版本自适应，见 icons.ts。 */
  readonly icon: ComponentType<{ size?: number; className?: string }>
  /** 额外搜索词：候选 name 是中文，拉丁输入（task / memory…）靠这些命中。 */
  readonly match: readonly string[]
  /** 点击后经 remote.commands.execute 执行的完整命令行。 */
  readonly line: string
}

/** 菜单三行。顺序即渲染顺序；标题复用面板已有的 view.* 文案，保证与面板视图名一致。 */
const ROWS: readonly SlashRow[] = [
  {
    labelKey: 'view.task',
    descriptionKey: 'slash.tasks-desc',
    icon: IconChecklistOutline16,
    match: ['tasks', 'task'],
    line: '/tasks',
  },
  {
    labelKey: 'view.project',
    descriptionKey: 'slash.project-desc',
    icon: IconLightOutline16,
    match: ['memory', 'project', 'insight'],
    line: '/tasks insight list project',
  },
  {
    labelKey: 'view.global',
    descriptionKey: 'slash.global-desc',
    icon: IconGlobeOutline16,
    match: ['memory', 'global', 'insight'],
    line: '/tasks insight list global',
  },
]

/** 本插件的 client 上下文投影：只看得到这几个能力，避免把整个 cordis ctx 传进来。 */
export interface SlashSourceDeps {
  /** 会话服务（`sessions`）：把 sessionId 换回会话 scope，用于消费触发 token。 */
  readonly sessions: any
  /** 执行一条完整命令行；返回 composer 认得的 SubmitOutcome 形状。 */
  run(session: any, line: string, attachments?: readonly unknown[]): Promise<{ kind: 'success' | 'error'; text?: string }>
}

/** 翻译函数签名（key 来自 ROWS，不是字面量，故不做类型约束）。 */
type Translate = (key: string, params?: Record<string, string | number>) => string

/** 按当前语言取翻译函数。 */
function translator(ctx: any): Translate {
  const dict = ctx?.locale?.getSnapshot?.()?.active === 'zh' ? zh : en
  return createTranslate(dict) as unknown as Translate
}

/**
 * 一轮候选：把三行装配成菜单行，再按查询与位置过滤。
 *
 * 三行都不接参数（动作全在面板卡片里），所以位置过滤只做一件事：行内出现的 `/` 多半是路径，
 * 不弹这一整组（宿主对无 input 命令在前导/行内都放行，这里更保守）。
 * @param t - 翻译函数。
 * @param req - 宿主给的候选请求（query / position）。
 * @returns 菜单行；永不抛出。
 */
export function buildSlashCandidates(t: Translate, req: any): readonly Record<string, unknown>[] {
  if (req?.position !== undefined && req.position !== 'leading') return []
  const query = typeof req?.query === 'string' ? req.query.trim().toLowerCase() : ''
  const rows = ROWS.map((row) => {
    const title = t(row.labelKey)
    return {
      name: title,
      // label 与 name 相同 → MenuView 不渲染尾随别名（这些是视图入口，不是命令名）
      label: title,
      description: t(row.descriptionKey),
      icon: row.icon,
      // 每一行都带 section → MenuView 不渲染组标题行，只渲染这个标题。
      section: t('slash.group'),
      line: row.line,
      terms: [title, ...row.match].map((term) => term.toLowerCase()),
    }
  })
  return rows
    .filter((row) => query === '' || row.terms.some((term) => term.startsWith(query)))
    .map(({ terms: _terms, ...candidate }) => candidate)
}

/**
 * 把触发 token 从草稿里删掉（span 做 CAS：草稿被改过就拒绝，什么都不动）。
 * 这是宿主 command 源消费菜单点击的同一条契约事件。
 * @returns true 表示确实消费掉了。
 */
function consumeSpan(deps: SlashSourceDeps, pick: any): boolean {
  try {
    const scope = deps.sessions?.scope?.(pick?.session?.sessionId)
    if (!scope || typeof scope.bail !== 'function') return false
    return scope.bail(scope, 'slash/input-consume-token', {
      guard: { kind: 'span', span: pick.span },
    }) === true
  } catch (err) {
    console.warn('[dsh-project-memory] slash token consume failed:', err)
    return false
  }
}

/**
 * 一次菜单点击：消费掉触发 token 后立刻执行该行对应的命令行。
 *
 * 不返回 claim（回填 `/xxx ` 再等回车）：这三行都是「打开某个视图」，claim 会多要一次回车，
 * 而且子动词（`insight list project`）也没法由一个 claim token 表达。消费失败时仍然执行，
 * 只是草稿里残留的触发文本要用户自己清掉 —— 比回填一个会执行错命令的 claim 安全。
 * @param t - 翻译函数（按当前语言把候选 name 映射回 ROWS）。
 * @param deps - 会话服务与命令执行通道。
 * @param pick - 宿主给的点击载荷。
 * @returns PickOutcome；拿不到可用形状时返回 undefined（菜单照常关闭，草稿不动）。
 */
export function dispatchSlashPick(t: Translate, deps: SlashSourceDeps, pick: any): unknown {
  const title = pick?.candidate?.name
  if (typeof title !== 'string' || title === '') return undefined
  const row = ROWS.find((candidate) => t(candidate.labelKey) === title)
  if (row === undefined) return undefined
  consumeSpan(deps, pick)
  void deps.run(pick.session, row.line, []).catch((err: unknown) => {
    console.warn(`[dsh-project-memory] ${row.line} failed:`, err)
  })
  return 'handled'
}

/**
 * 造出注册给 `ctx.inputTriggers.registerSource` 的源对象。
 * @param ctx - client 根上下文（只读 locale）。
 * @param deps - 会话服务与命令执行通道。
 * @returns 触发器源；只依赖宿主的公开契约字段。
 */
export function createSlashSource(ctx: any, deps: SlashSourceDeps): Record<string, unknown> {
  const t = translator(ctx)
  return {
    trigger: '/',
    name: SLASH_SOURCE_NAME,
    order: SLASH_SOURCE_ORDER,
    // 组标题不渲染：行上都有 section，MenuView 会用 section 标题取代它。
    showGroupTitle: false,
    candidates: async (_session: unknown, req: any) => buildSlashCandidates(t, req),
    onPick: (pick: any) => dispatchSlashPick(t, deps, pick),
  }
}
