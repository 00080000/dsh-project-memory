// 注入审计：把每次真实进入上下文的注入决策落成 JSONL，供离线复盘。
// 契约：只在确有决策时写一行（dropped 单独出现不写）；任何异常一律吞掉，
// 绝不影响宿主请求；单文件超限就地轮转一份 `.1`，不引入后台任务。
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { hasProjectMarker } from './util/fs.js'

export const AUDIT_FILE = 'injection-audit.jsonl'
const DEFAULT_MAX_BYTES = 256 * 1024

// 影子记录与主审计分开文件：主审计只记真的注入步，静默步不落痕；影子每步都写，
// 带全部候选与判据，用于离线重放阈值、攒"特征 → 该不该注入"的样本。
export const SHADOW_FILE = 'admission-shadow.jsonl'
// 512KB 而非 2MB：只保留 `.1` 一代，硬上限是 2×shadow + 2×audit ≈1.5MB（此前 4.6MB，
// 实测本插件 store 里 3.1M/4.2M 是日志）；每行 ~1.5KB 仍有 ~680 步窗口。
const DEFAULT_SHADOW_MAX_BYTES = 512 * 1024

/**
 * 一行影子记录最多保留的候选数：90.6% 的体积是 `candidates`（实测 210 行 / 965KB，
 * 候选占 875KB），真实 store 单步 40~60 条（中位 42）。候选按分数降序、`cand` 必在最前，
 * 所以保留全部 cand + 按排名补足，砍掉远处必被 coverage/relative 拦掉的尾巴；
 * 截断量记在 `candidatesTotal`。
 */
const SHADOW_MAX_CANDIDATES = 16

/**
 * 两份旁路日志共用的配置归一，差别只有开关名 / 上限键 / 默认值。
 * `!== false`：未配置 = 开；`> 0`：0 / 负数 / NaN 都视为没配，退回默认上限而不是禁用。
 */
function cfgSideLog(config, { enabledKey, maxKey, defaultMaxBytes }) {
  const c = (config && config.autoContext) || {}
  return {
    enabled: c[enabledKey] !== false,
    maxBytes: typeof c[maxKey] === 'number' && c[maxKey] > 0 ? c[maxKey] : defaultMaxBytes,
  }
}

/** 审计配置：默认开，显式 `auditLog: false` 才关。 */
export function cfgAudit(config) {
  return cfgSideLog(config, { enabledKey: 'auditLog', maxKey: 'auditMaxBytes', defaultMaxBytes: DEFAULT_MAX_BYTES })
}

export function auditFileFor(memoryDir) {
  return path.join(memoryDir, AUDIT_FILE)
}

/** 影子记录配置：默认开（它只写盘、不进 prompt、不花 token），显式 `shadowLog: false` 才关。 */
export function cfgShadow(config) {
  return cfgSideLog(config, { enabledKey: 'shadowLog', maxKey: 'shadowMaxBytes', defaultMaxBytes: DEFAULT_SHADOW_MAX_BYTES })
}

export function shadowFileFor(memoryDir) {
  return path.join(memoryDir, SHADOW_FILE)
}

/**
 * 一步的影子记录（纯函数，可单测）：每步都写（含零注入步），并带全部候选的
 * 判据特征与场景，才能离线回答"换个阈值会注入什么"、攒出训练样本。
 * @param {object} input { sessionId, root, step, query, scoreQuery, ops, writes, reasons, dropped, candidates, silence }
 */
