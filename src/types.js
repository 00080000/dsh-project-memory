// JSDoc 类型定义（服务端一律 .js；本文件仅供编辑器/阅读共享心智，无运行时导出）。
// v0.5 单一 insight 实体：kind 区分语义，scope 分层，提升 = scope 字段变更。

/**
 * @typedef {'lesson' | 'decision' | 'procedure' | 'experience'} InsightKind
 *  lesson: 曾踩坑/纠偏（pattern→fix）；decision: 曾权衡的选型（topic→choice+reason）；
 *  procedure: 多步操作指南（steps）；experience: 问题→解法笔记（`remember` 写的就是它，
 *  v0.4 experience.json 在加载时导入成同一实体，不再有第二个存储）。
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
 * @property {{ when?: { ops?: string[], writes?: string[], intents?: string[] },
 *   guard?: { paths?: string[], not_paths?: string[], hosts?: string[], tags?: string[] },
 *   prevents?: string, keywords?: string[], symbols?: string[], actions?: string[],
 *   paths?: string[], scope?: string[] }} [trigger]
 *   authored 触发规则：when 是唯一触发面（三者取或），guard 只收窄；旧字段仅为历史数据兼容。
 * @property {{ keywords: string[], actions: string[], paths: string[] }} [triggerDerived]
 *   从正文确定性派生的检索信号，只提升召回、不参与强制注入
 * @property {number} [confidence] 0..1
 * @property {number} [hitCount] 被注入/命中的次数（强化信号，无 LLM）
 * @property {string} [lastHitAt] 最近一次命中时间 ISO（衰减/归档依据）
 * @property {object} [prev] 被自动覆盖/就地更新挤掉的**上一个**值（按字段名），只留一版：
 *   误覆盖后用同一个 id 再写一次即可写回；不是历史（不做折叠、不压实）
 * @property {boolean} [archived] 归档 = 软删：不进召回/注入，可恢复
 * @property {string[]} [tags]
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {object} InsightConfig
 * @property {number} [dedupOverlap] 双向 token overlap 阈值（≥ 合并/取代）
 * @property {number} [reinforceBand] 近重复强化带下界（0.65~dedupOverlap → 强化）
 * @property {number} [autoMergeCos] 向量余弦自动覆盖带（默认 0.9，需 leanvec；无向量则不用）
 * @property {number} [autoMergeMargin] 自动覆盖还要求第一名领先第二名这么多（默认 0.05）
 * @property {number} [hintCos] 向量近邻提示带（默认 0.7，只在返回文本里提示 id，不改数据）
 * @property {number} [maxForgetMatches] forget 关键词删除的命中上限（默认 10）；超了一条都不删，只回报候选
 * @property {number} [maxProject] project insights 容量（含归档；超限先删归档条目）
 * @property {number} [maxGlobalProcedures] global insights 容量
 * @property {number} [promoteConfidence] 提升 project 所需最低 confidence
 * @property {number} [globalPromoteTasks] sourceTaskIds ≥ N → 提升 global
 * @property {number} [decayDays] 久置归档启发：最近活动（hit/updated/created）超该天数 → 归档（软删）
 * @property {string} [globalFile] global.json 绝对路径（默认 ~/.config/dsh-project-memory/global.json）
 */

export {}
