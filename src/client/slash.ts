/**
 * 自建 `/` 触发器源：三个视图入口合成一个「工作流」组，只往菜单里加行，不发命令；宿主只给
 * 第一方 definitionId 装配外观，所以标题走候选的 `section`（`slash.menu` 由 ui-input-trigger 独占）。
 * 面板 `closed`/`view` 是浏览器侧状态，直接调 `openView(view)`；也不实现 matchSpace / matchEnter。
 */
import type { ComponentType } from 'react'
import { createTranslate, en, zh } from './locales.ts'
import { service } from './services.ts'
import type { PanelView } from './task-ui-store.ts'
import { IconChecklistOutline16, IconGlobeOutline16, IconLightOutline16 } from './icons.ts'

/** 源的稳定标识：同一 trigger 内唯一，重复注册会抛错。 */
export const SLASH_SOURCE_NAME = 'project-memory'

/**
 * 组的排序权重（越小越靠前，未设时默认 0）。宿主内置源都取默认 0，所以 1 = 排在
 * 「指令 / 技能 / 子智能体」之后；其他插件若也留默认 0 会排在我们前面，1 是最接近的折中。
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
  /** 点击后打开的面板视图页。**纯客户端动作**，不绕宿主命令。 */
  readonly view: PanelView
}

/** 菜单三行。顺序即渲染顺序；标题复用面板已有的 view.* 文案，保证与面板视图名一致。 */
const ROWS: readonly SlashRow[] = [
  {
    labelKey: 'view.task',
    descriptionKey: 'slash.tasks-desc',
    icon: IconChecklistOutline16,
    match: ['tasks', 'task'],
    view: 'task',
  },
  {
    labelKey: 'view.project',
    descriptionKey: 'slash.project-desc',
    icon: IconLightOutline16,
    match: ['memory', 'project', 'insight'],
    view: 'project',
  },
  {
    labelKey: 'view.global',
    descriptionKey: 'slash.global-desc',
    icon: IconGlobeOutline16,
    match: ['memory', 'global', 'insight'],
    view: 'global',
  },
]

/** 本插件的 client 上下文投影：只看得到这几个能力，避免把整个 cordis ctx 传进来。 */
export interface SlashSourceDeps {
  /** 会话服务（`sessions`）：把 sessionId 换回会话 scope，用于消费触发 token。 */
  readonly sessions: any
  /** 打开面板并切到指定页（`taskUIStore.actions.openView`）。注入而非直接 import，方便最小替身单测。 */
  openView(view: PanelView): void
}

/** 翻译函数签名（key 来自 ROWS，不是字面量，故不做类型约束）。 */
type Translate = (key: string, params?: Record<string, string | number>) => string

/** 按当前语言取翻译函数。 */
function translator(ctx: any): Translate {
  // 软探测（services.ts）：宿主没有翻译服务时退英文，而不是抛错。
  const dict = service(ctx, 'locale')?.getSnapshot?.()?.active === 'zh' ? zh : en
  return createTranslate(dict) as unknown as Translate
}

/**
 * 一轮候选：把三行装配成菜单行，再按查询与位置过滤。
 * 三行都不接参数（动作全在面板卡片里），所以位置过滤只做一件事：非 leading 位置不弹这一整组
 * （行内出现的 `/` 多半是路径）。
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
      // **不带 line**：这三行不是命令，是打开面板某一页；动作在 onPick 里按 name 查表得到。
      terms: [title, ...row.match].map((term) => term.toLowerCase()),
    }
  })
  return rows
    .filter((row) => query === '' || row.terms.some((term) => term.startsWith(query)))
    .map(({ terms: _terms, ...candidate }) => candidate)
}

/**
 * 把触发 token 从草稿里删掉（span 做 CAS：草稿被改过就拒绝，什么都不动）。
 * 与宿主 command 源消费菜单点击是同一条契约事件。
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
 * 一次菜单点击：消费掉触发 token 后**直接打开面板的对应页** —— 这三行是「打开某个视图」不是
 * 「执行命令」，`closed`/`view` 是浏览器侧状态；不返回 claim 是因为没有参数要填，消费失败仍切页。
 * @param t - 翻译函数（按当前语言把候选 name 映射回 ROWS）。
 * @param deps - 会话服务与 UI store 动作。
 * @param pick - 宿主给的点击载荷。
 * @returns PickOutcome；拿不到可用形状时返回 undefined（菜单照常关闭，草稿不动）。
 */
export function dispatchSlashPick(t: Translate, deps: SlashSourceDeps, pick: any): unknown {
  const title = pick?.candidate?.name
  if (typeof title !== 'string' || title === '') return undefined
  const row = ROWS.find((candidate) => t(candidate.labelKey) === title)
  if (row === undefined) return undefined
  consumeSpan(deps, pick)
  try {
    deps.openView(row.view)
  } catch (err) {
    console.warn(`[dsh-project-memory] open view ${row.view} failed:`, err)
  }
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
