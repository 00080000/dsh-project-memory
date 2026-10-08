// 客户端半边「降级挂载」回归测试：node test/client-degraded.test.mjs
//
// 背景：cordis 的顶层 `inject` 是**装配期门控** —— 声明的一项在当前客户端装配里不可用，
// `apply()` 根本不会被调用。对插件来说这是最坏的失败形态：没有面板、没有 `/` 组、
// 也没有任何报错（0.1.7 会话快照变更、0.2.0 装配差异都踩过这一条）。
//
// 本用例把构建产物在宿主替身里求值，锁住四件事：
//   1. 顶层 inject 为空：贫服务宿主上 apply 也得跑完（插件一定挂载）；
//   2. 宽限期后仍缺服务 → **一条**点名缺失项的 console.warn（不是静默消失）；
//   3. 服务齐全 → 不误报；缺服务 → 面板**真的渲染出原因**（不只是打日志）；
//   4. 源码里不得再出现 `ctx.<必需服务>` 直接取值（一律走 services.ts 的软探测）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const SRC = read('client/client.js')

const docStub = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, appendChild() {} }),
  head: { appendChild() {}, append() {} },
}
const storageStub = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const navStub = { clipboard: { writeText: async () => {} } }
const winStub = { __ModuleLoader__: null, innerWidth: 1440, innerHeight: 900 }

/** 副作用队列：替身里 useEffect 只入队，由 renderPanelText 在渲染后统一执行（等价于一次挂载）。 */
const pendingEffects = []


/** React 替身：hooks 有最小实现，`useSyncExternalStore` 直接给快照（面板因此真的能渲染）。 */
const reactStub = {
  Component: class { constructor(props) { this.props = props } setState() {} },
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] },
  }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: (fn) => { pendingEffects.push(fn) },
  useLayoutEffect: (fn) => { pendingEffects.push(fn) },
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useSyncExternalStore: (subscribe, getSnapshot) => {
    const snapshot = getSnapshot()
    // 外壳替身模拟「用户已经把面板打开」：真实宿主里 closed 默认 true、默认折叠成迷你条，
    // 降级原因随面板一起显示（面板没开时用户只看得到 console.warn）。
    if (snapshot !== null && typeof snapshot === 'object' && 'closed' in snapshot) {
      return { ...snapshot, closed: false, minimized: false }
    }
    return snapshot
  },
  memo: (component) => component,
  forwardRef: (component) => component,
  Fragment: 'Fragment',
}
/** JSX 替身保留 type/props（静态扫描渲染结果用）。 */
const jsxRuntimeStub = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  Fragment: 'Fragment',
}

const ICON_NAMES = [
  'IconChevronDownOutline14', 'IconChevronUpOutline14', 'IconQuestionOutline14', 'IconCloseOutline16',
  'IconFolderOpenOutline16', 'IconCheckOutline16', 'IconPlayOutline16',
  'IconChecklistOutline14', 'IconLightOutline16', 'IconGlobeOutline14',
]
const primitivesStub = { Button: () => null, ...Object.fromEntries(ICON_NAMES.map((n) => [n, () => null])) }

/** 在宿主替身里求值产物，返回 client 模块导出。 */
function loadClient() {
  let registration
  const win = { ...winStub, __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', 'document', 'navigator', 'localStorage', SRC)(win, docStub, navStub, storageStub)
  return registration.factory((spec) => {
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
    if (spec === 'react') return reactStub
    if (spec === 'react/jsx-runtime') return jsxRuntimeStub
    throw new Error(`client bundle requested an unexpected external: ${spec}`)
  })
}

/** 一次 apply 期间抓到的告警（用完立刻还原 console.warn）。 */
function captureWarnings(fn) {
  const warns = []
  const original = console.warn
  console.warn = (...args) => { warns.push(args.map((a) => String(a)).join(' ')) }
  try {
    fn()
  } finally {
    console.warn = original
  }
  return warns
}

/** 各服务的替身。 */
const slotsStub = (regs) => ({
  inject: (_name, callback) => { callback() },
  register: (meta, render) => { regs.push({ ...meta, render }) },
})
const sessionsStub = () => ({
  list: {
    subscribe: () => () => {},
    getSnapshot: () => ({ ids: ['sess_1'], byId: { sess_1: { blank: false, retainedBy: { mainView: 1 } } } }),
  },
})
const remoteStub = () => ({
  commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: '{}' } } }) },
})
const localeStub = (active) => ({ getSnapshot: () => ({ active }) })
const inputTriggersStub = (sources) => ({ registerSource: (source) => { sources.push(source); return () => {} } })

