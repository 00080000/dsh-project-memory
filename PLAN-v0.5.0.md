# dsh-project-memory v0.5.0 完整落地方案（评审修订版）

> 相对初版的变更集中在四处：**单一 insight 实体**（消灭 lessons/decisions/procedure/skill 平行复制）、**注入按相关性门控**（不做每轮固定成本）、**反思默认草稿化**（反转 #6 取舍时的安全闸门）、以及两处硬伤修正（去重指标统一为双向 overlap；服务端一律 `.js`）。
>
> 数据布局 v0.4 → v0.5 会做一次幂等迁移，旧数据无损。

---

## 核心哲学（修订）

1. **用户无感，Agent 有感，噪音有闸门** —— 记忆沉淀/召回由 Agent 自动完成，但自动反思只写 Task 级草稿；只有被复用/审核的内容才会进 project/global 并参与静默注入
2. **一个实体，三个作用域** —— insight（kind 区分语义）按 `scope: task|project|global` 分层，**"提升" = scope 字段变更**，不是跨文件复制合并
3. **注入是召回，不是旁白** —— 每轮注入前先对"当前用户消息 + 当前 step"做一次廉价 BM25/重叠检索，**命中才注入，未命中零成本**；skill/procedure 与 Task 卡是两条例外规则
4. **纯本地、零新依赖** —— 复用现有 BM25/CJK/事务/去重层；LLM 只出现在反思管线（默认关）
5. **TaskPanel 统一交互** —— Task / Project / Global 三视图 + 草稿审核，承载所有"给用户看/改"的功能

---

## 一、数据模型：单一 insight 实体

### 1.1 Insight（所有层级、所有语义的唯一结构）

```ts
// types.js — JSDoc 类型（服务端一律 .js，不用 .ts）
interface Insight {
  id: string;                       // "ins_xxx"，全局唯一（task 内嵌的也是这个 id 体系）
  kind: 'lesson' | 'decision' | 'procedure' | 'experience';
  // lesson: 曾踩坑/纠偏；decision: 曾权衡的选型；procedure: 多步操作指南；experience: v0.4 旧笔记迁移而来

  scope: 'task' | 'project' | 'global';
  draft?: boolean;                  // true = 反思自动产出，未审核、不参与注入

  title: string;                    // 一句话标题（lesson: 错误模式；decision: 主题；procedure: 名称）
  body?: string;                    // 正文（lesson: fix；decision: reason；procedure: 描述）

  // kind 专属字段（全部可选，编辑器按 kind 切换表单）
  steps?: string[];                 // procedure：有序步骤
  choice?: string; reason?: string; // decision
  pattern?: string; fix?: string;   // lesson（向后兼容 experience.problem/solution 语义）
  problem?: string; solution?: string; // experience（旧字段保留，写入/读取兼容）

  // 溯源与审计
  files?: string[]; symbols?: string[];   // 关联代码位置
  sourceTaskIds?: string[];               // 曾在哪些任务中出现/被命中（提升判定的唯一依据）
  source: 'reflect' | 'agent' | 'user' | 'migrate';
  movedFrom?: { scope: string; id: string; at: number };  // 提升审计

  trigger?: {                          // procedure 的"生成 Skill" = 填这个字段，无独立 skill 实体
    keywords: string[];
    symbols?: string[];
    scope?: string[];                  // 如 ["npm"]，与项目画像 tags 取交集，空则跳过
  };

  confidence: number;                // 0..1
  hitCount?: number;                 // 被注入/命中的次数（强化信号，无 LLM）
  lastHitAt?: number;                // 最近一次命中时间（衰减/归档依据）
  archived?: boolean;                // 归档 = 软删：不进召回/注入，可恢复
  tags?: string[];
  createdAt: number; updatedAt: number;
}
```

