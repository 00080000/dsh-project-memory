// JSDoc 类型定义（服务端一律 .js；本文件仅供编辑器/阅读共享心智，无运行时导出）。
// v0.5 单一 insight 实体：kind 区分语义，scope 分层，提升 = scope 字段变更。

/**
 * @typedef {'lesson' | 'decision' | 'procedure' | 'experience'} InsightKind
 *  lesson: 曾踩坑/纠偏（pattern→fix）；decision: 曾权衡的选型（topic→choice+reason）；
 *  procedure: 多步操作指南（steps）；experience: v0.4 旧笔记迁移而来（problem→solution）。
 *
 * @typedef {'task' | 'project' | 'global'} InsightScope
 *  task: tasks.json 内嵌于任务实体 task.insights[]（私有草稿）；
 *  project: .dsh-project-memory/insights.json（团队/项目资产）；
 *  global: ~/.config/dsh-project-memory/global.json（个人能力库，跨项目）。
 *
 * @typedef {object} Insight
 * @property {string} id 全局唯一（新条目 "ins_…"；迁移条目沿用旧 uuid）
 * @property {InsightKind} kind
 * @property {InsightScope} scope
 * @property {boolean} [draft] true = 反思自动产出，未审核、不参与注入
 * @property {string} title 一句话标题
 * @property {string} [body] 正文
 * @property {string[]} [steps] procedure 有序步骤
 * @property {string} [choice] decision：选项
 * @property {string} [reason] decision：理由
 * @property {string} [pattern] lesson：错误模式
 * @property {string} [fix] lesson：修正做法
 * @property {string} [problem] experience：问题（旧字段保留）
 * @property {string} [solution] experience：解法（旧字段保留）
 * @property {string[]} [files] 关联代码位置
 * @property {string[]} [symbols] 关联符号
 * @property {string[]} [sourceTaskIds] 曾在哪些任务中出现/被命中（提升判定唯一依据）
 * @property {'reflect' | 'agent' | 'user' | 'migrate'} [source] 来源
 * @property {{ scope: string, id: string, at: string }} [movedFrom] 提升/降级审计
 * @property {{ keywords: string[], symbols?: string[], scope?: string[] }} [trigger]
 *   procedure 的 "生成 Skill" 触发规则（无独立 skill 实体）
 * @property {number} [confidence] 0..1
 * @property {number} [hitCount] 被注入/命中的次数（强化信号，无 LLM）
 * @property {string} [lastHitAt] 最近一次命中时间 ISO（衰减/归档依据）
 * @property {boolean} [archived] 归档 = 软删：不进召回/注入，可恢复
 * @property {string[]} [tags]
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {object} InsightConfig
 * @property {number} [dedupOverlap] 双向 token overlap 阈值（≥ 合并/取代）
 * @property {number} [reinforceBand] 近重复强化带下界（0.65~dedupOverlap → 强化）
 * @property {number} [maxProject] project insights 容量（归档区另计）
 * @property {number} [maxGlobalProcedures] global insights 容量
 * @property {number} [promoteConfidence] 提升 project 所需最低 confidence
 * @property {number} [globalPromoteTasks] sourceTaskIds ≥ N → 提升 global
 * @property {number} [decayDays] 久置归档启发：hitCount==0 超该天数 → 归档（软删）
 * @property {string} [globalFile] global.json 绝对路径（默认 ~/.config/dsh-project-memory/global.json）
 */

export {}
