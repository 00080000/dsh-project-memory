// 纯文本工具结果：所有工具共用的 output 声明；宿主按 render 出文本块。
export const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/**
 * 工具参数里的 `root` 声明。可选根缺省由 `openProjectContext` 解析成会话工作目录所属的项目根，
 * 所以描述里必须把默认值写出来——否则模型只能猜"不传会怎样"。
 *
 * 这段 4 行字面量曾在 9 个工具文件里各抄一份，可选根的措辞漂成两种（`save_lesson` 只写
 * "project root"，其余写 "(default: cwd)"）。描述文本**仍是参数**：`index_doc` 的根从
 * `file_path` 反推，`index_repo` / `watch_repo` 必须显式给根——这三类默认值不同，不能在
 * 调用点被抹平；收敛的是形状与"不传 root"的统一语义，不是把所有工具改成同一句话。
 * @param {{ required?: boolean, description?: string }} [opts]
 * @returns {{ type: 'string', description: string, required?: true }}
 */
export function rootParam({ required = false, description = 'project root (default: cwd)' } = {}) {
  return required ? { type: 'string', required: true, description } : { type: 'string', description }
}