export function shadowRecordFrom(input) {
  const reasons = Array.isArray(input.reasons) ? input.reasons : []
  const candidates = Array.isArray(input.candidates) ? input.candidates : []
  const dropped = Array.isArray(input.dropped) ? input.dropped : []
  // `support` / `terms` 是查询级量，半步内逐条恒定（实测 139/139 步），提到行级省 ~23%。
  const first = candidates[0]
  const slim = candidates.map((c) => ({
    id: c.id,
    rel: c.rel,
    coverage: c.coverage,
    matched: c.matched,
    // `decision` 是门槛层结论，`outcome` 是预算层结论，两者正交（见 auto-inject.js）。
    decision: c.decision,
    outcome: c.outcome,
  }))
  // 候选**只有提示通道**（trigger 的结果在 `injected` / `dropped` 里），所以不再逐条记 channel。
  const bounded = slim.length <= SHADOW_MAX_CANDIDATES ? slim : (() => {
    const keep = new Set()
    for (const c of slim) if (c.decision === 'cand') keep.add(c.id)
    for (const c of slim) {
      if (keep.size >= SHADOW_MAX_CANDIDATES) break
      keep.add(c.id)
    }
    return slim.filter((c) => keep.has(c.id))
  })()
  return {
    at: new Date().toISOString(),
    session: input.sessionId || null,
    root: input.root || null,
    step: typeof input.step === 'number' ? input.step : null,
    // 人类消息截断保存：没有它就判不了"这次注入该不该"——标签要能回放到当时的场景。
    query: typeof input.query === 'string' ? input.query.slice(0, 300) : '',
    // **实际用于评分**的查询文本（intent + 写目标拼合），与 `query` 不同：写目标驱动的步 query 为空、候选非空；缺它无法离线重放判据。
    scoreQuery: typeof input.scoreQuery === 'string' ? input.scoreQuery.slice(0, 300) : '',
    // query 来源：本步 delta / 会话缓存的最后一条真人消息 / 无——复盘要先分清"本来没意图"与"来源取错"。
    querySource: ['delta', 'session'].includes(input.querySource) ? input.querySource : 'none',
    ops: (Array.isArray(input.ops) ? input.ops : []).slice(0, 12),
    // 人类消息里解析出的全部动作词（含被 `PRE_ACTION_OPS` 过滤掉的），留着才能回答"这条为什么没注入"，以及"放回某类动作会发生什么"。
    opsIntent: (Array.isArray(input.opsIntent) ? input.opsIntent : []).slice(0, 12),
    writes: (Array.isArray(input.writes) ? input.writes : []).slice(0, 12),
    injected: reasons.map((r) => ({ id: r.id, channel: r.channel, why: r.why })),
    // 查询级支持度：语料能表示查询里多少个词（`terms` 是查询词数），通道级沉默判据用的就是它。
    support: typeof first?.support === 'number' ? first.support : null,
    terms: typeof first?.terms === 'number' ? first.terms : null,
    // candidates 的 `decision` 只说明过没过门槛，进不进上下文看 `outcome`
    // （injected / budget / quota / idle / gate / unscheduled），两者正交。
    candidates: bounded,
    // 截断前的候选总数：读日志的人能看出这一步裁掉了多少。
    candidatesTotal: candidates.length,
    // 触发通道的丢弃不在 candidates 里（候选只收提示通道），单列；有界，避免长候选池撑爆一行。
    dropped: dropped.slice(0, 40),
    silence: input.silence || null,
  }
}

/**
 * 审计只为"已存在"或"带项目标记"的根建 store 目录：否则在容器目录里开会话会留下
 * 只装审计日志的空 store，并被 `resolveProjectMemoryRoot()` 当成项目根。
 * 标记判据 `hasProjectMarker`，与 `rootNotice` 一致。
 * @param {string} memoryDir `<root>/.dsh-project-memory`
 * @param {string} [root] 项目根；省略时退回 `path.dirname(memoryDir)`
 */
function auditDirReady(memoryDir, root) {
  if (existsSync(memoryDir)) return true
  return hasProjectMarker(root || path.dirname(memoryDir))
}

/**
 * 两份旁路日志共用的追加：目录门禁 / mkdir / 轮转 / 吞异常只有这一份实现，
 * 调用方只声明文件名与默认上限（分开写会一处补了护栏、另一处漏）。
 * @returns {boolean} 是否写入成功（仅供测试断言）
 */
function appendJsonlRecord({ memoryDir, record, cfg, root, fileFor, defaultMaxBytes }) {
  const c = cfg || {}
  if (c.enabled === false) return false
  if (!memoryDir || !record) return false
  if (!auditDirReady(memoryDir, root)) return false
  try {
    mkdirSync(memoryDir, { recursive: true })
    const file = fileFor(memoryDir)
    rotateIfOversized(file, c.maxBytes || defaultMaxBytes)
    appendFileSync(file, `${JSON.stringify(record)}\n`)
    return true
  } catch {
    // 旁路契约：写不进去不能影响这一轮注入，更不能影响宿主的请求
    return false
  }
}

/**
 * 追加一行影子记录。与主审计同约定：任何异常一律吞掉，绝不影响宿主请求。
 * @returns {boolean} 是否写入成功（仅供测试断言）
 */
export function appendShadowAudit(memoryDir, record, cfg, root) {
  return appendJsonlRecord({ memoryDir, record, cfg, root, fileFor: shadowFileFor, defaultMaxBytes: DEFAULT_SHADOW_MAX_BYTES })
}

/**
 * 一次注入的审计记录（纯函数，可单测）：字段只回答两个问题——
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
    // `budget` 掉落带量纲（remaining / need），必须原样落地，否则"细缝可诊断"只活在内存里。
    // 只对带数字的条目落键——多数掉落没有量纲，不该为它们付两个 null。
    dropped: dropped.map((d) => ({
      id: d.id,
      channel: d.channel,
      reason: d.reason,
      ...(typeof d.remaining === 'number' ? { remaining: d.remaining } : {}),
      ...(typeof d.need === 'number' ? { need: d.need } : {}),
    })),
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
  return appendJsonlRecord({ memoryDir, record, cfg, root, fileFor: auditFileFor, defaultMaxBytes: DEFAULT_MAX_BYTES })
}

function rotateIfOversized(file, maxBytes) {
  try {
    if (statSync(file).size < maxBytes) return
    renameSync(file, `${file}.1`)
  } catch {
    // 文件不存在（首次写入）或轮转失败：下一次 append 会重新建文件；失败就不轮转
  }
}
