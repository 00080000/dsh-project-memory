// 插件页可视化设置的契约测试：node test/settings-card.test.mjs
//
// 这条 UI 只在**宿主契约齐备**时出现，而它一旦出现就必须真的能读写宿主配置。
// 所以这里钉住两边：
//   宿主侧：卡片上的三个键必须是 volatile —— 宿主 settings 只暴露 volatile 字段，
//           少标一个，卡片上那个开关就永远写不进去（且看起来完全正常）；
//           不该上卡片的键（lazyIndexing / watch / enableTypeScript）必须留在外面；
//           watchInterval 保存后要按新值重排定时器，不能等下次启动。
//   客户端：注册的必须正是 `plugins.bundle.config` + 包名 key + 条目 id `project-memory`；
//           默认收起，展开才渲染三个控件；旧宿主（缺控件 / 命名空间未提供）上**零注册**。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Config } from '../src/index.js'
import { cfgValue, changedConfigKeys } from '../src/util/config.js'
import { WatchManager, applyWatchSettings } from '../src/watch.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

// ---- 1. 宿主契约：卡片上的字段必须是 volatile（否则宿主设置接口拒写） ----
{
  const exposed = ['autoIndexOnFirstUse', 'watchInterval', 'llmQueryExpansion']
  const missing = exposed.filter((key) => Config.dict?.[key]?.meta?.volatile !== true)
  assert.deepEqual(missing, [],
    `这些字段没标 .volatile()：${missing.join(', ')} —— 设置页能渲染，但保存会被宿主以`
    + ' "Config field ... is not volatile" 拒绝，而且没有任何提示')
  // 默认值不能被顺手改掉：卡片显示的就是出厂行为。
  assert.equal(Config.dict.autoIndexOnFirstUse.meta.default, false)
  assert.equal(Config.dict.watchInterval.meta.default, 30)
  assert.equal(Config.dict.llmQueryExpansion.meta.default, false)
  // 刻意不在卡片上的：关掉只会让记忆变旧 / 是内部实现细节。它们回到普通值（不是 ref）。
  for (const key of ['lazyIndexing', 'watch', 'enableTypeScript']) {
    assert.notEqual(Config.dict[key].meta?.volatile, true, `${key} 不该出现在卡片上（volatile 会让它进设置命名空间）`)
  }
  ok('卡片上的三个字段在 Config 里声明为 volatile，其余保持普通值')
}

// ---- 2. 读取形状：volatile 字段是 ref，普通字段是值 ----
{
  const config = { watch: { get: () => false }, lazyIndexing: true, memoryDir: '.m' }
  assert.equal(cfgValue(config, 'watch'), false, 'volatile 字段取 ref.get()')
  assert.equal(cfgValue(config, 'lazyIndexing'), true, '普通字段原样返回')
  assert.equal(cfgValue(undefined, 'watch'), undefined, 'undefined config 不抛错')
  assert.equal(cfgValue({}, 'watch'), undefined, '缺字段返回 undefined')
  ok('cfgValue 同时接受 ref 与普通值（watch 关得掉，不会把 ref 当永远为真）')
}

// ---- 3. volatile 更新路径：整份 Config 的 `[[]]` 必须读成「全部重读」 ----
{
  assert.equal(changedConfigKeys(undefined), null)
  assert.equal(changedConfigKeys([]), null)
  assert.equal(changedConfigKeys([[]]), null, '空路径 = 整份 Config 变了，不能当成"什么都没变"')
  assert.deepEqual([...changedConfigKeys([['watch'], ['watchInterval']])], ['watch', 'watchInterval'])
  assert.deepEqual([...changedConfigKeys([['nested', 'x']])], ['nested'])
  ok('changedConfigKeys：空路径 → null（全部），其余归成顶层字段名')
}

