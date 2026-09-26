// 注入审计（PLAN S0）：把每次**真实进入上下文**的注入决策落成 JSONL。
//
// 为什么需要：注入的有效性无法在线逐条归因——宿主只给 turn 级聚合（cacheReadTokens /
// inputTokens），拿不到"这一条记忆值多少"。所以"当时注入了哪几条、因为什么命中、同一轮
// 哪些被预算挤掉"必须落盘才可离线复盘。缺了它，任何 trigger / 阈值改动都只能靠感觉。
//
// 契约（与 auto-inject 同款安全约定）：
//  - 只在确有决策（本条真的进了上下文）时写一行：dropped 单独出现不写，否则每步刷屏；
//  - 任何异常（目录不可写、磁盘满、记录序列化失败）一律吞掉，绝不影响宿主请求；
//  - 单文件超限就地轮转一份 `.1`，不引入新的清理线程或后台任务。
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { hasProjectMarker } from './util/fs.js'

export const AUDIT_FILE = 'injection-audit.jsonl'
const DEFAULT_MAX_BYTES = 256 * 1024

// 影子记录：与主审计**分开一个文件**。主审计只记"真的注入了"的步，静默步（包括对照组那种
// "本该零注入"的步）完全不落痕，于是日志回答不了"换个阈值/换个判据会怎样"。影子记录每步都写，
// 带全部候选的特征与判据结果，用来 (a) 离线重放任一阈值、(b) 攒"特征 → 该不该注入"的训练样本。
export const SHADOW_FILE = 'admission-shadow.jsonl'
const DEFAULT_SHADOW_MAX_BYTES = 2 * 1024 * 1024

/** 审计配置：默认开（观测是这个插件唯一的仪表盘），显式 `auditLog: false` 才关。 */
export function cfgAudit(config) {
  const c = (config && config.autoContext) || {}
  return {
    enabled: c.auditLog !== false,
    maxBytes: typeof c.auditMaxBytes === 'number' && c.auditMaxBytes > 0 ? c.auditMaxBytes : DEFAULT_MAX_BYTES,
  }
}

export function auditFileFor(memoryDir) {
  return path.join(memoryDir, AUDIT_FILE)
}

/** 影子记录配置：默认开（它只写盘、不进 prompt、不花 token），显式 `shadowLog: false` 才关。 */
export function cfgShadow(config) {
  const c = (config && config.autoContext) || {}
  return {
    enabled: c.shadowLog !== false,
    maxBytes: typeof c.shadowMaxBytes === 'number' && c.shadowMaxBytes > 0 ? c.shadowMaxBytes : DEFAULT_SHADOW_MAX_BYTES,
  }
}

export function shadowFileFor(memoryDir) {
  return path.join(memoryDir, SHADOW_FILE)
}

/**
 * 一步的影子记录（纯函数，可单测）。与主审计的差别只有两点，但都是关键：
 *  - **每步都写**（含零注入的静默步与对照组），所以"没注入"也留下了可复盘的事实；
 *  - 带**全部候选**的判据特征（cov/matched/support/relative）与场景（query/ops/writes），
 *    所以能离线回答"阈值换成 0.40 会注入什么"、并攒出"特征 → 该不该注入"的样本。
 * @param {object} input { sessionId, root, step, query, ops, writes, reasons, candidates, silence }
 */
export function shadowRecordFrom(input) {
  const reasons = Array.isArray(input.reasons) ? input.reasons : []
  const candidates = Array.isArray(input.candidates) ? input.candidates : []
  return {
    at: new Date().toISOString(),
    session: input.sessionId || null,
    root: input.root || null,
    step: typeof input.step === 'number' ? input.step : null,
    // 人类消息截断保存：没有它就判不了"这次注入该不该"——标签要能回放到当时的场景。
    query: typeof input.query === 'string' ? input.query.slice(0, 300) : '',
    ops: (Array.isArray(input.ops) ? input.ops : []).slice(0, 12),
    writes: (Array.isArray(input.writes) ? input.writes : []).slice(0, 12),
    injected: reasons.map((r) => ({ id: r.id, channel: r.channel, why: r.why })),
    candidates,
    silence: input.silence || null,
  }
}

/**
 * 追加一行影子记录。返回是否写入成功（仅供测试断言）。与主审计同约定：任何异常一律吞掉，
 * 绝不影响宿主请求。
 */

