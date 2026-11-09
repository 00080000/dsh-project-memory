// 纯文本工具结果：所有工具共用的 output 声明；宿主按 render 出文本块。
export const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}