**要点**
- 一个实体、一套去重、一套容量、一个编辑器组件、一个检索通道。skill 不再是独立索引，`trigger` 挂在 procedure 上 → "生成 Skill" = 打开 procedure 编辑 trigger，少一层映射表。
- `experience` 是 v0.4 旧笔记迁移后的 kind；`lesson` 是新反思/新保存的默认 kind。两者检索同权，避免在 schema 层面分家。
- **去重指标全库统一**：双向 token overlap ≥ 0.7（复用现有 experience 层实现，抽出到 `src/similarity.js`）。BM25 **只用于排序**，禁止当阈值（BM25 未归一化，跨库/跨长度不可比）。
- **近重复强化带**：0.65 ≤ overlap < 0.7 → 不合并，仅 `sourceTaskIds`/`hitCount` +1（多个独立任务各自踩同一坑的信号）；≥ 0.7 → 合并/取代。对齐竞品 qwert702 的 bigram Jaccard ≥ 0.65 强化。

### 1.2 三个作用域 = 三个物理位置（逻辑同构，物理分离）

| scope | 宿主 | 说明 |
|---|---|---|
| `task` | `tasks.json` 内嵌于任务实体 `task.insights[]` | 私有草稿；`list_tasks` 不返回，`select_task` 返回；不计容量 |
| `project` | `.dsh-project-memory/insights.json`（由 v0.4 `experience.json` 迁移而来） | 团队/项目资产，参与注入与召回 |
| `global` | `~/.config/dsh-project-memory/global.json` | 个人能力库，跨项目；含 procedure + trigger |

**为什么 task 内嵌而 project/global 独立文件**：task 随任务增删走（归档即随任务隐藏），project/global 是长期资产，生命周期不同——物理分离贴合现状，逻辑同构保证代码只写一套。

**v0.5 迁移（幂等，复用现有迁移机制）**：首次加载时若存在 `experience.json` 且无 `insights.json` → 每条 `{problem, solution}` 改写为 `{id, kind:'experience', scope:'project', problem, solution, confidence:1, source:'migrate', createdAt/updatedAt}` 写入 `insights.json`，旧文件改名 `experience.json.migrated`。`format.json` 版本 v2 → v3。失败走现有 `.corrupt` 隔离。

### 1.3 Task 实体扩展

```jsonc
{
  "id": "tsk_abc", "title": "重构 auth JWT",
  "steps": [...], "files": [...],
  "insights": [
    { "id": "ins_1", "kind": "lesson", "scope": "task", "draft": true,
      "pattern": "JWT 未校验 exp", "fix": "用 jose 校验 exp/nbf/iss",
      "confidence": 0.8, "source": "reflect",
      "files": ["src/auth/jwt.ts"], "symbols": ["parseToken"],
      "createdAt": 1699999999999, "updatedAt": 1699999999999 }
  ]
}
```

---

## 二、写入、去重与提升

### 2.1 统一写工具 `save_lesson`（名字保留，语义扩宽）

```
save_lesson(title, kind?, scope?, pattern?, fix?, choice?, reason?, steps?, trigger?,
            taskId?, files?, symbols?, confidence?, draft?)
```

- **scope 解析**：显式 `scope` > `taskId`（写进该 task 的 `task.insights[]`）> 当前绑定任务 > `project`
- 服务端默认 `source: 'agent'`；UI 直写为 `'user'`
- 写前查重：与目标 scope 内条目双向 overlap ≥ 0.7 → 视为同一 insight，**合并**：`sourceTaskIds` 取并集、`files/symbols` 并集、confidence 取 max、保留更完整的 body；不新建
- 全部写入走 `store.commit(fn)`（task 与 project 各自宿主文件的同步事务），复用损坏隔离
- **写盘前密文过滤**：`pattern/fix/body/steps` 命中密钥/token/私钥形态（简单正则）→ 拒绝写入并提示（对齐 memgas 写前拦截；反思产物同规）

### 2.2 提升 = 字段变更（删除整本书账）

**Task 草稿 → Project**
- 触发条件：非 draft 的 task insight，其 `sourceTaskIds.length ≥ 2`（两个不同任务各自产出/保存过同一条）且 `confidence ≥ 0.7`
- 动作：从原 task 的 `task.insights[]` 摘除，写入 `insights.json`，`scope: 'project'`，`sourceTaskIds` 保留（≥2），记 `movedFrom` 审计
- 反向（Project → Task 降级）：UI 触发，复制回指定 task，原条目删除

**Project → Global**
- 触发条件：project insight 的 `sourceTaskIds.length ≥ 3` 个不同任务命中
- 动作：写入 `global.json`，`scope: 'global'`，从 project store 删除，记 `movedFrom`

