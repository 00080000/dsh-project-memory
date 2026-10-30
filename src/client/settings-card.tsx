/**
 * 插件详情页上的「常用设置」卡片。
 *
 * 座位是 `plugins.bundle.config`（key = 包名），外形照宿主自己的插件卡片长：
 * 一行标题 + 说明 + 折叠箭头，**默认收起**；展开后是一列开关，底部右对齐一个保存。
 *
 * 数据面**完全走宿主设置**，不自建第二份配置：
 *   Config 里标了 `.volatile()` 的字段 → 宿主 settings 文档的一个命名空间（ns = 条目 id
 *   `project-memory`）→ 客户端 `ctx.configForms.get('project-memory')` 读写 → 宿主校验 +
 *   revision fence + volatile 原地更新（不重启插件）。这里既不写 profile 的 yml，也不缓存
 *   值：卡片永远是宿主那份配置的投影，命令行改配置和这里改配置是同一条链路。
 *
 * 只放**用户真的会想调、且调了不会让记忆失真**的旋钮（见 SETTINGS_FIELDS 的注释）。
 * memoryDir / roots / insight.* 这类一改就换数据位置或需要理解上下文的，仍留在 profile。
 */
import {
  Button, SettingsFormModel, Switch, settingsNumberField,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SettingsFieldSpec, SettingsFieldState, SettingsFormActions, SettingsFormScope, SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { useEffect, type ReactNode } from 'react'
import { IconChevronDownOutline14 } from './icons.ts'
import { createTranslate, en, zh, type LocaleDict } from './locales.ts'
import css from './SettingsCard.module.css'

/** bundle 包名：`plugins.bundle.config` 的 key 必须与 profile 里安装的包名一致。 */
export const SETTINGS_PACKAGE_NAME = '@yolk_vat-y/dsh-project-memory'
/** 本插件在 profile 的 loader 条目 id（bundle 的 cordis.patch.yml 定死的那个），也是 settings 命名空间。 */
export const SETTINGS_ENTRY_ID = 'project-memory'
/** 卡片文案的 locale 命名空间。与面板共用一份词典，但独立注册，互不影响。 */
export const SETTINGS_NS = 'dsh-project-memory.settings'

/**
 * 卡片编辑的字段；顺序即渲染顺序。
 *
 * 入选标准只有两条：**用户会主动想调**，且**调坏了不会让记忆失真**。
 *   - `autoIndexOnFirstUse`：换项目时最常见的诉求（"启动就把这里索引好"），默认关。
 *   - `watchInterval`：后台刷新唯一值得调的成本旋钮（频率）。监视本身**不提供关闭**——
 *     关掉之后记忆只会越来越旧，那不是一个选项，是一个坑。
 *   - `llmQueryExpansion`：唯一直接花 token 的开关，该由用户自己决定。
 * 刻意**没有**的：lazyIndexing（默认开，关掉只会让断言变旧）、enableTypeScript（内部实现
 * 细节，用户无从判断）、watch（见上）、memoryDir / roots / 扫描上限（改的是数据落在哪）。
 */
export const SETTINGS_FIELDS = [
  'autoIndexOnFirstUse',
  'watchInterval',
  'llmQueryExpansion',
] as const
export type SettingsFieldName = typeof SETTINGS_FIELDS[number]

/** 卡片渲染的一份状态：表单级状态 + 展开状态 + 每个字段的草稿。 */
export interface SettingsCardState extends SettingsFormShell {
  /** 卡片是否展开；默认收起，与宿主的插件卡片一致。 */
  readonly expanded: boolean
  readonly fields: Readonly<Record<SettingsFieldName, SettingsFieldState>>
}

/** 槽位注册侧注入给组件的动作与快照钩子。 */
export interface SettingsCardFace extends SettingsFormActions {
  /** 收起 / 展开卡片。 */
  toggleExpanded: () => void
  hooks: {
    /** 渲染器绑成 `useSettingsCard`。 */
    settingsCard: SnapshotStore<SettingsCardState>
  }
}

/** 渲染器交给组件的 props。`t` 由槽位的 `locale` 选项解析。 */
export interface SettingsCardProps {
  /** 宿主只对 bundle 页要 `page`；`summary` 在本卡片没有对应物。 */
  readonly view?: 'summary' | 'page'
  readonly t?: (key: keyof LocaleDict, params?: Record<string, string | number>) => string
  readonly useSettingsCard?: <S>(selector: (state: SettingsCardState) => S) => S
  readonly toggleExpanded?: () => void
  readonly edit?: (field: string, text: string) => void
  readonly save?: () => void
  readonly discard?: () => void
}

/** 布尔字段：草稿是 `'true'` / `'false'`，其它文本判为非法（挡住保存，而不是吞掉）。 */
function settingsBooleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => typeof value === 'boolean' ? String(value) : '',
    parse: text => text === 'true'
      ? { kind: 'set', value: true }
      : text === 'false'
        ? { kind: 'set', value: false }
        : undefined,
  }
}

