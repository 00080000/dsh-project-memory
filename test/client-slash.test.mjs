// `/` 菜单自定义源的回归测试：node test/client-slash.test.mjs
//
// 背景：宿主命令只拿得到「指令」组里一行纯文字（宿主 ui-commands 只给第一方 definitionId
// 白名单配图标和中文标题，宿主 CommandDescriptor 也只有 name/description/input）。所以想要
// 图标和分组，唯一的路是插件自己注册一个 `/` 触发器源。
//
// 合并后宿主只剩一条 /tasks（见 src/commands/workflow.js），本源的三个入口都是「打开某个视图」，
// 全部直接执行、不带参数。
//
// 本用例把构建产物在最小宿主替身里求值，直接调用 apply()，检查：
//   1. 源的身份与排序（分组顺序、不抢宿主位置）；
//   2. 候选的图标 / 标题 / section（section 是分组标题的唯一可本地化通道）；
//   3. 位置与查询过滤；
//   4. 点击语义：消费触发 token 后立刻执行对应命令行；
//   5. **降级**：宿主没有 inputTriggers、或注册抛错时，绝不能把整个 client 插件带崩
//      （那会连任务面板一起消失 —— 这正是 0.1.7 会话格式变更打崩插件的教训）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const SRC = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

const docStub = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, appendChild() {} }),
  head: { appendChild() {}, append() {} },
}
const storageStub = { getItem: () => null, setItem() {}, removeItem() {} }
const navStub = { clipboard: { writeText: async () => {} } }
class ReactComponent {
  constructor(props) {
    this.props = props
  }
  setState() {}
  forceUpdate() {}
}
const reactStub = {
  Component: ReactComponent,
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useSyncExternalStore: () => undefined,
  memo: (component) => component,
  forwardRef: (component) => component,
  Fragment: 'Fragment',
}
const jsxRuntimeStub = { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }

/** 宿主 ui-primitives 替身：两版命名都给全，图标一律解析成功。 */
const ICON_NAMES = [
  'IconChevronDownOutline14', 'IconChevronUpOutline14', 'IconQuestionOutline14', 'IconCloseOutline16',
  'IconFolderOpenOutline16', 'IconCheckOutline16', 'IconPlayOutline16',
  'IconChecklistOutline14', 'IconLightOutline16', 'IconGlobeOutline14',
  'IconChevronDownOutlineRegular', 'IconChevronUpOutlineRegular', 'IconQuestionOutlineRegular',
  'IconCloseOutlineRegular', 'IconFolderOpenOutlineRegular', 'IconCheckOutlineRegular', 'IconPlayOutlineRegular',
  'IconChecklistOutlineRegular', 'IconLightOutlineRegular', 'IconGlobeOutlineRegular',
]
const primitivesStub = { Button: () => null, ...Object.fromEntries(ICON_NAMES.map((n) => [n, () => null])) }