**没有"双写期"**：任何时刻一条 insight 只存在于一个物理位置，去重天然跨层，无合并账本、无平均 confidence、无冷却期的跨层去重逻辑。

**跨任务复用怎么发生**：反思草稿 A 属 tsk_1；之后在 tsk_2 反思产出同内容 → 查重命中草稿 A → 不新建，`sourceTaskIds.push('tsk_2')`、`draft` 保持 true 但命中数 +1；当 ≥2 任务命中即自动提升（即便仍是 reflect 来源，只要 2 个独立任务各自踩过同一坑，就是经验而非幻觉）。**审核仍是可选的第二道闸门**：用户可在 TaskPanel 手动提升/删除草稿，优先级高于自动提升。

### 2.3 容量策略（作用域配额，归档代替硬删）

| 位置 | 上限 | 淘汰 |
|---|---|---|
| task.insights[] | 不限（随任务归档） | — |
| project insights.json | 100（含迁移的旧笔记） | 久置（hitCount 低 / lastHitAt 旧）且低 confidence 者先**归档** |
| global.json | procedure 200 | 同上归档策略 + 手动删 |

- **归档（`archived: true`）= 软删**：不进召回、不参与注入，TaskPanel 可恢复；物理删除只发生在归档区溢出时（LRU）。与 memgas 衰减归档、memory-lite `.trash` 软删一致，防误杀。
- **强化反馈**：insight 每次被相关注入命中即 `hitCount+1`、刷新 `lastHitAt` —— 用量成为衰减/归档依据，全程无 LLM。

---

## 三、反思管线（PR 1b，默认关闭）

### 3.1 触发点
- **空闲 debounce（主触发）**：绑定任务 idle ≥ `reflection.idleMs` 或事件窗口累计 ≥ `reflection.windowEvents` 触发 —— 输入来自插件自有的 `tool/call` + `fs/observed` 事件流滚动维护的"任务事件摘要"（steps 变更 / 文件编辑 / 工具调用），**不依赖对话原文**，也不占对话关键路径
- `select_task` 切走旧任务前（异步，不阻塞切换）
- `/task archive` 归档时
- compaction 前（若 dsh 暴露对应钩子：蒸馏即将滑出上下文的窗口；不暴露则跳过，v0.5 不强依赖）
- 会话结束（下次启动补查"上次绑定未反思的任务"）

### 3.2 行为
- 冷却：同任务 30 分钟内不重复反思（配置 `cooldownMs`）
- 失败：异步重试，队列不阻塞任何工具调用
- **产出只写 Task 级草稿**：`{id, kind, scope:'task', draft:true, source:'reflect', confidence}`，**不直接写 project，不参与注入**；写盘前过 §2.1 密文过滤
- LLM 调用可整体关闭（`reflection.enabled: false` 默认）

### 3.3 反思 Prompt（温度 0.1，maxTokens 600，输出 JSON）

```
从任务上下文提取 0-3 条 Lesson 和 0-2 条 Decision。
只记「曾踩坑 / 曾纠偏 / 曾权衡」。正常开发不记。

Task: {title}
Steps 变更: {stepsDiff}
文件编辑摘要: {fileEdits}
（有缓冲则附最近对话 2-3 轮；无缓冲不阻塞，仅用以上输入）

Output JSON:
{ "lessons": [{"pattern":"具体错误模式","fix":"修正做法","files":["..."],"symbols":["..."],"confidence":0.8}],
  "decisions": [{"topic":"...","choice":"...","reason":"...","confidence":0.9}] }
```

> 输入不依赖"最近 10 轮对话"：select_task/archive 触发点不在 `llm.stream` 上下文里，对话文本只能靠常驻缓冲，成本不值。stepsDiff + fileEdits（已有事件流）质量足够。
> 反思读**任务快照**，不在异步回调里读可变状态。

---

## 四、静默注入引擎（PR 2，核心体验）

