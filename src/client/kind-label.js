/**
 * 记忆 kind 的展示名（纯函数、零依赖，面板卡片与记忆视图共用）。
 *
 * 为什么单独一个模块：同一份「kind → 词典 key」映射原先在两处各抄一份
 * （TaskComponents.tsx 的 insightKindLabel、MemoryView.tsx 的 kindText，逐字相同）。
 * 新增 kind 时漏改一处，两个界面就会对同一条记忆显示不同的标签；而词典 key 本身
 * 是 locales.ts 的一等公民（`mem.kind.*` 中英两份），映射不该散落在组件里。
 *
 * 语义（刻意定死，边缘输入也用测试钉住）：
 *  - 四个合法 kind 一律走 `t(key)`，语言切换由词典自己负责；
 *  - 其余值**原样返回**（字符串化），绝不回退到某个默认 kind —— 脏数据要让调用方看见；
 *  - 用 `hasOwn` 而不是 `map[kind] ?? kind` 查表：`kind: '__proto__'` / `'constructor'`
 *    在对象字面量上会命中原型成员（返回函数/对象），React 渲染对象会直接抛
 *    "Objects are not valid as a React child"。非 kind 的键必须当成非法值处理。
 * @module dsh-project-memory/client/kind-label
 */

/** kind → 词典 key（唯一一份；与 locales.ts 的 `mem.kind.*` 一一对应）。 */
export const KIND_LABEL_KEYS = Object.freeze({
  lesson: 'mem.kind.lesson',
  decision: 'mem.kind.decision',
  procedure: 'mem.kind.procedure',
  experience: 'mem.kind.experience',
})

/**
 * 一条记忆的 kind 展示名。
 * @param {unknown} kind - 记忆条目的 kind（可能是缺失/脏值）。
 * @param {any} t - 翻译函数。这里刻意不收窄成 `(key: string) => string`：组件的 t 是
 *   `ReturnType<typeof createTranslate>`（key 为词典字面量并集），收窄会让严格模式下的
 *   函数参数逆变检查拒绝调用；key 本身由本模块掌管，调用方只需要"能翻译一个字符串 key"。
 * @returns {string} 本地化后的标签；非法 kind 原样字符串化。
 */
export function insightKindLabel(kind, t) {
  const key = typeof kind === 'string' && Object.hasOwn(KIND_LABEL_KEYS, kind) ? KIND_LABEL_KEYS[kind] : null
  if (key === null) return String(kind ?? '')
  return t(key)
}