// ---- 4. watch 开关的活生效：关掉不留定时器，改间隔立刻重排 ----
{
  const wm = new WatchManager({}, { memoryDir: '.dsh-project-memory' })
  assert.equal(applyWatchSettings(wm, { watch: false, watchInterval: 30 }), false)
  assert.equal(wm.timer, null, 'watch:false 时不得留下定时器')
  wm.start(30000)
  wm.timer?.unref?.()
  const before = wm.timer
  assert.ok(before, 'watch:true 时应启动')
  // 模拟设置页把间隔改成 45 秒：同一个 ref 对象，值变了。
  let interval = 45
  const config = { watch: { get: () => true }, watchInterval: { get: () => interval } }
  assert.equal(applyWatchSettings(wm, config), true)
  assert.notEqual(wm.timer, before, '应换掉旧定时器（不是排第二个）')
  assert.equal(wm.timer._idleTimeout, 45000, `新间隔应生效，实际 ${wm.timer._idleTimeout}`)
  interval = 5
  applyWatchSettings(wm, config)
  assert.equal(wm.timer._idleTimeout, 5000)
  // 关掉：留一个干净实例，避免进程退出时还有未清理的定时器。
  wm.stop()
  ok('applyWatchSettings：关掉即停、改间隔即重排（volatile 保存当场生效）')
}

// ---- 4b. 整份 apply 在「volatile ref」形状的 Config 上必须能装配 ----
//
// 这是升级后第一次重启的真实形状：配置里的 volatile 键不再是布尔/数字，而是 `{ get() }`。
// 任何一处仍按普通值读（`if (config.watch)`）都会在这里静默变味：ref 恒为真。
{
  const { apply } = await import('../src/index.js')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  // 只把真正 volatile 的三个键换成 ref；其余保持 Config 解析出来的普通值。
  const values = { autoIndexOnFirstUse: false, watchInterval: 30, llmQueryExpansion: false }
  const parsed = Config({ enableTypeScript: false })
  for (const key of Object.keys(values)) parsed[key] = { get: () => values[key] }
  const handlers = new Map()
  const disposers = []
  const tools = []
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    on: (event, fn) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return () => {}
    },
    inject: () => ({ dispose() {} }),
    tools: { register: (tool) => tools.push(tool.name ?? tool) },
    llm: {},
  }
  const cwd = process.cwd()
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-settings-apply-'))
  process.chdir(dir)
  try {
    apply(ctx, parsed)
    assert.ok(tools.length >= 10, `apply 应注册工具，实际 ${tools.length}`)
    const fire = (paths) => { for (const fn of handlers.get('loader/volatile-update') ?? []) fn(paths) }
    assert.equal((handlers.get('loader/volatile-update') ?? []).length, 1, '必须订阅 volatile 更新')
    // 三种事件形状都不能炸：单字段、整份 Config（`[[]]`）、以及"卡片之外的字段"。
    fire([['watchInterval']])
    values.watchInterval = 5
    fire([['watchInterval']])
    fire([[]])
    fire([['lazyIndexing']])
    assert.equal((handlers.get('loader/volatile-update') ?? []).length, 1, '一次装配只订阅一次')
  } finally {
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
    process.chdir(cwd)
  }
  ok('apply 以 volatile ref 形状装配：不抛错，且订阅了 loader/volatile-update')
}

// ---- 5. 客户端注册：槽位 / key / 命名空间，以及旧宿主上的零注册 ----
const SRC = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

const docStub = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, appendChild() {} }),
  head: { appendChild() {}, append() {} },
}
const storageStub = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const navStub = { clipboard: { writeText: async () => {} } }
const reactStub = {
  Component: class { constructor(props) { this.props = props } setState() {} forceUpdate() {} },
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn, useMemo: (fn) => fn(), useSyncExternalStore: () => undefined,
  memo: (c) => c, forwardRef: (c) => c, Fragment: 'Fragment',
}
const jsxRuntimeStub = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' }

/** 一个够用的 SettingsFormModel 替身：只实现卡片用到的那几个方法。 */
class SettingsFormModelStub {
  constructor(scope, specs) { this.scope = scope; this.specs = specs }
  bind(project) {
    let snapshot = project()
    const listeners = new Set()
    return {
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: (next) => { snapshot = next; for (const listener of listeners) listener() },
    }
  }
  shell() { return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false } }
  field(name) {
    const spec = this.specs.find((item) => item.field === name)
    const value = this.scope.getSnapshot().value?.[name]
    return { text: spec.format(value), overridden: false, invalid: false }
  }
  actions() { return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} } }
  dispose() {}
}

