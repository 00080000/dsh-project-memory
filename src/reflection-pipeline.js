// PR 1b 反思管线（v0.5，默认关）
// - 触发：select_task 切走旧任务 / archive_task 与 /task archive /（预留空闲与 compaction 前）
// - 输入不依赖对话原文：task 快照（title + steps + files）相对上次反思的摘要变更（digest 门控）
// - 冷却：同任务 cooldownMs 内、内容摘要未变 → 跳过（LLM 零调用）
// - 产出只写 task 级草稿（source: reflect, draft: true），不直接写 project/global；
//   由 insight-store 的跨任务去重/自动提升语义处理（2 个独立任务命中同一坑 → 升 project）
// - 任何失败只记日志，绝不抛出、不阻塞调用方
import { createHash } from 'node:crypto'
import { ProjectMemoryStore } from './store.js'
import { memoryRootFor } from './util/fs.js'
import { cfgInsight, saveInsight, GlobalStore, defaultGlobalFile } from './insight-store.js'
import { chatText, parseStructuredJson } from './llm.js'

export const REFLECT_SYSTEM =
  'You distill task work into durable lessons and decisions for project memory. ' +
  'Only record things worth remembering: a real pitfall hit and fixed, a correction received, or a deliberate tradeoff decision. ' +
  'Normal development does not produce entries. ' +
  'Return a STRICT JSON object: {"lessons":[{"pattern":"具体错误模式","fix":"修正做法","files":["rel/path.ts"],"symbols":["fnName"],"confidence":0.8}], ' +
  '"decisions":[{"topic":"主题","choice":"选了什么","reason":"为什么","confidence":0.9}]}. ' +
  'No markdown fences, no commentary, only the JSON object.'

export function taskReflectionSnapshot(task) {
  return {
    title: task ? task.title : '',
    steps: ((task && task.steps) || []).map((s) => (typeof s === 'string' ? s : s.content || s.text || '')).filter(Boolean).join('\n'),
    files: ((task && task.files) || []).join('\n'),
  }
}

export function taskDigest(task) {
  const snap = taskReflectionSnapshot(task)
  return createHash('sha256')
    .update(JSON.stringify({ steps: snap.steps, files: snap.files }))
    .digest('hex')
    .slice(0, 16)
}

/** 反思是否到期（enabled / 未反思过 / 摘要已变 / 冷却已过）。 */
export function isReflectDue(config, task, nowMs = Date.now()) {
  const rc = (config && config.reflection) || {}
  if (rc.enabled === false || rc.enabled == null) return { due: false, reason: 'disabled' }
  if (!task) return { due: false, reason: 'no-task' }
  const last = task.reflection || {}
  if (!last.lastAt) return { due: true, reason: 'never' }
  if (last.digest === taskDigest(task)) return { due: false, reason: 'unchanged' }
  const cooldown = typeof rc.cooldownMs === 'number' ? rc.cooldownMs : 1800000
  if (nowMs - Date.parse(last.lastAt) < cooldown) return { due: false, reason: 'cooldown' }
  return { due: true, reason: 'changed' }
}

function normalizeList(arr, max) {
  if (!Array.isArray(arr)) return []
  return arr.filter((x) => x && typeof x === 'object').slice(0, max)
}

/**
 * 对某任务做一次反思（可归档任务照做——归档正是收割时机）。
 * 全程 try/catch：调用方 fire-and-forget 即可。
 */
export async function reflectTaskAfter({ config, llm, root, taskId, reason = 'transition' }) {
  const rc = (config && config.reflection) || {}
  const fallback = { ok: false, skipped: 'disabled' }
  if (!rc.enabled) return fallback
  if (!llm) return { ok: false, skipped: 'no-llm' }
  try {
    const store = new ProjectMemoryStore(memoryRootFor(root, config.memoryDir)).load()
    const task = store.getTask(taskId)
    const gate = isReflectDue(config, task)
    if (!gate.due) return { ok: false, skipped: gate.reason }

    const snap = taskReflectionSnapshot(task)
    const user =
      `Task: ${snap.title || '(untitled)'}\n` +
      (snap.steps ? `Steps:\n${snap.steps.slice(0, 2000)}\n` : '') +
      (snap.files ? `Files touched:\n${snap.files.slice(0, 1000)}\n` : '') +
      `Trigger: ${reason}\n\nReturn the JSON object.`

    const raw = await chatText(llm, REFLECT_SYSTEM, user, { timeoutMs: 90000 })
    const parsed = parseStructuredJson(raw)
    if (!parsed) return { ok: false, skipped: 'unparsable' }

    const cfg = cfgInsight(config)
    const globalStore = new GlobalStore(cfg.globalFile || defaultGlobalFile()).load()
    const maxLessons = typeof rc.maxLessonsPerReflect === 'number' ? rc.maxLessonsPerReflect : 3
    const maxDecisions = typeof rc.maxDecisionsPerReflect === 'number' ? rc.maxDecisionsPerReflect : 2
    const written = []

    for (const l of normalizeList(parsed.lessons, maxLessons)) {
      if (!(l.pattern || l.title)) continue
      const res = store.commit((s) =>
        saveInsight({
          store: s,
          globalStore,
          raw: {
            title: l.title || l.pattern,
            kind: 'lesson',
            pattern: l.pattern,
            fix: l.fix,
            files: l.files,
            symbols: l.symbols,
            confidence: typeof l.confidence === 'number' ? l.confidence : 0.7,
            draft: true,
          },
          scope: 'task',
          taskId,
          cfg,
          source: 'reflect',
        }),
      )
      if (res && res.ok) written.push({ kind: 'lesson', id: res.id, action: res.action })
    }
    for (const d of normalizeList(parsed.decisions, maxDecisions)) {
      if (!(d.topic || d.choice)) continue
      const res = store.commit((s) =>
        saveInsight({
          store: s,
          globalStore,
          raw: { title: d.topic, kind: 'decision', choice: d.choice, reason: d.reason, confidence: typeof d.confidence === 'number' ? d.confidence : 0.7, draft: true },
          scope: 'task',
          taskId,
          cfg,
          source: 'reflect',
        }),
      )
      if (res && res.ok) written.push({ kind: 'decision', id: res.id, action: res.action })
    }
    // 标记反思进度（冷却/摘要以磁盘为准）
    const now = new Date().toISOString()
    store.commit((s) => s.updateTask(taskId, { reflection: { lastAt: now, digest: taskDigest(task) } }))
    globalStore.commit() // task 路径可能链到 global（命中既有知识）
    return { ok: true, reason, written }
  } catch (err) {
    console.error(`[dsh-project-memory] reflection failed for ${taskId}: ${err?.message || err}`)
    return { ok: false, skipped: 'error', error: String(err?.message || err) }
  }
}

/** 工具/命令层 fire-and-forget：默认关时立刻廉价返回，绝不让错误上抛。 */
export function fireReflect(config, host, root, taskId, reason) {
  const rc = (config && config.reflection) || {}
  if (!rc.enabled) return Promise.resolve({ ok: false, skipped: 'disabled' })
  return reflectTaskAfter({ config, llm: host?.llm, root, taskId, reason }).catch((err) => {
    console.error(`[dsh-project-memory] fireReflect error: ${err?.message || err}`)
    return { ok: false, skipped: 'error' }
  })
}
