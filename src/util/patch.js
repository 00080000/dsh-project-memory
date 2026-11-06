/**
 * Codex `apply_patch` 正文里的目标路径。
 *
 * 这个工具没有 `file_path` / `path` 参数，路径只出现在补丁正文的文件头里：
 *   *** Add File: src/a.ts / *** Update File: src/b.ts / *** Delete File: src/c.ts
 *   *** Move to: src/d.ts（跟在 Update File 之后，是移动后的新路径）
 * 正文里的增删行都带 `+` / `-` / 空格前缀，所以行首的 `*** …` 只可能是文件头。
 *
 * 只做机械提取：不校验补丁语法、不判断文件是否存在——调用方拿到的路径仍要走
 * 自己的根归一化（项目外会被丢弃）。
 *
 * @param {string} input - `apply_patch` 的 `input` 参数（整段补丁文本）
 * @returns {string[]} 按出现顺序去重后的路径（原样，未解析为绝对路径）
 */
export function patchFilePaths(input) {
  if (typeof input !== 'string' || input === '') return []
  const paths = []
  const seen = new Set()
  for (const line of input.split(/\r?\n/)) {
    const matched = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/.exec(line) || /^\*\*\* Move to:\s*(.+)$/.exec(line)
    if (!matched) continue
    const raw = matched[1].trim().replace(/^(['"`])(.*)\1$/, '$2').trim()
    if (!raw || seen.has(raw)) continue
    seen.add(raw)
    paths.push(raw)
  }
  return paths
}
