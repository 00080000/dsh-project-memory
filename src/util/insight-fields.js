// insight kind ↔ 正文字段归属：save_lesson 就地更新、面板 /insight edit 与记忆列表共用。
// ALL_CONTENT 不含 trigger —— 任何 kind 都能带 authored trigger，切 kind 不能删掉注入面。

const KIND_CONTENT = {
  lesson: ['pattern', 'fix'],
  decision: ['choice', 'reason'],
  procedure: ['steps', 'trigger'],
  experience: ['problem', 'solution'],
}

/**
 * 每个 kind 的「解答」字段（写侧 / 列表摘要侧的唯一一份映射）。
 *
 * 由来：面板把 textarea 的正文提交到哪个字段（MemoryView.submitNew）、编辑时从哪个字段
 * 预填（MemoryView.rowToForm）、记忆列表的合成摘要取哪个字段当正文（insight-actions.insSummary）
 * 原先各写一份 if/else 链，三处必须对同一 kind 指向同一字段，抄漏一处就是"编辑后正文搬了家"。
 * 映射依据 KIND_CONTENT 的配对：每种 kind 是 [症状, 解答]，解答即正文；
 * procedure 的正文是 steps（没有单字段正文），未知 kind 落到通用 body。
 *
 * 查表用 `Object.hasOwn` 而不是 `map[kind] || 'body'`：kind 是外来字符串（脏 JSON / 手改
 * store），`__proto__` / `constructor` 会命中原型成员，返回函数就不是字段名了。
 */
const BODY_FIELD = { lesson: 'fix', decision: 'reason', experience: 'solution' }

/**
 * kind → 正文所在字段名。
 * @param {unknown} kind - 记忆条目的 kind（可能是缺失/脏值）。
 * @returns {'fix'|'reason'|'solution'|'body'} 字段名；procedure 与未知 kind 都是 `body`。
 */
export function bodyFieldOf(kind) {
  return typeof kind === 'string' && Object.hasOwn(BODY_FIELD, kind) ? BODY_FIELD[kind] : 'body'
}

/** 与正文配对的「症状」字段：新建条目时用标题镜像它（KIND_CONTENT 的另一半）。 */
const TITLE_FIELD = { lesson: 'pattern', decision: 'choice', experience: 'problem' }

/**
 * kind → 新建时用标题镜像的字段名。
 * @param {unknown} kind - 记忆条目的 kind（可能是缺失/脏值）。
 * @returns {'pattern'|'choice'|'problem'|null} 字段名；procedure 与未知 kind 没有对应字段。
 */
export function titleFieldOf(kind) {
  return typeof kind === 'string' && Object.hasOwn(TITLE_FIELD, kind) ? TITLE_FIELD[kind] : null
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