/**
 * 最小 client 宿主替身。
 * @param options.services 装配里**存在**的服务名（'slots' / 'sessions' / 'remote' / 'locale' / 'inputTriggers'）
 * @param options.bare 连 `ctx.inject` 都没有的老宿主（软依赖只剩属性回退那条路）
 * @param options.activeLocale `locale` 服务报的语言
 */
function fakeHost({ services = [], bare = false, activeLocale = 'zh' } = {}) {
  const regs = []       // slots.register 记录
  const sources = []    // inputTriggers.registerSource 记录
  const scheduled = []  // ctx.setTimeout 捕获（宽限期检查），测试里手动触发
  const ctx = { setTimeout: (fn) => { scheduled.push(fn); return 0 } }

  const resolveDep = (dep) => {
    const [head, ...rest] = dep.split('.')
    if (!(head in ctx)) return undefined
    let value = ctx[head]
    for (const key of rest) value = value?.[key]
    return value
  }

  if (services.includes('slots')) ctx.slots = slotsStub(regs)
  if (services.includes('sessions')) ctx.sessions = sessionsStub()
  if (services.includes('remote')) ctx.remote = remoteStub()
  if (services.includes('locale')) ctx.locale = localeStub(activeLocale)
  if (services.includes('inputTriggers')) ctx.inputTriggers = inputTriggersStub(sources)

  if (!bare) {
    ctx.inject = (deps, callback) => {
      // cordis 语义：依赖齐了就回调，不齐就一直等（永不回调）。
      const scope = { effect: (fn) => fn() }
      for (const dep of deps) {
        const value = resolveDep(dep)
        if (value === undefined) return { dispose() {} }
        scope[dep.split('.')[0]] = value
      }
      callback(scope)
      return { dispose() {} }
    }
  }

  return { ctx, regs, sources, scheduled }
}

/** 触发宽限期检查（`later()` 把回调交给了替身的 setTimeout）。 */
function runGraceChecks(host) {
  const pending = host.scheduled.splice(0)
  for (const fn of pending) fn()
}

/**
 * 渲染一次已注册的面板，返回其中所有文本片段。
 * 直接调用 `TaskPanelView`（跳过 class 形式的错误边界）：这里要断言的是它渲染出的**文本**；
 * 渲染后跑一遍 effect（等价于一次挂载），顺带证明缺服务的宿主上 effect 也不抛。
 */
function renderPanelText(regs) {
  const record = regs.find((r) => r.name === 'shell.overlay')
  assert.ok(record, '面板没注册，渲染无从谈起')
  pendingEffects.length = 0
  const entryElement = record.render()             // <TaskPanelEntry ctx={ctx} />
  const boundary = entryElement.type(entryElement.props)   // <PanelErrorBoundary>…</PanelErrorBoundary>
  const viewElement = boundary.props.children              // <TaskPanelView ctx={ctx} />
  const tree = viewElement.type(viewElement.props)
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node === 'object' && 'props' in node) walk(node.props?.children)
  }
  walk(tree)
  pendingEffects.splice(0).forEach((effect) => { effect() })
  return out
}

const client = loadClient()

// ---- 1. 顶层 inject 为空：贫服务宿主上 apply 也得跑完，宽限后点名缺失服务 ----
{
  assert.deepEqual([...client.inject], [],
    '顶层 inject 必须为空：门控缺一项就根本不调用 apply()，也就是"界面上静默消失"')
  const host = fakeHost({ services: [], bare: true })
  const before = captureWarnings(() => { client.apply(host.ctx) })
  assert.ok(!before.some((w) => w.includes('degraded')),
    '宽限期没到之前不得报降级（装配是异步的，apply 时服务没到位很正常）')

  const after = captureWarnings(() => { runGraceChecks(host) })
  const degraded = after.filter((w) => w.includes('degraded'))
  assert.equal(degraded.length, 1, `过了宽限期仍然缺服务 → 恰好一条告警（静默才是要修的形态）：${after.join(' | ')}`)
  for (const name of ['slots', 'sessions', 'remote', 'remote.commands', 'locale']) {
    assert.ok(degraded[0].includes(name), `告警必须点名缺失的服务：漏了 ${name}（${degraded[0]}）`)
  }
  assert.deepEqual(captureWarnings(() => { runGraceChecks(host) }), [], '宽限检查是一次性的（不刷屏）')
  ok('顶层 inject 为空；缺服务时 apply 跑完，宽限后一条告警点名所有缺失项')
}

