// 注入审计：把每次**真实进入上下文**的注入决策落成 JSONL。
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
// 512KB 而不是 2MB：轮转只保留 `.1` 一代，所以单项目日志的硬上限是
// `2 × shadowMaxBytes + 2 × auditMaxBytes`，之前是 4.6MB（在小项目上比 store 本身还大，
// 实测本插件自己的 store 里 3.1M/4.2M 是日志）。512KB 下上限降到 ≈1.5MB，
// 而按每行 ~1.5KB 算仍有 ~680 步的历史窗口 —— 远超"离线重放最近的历史"所需。
const DEFAULT_SHADOW_MAX_BYTES = 512 * 1024

/**
 * 一行影子记录最多保留多少个候选。
 *
 * 影子日志 **90.6% 的体积是 `candidates`**（实测 210 行 / 965KB，候选占 875KB），而真实 store
 * 单步就能产生 40~60 条（中位 42）。候选按分数降序排列，`decision === 'cand'` 必然排在最前
 * （相对阈值就是分数比），所以「**全部 cand + 按排名补足**」既保住离线重放最需要的那批，
 * 又砍掉远处必然被 coverage/relative 拦掉的尾巴。截断量记在 `candidatesTotal`，不静默。
 */
const SHADOW_MAX_CANDIDATES = 16

/**
 * 两份 JSONL 旁路日志共用的配置归一。它们的差别只有「开关名 / 字节上限键 / 默认上限」，
 * 其余判定（默认开、非法上限退回默认）必须完全一致——抄成两份就等着一边补了 `> 0`、
 * 另一边忘了。语义刻意选择：
 *  - `!== false` 而不是 `=== true`：未配置 = 开（观测是这个插件唯一的仪表盘）；
 *  - `> 0` 而不是 `!= null`：0 / 负数 / NaN 都视为「没配」，退回默认上限，而不是禁用。
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
 * 一步的影子记录（纯函数，可单测）。与主审计的差别只有两点，但都是关键：
 *  - **每步都写**（含零注入的静默步与对照组），所以"没注入"也留下了可复盘的事实；
 *  - 带**全部候选**的判据特征（cov/matched/support/relative）与场景（query/ops/writes），
 *    所以能离线回答"阈值换成 0.40 会注入什么"、并攒出"特征 → 该不该注入"的样本。
 * @param {object} input { sessionId, root, step, query, scoreQuery, ops, writes, reasons, dropped, candidates, silence }
 */
export function shadowRecordFrom(input) {
  const reasons = Array.isArray(input.reasons) ? input.reasons : []
  const candidates = Array.isArray(input.candidates) ? input.candidates : []
  const dropped = Array.isArray(input.dropped) ? input.dropped : []
  // `support` / `terms` 是**查询级**量（语料里有几个词能表示这条查询），同一个 pre-step 内
  // 逐条恒定（实测 139/139 步）。把它们从每条候选提到行级：单候选省 ~25 B，整行省 ~23%。
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
    // **实际用于评分**的查询文本（intent + 写目标的拼合）。它和 `query` 不是一回事：
    // 写目标驱动的那些步 `query` 是空的、候选却非空。少了这一栏，判据无法离线重放。
    scoreQuery: typeof input.scoreQuery === 'string' ? input.scoreQuery.slice(0, 300) : '',
    // query 是从哪来的：本步 delta（delta）/ 会话缓存的最后一条真人消息（session）/ 没有（none）。
    // 离线复盘必须先分清"这一步本来就没意图"与"意图取错了来源"。
    querySource: ['delta', 'session'].includes(input.querySource) ? input.querySource : 'none',
    ops: (Array.isArray(input.ops) ? input.ops : []).slice(0, 12),
    // 人类消息里解析出的**全部**动作词（含被 `PRE_ACTION_OPS` 过滤掉的删除/清理/渲染…）。
    // 留着才能回答"这条为什么没注入"，以及"把某类散文动作放回准入后会发生什么"。
    opsIntent: (Array.isArray(input.opsIntent) ? input.opsIntent : []).slice(0, 12),
    writes: (Array.isArray(input.writes) ? input.writes : []).slice(0, 12),
    injected: reasons.map((r) => ({ id: r.id, channel: r.channel, why: r.why })),
    // 查询级支持度：语料能表示查询里多少个词（`terms` 是查询词数）—— 通道级沉默判据用的就是它。
    support: typeof first?.support === 'number' ? first.support : null,
    terms: typeof first?.terms === 'number' ? first.terms : null,
    // candidates 的 `decision` 只说明"过没过门槛"，进不进上下文看 `outcome`
    // （injected / budget / quota / idle / gate / unscheduled）。两者正交。
    candidates: bounded,
    // 截断前的候选总数：不静默，读日志的人能一眼看出这一步被裁掉了多少。
    candidatesTotal: candidates.length,
    // 触发通道的丢弃不在 candidates 里（候选只收提示通道），单列；有界，避免长候选池撑爆一行。
    dropped: dropped.slice(0, 40),
    silence: input.silence || null,
  }
}

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

/**
 * 两份旁路日志共用的追加：目录门禁 / mkdir / 轮转 / 吞异常**只有这一份实现**，
 * 调用方只声明文件名与默认上限。分开写两份时，一处补了护栏另一处就会漏
 * （影子记录与主审计的"不建推测根"曾经就是各写一遍）。
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
 * 追加一行影子记录。返回是否写入成功（仅供测试断言）。与主审计同约定：任何异常一律吞掉，
 * 绝不影响宿主请求。
 */
export function appendShadowAudit(memoryDir, record, cfg, root) {
  return appendJsonlRecord({ memoryDir, record, cfg, root, fileFor: shadowFileFor, defaultMaxBytes: DEFAULT_SHADOW_MAX_BYTES })
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
    // `budget` 掉落带量纲（还剩多少 / 这条最少要多少），必须在审计面原样落地：
    // 抹掉它们，`buildInjection` 那侧"细缝可诊断"的努力就只活在内存里。
    // 只对带数字的条目落键——多数掉落（coverage 等）没有量纲，不该为它们付两个 null。
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
