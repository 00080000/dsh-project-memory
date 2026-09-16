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
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

export const AUDIT_FILE = 'injection-audit.jsonl'
const DEFAULT_MAX_BYTES = 256 * 1024

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
export function appendInjectionAudit(memoryDir, record, cfg) {
  const c = cfg || {}
  if (c.enabled === false) return false
  if (!memoryDir || !record) return false
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