### 4.1 机制（对齐竞品的 entry/relevance 双通道）
- `llm.stream` wrapper，两条通道都带 `[Memory Inject]` 前缀、落在 GUI 上下文行（可审计）：
  1. **常驻块（entry，多数轮次增量成本 ≈ 0）**：把「Task 卡 + 该任务非草稿 insights 摘要」作为**一条独立消息置于上下文前部（system 之后）**；仅当内容哈希变化或 compaction 把上次的块挤出可见区时**重发**。块在前部 → 后续轮次整段走 KV cache 复用，增量成本 ≈ 0（对齐 dsh-memory-lite / dsh-plugin-memory / dsh-memory）
  2. **相关注入（relevance，query 命中才追加）**：见 4.2 门控；命中条目 `hitCount+1`、刷新 `lastHitAt`
- ≤ `autoContext.maxTokens`（默认 400），超限截断（排序见 4.4）

### 4.2 注入门控（双通道，全部廉价、全部可短路）

```
每轮请求：

A) 常驻块（entry）
   会话状态记录"当前常驻块指纹"；有绑定任务 且 内容哈希 ≠ 指纹 → 更新常驻块
   （未变更则零操作 —— 块本体留在 KV 前缀里，不重复计费；无绑定任务则块为空）

B) 相关注入（relevance，query 命中才追加）
   query = 最后一条 user 消息文本（必要时拼当前 step）

   1) Skill / Procedure 命中
      BM25 检索 global scope、kind=procedure、带 trigger 的条目；
      trigger.keywords/symbols 命中 且 trigger.scope 与项目画像 tags 交集非空
      → 追加该 procedure 全步骤（当下动作指南）；命中后继续 2)
   2) 相关 insights
      用 query 在 project + global scope（非 draft、非 archived）中 BM25 检索，
      取 top-3；排序分低于阈值（相对分，取该 store top1 的 ~30%）→ 整体跳过
      → 追加命中条目（lesson/decision/experience/procedure，带 id 便于核对/纠错），
        并对每条 `hitCount+1`、刷新 `lastHitAt`
```

**结果**：用户闲聊、无关任务 → 只有（至多一次、KV 复用的）常驻块，无逐轮追加；动手/踩坑/选型时 → 恰好追加对应知识。不做"每轮尾部重放全部记忆"的固定成本。

### 4.3 项目画像 `src/project-profile.js`（tags）
- 解析 package.json / go.mod / Cargo.toml 等，产出技术栈 tags，内存缓存
- 仅用于 global procedure 的 `trigger.scope` 过滤与技能匹配，不参与注入文本

### 4.4 注入预算与优先级
1. 常驻块（Task 卡摘要，仅内容变更时更新，~100 tokens 级）
2. Procedure（相关注入命中时，全步骤优先）
3. 相关 insights（BM25 命中）
单次请求追加总量 ≤ 400 tokens（常驻块首轮计入），超限按 1→2→3 反序截断。

---

## 五、TaskPanel 三视图（PR 3，UI）

沿用现有浮动画板与拖拽/主题基建，单图标按钮循环 `Task → Project → Global`。

| 视图 | 内容 | 交互 |
|---|---|---|
| **Task** | 进度卡片、steps、files、本任务 insights（草稿标 **draft** badge） | 双击编辑（按 kind 切表单）、拖拽重排、步骤状态循环、**[审核提升]**（草稿→project，或直接删草稿） |
| **Project** | Runbooks/Conventions（现有字段不动）、project insights、BlindSpots（复用 doc summary 已有的 `blindSpots` 字段聚合展示，不新造） | 新增/编辑/删除 insight、**[提升到全局]**、**[降级到任务]** |
| **Global** | procedure 列表（含 trigger 列） | 新建 procedure → 填 steps/tags → **勾选"作为 Skill"** → 直接编辑 trigger（关键词/symbols/scope）——不再有独立的 skill 编辑层 |

编辑组件统一：`InsightEditor`（按 kind 渲染 lesson/decision/procedure/experience 表单）+ 通用 scope/draft 切换。所有写回走与模型 `save_lesson` 同一代码路径。

---

## 六、PR 划分（服务端一律 `.js`，client 才 `.tsx`）