/** 把 `project-memory` 命名空间桥到卡片的状态上。 */
export class SettingsCardController {
  private readonly form: SettingsFormModel<Record<string, unknown>>
  private readonly store: SnapshotStore<SettingsCardState>
  private expanded = false

  /**
   * @param scope - 宿主共享配置表单（`ctx.configForms.get('project-memory')`）
   */
  constructor(scope: SettingsFormScope<Record<string, unknown>>) {
    this.form = new SettingsFormModel(scope, [
      settingsBooleanField('autoIndexOnFirstUse'),
      settingsNumberField('watchInterval'),
      settingsBooleanField('llmQueryExpansion'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  /**
   * 构造槽位注入面。
   * @returns 快照钩子、展开动作与表单动作
   */
  inject(): SettingsCardFace {
    return {
      hooks: { settingsCard: this.store },
      toggleExpanded: () => {
        this.expanded = !this.expanded
        // 展开状态不进表单模型；投影自己推一次，别等 scope 变化。
        this.store.set(this.projection())
      },
      ...this.form.actions(),
    }
  }

  /** 释放对宿主命名空间的订阅。 */
  dispose(): void {
    this.form.dispose()
  }

  private projection(): SettingsCardState {
    const fields = {} as Record<SettingsFieldName, SettingsFieldState>
    for (const field of SETTINGS_FIELDS) fields[field] = this.form.field(field)
    return { ...this.form.shell(), expanded: this.expanded, fields }
  }
}

/** 一行：左侧标题 + 说明，右侧控件（与宿主插件卡片的行同构）。 */
function SettingRow(props: {
  readonly title: string
  readonly hint: string
  readonly children: ReactNode
}) {
  return (
    <div className={css.row}>
      <div className={css.labelBox}>
        <span className={css.label}>{props.title}</span>
        <span className={css.hint}>{props.hint}</span>
      </div>
      <div className={css.control}>{props.children}</div>
    </div>
  )
}

/** 宿主导出的"可渲染组件"：普通函数组件，或 `forwardRef` / `memo` 返回的对象。 */
function isComponent(value: unknown): boolean {
  return typeof value === 'function' || (typeof value === 'object' && value !== null)
}

/** 渲染器缺钩子时的占位状态：卡片只显示标题，不读任何宿主值。 */
const UNAVAILABLE_STATE: SettingsCardState = {
  available: false,
  writable: false,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
  expanded: false,
  fields: Object.fromEntries(
    SETTINGS_FIELDS.map(field => [field, { text: '', overridden: false, invalid: false }]),
  ) as Record<SettingsFieldName, SettingsFieldState>,
}

/** 非 Hook 的稳定回退：hook 数量在两次渲染之间不变，避免条件调用 Hooks。 */
const fallbackHook = <S,>(selector: (state: SettingsCardState) => S): S => selector(UNAVAILABLE_STATE)

/**
 * 渲染本插件的常用设置。
 * @param props - 表单快照与动作（由槽位注入）
 * @returns 折叠卡片；`summary` 视图不渲染
 */
export function SettingsCard(props: SettingsCardProps) {
  const t = props.t ?? createTranslate(zh)
  const useSettingsCard = props.useSettingsCard ?? fallbackHook
  // Hook 必须无条件调用：`summary` 只影响后面的返回，不影响 hook 顺序。
  const state = useSettingsCard(snapshot => snapshot)
  const discard = props.discard
  // 离开页面时丢掉未保存的草稿（与宿主设置表单的约定一致；收起卡片不算离开）。
  useEffect(() => () => { discard?.() }, [discard])
  if (props.view === 'summary') return null
  const edit = props.edit
  const save = props.save
  if (edit === undefined || save === undefined) return null
  const disabled = !state.writable || state.saving
  const on = (field: SettingsFieldName): boolean => state.fields[field]?.text === 'true'
  const toggle = (field: SettingsFieldName, next: boolean): void => { edit(field, next ? 'true' : 'false') }
  const expanded = state.expanded === true
  const saveBlocked = !state.dirty || state.invalid || state.saving || !state.writable

  return (
    <div className={expanded ? `${css.card} ${css.cardOpen}` : css.card} data-project-memory-settings>
      <button
        type="button"
        className={css.header}
        aria-expanded={expanded}
        onClick={props.toggleExpanded}
      >
        <span className={css.headText}>
          <span className={css.name}>{t('settings.title')}</span>
          <span className={css.desc}>{t('settings.subtitle')}</span>
        </span>
        {state.dirty ? <span className={css.unsaved}>{t('settings.unsaved')}</span> : null}
        <span className={expanded ? `${css.chevron} ${css.chevronOpen}` : css.chevron}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {expanded
        ? (
          <div className={css.body}>
            {state.available
              ? (
                <>
                  {!state.writable ? <p className={css.notice}>{t('settings.form.readOnly')}</p> : null}
                  <SettingRow title={t('settings.autoIndexOnFirstUse.title')} hint={t('settings.autoIndexOnFirstUse.hint')}>
                    <Switch
                      checked={on('autoIndexOnFirstUse')} disabled={disabled}
                      label={t('settings.autoIndexOnFirstUse.title')}
                      onChange={(next) => { toggle('autoIndexOnFirstUse', next) }}
                    />
                  </SettingRow>
                  <SettingRow title={t('settings.watchInterval.title')} hint={t('settings.watchInterval.hint')}>
                    <input
                      className={css.number}
                      type="number"
                      min={5}
                      max={600}
                      step={1}
                      inputMode="numeric"
                      aria-label={t('settings.watchInterval.title')}
                      value={state.fields.watchInterval.text}
                      disabled={disabled}
                      aria-invalid={state.fields.watchInterval.invalid || undefined}
                      onChange={(event) => { edit('watchInterval', event.target.value) }}
                    />
                    <span className={css.unit}>{t('settings.unit.seconds')}</span>
                  </SettingRow>
                  <SettingRow title={t('settings.llmQueryExpansion.title')} hint={t('settings.llmQueryExpansion.hint')}>
                    <Switch
                      checked={on('llmQueryExpansion')} disabled={disabled}
                      label={t('settings.llmQueryExpansion.title')}
                      onChange={(next) => { toggle('llmQueryExpansion', next) }}
                    />
                  </SettingRow>
                  <div className={css.actions}>
                    {state.failed ? <p className={css.failed} role="status">{t('settings.form.saveFailed')}</p> : null}
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={saveBlocked}
                      onClick={save}
                    >
                      {state.saving ? t('settings.form.saving') : t('settings.form.save')}
                    </Button>
                  </div>
                </>
              )
              : <p className={css.notice}>{t('settings.form.unavailable')}</p>}
          </div>
        )
        : null}
    </div>
  )
}

/**
 * 注册卡片（软依赖，永不抛出）。
 *
 * 两层门控：
 *   1. 嵌套 `inject(['slots','configForms','locale'])` —— 宿主没有设置服务时这里根本不跑；
 *   2. `configForms.whileServed(['project-memory'])` + `slots.inject('plugins.bundle.config')`
 *      —— 命名空间没被宿主提供、或该版本没有这个槽时，不留下任何注册痕迹。
 * @param ctx - client 根上下文
 */
export function registerSettingsCard(ctx: any): void {
  if (typeof ctx?.inject !== 'function') return
  try {
    ctx.inject(['slots', 'configForms', 'locale'], (scope: any) => {
      try {
        mountSettingsCard(scope)
      } catch (err) {
        console.warn(`[${SETTINGS_NS}] settings card registration failed:`, err)
      }
    })
  } catch (err) {
    console.warn(`[${SETTINGS_NS}] settings card injection failed:`, err)
  }
}

/**
 * 在已就绪的 scope 上挂载卡片。
 * @param scope - 三个服务齐备的嵌套上下文
 */
function mountSettingsCard(scope: any): void {
  const slots = scope?.slots
  const configForms = scope?.configForms
  const locale = scope?.locale
  if (typeof slots?.inject !== 'function' || typeof configForms?.get !== 'function'
    || typeof configForms?.whileServed !== 'function' || typeof locale?.register !== 'function') return
  // 卡片的保存按钮 / 开关来自宿主 ui-primitives：缺任何一个都别注册，避免渲染时才炸。
  //
  // ⚠ 组件不等于函数：宿主用 `forwardRef` 包了 Button（导出是对象 `{ $$typeof, render }`），
  // 用 `typeof x === 'function'` 判定会把它当成"不存在"，卡片在真实宿主上整块消失。
  // 这就是当初"测试全绿、界面没东西"的原因 —— 判定必须接受函数与对象两种导出形状。
  if (typeof SettingsFormModel !== 'function' || !isComponent(Switch) || !isComponent(Button)) {
    console.warn(`[${SETTINGS_NS}] host ui-primitives has no settings controls — visual settings disabled`)
    return
  }
  const effect = typeof scope.effect === 'function' ? scope.effect.bind(scope) : null
  const keep = (dispose: unknown): void => {
    if (typeof dispose !== 'function' || effect === null) return
    effect(() => () => {
      try {
        dispose()
      } catch {
        // 宿主已经拆掉这层：忽略
      }
    })
  }
  try {
    keep(locale.register(SETTINGS_NS, { zh, en }))
  } catch (err) {
    // 同 namespace 已注册（HMR 没等到 disposer）：沿用既有词典，卡片照常挂。
    console.warn(`[${SETTINGS_NS}] locale dictionary already registered:`, err)
  }
  const controller = new SettingsCardController(configForms.get(SETTINGS_ENTRY_ID))
  keep(() => controller.dispose())
  keep(configForms.whileServed([SETTINGS_ENTRY_ID], () => slots.inject('plugins.bundle.config', () => slots.register({
    name: 'plugins.bundle.config',
    key: SETTINGS_PACKAGE_NAME,
    locale: SETTINGS_NS,
    inject: () => controller.inject(),
  }, SettingsCard))))
}
