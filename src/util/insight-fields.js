// insight kind ↔ 正文字段归属：save_lesson 就地更新与面板 /insight edit 共用。
// ALL_CONTENT 不含 trigger —— 任何 kind 都能带 authored trigger，切 kind 不能删掉注入面。

const KIND_CONTENT = {
  lesson: ['pattern', 'fix'],
  decision: ['choice', 'reason'],
  procedure: ['steps', 'trigger'],
  experience: ['problem', 'solution'],
}

const ALL_CONTENT = ['body', 'pattern', 'fix', 'problem', 'solution', 'choice', 'reason', 'steps']

/** 切 kind 后清掉不属于新 kind 的旧内容字段；procedure 保留通用 body。 */
export function pruneKindFields(item, oldKind) {
  if (!item || item.kind === oldKind || !KIND_CONTENT[item.kind]) return
  const keep = new Set(KIND_CONTENT[item.kind])
  const keepBody = item.kind === 'procedure'
  for (const f of ALL_CONTENT) {
    if (keep.has(f) || (keepBody && f === 'body')) continue
    delete item[f]
  }
}