### PR 1a：数据层基础（~350 行，无 LLM）
| 文件 | 说明 |
|---|---|
| `src/similarity.js` | 抽通用双向 token overlap（0.7），experience/insight 共用 |
| `src/insight-store.js` | insight 实体：增删改、scope 存取、双向 overlap 去重合并、sourceTaskIds 累积、提升/降级（scope 变更）、容量 LRU |
| `src/store.js` | `insights.json` 纳入 `store.commit`；v2→v3 幂等迁移（experience.json → insights.json） |
| `src/global-seed.js` | 种子 procedure（含 trigger/tags），幂等初始化 `global.json`（仅补缺失 id） |
| `src/tools/lesson-tools.js` | `save_lesson` 工具（scope 解析 + 合并 + commit） |
| `src/types.js` | JSDoc 类型（Insight / 配置），供编辑器与 server 共享心智 |
| `src/index.js` | 注册工具、挂载 insightStore、加载时跑迁移与种子 |
| `test/insight-store.test.mjs` | 存取/去重合并/提升/降级/迁移/种子幂等/容量裁剪全绿 |

**验收**：`save_lesson` 三级可写；双向 overlap ≥0.7 合并生效（含跨任务累积 sourceTaskIds）；2 任务命中自动提升 project、3 任务提升 global；旧 experience.json 迁移无损幂等；测试全绿。

### PR 1b：反思管线（~150 行，LLM，默认关）
| 文件 | 说明 |
|---|---|
| `src/reflection-pipeline.js` | `reflectOnTask(taskSnapshot, ctx)`：LLM 结构化提取 → 仅写 task 草稿；冷却/异步重试/失败队列 |
| `src/index.js` | `select_task` 切走前、`archive_task`、空闲 debounce（订阅 `tool/call`/`fs/observed` 事件流）时挂 `onTaskTransition(taskSnapshot, action)` |

**验收**：任务切换自动产出草稿（draft 标记，不进 project/不注入）；同内容第二次产出命中草稿而非新建；开关关闭时零 LLM 调用。

### PR 2：注入引擎（~150 行，核心体验）
| 文件 | 说明 |
|---|---|
| `src/auto-inject.js` | `llm.stream` wrapper：entry 常驻块 + relevance 门控 + 前缀 + 预算截断 + 指纹去重 + 命中强化计数 |
| `src/project-profile.js` | 技术栈 tags 画像（内存缓存） |
| `src/index.js` | 包装 `ctx.llm.stream` |

**验收**：procedure 命中 → 追加步骤；常驻块仅内容变更/compaction 后重发一次（无命中零增量）；insights 按当前消息 BM25 命中才追加、低于阈值整体跳过；单次 ≤400；entry/relevance 在 GUI 上下文行可区分；trigger.scope 与画像 tags 过滤生效；命中强化计数正确。

### PR 3：TaskPanel 三视图（UI，可延后）
`src/client/TaskPanel.tsx` / `TaskComponents.tsx` / `InsightEditor.tsx`

**验收**：三视图循环切换；insight 增删改/提升/降级/草稿审核/生成 Skill（编辑 trigger）全可用；BlindSpots 复用现有 doc 字段。

---

## 七、配置项（全部可关、可调，默认值已定）

```yaml
insight:
  dedupOverlap: 0.7        # 双向 token overlap 阈值（统一指标，非 BM25）
  reinforceBand: 0.65      # 0.65~0.7：近重复→强化（sourceTaskIds/hitCount+1）；≥0.7 合并
  maxProject: 100          # project insights 容量（归档区另计）
  maxGlobalProcedures: 200
  promoteConfidence: 0.7
  globalPromoteTasks: 3    # sourceTaskIds ≥ 3 → 提升 global
  decayDays: 90            # 久置归档启发：hitCount==0 超过该天数 → 归档（软删）
autoContext:
  enabled: true
  entryOn: true            # 常驻块（entry 通道）；仅内容变更/compaction 后重发
  maxTokens: 400           # 单次请求追加预算（含 procedure 全步骤）
reflection:
  enabled: false           # 默认关：LLM 反思是唯一 LLM 消耗点
  idleMs: 1800000          # 空闲触发（主）：30 分钟
  windowEvents: 40         # 或事件窗口累计达阈值触发
  cooldownMs: 1800000      # 同任务反思冷却：30 分钟
  maxLessonsPerReflect: 3
  maxDecisionsPerReflect: 2
```