// ---- 2. 只有 slots：面板挂载成功，告警只点名真正缺的那些 ----
{
  const host = fakeHost({ services: ['slots'], bare: true })
  captureWarnings(() => { client.apply(host.ctx) })
  assert.ok(host.regs.some((r) => r.name === 'shell.overlay'), 'slots 在就必须挂上面板（而不是整体消失）')

  const host2 = fakeHost({ services: ['slots'], bare: true })
  captureWarnings(() => { client.apply(host2.ctx) })
  const line = captureWarnings(() => { runGraceChecks(host2) }).find((w) => w.includes('degraded'))
  assert.ok(line, '缺 sessions/remote/locale 时要告警')
  assert.ok(!line.includes('slots'), `slots 明明在，不该被点名：${line}`)
  assert.ok(line.includes('remote.commands'), `数据通道缺失必须点名：${line}`)
  ok('只有 slots 的宿主：面板照常挂载，告警只点名真正缺的服务')
}

// ---- 3. 服务齐全：不误报，面板与 `/` 源都注册 ----
{
  const host = fakeHost({ services: ['slots', 'sessions', 'remote', 'locale', 'inputTriggers'] })
  const warns = captureWarnings(() => { client.apply(host.ctx) })
  assert.deepEqual(warns, [], '服务齐全时 apply 不该有任何告警')
  runGraceChecks(host)
  assert.deepEqual(warns, [], '宽限后也不该有告警（误报会让每次启动都刷一行）')
  assert.ok(host.regs.some((r) => r.name === 'shell.overlay'), '面板注册')
  assert.equal(host.sources.length, 1, '/ 菜单源注册')
  ok('服务齐全：无告警（不误报），面板与 slash 源照常注册')
}

// ---- 4. 缺数据通道：面板把原因渲染在界面上（不只是 console） ----
{
  const host = fakeHost({ services: ['slots', 'sessions', 'locale'], activeLocale: 'zh' })
  captureWarnings(() => { client.apply(host.ctx) })
  const texts = renderPanelText(host.regs)
  const joined = texts.join(' | ')
  assert.ok(joined.includes('插件降级：缺少客户端服务 remote, remote.commands'),
    `面板必须显示降级原因与缺失项：${joined}`)
  assert.ok(!joined.includes('还没有会话'), '会话服务在，就不该误报"还没有会话"')
  ok('缺 remote：面板渲染出降级原因（中文），且不误报会话缺失')
}

// ---- 5. 静态守卫：源码里不得再直接取 ctx.<必需服务>（一律走 services.ts 软探测） ----
{
  const FILES = ['client.ts', 'TaskPanel.tsx', 'TaskComponents.tsx', 'MemoryView.tsx', 'slash.ts', 'ShowTaskPanelNode.tsx', 'TaskCommandNode.tsx']
  const DIRECT = /\bctx\??\.(slots|sessions|remote|locale)\b/
  const offenders = []
  for (const file of FILES) {
    read(`src/client/${file}`).split('\n').forEach((line, i) => {
      const code = line.trim()
      // 注释里点名这些服务正是为了解释"为什么要走软探测"，只扫代码行。
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return
      if (DIRECT.test(line)) offenders.push(`src/client/${file}:${i + 1}  ${code}`)
    })
  }
  assert.deepEqual(offenders, [],
    `这些行绕过了软探测：\n${offenders.join('\n')}\n`
    + '（cordis 里"没有 inject 又没有实现"时 ctx.<service> 会抛错，必须走 services.ts 的 service()）')
  ok('静态守卫：src/client 里不再有 ctx.<必需服务> 直接取值')
}

console.log(`\nclient-degraded tests: ${passed} passed`)
// 产物求值带起客户端 store 的模块级 BroadcastChannel（它 ref 住事件循环）；用例不依赖它，直接收尾。
process.exit(0)
