// entry id 的「路径前缀」编码：**必须是单射**（不同路径 → 不同前缀）。
//
// 为什么值得单独一个模块：同一个规则曾在三处各写一份（doc-pipeline 的 relativeId、
// symbols.js 的 buildSymbol、enhancer.js 的 applyEnhancedSymbols），三份都是
// `replace(/[\\/:\s]/g, '_')`。于是 `a b.md` 与 `a_b.md`（以及 `a/b.md`、`a:b.md`、
// `a\b.md`）得到同一个前缀，`${prefix}#0` 就撞成同一个 id。
//
// 撞 id 不是「不好看」，它会让检索**静默少结果**：`rankEntriesStreaming` 按 id 合并
// 多查询命中（src/util/search.js），两条不同文件的条目会被合成一条、低分的那条被丢掉。
//
// 编码规则：
//   - `/` → `_`（最常见的那种分隔符，保持 id 可读：`src/foo.js` → `src_foo.js`）；
//   - 其余风险字符（`\` `:` 各类空白 `_` `%` `#`）→ `%` + 该字符码点的十六进制。
//
// 单射理由：输出里的 `%` 只可能来自转义（源里的 `%` 一定被转成 `%25`），而每个风险字符
// 的转义串互不相同、也不同于 `_`（`/` 专属）；其余字符原样输出，且原样字符里不可能出现
// 上面这些风险字符。所以解码唯一。
//
// 注意「所有分隔符都变成 `_`」是**不够**的：那正是旧实现的错（`a b.md` 与 `a/b.md` 仍然
// 同 id）。每种分隔符必须有各自的输出。
//
// 后缀（`#<chunkIndex>` / `#<line>`）只由整数构成，因此前缀单射 ⇒ 完整 id 单射。

const RISKY = /[\\/:\s_%#]/g

/** 把相对路径编码成 entry id 的路径前缀（单射、基本可读）。 */
export function entryIdPrefix(relPath) {
  return String(relPath).replace(RISKY, (ch) => {
    if (ch === '/') return '_'
    return `%${ch.codePointAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  })
}
