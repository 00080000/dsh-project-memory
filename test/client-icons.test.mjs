// 客户端图标兼容回归测试：node test/client-icons.test.mjs
//
// 背景：宿主 ui-primitives 的图标命名在 dsh 0.1.7 变过一次 ——
//   0.1.5（含 rc）：尺寸在名字里，IconFolderOpenOutline16 / …Outline14；
//   0.1.7+：尺寸后缀去掉、改字重后缀，IconFolderOpenOutlineRegular / …Medium，尺寸走 size prop。
// ui-primitives 是 web shell 的冻结 seed 模块，插件固定不了版本，所以同一份
// client/client.js 必须能在两种宿主上都解析到图标，否则渲染时 createElement(undefined)
// 抛 "Element type is invalid"，整个任务面板崩掉（这正是 0.1.5 → 0.1.7 升级后的故障）。
//
// 本用例不渲染界面：直接把构建产物在最小宿主替身里求值，看图标解析是否告警。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const SRC = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

const LEGACY = [
  'IconChevronDownOutline14',
  'IconChevronUpOutline14',
  'IconQuestionOutline14',
  'IconCloseOutline16',
  'IconFolderOpenOutline16',
  'IconCheckOutline16',
  'IconPlayOutline16',
  // `/` 菜单行图标（src/client/slash.ts）
  'IconChecklistOutline14',
  'IconGlobeOutline14',
  'IconLightOutline16',
]
const CURRENT = LEGACY.map((name) => name.replace(/(14|16)$/, 'Regular'))

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
  useSyncExternalStore: (subscribe) => (typeof subscribe === 'function' ? undefined : undefined),
  memo: (component) => component,
  forwardRef: (component) => component,
  Fragment: 'Fragment',
}
const jsxRuntimeStub = { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }

/** 在宿主替身里求值产物，返回宿主 ui-primitives 缺失名字引发的告警。 */
function materialize(primitives) {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    let registration
    const win = { __ModuleLoader__: { load: (r) => { registration = r } } }
    new Function('window', 'document', 'navigator', 'localStorage', SRC)(win, docStub, navStub, storageStub)
    assert.equal(registration?.id, '@yolk_vat-y/dsh-project-memory', '产物必须用插件包名注册')
    assert.equal(typeof registration.factory, 'function')
    registration.factory((spec) => {
      if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
      if (spec === 'react') return reactStub
      if (spec === 'react/jsx-runtime') return jsxRuntimeStub
      throw new Error(`client bundle requested an unexpected external: ${spec}`)
    })
  } finally {
    console.warn = originalWarn
  }
  return warnings
}

const missingIconWarnings = (warnings) => warnings.filter((line) => line.includes('ui-primitives exports neither'))

// ---- 0.1.7+ 宿主：只有 IconXxxRegular ----
{
  const table = { Button: () => null, ...Object.fromEntries(CURRENT.map((n) => [n, () => null])) }
  assert.deepEqual(missingIconWarnings(materialize(table)), [])
  ok('0.1.7 宿主（IconXxxRegular）下 10 个图标全部解析到')
}

// ---- 0.1.5 宿主：只有 IconXxx14/16 ----
{
  const table = { Button: () => null, ...Object.fromEntries(LEGACY.map((n) => [n, () => null])) }
  assert.deepEqual(missingIconWarnings(materialize(table)), [])
  ok('0.1.5 宿主（IconXxx14/16）下 10 个图标全部解析到')
}

// ---- 两版都没有：降级告警，不允许抛错 ----
{
  const warnings = materialize({ Button: () => null })
  assert.equal(missingIconWarnings(warnings).length, LEGACY.length)
  ok('宿主缺少图标时逐条告警且不抛错（面板降级而非崩溃）')
}

console.log(`\nclient-icons tests: ${passed} passed`)
// 产物求值会带起客户端 store 的模块级定时器；用例不依赖它们，直接收尾退出。
process.exit(0)