/**
 * 审计**只为"已经存在"或"结论明确"的根创建 store 目录**。
 *
 * 本插件里会在"什么都没索引过"的空目录里造出 `.dsh-project-memory` 的就是下面那句
 * `mkdirSync`（`load()` 不建目录，`ensureSelfIgnore()` 也要求目录已存在）。于是任何一次
 * "**在容器目录里**开会话"都会留下一个只装着审计日志的空 store —— 而那个目录随后还会被
 * `resolveProjectMemoryRoot()` 当成项目根。审计是旁路，没有 store 就没有可对照的候选。
 *
 * 两个放行条件：
 *   - store 目录已存在 → 真被索引/写过，照旧；
 *   - 该根**自身带项目标记**（`hasProjectMarker`）→ 是"声明过的项目"，即便还没落过盘，
 *     也该留下第一步的记录（`rootNotice` 用的是同一个判据，两处口径一致）。
 * "根是推定的（无标记）且还没有内容"→ 跳过。这正是容器目录的那种情况。
 *
 * @param {string} memoryDir `<root>/.dsh-project-memory`
 * @param {string} [root] 项目根；省略时退回 `path.dirname(memoryDir)`
 */
function auditDirReady(memoryDir, root) {
  if (existsSync(memoryDir)) return true
  return hasProjectMarker(root || path.dirname(memoryDir))
}

export function appendShadowAudit(memoryDir, record, cfg, root) {
  const c = cfg || {}
  if (c.enabled === false) return false
  if (!memoryDir || !record) return false
  if (!auditDirReady(memoryDir, root)) return false
  try {
    mkdirSync(memoryDir, { recursive: true })
    const file = shadowFileFor(memoryDir)
    rotateIfOversized(file, c.maxBytes || DEFAULT_SHADOW_MAX_BYTES)
    appendFileSync(file, `${JSON.stringify(record)}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * 一次注入的审计记录（纯函数，可单测）。字段刻意保持"能直接回答两个问题"：
 * 注入了什么（injected）、为什么没注入别的（dropped）。
 * @param {object} input { sessionId, root, step, text, labels, reasons, dropped }
 */
export function auditRecordFrom(input) {
  const reasons = Array.isArray(input.reasons) ? input.reasons : []
  const dropped = Array.isArray(input.dropped) ? input.dropped : []
  return {
    at: new Date().toISOString(),
    session: input.sessionId || null,
    root: input.root || null,
    step: typeof input.step === 'number' ? input.step : null,
    chars: typeof input.text === 'string' ? input.text.length : 0,
    labels: Array.isArray(input.labels) ? [...input.labels] : [],
    injected: reasons.map((r) => ({
      id: r.id,
      channel: r.channel,
      why: r.why,
      chars: typeof r.chars === 'number' ? r.chars : null,
    })),
    dropped: dropped.map((d) => ({ id: d.id, channel: d.channel, reason: d.reason })),
    // 会话级额度快照与"本轮为什么沉默"：注入频率本身是可观测指标，不该只能靠感觉。
    budget: input.budget || null,
    silence: input.silence || null,
  }
}

/**
 * 追加一行审计。返回是否写入成功（调用方不必关心，仅供测试断言）。
 * @param {string} memoryDir 项目记忆目录（`<root>/.dsh-project-memory`）
 * @param {object} record {@link auditRecordFrom} 的产物
 * @param {{enabled?: boolean, maxBytes?: number}} [cfg] {@link cfgAudit} 的产物
 */
export function appendInjectionAudit(memoryDir, record, cfg, root) {
  const c = cfg || {}
  if (c.enabled === false) return false
  if (!memoryDir || !record) return false
  if (!auditDirReady(memoryDir, root)) return false
  try {
    mkdirSync(memoryDir, { recursive: true })
    const file = auditFileFor(memoryDir)
    rotateIfOversized(file, c.maxBytes || DEFAULT_MAX_BYTES)
    appendFileSync(file, `${JSON.stringify(record)}\n`)
    return true
  } catch {
    // 审计是旁路：写不进去不能影响这一轮注入，更不能影响宿主的请求
    return false
  }
}

function rotateIfOversized(file, maxBytes) {
  try {
    if (statSync(file).size < maxBytes) return
    renameSync(file, `${file}.1`)
  } catch {
    // 文件不存在（首次写入）或轮转失败：下一次 append 会重新建文件；失败就不轮转
  }
}