/** 在宿主替身里求值产物，返回 client 模块的导出。 */
function loadClient() {
  let registration
  const win = { __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', 'document', 'navigator', 'localStorage', SRC)(win, docStub, navStub, storageStub)
  assert.equal(registration?.id, '@yolk_vat-y/dsh-project-memory', '产物必须用插件包名注册')
  return registration.factory((spec) => {
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
    if (spec === 'react') return reactStub
    if (spec === 'react/jsx-runtime') return jsxRuntimeStub
    throw new Error(`client bundle requested an unexpected external: ${spec}`)
  })
}

/**
 * 造一个最小 client 宿主。
 * @param options.declareTriggers 宿主是否声明 inputTriggers 服务（老/未来宿主可能没有）
 * @param options.registerThrows registerSource 是否抛错（源名撞车等）
 * @param options.activeLocale 当前语言
 * @param options.consumeOk bail（消费触发 token）是否成功
 */
function fakeHost({ declareTriggers = true, registerThrows = false, activeLocale = 'zh', consumeOk = true } = {}) {
  const registered = []
  const executes = []
  const bails = []
  const scope = {
    locale: { getSnapshot: () => ({ active: activeLocale }) },
    sessions: { scope: () => scope },
    remote: {
      commands: {
        execute: async (...args) => {
          executes.push(args)
          return { ok: true, value: { result: { kind: 'success' } } }
        },
      },
    },
    inputTriggers: declareTriggers
      ? {
        registerSource: (source) => {
          if (registerThrows) throw new Error('slash source "project-memory" is already registered')
          registered.push(source)
          return () => {}
        },
      }
      : undefined,
    effect: (fn) => fn(),
    bail: (...args) => {
      bails.push(args)
      return consumeOk
    },
  }
  const injected = []
  const ctx = {
    slots: { inject: () => {}, register: () => {} },
    inject: (deps, callback) => {
      injected.push(deps)
      // 只有宿主真的声明了所需服务时才回调（cordis 的语义：依赖不齐就一直等）。
      if (declareTriggers) callback(scope)
    },
  }
  return { ctx, scope, registered, executes, bails, injected }
}

const pickOf = (name, extra = {}) => ({
  candidate: { name },
  session: { sessionId: 'sess_slash' },
  position: 'leading',
  via: 'menu',
  action: 'pick',
  span: { start: 0, end: 1 + name.length },
  ...extra,
})

/** 造一个已注册好源的宿主。 */
function mounted(options) {
  const client = loadClient()
  const host = fakeHost(options)
  client.apply(host.ctx)
  return { client, host, source: host.registered[0] }
}

// ---- 1. 顶层 inject 不得硬依赖 inputTriggers ----
{
  const client = loadClient()
  assert.equal(typeof client.apply, 'function', 'client 必须导出 apply')
  assert.ok(client.inject.includes('slots'), 'slots 仍是硬依赖')
  assert.ok(!client.inject.includes('inputTriggers'),
    'inputTriggers 必须是软依赖：写进顶层 inject 后，没有 slash 服务的宿主根本不会加载本插件（面板一起消失）')
  ok('inputTriggers 是软依赖（不进顶层 inject）')
}

// ---- 2. 源的身份与排序 ----
{
  const { host, source } = mounted()
  assert.deepEqual(host.injected, [['inputTriggers', 'sessions', 'remote.commands']],
    '按软依赖注入注册 slash 源')
  assert.equal(host.registered.length, 1, '应当注册恰好一个 slash 源')
  assert.equal(source.trigger, '/', '挂在 / 触发上')
  assert.equal(source.name, 'project-memory', '源名（组标识）')
  assert.equal(source.order, 1, '排在宿主内置源（默认 0）之后，不抢主位置')
  assert.equal(source.showGroupTitle, false, '组标题行不渲染（标题由 section 承担）')
  assert.equal(source.matchSpace, undefined, '不参与空格判定，避免抢宿主的分发')
  assert.equal(source.matchEnter, undefined, '不参与回车判定：手敲 /tasks 仍由宿主 command 源处理')
  ok('slash 源身份/排序正确，且不抢宿主的 space/enter 判定')
}

// ---- 3. 候选外观：图标 + 标题 + section（section 就是分组标题） ----
{
  const { source } = mounted()
  const rows = await source.candidates({ sessionId: 's' }, { query: '', position: 'leading' })
  assert.equal(rows.length, 3, '三个视图入口各一行')
  assert.deepEqual(rows.map((r) => r.name), ['任务', '项目记忆', '全局记忆'],
    '顺序即渲染顺序；候选 name 同时是行标题')
  for (const row of rows) {
    assert.equal(row.section, '工作流', `${row.name}: section 就是分组标题（走候选字段，不碰 slash.menu 词典）`)
    assert.equal(row.label, row.name, `${row.name}: label 与 name 相同 → MenuView 不渲染尾随别名`)
    assert.equal(typeof row.description, 'string', `${row.name}: 行描述`)
    assert.equal(typeof row.icon, 'function', `${row.name}: 行图标（宿主目录行拿不到图标，这是本源存在的理由）`)
    assert.equal(row.hint, undefined, `${row.name}: 不声明 input → 不受宿主位置过滤影响`)
  }
  assert.deepEqual(rows.map((r) => r.line), ['/tasks', '/tasks insight list project', '/tasks insight list global'],
    '每行对应一条完整命令行（都走唯一的宿主命令 /tasks）')
  ok('候选带图标 / 标题 / section（section 承载分组标题）')
}

// ---- 4. 语言切换：section 与行标题跟着走（slash.menu 词典做不到这件事） ----
{
  const { source } = mounted({ activeLocale: 'en' })
  const rows = await source.candidates({ sessionId: 's' }, { query: '', position: 'leading' })
  assert.equal(rows[0].section, 'Workflow', '英文宿主下 section 为英文')
  assert.deepEqual(rows.map((r) => r.name), ['Tasks', 'Project Memory', 'Global Memory'], '行标题走英文词典')
  ok('分组标题与行文案可双语（宿主 slash.menu 无法为第三方源做到这点）')
}

// ---- 5. 过滤：位置与查询 ----
{
  const { source } = mounted()
  const at = (req) => source.candidates({ sessionId: 's' }, req)

  assert.equal((await at({ query: '', position: 'leading' })).length, 3, '前导位置三行都在')
  assert.deepEqual(await at({ query: '', position: 'inline' }), [],
    '行内位置的 / 多半是路径：整组不出现')
  assert.deepEqual(await at({ query: '', position: undefined }), (await at({ query: '', position: 'leading' })),
    'position 缺失时按前导位置处理（老宿主兜底）')

  const names = async (query) => (await at({ query, position: 'leading' })).map((r) => r.name)
  assert.deepEqual(await names('任务'), ['任务'], '按中文标题过滤')
  assert.deepEqual(await names('task'), ['任务'], '拉丁别名也能命中（match 词表）')
  assert.deepEqual(await names('memory'), ['项目记忆', '全局记忆'], '一个 match 词可命中多行')
  assert.deepEqual(await names('global'), ['全局记忆'], '按 match 词过滤')
  assert.deepEqual(await names('insight'), ['项目记忆', '全局记忆'], '按 match 词过滤')
  assert.deepEqual(await names('zzz'), [], '无匹配返回空（组自动不渲染）')
  ok('候选过滤：前导/行内位置与查询过滤符合预期')
}

// ---- 6. 点击语义：消费触发 token 后立刻执行该行的命令行 ----
{
  const { host, source } = mounted()

  const handled = source.onPick(pickOf('项目记忆'))
  assert.equal(handled, 'handled', '菜单点击应当立刻执行（不回填 claim，不多要一次回车）')
  assert.equal(host.bails.length, 1, '执行前先消费掉草稿里的触发 token')
  assert.equal(host.bails[0][1], 'slash/input-consume-token', '走宿主公开的 consume-token 契约事件')
  assert.deepEqual(host.bails[0][2], { guard: { kind: 'span', span: { start: 0, end: 5 } } }, '用 span 做 CAS 守卫')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(host.executes.at(-1), ['sess_slash', '/tasks insight list project', []],
    '行 → 命令行映射正确')

  source.onPick(pickOf('任务'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(host.executes.at(-1)[1], '/tasks', '任务视图就是裸 /tasks')

  source.onPick(pickOf('全局记忆'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(host.executes.at(-1)[1], '/tasks insight list global')

  assert.equal(source.onPick(pickOf('nope')), undefined, '未知行不得引发任何动作')
  assert.equal(source.onPick({ candidate: {} }), undefined, '缺 name 时安全返回')
  ok('点击语义：消费 token 后立刻执行对应命令行')
}

// ---- 7. 消费失败仍然执行（只是草稿残留触发文本），不能静默丢动作 ----
{
  const { host, source } = mounted({ consumeOk: false })
  const outcome = source.onPick(pickOf('任务'))
  assert.equal(outcome, 'handled', '消费失败也要报 handled，否则菜单会留下一个「什么都没发生」的点击')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(host.executes.at(-1)[1], '/tasks', '消费失败时命令照常执行')
  ok('consume-token 失败时仍执行命令，不静默丢动作')
}

// ---- 8. 降级：宿主没有 slash 服务 / 注册抛错，都不得带崩整个 client 插件 ----
{
  const client = loadClient()
  const noTriggers = fakeHost({ declareTriggers: false })
  client.apply(noTriggers.ctx)
  assert.equal(noTriggers.registered.length, 0, '没有 inputTriggers 时不注册')
  ok('宿主没有 inputTriggers：静默跳过，不抛错')

  const dup = fakeHost({ registerThrows: true })
  client.apply(dup.ctx)
  ok('registerSource 抛错（源名撞车）：被吞掉，插件其余部分照常')

  // 完全畸形的 ctx：apply 也不得抛
  client.apply({})
  client.apply(undefined)
  ok('ctx 畸形（无 inject/slots）时 apply 不抛错')
}

console.log(`\nclient-slash tests: ${passed} passed`)
process.exit(0)