> 默认值延续本项目惯例（`llmQueryExpansion: false`）：会花 token / 会写上下文的 LLM 功能默认关，用户显式开启。

---

## 八、两个例子在新体系里的完整路径

| 场景 | 存成什么 | 生效路径 |
|---|---|---|
| **WSL npm publish 官方源** | global procedure `proc_npm_publish_wsl`（kind=procedure, scope=global, `trigger: {keywords:["npm publish","发包"], scope:["npm"]}`） | 用户说"发包" → 步骤 1 BM25 命中 trigger → 画像 tags 含 npm → 注入完整 5 步；此后**永不提示、零工具调用** |
| **dsh 插件本地/市场切换** | global procedure `proc_dsh_plugin_local` + trigger | 用户说"本地插件"/模型要 `dsh plugin add` → 命中 → 注入切换步骤 |

**用户操作**：TaskPanel Global 视图 → 新建 Procedure → 填步骤/tags → 勾选"作为 Skill" → 填 trigger。之后永远静默生效。

---

## 九、与 v0.4 哲学的关系（显式声明）

- **#6 显式 remember 反对隐式学习**：本方案不推翻它，而是加了两道闸门使其安全——反思只产草稿（默认还关着）、草稿需 2 个独立任务命中或人工审核才进入 project/global 注入面。显式 `save_lesson` 仍是主写入通道。
- **注入默认开、反思默认关**：注入是纯本地 BM25 召回（不花 LLM token），开；反思花 token 且产噪音，默认关。两者不对称是有意的。
- **去重/检索纪律**：统一用经验层已验证的双向 overlap 0.7 + BM25 排序，不引入不可比的新阈值。

---

## 十、风险与未决

1. 常驻块需以**独立消息**插入 system 之后 —— 需在真实 dsh 上验证 `llm.stream` 能插入独立消息、且位置落在 KV-cached 前缀区（PR 2 第一个验收点）；若不支持独立消息，退化为"追加到最后一条 user message + 变更才重发"，牺牲部分 KV 复用。
2. 反射产物的自动提升（2 任务命中即升 project）仍可能带噪音 → 若实测噪音高，把自动提升改为"标记 eligible，TaskPanel 一键确认"，成本一行配置。
3. 多 dsh 实例并发写 global.json 无锁（沿用现有 in-process 锁假设），README 已声明，不新增机制。
4. `insights.json` 与 `experience.json` 的迁移在超大型 experience 库上是否要分批 —— 现有事务整文件覆盖已够用，实测后定。
5. **多记忆插件并存**：qwert702/dsh-memory、NattoCB/dsh-plugin-memory、dsh-memgas、dsh-memory-lite 同跑时各自注入上下文（seam 不同），会冗余 —— 至少在 README 声明"记忆插件建议互斥"，不新增协调机制。

---

## 十一、竞品对照（调研补录）

dsh 生态同期已出现四个原生长期记忆插件，全部具备"自动提取 + 自动注入"，方向与 v0.5 一致。本方案的差异点：Task 锚点 + 草稿闸门 + BM25 零 LLM + 单一 insight 实体。

