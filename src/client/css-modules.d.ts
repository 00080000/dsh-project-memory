/**
 * CSS Modules 的类型声明（仅服务 tsc 类型检查）。
 *
 * 客户端样式由 tsdown 的 `dsh-css-modules-inline` 插件在构建期内联：
 * `.module.css` 被编译成 `{ <local>: '<hash>_<local>', ... }` 映射，
 * 因此运行时拿到的是一个「类名 → 混淆后类名」的普通对象。
 * 这里给 tsc 一个等价形状，避免 `import css from './x.module.css'` 报 TS2307。
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
