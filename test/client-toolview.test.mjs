// `show_task_panel` 的客户端视图回归测试：node test/client-toolview.test.mjs
//
// 背景：这个工具原来在宿主侧读 `exec.ctx` 并 `emit('dsh:task-panel:show')`，而宿主契约里
// **没有** `ctx`（`ToolRunContext` 只有 `deferContext()` / `concludeTurn()`，
// packages/core/tools/src/index.ts:418），于是它每次都只返回「无法获取上下文」，面板从未打开过。
// 面板状态（closed/minimized）在浏览器侧的 UI store 里，宿主进程碰不到，所以真正的动作只能
// 由客户端视图完成：认领 `ui-tool` 的子槽 `tool.call.toolview` 里 `show_task_panel` 这个 key。
//
// 本用例把构建产物在最小宿主替身里求值，检查：
//   1. 该 key 真的被注册（契约原文："a typo never renders"）；
//   2. 只在**现场执行**时打开面板 —— 历史节点（刷新/切会话后）直接以 result 阶段挂载，
//      那时开面板会让每次打开会话都弹一次；
//   3. 宿主缺这个槽时，apply 不得抛错（别把整个 client 插件带崩）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const SRC = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const STORAGE_KEY = 'dsh-pm-task-panel-ui'

// ---- 每个测试独立的一份宿主替身（localStorage 写入可观测，用来判"面板有没有被打开"） ----
function makeHost({ slotUnavailable = null } = {}) {
  const writes = []
  const storage = {
    getItem: () => null,
    setItem: (k, v) => { writes.push([k, v]) },
    removeItem: () => {},
  }
  const doc = { querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, appendChild() {} }), head: { appendChild() {}, append() {} } }
  const nav = { clipboard: { writeText: async () => {} } }

  // Hook 记忆按"一个已挂载实例"建模：useRef 跨渲染保持，useEffect 由测试显式触发。
  const hooks = { refs: [], effects: [], cursor: 0 }
  const react = {
    Component: class { constructor(p) { this.props = p } setState() {} forceUpdate() {} },
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (i) => [typeof i === 'function' ? i() : i, () => {}],
    useEffect: (fn) => { hooks.effects.push(fn) },
    useLayoutEffect: () => {},
    useRef: (init) => {
      const i = hooks.cursor++
      if (!(i in hooks.refs)) hooks.refs[i] = { current: init }
      return hooks.refs[i]
    },
    useCallback: (f) => f,
    useMemo: (f) => f(),
    useSyncExternalStore: () => undefined,
    memo: (c) => c,
    forwardRef: (c) => c,
    Fragment: 'Fragment',
  }
  const icons = ['IconChevronDownOutline14', 'IconChevronUpOutline14', 'IconQuestionOutline14', 'IconCloseOutline16', 'IconFolderOpenOutline16', 'IconCheckOutline16', 'IconPlayOutline16', 'IconChecklistOutline14', 'IconLightOutline16', 'IconGlobeOutline14',
    'IconChevronDownOutlineRegular', 'IconChevronUpOutlineRegular', 'IconQuestionOutlineRegular', 'IconCloseOutlineRegular', 'IconFolderOpenOutlineRegular', 'IconCheckOutlineRegular', 'IconPlayOutlineRegular', 'IconChecklistOutlineRegular', 'IconLightOutlineRegular', 'IconGlobeOutlineRegular']
  const primitives = { Button: () => null, ...Object.fromEntries(icons.map((n) => [n, () => null])) }

  const regs = []
  const slots = {
    inject: (name, cb) => {
      if (name === slotUnavailable) throw new Error(`slot ${name} unavailable`)
      cb()
    },
    register: (opts, Component) => { regs.push({ ...opts, Component }); return () => {} },
  }

  let registration
  const win = { innerWidth: 1200, __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', 'document', 'navigator', 'localStorage', SRC)(win, doc, nav, storage)
  assert.equal(registration?.id, '@yolk_vat-y/dsh-project-memory', '产物必须用插件包名注册')
  const client = registration.factory((spec) => {
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    if (spec === 'react') return react
    if (spec === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
    if (spec === '@deepseek-ai/dsh-client-ui-slots') return {}
    if (spec === '@deepseek-ai/dsh-client-locale') return {}
    if (spec === '@deepseek-ai/dsh-client-store') return {}
    throw new Error(`client bundle requested an unexpected external: ${spec}`)
  })

  /** 渲染一次该组件实例（hook 游标归零），返回"跑掉本次收集到的 effect"的函数。 */
  const render = (Component, props) => {
    hooks.cursor = 0
    hooks.effects.length = 0
    const out = Component(props)
    const pending = hooks.effects.slice()
    hooks.effects.length = 0
    return { out, runEffects: () => { for (const fn of pending) fn() } }
  }

  return { client, ctx: { slots }, regs, writes, render, resetHooks: () => { hooks.refs.length = 0; hooks.cursor = 0; hooks.effects.length = 0 } }
}

const panelOpened = (writes) => writes.some(([k, v]) => k === STORAGE_KEY && String(v).includes('"closed":false'))

// --- 1. 注册：认领 tool.call.toolview 的 show_task_panel key ---
{
  const h = makeHost()
  h.client.apply(h.ctx)
  const view = h.regs.find((r) => r.name === 'tool.call.toolview')
  assert.ok(view, '必须注册 tool.call.toolview，否则面板永远打不开')
  assert.equal(view.key, 'show_task_panel', 'key 必须等于 wire 工具名（打错就永远不渲染）')
  assert.equal(typeof view.Component, 'function', '必须给出一个组件')
  // 同一次 apply 里的其余注册不该被挤掉
  assert.ok(h.regs.some((r) => r.name === 'shell.overlay'), '面板本体仍要注册')
  assert.ok(h.regs.some((r) => r.name === 'conversation.chat.commandview' && r.key === 'tasks'), '命令节点渲染器仍要注册')
  ok('客户端注册：tool.call.toolview 认领 show_task_panel（key = wire 工具名）')
}

// --- 2. 历史回放：以 result 阶段挂载时**不得**开面板 ---
{
  const h = makeHost()
  h.client.apply(h.ctx)
  const View = h.regs.find((r) => r.name === 'tool.call.toolview').Component
  const r = h.render(View, { phase: 'result', callId: 'c1' })
  r.runEffects()
  assert.equal(panelOpened(h.writes), false, '历史节点重新挂载不得弹面板')
  ok('历史回放：result 阶段挂载不打开面板（刷新/切会话不弹窗）')
}

// --- 3. 现场执行：preparing/start → result 时打开面板 ---
{
  const h = makeHost()
  h.client.apply(h.ctx)
  const View = h.regs.find((r) => r.name === 'tool.call.toolview').Component
  h.render(View, { phase: 'start', callId: 'c2' }).runEffects()
  assert.equal(panelOpened(h.writes), false, 'start 阶段还看不到结果，不该开')
  h.render(View, { phase: 'result', callId: 'c2' }).runEffects()
  assert.equal(panelOpened(h.writes), true, '现场调用的结果一到就必须打开面板')
  ok('现场执行：start → result 打开面板')
}

// --- 4. 降级：宿主没有这个槽时 apply 不得抛错 ---
// `tool.call.toolview` 由 ui-tool 声明，只有它的 `tool-call` 节点挂载时才存在；宿主缺它时
// 只该少一个开面板的入口，绝不能把整个 client 插件（含面板本体）带崩。
{
  const h = makeHost({ slotUnavailable: 'tool.call.toolview' })
  assert.doesNotThrow(() => h.client.apply(h.ctx), '槽不可用时 apply 必须降级而不是抛')
  assert.ok(h.regs.some((r) => r.name === 'shell.overlay'), '降级后面板本体仍应注册成功')
  assert.equal(h.regs.some((r) => r.name === 'tool.call.toolview'), false, '不可用的槽不该有注册记录')
  ok('降级：tool.call.toolview 不可用时只少一个入口，其余注册照旧')
}

// --- 5. 畸形容器：slots 空壳 / 无 ctx / 空 ctx 都不得抛 ---
{
  const h = makeHost()
  h.ctx.slots = { inject: () => {}, register: () => {} }
  assert.doesNotThrow(() => h.client.apply(h.ctx), 'slots 是空壳时 apply 不得抛')
  h.client.apply(undefined)
  h.client.apply({})
  ok('畸形 ctx（slots 空壳 / undefined / {}）时 apply 不抛错')
}

console.log(`\nclient-toolview tests: ${passed} passed`)
// 产物求值会带起客户端 store 的模块级 BroadcastChannel（它 ref 住事件循环）；用例不依赖它，直接收尾。
// 与 test/client-icons / client-slash 同款。
process.exit(0)
