# dsh-project-memory

> 如果这个插件帮你省下 1 小时 Debug 时间，请点个 Star。

[English](README.md) | [简体中文](README.zh-CN.md)

[![ci](https://github.com/00080000/dsh-project-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/00080000/dsh-project-memory/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![npm](https://img.shields.io/npm/v/@yolk_vat-y/dsh-project-memory)](https://www.npmjs.com/package/@yolk_vat-y/dsh-project-memory) [![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/00080000/dsh-project-memory) [![Awesome](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）agent 提供持久化的 **项目开发记忆**。专门针对项目开发，原生融合 dsh 任务系统，会话内任务清单与读过的文件自动沉淀为跨会话任务记录，任务↔文件自动关联——开发工作流可切换、可续接，无需重复梳理整个项目，解决上下文失效；文档（PDF/Markdown/txt）与代码符号写入工作区独立存储，文档自动交叉链接至所提及的代码符号；经验笔记（问题 → 方案）自动去重，避免重复踩坑。所有数据按项目落盘，跨会话压缩与交接保留，召回附带 `路径:行号` 可回源核实。单依赖，无向量数据库，无原生构建。


> 插件在磁盘上维护一份精简的项目**记忆**，每条记录指向具体的文件与行号；agent 需要快速了解项目时先查**记忆**，无需重读整个项目。任务与经验跨会话压缩与交接保持。
![alt text](docs/images/image.png)

工作流卡片可收起，自动适应dsh及主题插件风格，提供四种卡片风格切换。

![alt text](docs/images/image-4.png)
## 特性

- **TaskBridge：跨会话开发任务** — 监听会话内宿主 `todo_write` 维护的任务清单与 `tool/call` 读文件：进度快照（steps）与触碰文件自动同步进跨会话的任务实体。未绑定会话写 todo 时自动建档。关联文件按**最近活跃排序（写过/编辑的排最前，任何读取不越过写过文件）**，续接时一眼看到该看哪些文件。新会话通过 `list_tasks` → `select_task`（绑定/改名/解归档）续接；`query_memory` 新增 `type:'task'`，`type:'all'` 结果尾部附任务计数提示。用户侧 `/tasks` 命令展示任务栈、步骤进度、涉及文件与当前会话绑定。由模型经 `select_task(title=…)` 命名的任务沿用该标题；由首次 `todo_write` **自动建档**的任务取**清单首条**（≤48 字符）为标题，回退到首条真人消息（取最后一个「：」后的任务段），再回退 `Untitled Task`。以**子代理**身份启动的会话被排除在自动建档之外（`origin: 'subagent'` / `delegationDepth > 0`）；把委派出去的工作并回任务这件事**有意没做**——见「设计取舍」第 11 条。容量随项目体积自适应（fileCount/20，clamp 5–100）。存储：`.dsh-project-memory/tasks.json` + `binding.json`。自动同步需含会话事件与 `todo_write` 的 dsh（0.1.2-alpha.x 实测，并已针对 0.1.5-rc.1 宿主面复核）；旧宿主下降级为纯记录。
- **Task Panel（v0.4.2+）：dsh web 浮动任务面板** — 按 dsh web 0.1.5-rc.1 真实 client 插件契约落地（cordis inject + apply，注册进宿主 `shell.overlay` 槽）。卡片可拖拽、展开查看步骤/文件（点击复制路径）；折叠为可拖拽顶部迷你条；可彻底隐藏（输入 `/task` / `/tasks` 唤起）。渲染错误有边界兜底，面板崩溃不再拖垮宿主。
- **任务面板行为** —
  - **默认隐藏**：dsh web 启动时面板不显示
  - **显式唤起**：输入 `/tasks` 或 `/task`（列表形式）打开；模型调用 `show_task_panel` 工具打开
  - **会话切换**：仅后台同步数据，**不**自动打开面板
  - **刷新页面**：面板保持隐藏（UI 状态 `closed` 不持久化）
  - **手动关闭**：点击 × 彻底隐藏（无迷你条）；重新打开需显式唤起
  - **折叠迷你条**：点击 ↓ 仅保留顶部可拖拽迷你条；点击迷你条展开
  - **隐藏提示信息**：点击 ? 关闭面板内所有悬停提示气泡（含拖拽把手、风格/视图/收起/关闭、双击改名、步骤状态、复制路径、迷你条与记忆视图），偏好写入 localStorage，刷新后保持；关闭态按钮变暗，再点恢复
- **任务清单双向同步（宿主 ↔ 插件任务，v0.4.2+）** — `select_task` 或 `/task switch` 绑定任务时，将任务 steps 推给宿主 `todo/write`，dsh 渲染的任务清单跟随我们维护的任务实体。配置 `tasklist.syncHostOnAdopt`（默认开）可关。空 `todo/write` 语义定为「清空」：未绑定会话清空清单不再误建垃圾任务；已绑定则清空该任务 steps（任务保留）。面板编辑（改步骤文本/状态）= 写回绑定任务并推宿主清单，与模型 `todo_write` 共用一套逻辑，无第二套同步。`/task` 新增 `switch` / `archive` / `unbind` / `rename` / `todos`（均由面板按钮/双击调用，不经模型）；`unbind` 同时清掉输入框上方的宿主任务清单。
- **面板编辑与风格（v0.4.2+）** — 绑定卡片：双击标题/步骤行内编辑（输入框随内容自动增高），点步骤状态图标循环 待办→进行中→已完成；非绑定卡片只读。**四档外观风格**（点标题左侧文件夹图标切换，本地记忆）：原生 / 玻璃拟态 / 粗野主义 / 终端等宽——只改材质、几何、字型与密度，颜色始终取自 dsw 别名令牌，跟随宿主明暗与主题插件。
- **文档记忆** — PDF、Markdown、纯文本按块切分并生成摘要，**索引期不调用任何模型**：每条记忆保留 ≤300 字符的 `summary` 供注入、一个有界（≤160）且确定性、去停用词的 `terms` 集合覆盖**整个 chunk**（仅用于检索，因此召回不受开头几行限制），并携带 `路径:行号` 引用回源文件。历史字段 `blindSpots` 在索引期不调用模型后恒为空，仅为兼容早期版本写下的存储而保留。
- **代码符号记忆（L1 正则）** — 零依赖扫描器提取函数、类与方法及其完整签名（泛型、参数/返回类型、重载），并覆盖接口与类型别名，支持 8 种语言，产出单行身份签名 `fn(a: A, b: B): R — file.ts:42`；含字符串/注释掩码、多行签名续行、Python 缩进感知与类方法上下文，不使用 LLM token。
- **可选 TypeScript 语义增强 (L2/L3)** — 当用户项目安装了 `typescript`（`npm i -D typescript@5` 或 `npm i -D typescript@6`），插件自动激活第二层（L2），利用 TS Compiler API 推导返回类型、实例化泛型、提取接口与类型别名、丰富箭头函数签名 —— 全部在优先级队列中异步后台处理（P0：`fs/observed` 读文件瞬间、P1：`watch` 变更后、P2：`index_repo` 批量索引）。结果按文件内容哈希缓存到磁盘（L3），冷启动毫秒级复用。零配置：装 TS 再重启 dsh 即可。完全可选；若无 TS 或设置 `enableTypeScript: false`，回退至 L1 正则提取。
- **自动刷新** — `watch_repo` 后台轮询，按内容哈希识别新增或变更文件，仅重记这些文件。
- **读到即记忆** — 文件在模型**实际读取的瞬间**被记忆（监听 `fs/observed`），记忆是正常工作的副产品，而非额外的一次全量扫描。从未读过的文件不会被记忆。项目根通过标记（`.git`、`package.json` 等）、README 加源码目录、或兜底到文件所在目录逐级识别。
- **文档 ↔ 代码交叉链接** — 文档提及某符号时记录为 `reference`；查询符号时同时带出描述该符号的文档。
- **BM25 记忆召回** — 对文档、符号与经验笔记进行排序召回，可选 LLM 查询扩展以应对表述不一致。**CJK 增强**：精确短语乘法加分（3+ 字短语在标题/关键词命中 ×1.5）、同义词表（如 数据库连接池 ↔ 连接池 ↔ DB pool）、CJK 感知的文档↔符号链接边界。
- **经验笔记** — 记录问题 → 方案；相似问题覆盖而非重复；笔记仅在检索命中时返回。笔记数量有界：容量随项目规模伸缩（钳制在 100–2000），超限时淘汰最旧的笔记。**覆盖阈值收紧为双向 0.7 重叠**（原 0.6）；**经验 `problem` 字段现参与 CJK 短语加分**，提升长尾问句召回。
- **v0.5 分层 insight 记忆（教训 / 决策 / 流程）** — 一个 `insight` 实体贯穿三级：`task`（任务私有草稿，存 `tasks.json`）、`project`（`.dsh-project-memory/insights.json`）、`global`（`~/.config/dsh-project-memory/global.json`）。`save_lesson` 三级可写；去重采用双向 token overlap ≥ 0.7（合并）外加 0.65–0.7 近重复强化带；**提升 = scope 字段变更而非复制**——同一 insight 被 2 个任务命中升 project、3+ 升 global。归档为软删（`archived`），容量/衰减只清归档区；写盘前过滤密钥/token 形态内容。LLM **反思默认关闭**，且只产任务级草稿（`source: reflect`，触发于任务切走/归档时）。面板新增 Task / Project / Global 记忆视图：审核、提升/降级、归档/恢复、删除、编辑与新建表单（procedure 可带"作为 Skill"触发关键词）。旧 `experience.json` 笔记**非破坏**导入 `insights.json` 一次。所有 kind 都可带 authored `trigger`（`keywords` / `symbols` / `actions` / `paths`）：命中即**在动手前**确定性注入——v0.5 仅 procedure，就绪层起覆盖全部 kind。
- **流式 TF + IDF 缓存** — 查询路径按存储版本缓存 IDF（词逆频率）；命中时单次流式遍历 20k 条目（5k 文件）为 p50 2.6 ms / p95 5.4 ms，4k 条目（1k 文件）为 p50 0.6 ms / p95 1.6 ms，零中间对象。只有**真正脏了**的写入才递增版本号并清空缓存——无变更时 `save()` 在碰盘前直接返回，因此 15 秒一轮的 watch 轮询不会把查询刚建好的 IDF 缓存清掉。
- **无锁同步事务** — 不采用锁：所有写入（index / watch / remember / forget / watch_repo）统一走同步事务 `store.commit(fn)`，fn 成功后才一次落盘；JS 单线程事件循环保证事务间不交错，`remember`/`forget` 不会被 watch 重索引阻塞排队。全部写入在**进程内**串行；CAS 幂等更新保证同一文件的重复写入不会写坏。但这里**没有跨进程文件锁**——请勿让多个 dsh 实例同时写同一项目存储（见「设计」的一致性一节）。
- **依赖极简** — 纯 JavaScript；唯一运行时依赖是 `pdfjs-dist`（PDF 文本提取），无需原生构建。
- **开销可忽略** — 纯进程内操作；5k 文件的 store 冷加载 40 ms，20k 条目的缓存查询 p50 2.6 ms / p95 5.4 ms（4k 条目：p50 0.6 ms / p95 1.6 ms）；瓶颈在 PDF 解析与磁盘 I/O，插件本身的打分开销不阻塞。

## 性能

### 合成基准测试（Node 24.19，WSL2 / 20 vCPU，Linux 文件系统）

| 场景 | 规模 | 实测 |
|------|------|------|
| 批量冷记忆构建 | 5,000 文件 / 20k 条目 | 269 ms 均值（p50 267）|
| 冷加载 | 5,000 文件 | 40 ms |
| 热路径懒记忆 | 单文件重记忆+落盘 | p50 2.4 ms / 最大 5.5 ms (5k) |
| query_memory (缓存命中) | 5k 文件 / 20k 条目 | p50 2.6 ms / p95 5.4 ms |
| query_memory (缓存命中) | 1k 文件 / 4k 条目 | p50 0.6 ms / p95 1.6 ms |
| 批量冷记忆构建 | 10,000 文件 / 40k 条目 | 551 ms 均值（p50 528）|
| 冷加载 | 10,000 文件 | 90 ms |
| 热路径懒记忆 | 单文件重记忆+落盘 | p50 5.4 ms / 最大 9.2 ms (10k) |

> 合成基准：生成代码（~4–5 符号/文件），Node 24.19 / WSL2 / 20 vCPU / Linux 文件系统，实测于 2026-09-14。复现命令 `npm run bench:synthetic -- 5000`（脚本 `scripts/bench-synthetic.mjs`）。测量纯索引开销，不含 LLM 调用。query_memory 使用 IDF 缓存 + 预计算 searchText；写入后的首次查询会重建 IDF（**40k 条目 106 ms**，20k 条目 57 ms，4k 条目 12 ms），后续查询命中缓存。

### 真实项目存储体积

| 项目 | 文件数 | 条目数 | 存储体积 | 单条目 |
|------|--------|--------|----------|--------|
| Java Spring Boot 后端 | 1,254 | 7,335 | 6.7 MB | ~0.9 KB |
| Vue 3 + Vite 前端 | 289 | 2,141 | 1.0 MB | ~0.5 KB |

> 真实项目（Java + Vue），测试于 Linux 文件系统（Node 24）。真实项目单条目体积小于合成基准，因符号密度更低、声明行更短。

### 自己复现这些数字

与其让你相信上面的表格，不如把测量本身一起发布。脚本**不需要 dsh 实例、不需要网络、不调用任何模型**，也**不碰被测项目自己的 store**——结果写进临时目录，跑完删除：

```bash
npm run bench -- /你的/项目路径
# 或带参数：
node scripts/bench.mjs /你的/项目路径 [--json] [--samples 100] [--no-pdf] [--keep]
```

输出包含：冷索引（拆成 read+hash / extract / commit 三段）、冷加载、IDF 重建、冷查询与热查询延迟（走线上同一套 scorer，100 条采样报 p50/p95/max）、单文件热重索引、存储体积与每条字节数。示例——我们内部的 Vue 项目（289 文件 / 2,141 条目，Node 24，20 CPU，Linux）：

```
冷索引     253 ms   （read+hash 9 ms · extract 229 ms · commit 13 ms）← 第二次、页缓存已热
存储       1.10 MB · 538 bytes/条目 · 冷加载 4.6 ms
热查询     p50 0.80 ms · p95 1.35 ms          （2,141 条目）
单文件重索引  p50 0.33 ms
```

两个我们宁可自己说清楚的坑：`read+hash` 受操作系统页缓存影响——同一个语料第一遍花了 787 ms、第二遍 253 ms，报数时请说明是第几遍；**真实项目比上面的合成基准慢**——在一个大型 TypeScript 仓库的 3,000 文件切片上（15,594 条目）热查询 p50 为 7.5 ms，因为真实声明文本比生成出来的桩代码长得多。带 `--queries 你的查询集.json` 可以在你自己的项目上跑同一套标注集方法（hit@5 / hit@10 / MRR）。

## 工作原理

设计遵循四个原则：

- **易失性** — 上下文是临时的，会话压缩即丢失。
- **持久性** — **记忆**存于磁盘，跨压缩与会话保留。
- **紧凑性** — 代码层每个符号只存一行声明，所以代码为主的项目仍约 **0.5% 源码体积**（示例项目中 8.8 MB 源码 → 49 KB 索引），**召回**替代了通读整个文件。文档层按设计更重：每个 chunk 保留 ≤300 字符的注入 `summary`、覆盖整 chunk 的 `terms`，以及预计算的 `searchText`。纯文档语料实测（179 chunk / 225 KB Markdown）：`terms` ≈ 源码 **27.5%**，整库落盘 ≈ 源码 **166%**——文档占比高的项目请按「约等于文档本身大小」估，而不是 0.5%。
- **可核验性** — **召回**在适用时携带 `路径:行号` 引用，agent 可对照源文件核实。

构建**记忆**无需预先全量扫描：文件在模型读取时被记忆，**记忆**恰好覆盖实际处理过的内容。未变更的文件重读是空操作（内容哈希），因此**记忆**的持续维护开销很低。

存储按项目独立存放，并跟随代码库变化：文件变更按内容哈希重新抽取，文件删除则同步移除。经验层仅检索，累积不影响上下文。

## 安装

插件仅依赖通过 peerDependencies 声明的稳定公共 API（`defineTool`、`llm.stream`、`Schema`），保证与后续 rc/alpha 版本无需改动即兼容。

```bash
cd dsh-project-memory && dsh plugin --profile web add . -w
```

`-w`（workspace-root）标志是必需的：profile 目录是 pnpm 工作区根目录，不带该标志 pnpm 会拒绝 add。其他目录下同样可用路径形式：`dsh plugin --profile web add /path/to/dsh-project-memory -w`。

插件同时发布在 npm 上（scoped 包）：

```bash
dsh plugin --profile web add @yolk_vat-y/dsh-project-memory -w
```

每个版本会附带预构建 tarball，无需构建步骤即可安装：

```bash
dsh plugin --profile web add /path/to/dsh-project-memory.tgz
```

每个被索引的项目在 `<root>/.dsh-project-memory/` 下有独立存储。如无需入库，可加入 `.gitignore`。

## 用法

以下工具由 **agent 自动调用**，无需用户手动输入。在对话中直接说自然语言即可——例如「给这个项目建个索引」或「auth 模块是干嘛的」，或者正常开发即可——agent 会自动调用对应工具。默认开启「读到即索引」（`lazyIndexing`）：模型读哪个文件，就顺便索引哪个文件，记忆在你干活的过程中自然积累。`watch_repo` 让显式监听的根目录在后台保持新鲜；`index_repo` 强制对项目做一次全量回填（未变更文件自动跳过）。

| 工具 | 用途 |
|---|---|
| `index_doc file_path` | 索引单个文档（PDF/MD/txt）：分块 → 确定性 `summary` + 整 chunk `terms` → 带 `路径:行号` 入库。未变更文件自动跳过。 |
| `index_repo root` | 索引整个项目：文档生成确定性摘要 + 整 chunk 词项，代码文件生成零 token 符号表。增量更新、清理已删除文件、文档与符号交叉链接。根目录不存在（含在 Linux/macOS 上被解析成相对路径的 Windows 风格路径）时，会在写入任何内容前直接拒绝。 |
| `watch_repo root` | 启用自动刷新：后台轮询检测新增/变更文件（mtime + 内容哈希），仅重抽这些文件。监听的项目在插件重启后自动恢复；不存在的根目录、文件系统根与共享临时目录都会被拒绝，已消失的根目录会被丢弃而不是被重新创建。 |
| `memory_stats root` | 查看记忆库内容：总量（文件 / 条目 / 经验笔记）、最近索引时间，以及按时间排序的逐文件清单。 |
| `query_memory query` | 对文档、符号、经验与 insight（教训/决策/流程）执行 BM25 检索，可选 LLM 查询扩展。`type` 选择层（`all` / `doc` / `symbol` / `experience` / `insight` / `task`）。返回带相对分数（0-100）、引用或 insight id、以及文档→符号链接的排序结果。 |
| `list_tasks` | 列出本项目任务记录（含归档，带标记）。新会话/续接前先调用。 |
| `select_task` | 将会话绑定到某任务（此后 todo 清单与读文件同步进该任务）。按 `taskId` 精确绑定，或按 `title` 完全匹配（多个同名返回候选；无则新建）。带 title 可改名；自动解归档。 |
| `archive_task` | 归档任务（隐藏默认视图、不占容量、停止同步）。`select_task` 可恢复。 |
| `show_task_panel` | 在 UI 中打开任务面板。用户要求查看任务列表或你想展示面板时调用。 |
| `/tasks`（用户输入，不经模型） | 展示任务栈：标题、步骤进度、涉及文件、当前会话绑定哪套任务。 |
| `/task`（用户输入，不经模型） | 任务面板子命令：`switch` / `archive` / `unbind` / `rename` / `todos`（面板按钮/点击触发，不经模型）。 |
| `/insight`（用户输入，不经模型） | v0.5 记忆视图动作（面板按钮触发）：`list [task|project|global]`、`confirm` / `promote` / `demote` / `archive` / `restore` / `delete` `<scope> <id>`、`save <scope> <json>`、`edit <scope> <id> <json>`。 |
| `remember problem solution` | 保存经验笔记。相似问题覆盖而非重复。 |
| `forget id_or_query` | 删除过期经验笔记。 |
| `save_lesson`（模型工具） | 在 task/project/global 任一作用域保存教训/决策/流程（单一 insight 实体）。近重复按双向 overlap ≥ 0.7 合并、0.65–0.7 强化；同一 insight 被 2+ 任务命中自动 task→project、3+ → global。参数：`title`、`kind`、`scope`、`pattern`/`fix` 或 `choice`/`reason` 或 `steps`、`trigger`（`keywords`/`symbols`/`actions`/`paths`/`scope`，所有 kind 通用，命中即在动手前注入）、`task_id`、`files`、`symbols`、`confidence`、`root`。 |

## 设计

```
.dsh-project-memory/
  format.json      布局标记（v2，分片式）
  shards/          每个被索引源文件一个自描述 JSON
                    （{ relPath, record, entries }）——写入只落脏分片
  experience.json  问题 → 方案笔记（仅检索）
  watch.json       被监听根目录
  tasks.json       TaskBridge 任务实体（跨会话）
  binding.json     当前会话 ↔ 任务绑定
  insights.json    v0.5 项目级 insights（教训/决策/流程）；v0.4 经验笔记非破坏导入一次
```

v0.2.0 之前创建的库（单文件 `entries.json` / `index.json`）在首次加载时自动幂等迁移。同一个 dsh 进程内，所有工具调用共享每个项目的单一内存 store 实例，热路径索引只写发生变化的那一个分片。

- **增量** — 按文件内容哈希，仅重新抽取变更文件。
- **交叉链接** — 索引后将文档摘要与符号名匹配，命中符号以 `references` 挂载到文档条目，由 `query_memory` 带出。
- **查询扩展** — `llmQueryExpansion` 开启时，`query_memory` 让 `ctx.llm` 将查询改写为多个变体（同义词、中英、符号名猜测），再跨变体合并 BM25 分数；关闭时查询完全不碰 LLM。索引本身不调用模型：keywords 由规则推导（标题加权词项），doc↔symbol 链接也会从中文命中带出英文符号名。
- **一致性** — 事实层跟随代码库（哈希重抽 / 删除即移除）；经验层仅检索，配合覆盖与 `forget` 机制。每个记忆目录的写入走同步事务 `store.commit(fn)`：fn 内完成校验与变更、成功后才原子落盘，单进程内天然串行；请避免多个 dsh 实例同时写同一项目存储。

## 架构（任务面板）

```
TaskPanel (Container)
├── task-data-store  (服务端数据，跨标签页 BroadcastChannel 同步)
├── task-ui-store    (本地 UI 状态，localStorage)
├── task-hooks       (useTaskDrag, useTaskEdit)
└── TaskComponents   (MiniBar, TaskCard — 纯展示组件)
```

## 设计取舍

### 1. 同步无锁事务，而非异步锁

**我们做：** 所有写入走 `store.commit(fn)` 同步事务。回调 `fn` 内完成校验与变更，成功后才原子落盘。JS 事件循环天然串行，CAS (`applyFileUpdate`) 让并发写入幂等。

**不做：** 异步互斥锁、文件锁、多进程协调。

**为什么：** DSH 基于 Cordis，单进程是架构基石。为极少见的多进程场景加锁，会让热路径（每次 `remember`/`forget`/`index_doc`）增重。同步事务让热路径中位数 ~2 ms，零争用开销。

### 2. Watch：事务外计算，事务内提交

**我们做：** 重活（mtime/哈希/扫描/解析/PDF 抽取）在事务外跑，单次 `commit` 原子应用全部变更。失败回滚 snapshot，下轮自动重试。

**不做：** 持锁做解析，或用 `fs.watch` 事件。

**为什么：** PDF 抽取与大文件解析耗时明显，持锁会阻塞 `remember`/`forget`/`query_memory`。轮询 + mtime+内容哈希跨平台一致（网络盘、Docker 卷、WSL 皆可），避免 `fs.watch` 的「重复触发/漏事件」噩梦。

### 3. 损坏文件隔离，不自动修复

**我们做：** JSON 解析失败时，坏文件改名 `*.corrupt`、记错误、该文件存储重头开始，其余分片不受影响。

**不做：** 预写日志 (WAL)、嵌入式数据库、自动部分恢复。

**为什么：** 一个损坏分片 = 一个源文件索引丢失，隔离成本近零。WAL 或嵌入式 DB 增加 500 KB+ 原生依赖、锁竞争、新故障模式（WAL 自身损坏）。权衡：丢一个文件索引 vs. 引入重型原生栈。

### 4. 查询零向量、零语义搜索

**我们做：** BM25 + CJK 短语加分（3+ 字 ×1.5）、同义词表双向展开、字段加权（标题 ×5）、经验层短语加分。查询侧零 LLM 调用。

**不做：** 向量嵌入、稠密检索、重排序、混合搜索。

**为什么：** 向量需要嵌入模型（本地重、远程慢+贵+隐私）、向量索引（HNSW/IVF 占内存+建索引慢）、重排序（再调一次 LLM）。对本插件所针对的查询，词法 BM25 已经够用且可核实：基准（真实 Vue 项目 29 条查询）文件级 hit@5 为 **96.6%**，其中 28 条是精确符号名查询、词法检索基本必中；整 chunk `terms` 把文档词项覆盖从 **27.3% 提到 100%**，而原本可答的查询排序不变（MRR **0.958** vs **0.955**）。这些数字来自内部一个 Vue 项目 + 手工标注的 29 条查询集，出了那个语料无法复现——但**方法**已随代码发布：`scripts/bench.mjs --queries 你的查询集.json`，可以在你自己的项目上跑完全相同的测量。边际收益不抵 10x 复杂度/成本。

### 5. 索引确定且不调用模型

**我们做：** keywords 由规则推导（标题加权词项），并构建覆盖整 chunk 的 `terms`——两者都确定、可复现。doc↔symbol 链接从中文命中带出英文符号名，CJK 分词保证跨语种命中。`llmQueryExpansion: false` 时查询完全不碰 LLM。

**不做：** 索引时调用模型去翻译或改写文档，也不在查询时翻译。

**为什么：** 索引期调用模型会让索引变慢、不确定、不可复现——同一份文档两次索引可能得到不同结果。查询时翻译增延迟，且有一个硬失败模式（译错 = 零召回）。规则 + 符号链接覆盖常见情况，离线可用，并让索引期保持零模型调用。

### 6. 面向模型的记忆：agent 自己写，不把人放进回路

**我们做：** 把 agent 当作一等写入者。`remember` / `save_lesson` **随时可写任意作用域**（`task` / `project` / `global`），不需要人参与；提升是确定性的，就发生在普通写入路径里：跨任务的 token 重叠去重会累积 `sourceTaskIds`，随后 `promoteAllTasksToProject` / `promoteProjectToGlobal` 在佐证数达标时把条目上移（升 project 需 ≥2 个任务命中，升 global 需 ≥ `globalPromoteTasks`，默认 3）。整条链路不等任务面板：用户从不打开 UI，记忆照样会积累、去重、逐级提升。

**我们做（标注）：** 让「推断出来的」和「记录下来的」可区分。v0.5 `reflection`（可选、**默认关闭**）是唯一做推断而非记录的写入者：它写的是 task 级草稿，带 `draft: true` / `source: 'reflect'`；只要还是草稿，`recall` 与静默注入就会跳过它。

**不做：** 不要求「人工批准」记忆才能生效，也不把 UI 变成写入路径上的一步。`draft` 是**来源标记 + 佐证门槛**，不是审批队列。

**为什么：** 记忆的消费方是 agent，而 agent 通常是无头的——只在有人点卡片时才升级的记忆，等于永远不会升级。保留标注就保住了这份谨慎里有用的那一半（推断 ≠ 记录，且未经佐证的单任务推断不进提示词），同时又不用给正常路径加税。草稿靠佐证毕业：第二个任务通过模型自己的写入命中了它，或者模型把同一知识直接写到 project 级（此时会挂到既有条目上，而不是复制一份）。

### 7. 直接返回完整条目

**我们做：** `query_memory` 直接返回含 `path:line` 引用的完整条目，每条可回源核实。

**不做：** 先返回极简索引（如 700 字符），再二次调工具取详情。

**为什么：** 完整返回保持 **可核验性**——Agent 能看到每条声明的出处行号。也避免了每次有效命中多一轮工具调用+上下文切换。条目本已紧凑（~300 字摘要+引用，外加一个从不进上下文的检索用 `terms`），完整返回的 token 成本低于二次调用。

### 8. 符号提取聚焦开发者实际搜索的内容

**我们做：** 正则符号提取（函数/类/方法/接口/类型别名），含字符串/注释掩码、多行签名、跨文件按名链接。对 TypeScript/JavaScript 项目，可选的 L2 增强层利用 TS Compiler API 推导返回类型、实例化泛型、提取接口 —— 全部按内容哈希缓存，毫秒级复用。

**不做：** tree-sitter AST、导入图、调用图、跨文件全程序类型推导。

**为什么：** 正则扫描器零依赖、8 语言、<1 ms/文件，覆盖开发者最常搜索的声明（名字、签名、泛型）。可选 TS 增强层为 TS/JS 提供语义深度，且无原生依赖。按名跨文件链接已覆盖最常见的「找相关代码」场景。全程序分析会引入原生二进制、安装体积增 10x、语言版本即破——边际收益仅在剩余 5% 的边缘情况。

### 9. `forget` 按关键词激进；精确请用 ID

**我们做：** `forget query` 删除所有 token 重叠 ≥0.5 的经验笔记。

**不做：** 交互确认、软删除/回收站、仅精确匹配。

**为什么：** 经验笔记低风险、高量、仅检索。激进删除防止陈旧噪音污染搜索。精确删用 ID（`query_memory` 输出里有）。

### 10. TS 增强可选、异步、缓存

**我们做：** L2 TS Compiler API 在优先级队列异步跑（P0 `fs/observed`、P1 `watch`、P2 `index_repo`），结果按内容哈希缓存 `type-cache/`。零配置——`npm i -D typescript@5` 或 `npm i -D typescript@6` 即用。无 TS 或禁用时优雅回退 L1 正则。

**不做：** 强制 TS、阻塞式增强、全程序类型检查。

**为什么：** 强制 TS 会让非 TS 项目装不上。阻塞增强会卡死大项目 `index_repo`。全程序检查慢 10x、内存重。设计：读到即增强、缓存复用、热路径永不阻塞。

### 11. 子代理会话暂不纳入（以后可能做）

**我们做：** 把以子代理身份启动的会话（`origin: 'subagent'` / `delegationDepth > 0`）排除在自动建档与绑定之外：它们的 `todo_write` 不建任务，也不继承任何任务绑定。

**不做：** 把委派出去的运行的 steps 与文件并回派发它的那条任务。这块**尚未设计**：目前没有委派工作的父子关联模型，而粗暴实现只会让每个子代理各铸一条项目任务。

**为什么：** 子代理只要写一次 todo 就会各自建档，一次 fan-out 就会往任务列表里灌进一批没人会续接的临时条目。排除掉它们，任务列表才等于「用户真正拥有的工作」。代价是委派进度在任务记录里不可见；正确的合并方式（子步骤折进父任务，或单列一个委派视图）属于后续工作。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `memoryDir` | `.dsh-project-memory` | 每个被索引根目录内的存储目录 |
| `chunkChars` | 3000 | 每个文档块最大字符数 |
| `maxChunksPerFile` | 40 | 每文档最大块数 |
| `maxFileSizeMb` | 50 | 大于该值（MB）的文档（含 PDF）/代码文件跳过 |
| `maxOutputChars` | 8000 | `query_memory` 返回文本上限（字符） |
| `tasklist.enabled` | true | 启用 TaskBridge 自动同步（由会话 todo 清单与文件读取沉淀任务实体） |
| `tasklist.syncHostOnAdopt` | true | `select_task`/`/task switch` 绑定任务时，将其 steps 推给宿主 `todo/write`，使 dsh 任务清单镜像任务实体 |
| `maxPdfPages` | 1000 | 未另行限制时 PDF 的页数上限 |
| `llmQueryExpansion` | false | BM25 检索前通过 `ctx.llm` 扩展查询（默认关闭，节省 token） |
| `expansionCount` | 6 | 扩展变体上限 |
| `lazyIndexing` | true | 模型读取文件的瞬间即索引（`fs/observed`） |
| `autoIndexOnFirstUse` | false | 插件加载时对当前工作目录做全量扫描（可选） |
| `watch` | true | 启用后台刷新 |
| `watchInterval` | 15 | 轮询间隔（秒） |
| `tsPath` | (自动) | 可选：强制指定特定 `typescript` 安装路径；省略时按项目 cwd → 插件 node_modules 向上解析 |
| `enableTypeScript` | true | 设为 `false` 彻底禁用 L2 TS 增强（仅保留 L1 正则） |
| `insight.*` | dedupOverlap `0.7` · reinforceBand `0.65` · maxProject `100` · maxGlobalProcedures `200` · promoteConfidence `0.7` · globalPromoteTasks `3` · decayDays `90` · `globalFile`（自动） | v0.5 insight 去重/强化/提升/容量/归档设置 |
| `reflection.enabled` | false | v0.5 LLM 反思，**只写任务级草稿**（触发于任务切走/归档）。`cooldownMs` `1800000`、`maxLessonsPerReflect` `3`、`maxDecisionsPerReflect` `2` |
| `autoContext.enabled` | true | v0.5 静默注入包装（entry 常驻块 + relevance）。宿主无法解析会话 cwd 时完全透传（零副作用）；`maxTokens` `400`、`editedMax` `3`（resident 任务卡显示最近"编辑中"文件数）、`signalMinRatio` `0.5`（提示至少要达到该层最高分的一半）、`skipEchoSelfTodo` `true`（模型自己写/维护任务清单后、无新人类消息时不回声任务卡，省 token；相关 insights 仍注入） |

### 功能开关

两个最常用的开关是 `lazyIndexing`（模型读取文件的瞬间即索引；默认开启）和 `autoIndexOnFirstUse`（插件加载时对当前工作目录做全量扫描；默认关闭）。懒加载建立的索引根会自动注册到 watcher，文件变更无需手动 `watch_repo` 也能保持新鲜。

配置存放在插件的 config 对象中。修改方式：在 profile 的 `cordis.patch.yml` 里加一条覆盖项——web profile 对应 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: project-memory
  config:
    lazyIndexing: true          # 开启：模型读到哪个文件就索引哪个（默认）
    autoIndexOnFirstUse: false  # 关闭：不做加载时的全量扫描（默认）
    llmQueryExpansion: false    # 关闭：不用 LLM 扩展查询，节省 token（默认）
    watch: true                 # 开启：被监听根目录后台保持新鲜（默认）
    watchInterval: 15           # 轮询间隔（秒）
    enableTypeScript: true      # 开启：装了 TS 时启用 L2 语义增强（默认）
    # tsPath: /custom/path/to/typescript  # 可选：强制指定 TS 安装路径
```

只需列出要改的键，其余键回落到插件默认值。用 `dsh --profile web --dump-config` 验证生效。

不想改 profile 文件、只想临时试一次，可用 CLI 补丁覆盖：

```bash
dsh web --patch ./config.yml
```

其中 `config.yml` 内容就是上面的覆盖块。

## 开发（面向贡献者）

以下命令用于**维护插件源码**，普通用户无需执行。安装插件只需使用[安装](#安装)一节中的命令。

```bash
npm install
npm test          # 280 项测试（核心 180 + TaskBridge 16 + insight-store 11 + insight-actions 9 + doc-index 8 + auto-inject 7 + host-contract 7 + reflection 5 + llm-route 4 + client-hints 2 + recall 8 + readiness 13 + insight-derive 6 + readiness-eval 4）
npm run bench -- /你的/项目路径   # 对任意项目量索引/查询性能，不需要 dsh
```

## 许可证

MIT