| 插件 | 核心定位 | 本文借用 / 对照结论 |
|---|---|---|
| [qwert702/dsh-memory](https://github.com/qwert702/dsh-memory) | project+global 双 store；turn/end 事件回放蒸馏；bigram Jaccard ≥ 0.65 近重复 → 强化；定期 consolidation；freshness×reinforcement 排序注入 | 近重复强化带（§1.1）；事件流蒸馏触发（§3.1） |
| [NattoCB/dsh-plugin-memory](https://github.com/NattoCB/dsh-plugin-memory) | 五层；index+topic 拆分（索引 ≤150 字符/行，硬钳 200 行/40K 字符）；entry/relevance 双通道注入且 GUI 标源；60s idle 自动提取；无 llm 路由时关键词降级 | entry/relevance 双通道与 GUI 可审计（§4.1/4.2）；无 LLM 降级（我方天然满足，本就是关键词优先） |
| [quqxui/dsh-memgas](https://github.com/quqxui/dsh-memgas) | SQLite；四通道检索 + RRF 融合（基线保底半席位）；六演化过程（关联/调和/强化/衰减/抽象/重关联）；写前密文拦截；scope 按 git remote 归一化；`/memory review` 确认队列 | 归档代替硬删（§2.3）；写前密文过滤（§2.1/3.2）；命中强化 hitCount（§1.1）；审核队列 ≈ 草稿闸门（§3.2） |
| [@alanzhao/dsh-memory-lite](https://www.npmjs.com/package/@alanzhao/dsh-memory-lite) | L0 目录 = 一条常驻 durable message（KV cache 近零增量，compaction/变更后重发）；`remember` 仅用户显式要求；软删 `.trash` | 常驻块注入机制（§4.1）；显式优先哲学一致 |

**明确不做（对照后维持原判）**：向量/图检索、consolidation 抽象、MCP 服务化、跨机/多 Agent 共享、git-remote 归一化 scope、独立服务器 —— 与 README 既有取舍一致，是差异化而非缺口。

> 前置调研（通用 MCP 层 8 插件：agentmemory / mem0 / ctxr-dev / MemoryAI / agent-memory-engine / PlugMem / Lotargo / ContextAtlas）结论未变：我们不需要 hook 服务化或向量化，v0.5 的"本地零依赖 + 静默注入 + 显式工具"组合在该层依然成立。

---

## 十二、实施状态（截至 2026-09-06，全部测试通过）

> 本文档 = 方案 + 实现说明 + 验收对照。实现按 PR 顺序落地并全部落地于代码；以下为逐 PR 状态、与正文的偏差、启用方式与实机验证清单。

### PR 1a 数据层 —— 已完成
- `src/similarity.js` 通用双向 token overlap（归一化 0..1；≥0.7 合并 / 0.65~0.7 强化带）
- `src/insight-store.js` 单一 insight 实体：三级存取、sourceTaskIds 累积、2 任务→project / 3 任务→global 自动提升（scope 变更，无双写）、confidence 闸门、归档软删 + 容量溢出物理删、衰减、降级、写盘前密文过滤、`GlobalStore`
- `src/store.js` 接入 `insights.json`（`store.commit` 事务）+ 迁移；`src/global-seed.js` 幂等初始化；`src/tools/lesson-tools.js` `save_lesson`；`src/types.js` JSDoc；index Config `insight.*` + 注册；`select_task` 卡片返回 `insights`
- 测试 `test/insight-store.test.mjs`（11 项）
- **与正文 §1.2/§10 的偏差（有意为之）**：迁移采用**非破坏导入**——v0.4 `experience.json` 保留并继续服务 `remember/forget/query_memory`，首次加载把旧笔记复制导入 `insights.json`（`kind:'experience', source:'migrate'`，`insights.json.migratedAt` 落盘保证只导入一次），`format.json` 版本号不动。销毁式收敛留给"召回统一"PR（届时 query_memory 改读 insights 并退役 experience 通道），避免旧数据在无召回入口的窗口期"失明"并连锁改动 20+ 既有用例。

### PR 1b 反思管线 —— 已完成（默认关）
- `src/reflection-pipeline.js`：`reflectTaskAfter`（task 快照摘要 digest 门控 + `cooldownMs` + 失败静默）、`isReflectDue`、`fireReflect`
- 触发接线：`select_task` 切走旧任务、`archive_task`、`/task switch`、`/task archive`（fire-and-forget，绝不影响响应）；产出只写 task 级草稿（`source:'reflect', draft:true`），自动提升语义沿用 PR 1a
- 测试 `test/reflection-pipeline.test.mjs`（5 项）
- **与正文 §3.1 的偏差**：主触发为"任务切走/归档（含摘要变化才调 LLM）"；**空闲 debounce 与 compaction 前蒸馏未接线**——需要真实宿主事件/钩子验证，属 §3.1 预留位；`reflection.enabled` 默认 false（唯一 LLM 消耗点，遵循仓库惯例默认关）。

### PR 2 静默注入引擎 —— 已接入宿主官方缝（agent/pre-step）
- `src/project-profile.js` tags 画像（package.json/go.mod/Cargo.toml，mtime 缓存）；`src/auto-inject.js`：`buildInjection`（procedure trigger 命中→全步骤，`trigger.scope` 与画像 tags 取交集过滤，procedure 不绕道通用相似度通道；lexical top-k 相关 insights + 预算截断）、`buildEntryContent`（常驻块）、`wrapLlmStream`（纯函数测试用；**任何异常/无 root → 原样透传**，指纹去重）、`cfgEngine`
- **注入缝（实机结论）**：patch `ctx.llm.stream` 无效——宿主管道持有内部 `loopCtx.llm` 引用，包装永远不会被调用。已改为**宿主官方缝 `agent/pre-step`**：`ctx.on('agent/pre-step', …)` 先 `await next()` 取默认 `enter` 决策，再把 `[Memory Inject]` 记忆拼成带 `source: {kind:'plugin', plugin:'dsh-project-memory'}` 的 UserMessage 追加到 `messages` 末尾；root 取自 `agent.session.header.cwd`、sessionId 取自 `agent.session.id`（任务级 entry 因此可用）；同内容 60s 去重；任何异常/无 cwd → 原样返回默认决策（零副作用）。
- 测试 `test/auto-inject.test.mjs`（9 项，含任务级 entry 注入）
- **实机验证清单（重启 dsh web 后在真实会话做）**：
  1. 启动日志出现 `auto-context installed via agent/pre-step` → 注册成功；
  2. 正常聊一句话后出现 `auto-context: FIRST injection fired (… chars, root=…, session=…)` → 注入链路生效；
  3. 上下文可见带 `[Memory Inject]` 前缀的内容（plugin source，可被用户审核）；
  4. 无 cwd 的会话（headless 等）静默跳过，不影响任何路径。

### PR 3 TaskPanel 记忆三视图 —— 已完成（遗留精修见下）
- 服务器 `/insight` 命令 `src/commands/insight-actions.js`：`list` / `confirm` / `promote` / `demote` / `archive` / `restore` / `delete` / `save` / `edit`（纯函数 `listInsights/actInsight/saveMemoryItem/editMemoryItem` 可单测；save 与 `save_lesson` 同语义；edit 白名单含 title/正文/trigger/steps/confidence 等）
- 客户端 `src/client/MemoryView.tsx`：Task 草稿 / Project / Global 三视图列表 + 行内动作 + 新建/编辑表单（procedure 可填 steps 与"作为 Skill"触发关键词）；TaskPanel 头部按钮循环 Task/Project/Global 三视图
- 任务卡内联：`/tasks` 载荷携带每任务 insights，展开卡片内直接审核(confirm)/提升(promote)/删除
- 测试 `test/insight-actions.test.mjs`（7 项）；`pnpm run build:client` 通过
- **刷屏修复（实机反馈）**：`/insight list` 的大 JSON 载荷原会整段渲染进对话——已把 `insight` 注册进 `conversation.chat.commandview`（`client.ts` nodeKeys），`TaskCommandNode` 对 /insight 只渲染一行摘要/一句结果，列表载荷永不进对话。任务卡与记忆视图文案已双语化（`mem.section-label` 等）。
- **遗留精修（非阻塞）**：insight 拖拽重排无（insights 无顺序语义）；其余面板交互（列表/审核/提升/降级/归档/删除/编辑/新建）均已可用。

### 测试与质量
`npm test`：core 166 + TaskBridge 11 + insight-store 11 + reflection 5 + auto-inject 9 + insight-actions 7 = **209 项，exit 0**。client 产物 `client/client.js(.map)` 已重编。插件入口可加载（Config 校验含 `insight/reflection/autoContext`）。

### 启用方式（cordis.patch.yml）
```yaml
- id: project-memory
  config:
    reflection:
      enabled: true        # 反思（默认 false；产出草稿，审核/2 任务命中才入共享层）
    autoContext:
      enabled: true        # 静默注入（默认 true；宿主解析不到会话时自动透传）
      maxTokens: 400
    insight:
      globalFile: /自定义/global.json   # 可选，默认 ~/.config/dsh-project-memory/global.json
```

### 说明已写在哪
- 方案/数据模型/阈值/配置默认值：本文档 §1–§9
- 竞品对照与"明确不做"：§11
- 实施状态/偏差/实机验证清单/遗留精修：§12（本节）