const SETTINGS_VALUES = { autoIndexOnFirstUse: false, watchInterval: 30, llmQueryExpansion: false }

/**
 * 在宿主替身里跑 apply，返回观察点。
 * @param options.served 命名空间是否由宿主提供（false → whileServed 不回调）
 * @param options.withForm 宿主 ui-primitives 是否有 settings-form
 */
function mountClient({ served = true, withForm = true } = {}) {
  const registrations = []
  const asked = []
  const watched = []
  const warned = []
  const configForms = {
    get: (ns) => {
      asked.push(ns)
      return {
        getSnapshot: () => ({ status: 'ready', value: { ...SETTINGS_VALUES }, base: {}, user: {}, revision: 3, writable: true }),
        subscribe: () => () => {},
        mutate: async () => true,
      }
    },
    whileServed: (names, register) => {
      watched.push([...names])
      if (!served) return () => {}
      return register(new Set(names))
    },
  }
  const primitivesStub = {
    Switch: (props) => ({ type: 'Switch', props }),
    // 宿主的 Button 是 forwardRef 包出来的**对象**（不是函数）。替身必须照这个形状，
    // 否则"typeof x === 'function'"那类判定会把线上真实组件当成不存在（卡片整块消失）。
    Button: { $$typeof: Symbol.for('react.forward_ref'), render: () => null },
    settingsNumberField: (field) => ({
      field,
      format: (value) => typeof value === 'number' ? String(value) : '',
      parse: (text) => text.trim() === '' ? { kind: 'clear' } : { kind: 'set', value: Number(text) },
    }),
  }
  if (withForm) primitivesStub.SettingsFormModel = SettingsFormModelStub
  const registry = {
    slots: {
      inject: (name, callback) => { if (name === 'plugins.bundle.config' || name === 'shell.overlay') callback() },
      register: (meta, render) => { registrations.push({ ...meta, render }); return () => {} },
    },
    configForms,
    locale: {
      register: () => () => {},
      bind: (ns) => (key) => `T:${ns}:${key}`,
      getSnapshot: () => ({ active: 'zh' }),
    },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ ids: [], byId: {} }) } },
  }
  const ctx = {
    get: (name) => registry[name],
    inject: (deps, callback) => {
      if (deps.some((dep) => registry[dep] === undefined)) return { dispose() {} }
      const scope = { effect: (fn) => fn() }
      for (const dep of deps) scope[dep.split('.')[0]] = registry[dep]
      callback(scope)
      return { dispose() {} }
    },
    effect: (fn) => fn(),
    on: () => () => {},
  }
  let registration
  const win = { __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', 'document', 'navigator', 'localStorage', SRC)(win, docStub, navStub, storageStub)
  const originalWarn = console.warn
  console.warn = (...args) => { warned.push(args.map(String).join(' ')) }
  let client
  try {
    client = registration.factory((spec) => {
      if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
      if (spec === 'react') return reactStub
      if (spec === 'react/jsx-runtime') return jsxRuntimeStub
      throw new Error(`client bundle requested an unexpected external: ${spec}`)
    })
    client.apply(ctx)
  } finally {
    console.warn = originalWarn
  }
  return { registrations, asked, watched, warned }
}

{
  const host = mountClient()
  assert.deepEqual(host.asked, ['project-memory'],
    '卡片必须读写 loader 条目 id 对应的命名空间（project-memory），不是包名')
  assert.deepEqual(host.watched, [['project-memory']],
    '命名空间没被宿主提供时不该留下注册痕迹')
  const card = host.registrations.find((item) => item.name === 'plugins.bundle.config')
  assert.ok(card, '应注册 plugins.bundle.config（本插件详情页的设置区）')
  assert.equal(card.key, '@yolk_vat-y/dsh-project-memory', 'key 必须是 bundle 包名，页面按 pkg.name 查表')
  assert.equal(card.locale, 'dsh-project-memory.settings', '卡片文案走独立 locale 命名空间')
  ok('注册到 plugins.bundle.config：包名 key + project-memory 命名空间（Button 为 forwardRef 对象时也照常注册）')
}

{
  const host = mountClient()
  const card = host.registrations.find((item) => item.name === 'plugins.bundle.config')
  const face = card.inject()
  assert.equal(typeof face.edit, 'function')
  assert.equal(typeof face.save, 'function')
  assert.equal(typeof face.toggleExpanded, 'function', '卡片必须能收起 / 展开')
  assert.ok(face.hooks.settingsCard, 'hooks 里必须带快照源（渲染器会绑成 useSettingsCard）')

  const t = (key) => `T:${key}`
  const render = () => card.render({
    view: 'page',
    t,
    edit: face.edit,
    save: face.save,
    discard: face.discard,
    toggleExpanded: face.toggleExpanded,
    useSettingsCard: (selector) => selector(face.hooks.settingsCard.getSnapshot()),
  })
  const walk = (node, visit) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') return
    if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
    if (typeof node !== 'object') return
    visit(node)
    walk(node.props?.children, visit)
  }
  const collect = (tree) => {
    const types = []
    const texts = []
    const inputs = []
    walk(tree, (node) => {
      if (typeof node.type === 'string') types.push(node.type)
      else if (typeof node.type === 'function') types.push(node.type.name)
      if (node.type === 'input') inputs.push(node)
      // 文本既可能是子节点，也可能是 SettingRow 的 title/hint props（替身不展开函数组件）。
      for (const value of Object.values(node.props ?? {})) {
        if (typeof value === 'string') texts.push(value)
        else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') texts.push(item)
      }
    })
    return { types, texts, inputs }
  }

  // 默认收起：与宿主的插件卡片一致，只露出标题、说明和箭头。
  const collapsed = collect(render())
  assert.equal(collapsed.types.filter((type) => type === 'Switch').length, 0, '收起时不渲染任何控件')
  assert.equal(collapsed.inputs.length, 0, '收起时不渲染数字输入')
  assert.ok(collapsed.texts.includes('T:settings.title'), '收起时也要有标题')
  assert.ok(collapsed.texts.includes('T:settings.subtitle'), '收起时也要有一行说明')

  // 展开：三行（2 个开关 + 1 个数字），且没有"每行一个重置"那种噪音。
  face.toggleExpanded()
  assert.equal(face.hooks.settingsCard.getSnapshot().expanded, true, '展开状态进快照')
  const expanded = collect(render())
  assert.equal(expanded.types.filter((type) => type === 'Switch').length, 2, '两个布尔开关')
  assert.equal(expanded.inputs.length, 1, '一个数字输入（刷新间隔）')
  assert.equal(expanded.inputs[0].props.value, '30', '数字输入显示宿主当前值（30 秒）')
  for (const key of ['settings.autoIndexOnFirstUse.title', 'settings.watchInterval.title',
    'settings.llmQueryExpansion.title']) {
    assert.ok(expanded.texts.includes(`T:${key}`), `卡片文本缺 ${key}`)
  }
  assert.ok(!expanded.texts.includes('T:settings.reset'), '不再有每行的"重置"')
  ok('默认收起；展开后 3 行（2 开关 + 1 输入），没有逐行重置')
}

{
  const host = mountClient({ served: false })
  assert.equal(host.registrations.filter((item) => item.name === 'plugins.bundle.config').length, 0,
    '宿主没提供 project-memory 命名空间时不得注册（不同版本/改过条目 id 的宿主）')
  ok('命名空间未提供 → 零注册（旧宿主/改条目 id 的宿主上不留半截 UI）')
}

{
  const host = mountClient({ withForm: false })
  assert.equal(host.registrations.filter((item) => item.name === 'plugins.bundle.config').length, 0,
    '宿主 ui-primitives 没有 settings-form 时不得注册')
  assert.ok(host.warned.some((line) => line.includes('settings')), '应有一条点名原因的告警，而不是静默消失')
  ok('ui-primitives 缺 settings-form → 零注册 + 一条告警')
}

console.log(`\nsettings-card tests: ${passed} passed`)
console.log('(run via: node test/settings-card.test.mjs)')
// 求值 client 产物会带起模块级 BroadcastChannel（它 ref 住事件循环）；用例不依赖它，直接收尾。
process.exit(0)
