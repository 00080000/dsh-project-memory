# Changelog

## 0.4.3 (2026-09-04)
### 修复
- **CI 依赖解析**：锁定 devDependencies 版本，新增 package-lock.json

## 0.4.2 (2026-09-04)

### Task Panel 重构：真实 dsh web 契约 + 任务清单双向同步

- **Client 落地（修复此前面板无法注册/显示）**
  - 按 dsh web 0.1.2-rc.1 真实 client 插件契约重写（cordis inject + apply，注册进宿主 `shell.overlay` 槽）；此前使用的槽位/接口在 rc.1 不存在，现已全部对齐真实注册面
  - 浮动任务面板：卡片可拖拽、展开看步骤/文件（点击复制路径）；折叠为可拖拽顶部迷你条；可彻底隐藏（输入 `/task` / `/tasks` 唤起）；渲染错误有边界兜底，不再因一次崩溃被宿主整条退休
  - 会话内 `/tasks`、`/task` 命令节点改为专属一行渲染：不再输出长文本+JSON，数据经载荷自动同步进侧边面板

- **任务清单双向同步（宿主 ↔ 插件任务）**
  - 反向接管：`select_task` 或 `/task switch` 把任务设为会话绑定时，任务步骤推成宿主 `todo/write`——dsh 渲染的任务清单跟随我们维护的任务；配置 `tasklist.syncHostOnAdopt`（默认开）可关
  - 空 `todo/write` 语义定为「清空」：未绑定会话清空清单不再误建垃圾任务；已绑定则清空该任务 steps（任务保留）
  - 用户编辑走同一镜像：面板改步骤/状态 = 写回绑定任务并推宿主清单，与模型 `todo_write` 共用一套逻辑，无第二套同步
  - `/task` 新增 `switch` / `archive` / `unbind` / `rename` / `todos`（均不经模型，由面板按钮/双击调用）；`unbind` 同时清掉输入框上方的宿主任务清单

- **面板编辑与风格**
  - 绑定卡片：双击标题/步骤行内编辑（输入框随内容自动增高），点步骤状态图标循环 待办→进行中→已完成；非绑定卡片只读
  - 四档外观风格（点标题左侧文件夹图标切换，本地记忆）：原生 / 玻璃拟态 / 粗野主义 / 终端等宽——只改材质、几何、字型与密度，颜色始终取自 dsw 别名令牌，跟随宿主明暗与主题插件

- **测试与维护**
  - TaskBridge 测试增至 11 项（新增反向接管、空写语义等）；既有 166 项全绿
  - 清理：移除废弃 client 包依赖与死代码，样式收敛到 dsw token



## 0.4.1 (2026-09-03)

### TS 6.x 兼容

- **L2/L3 增强器**：验证 TS Compiler API 在 TypeScript 6.0.3 下完全兼容，放开版本限制；`peerDependencies` 与运行时检查同步支持 `^5.0.0 || ^6.0.0`
- 仅拦截 TS 7.x+（major 版本通常有 breaking changes），警告提示更新为「请使用 TS 5.x/6.x 获得增强类型」

## 0.4.0 (2026-09-02)

### TaskBridge：跨会话开发任务（取代 v1.2 workflow 方案，v2.5 契约落地）

- **定位**：模型会话内用宿主 `todo_write` 维护的清单 + 实际读过的文件，自动沉淀为跨会话可续接的任务实体——新会话 `list_tasks` → `select_task` 即接回进度与文件
- **事件订阅（`session/event`，签名 (session, event)）**：`todo/write` → 绑定任务 steps 快照整体覆盖，未绑定会话自动新建任务并绑定；`tool/call`（read/write/edit/read_image，`arguments` 为 JSON 串）→ 绑定任务 files 并集（归一化相对路径、项目外拒绝、上限 100）
- **标题由模型定**：`select_task(title=任务名)` 先命名再写 todo；自动回退取用户消息最后「：」后的任务段（截断 48 字）；续接可 `select_task(taskId, title)` 改名
- **工具**：`list_tasks` / `select_task`（taskId 精确、自动解归档；title 完全匹配、多候选返回列表、无则新建）/ `archive_task`
- **用户命令 `/tasks`**（`ctx.commands` 存在时注册，handler 不经模型）：任务数、标题、步骤进度、涉及文件、当前会话绑定；快捷键无宿主 API 不做
- **`query_memory`**：新增 `type:'task'` 检索（title/steps/files）；`type:'all'` 结果尾部附一行任务计数提示
- **存储**：`.dsh-project-memory/tasks.json` + `binding.json`（load 兜底空值、独立于 format v2 布局）；容量随项目体积自适应 `fileCount/20` clamp [5,100]，超限按 lastActiveAt 归档最旧
- **边界**：不做步骤↔文件映射（todo 无 id、全量替换，语义上不可靠）；不去重（宿主语义）；子代理会话无法可靠判定，接受其自动建档（低频）
- **环境要求**：自动同步需含 `session/event` 事件与 `todo_write` 的 dsh（0.1.2-alpha.x 实测）；旧宿主 `ctx.on('session/event')` 不触发时降级——任务工具仍可作纯记录使用
- **测试**：新增 `test/taskbridge.test.mjs`（5 项：持久化往返/容量裁剪/路径归一化/自动建任务+快照覆盖/tool 文件跟踪边界）；既有 166 项测试全绿
- **文档同步**：README.md / README.zh-CN.md

## 0.3.4 (2026-09-02)

### query_memory 性能优化：流式 TF + IDF 缓存
- **IDF 缓存**：`store._version` + `store._idfCache`，`save()` 时 `version++` 标记失效，查询时版本命中直接复用，无需重建 BM25 索引
- **预计算 searchText**：`setEntries` 时预计算 `entry.searchText`（标题×5 + keywords + summary + path 的小写拼接），查询时直接复用，避免重复字符串拼接与 `toLowerCase()`
- **流式打分**：`rankEntriesStreaming` 单次遍历 entries，用 `countOccurrences()` 字符串计数替代完整 `tokenizeRaw` + TF 表构建，零中间对象分配
- **性能提升**：5k 文件 / 20k 条目场景 `query_memory` 中位数 **187 ms → 9.3 ms**（20x）；1k 文件典型项目 **<1 ms**

### 测试覆盖
- 新增 `IDF caching & streaming TF` 测试组（7 项）：缓存构建、命中、版本失效、流式打分正确性、空查询、searchText 预计算
- 新增 `query_memory streaming path` 集成测试（2 项）：端到端首次查询建缓存、二次查询复用缓存
- 总测试数 157 → 166 全绿

## 0.3.3 (2026-08-31)

### 符号层：只存身份牌，不存行为
- `src/symbols.js` `buildSymbol`：删除 `summary` 废话字段；`text` 不再截断，保存完整声明行（含签名）；返回一行身份牌 `fn(a: A, b: B): R — file.ts:42`；删除冗余 `sig` 字段

### 文档层：答案级摘要 + 自报盲区
- `src/llm.js` `extractDocEntry`：新增 `blindSpots` 字段（自报盲区，如 `// 未覆盖：部署细节、性能基准、v0.2 前 API`）；Prompt 要求 LLM 返回 `blindSpots`；摘要通过 `summarizeText()` 截断至 300 字符；`blindSpots` 追加在摘要末尾 `// 未覆盖：...`
- `src/doc-pipeline.js` `buildDocEntries`：新增 `hash` 字段（SHA256 内容哈希，用于更新检测）；新增 `blindSpots` 字段存入分片

### L1 增强正则：泛型、参数/返回类型、重载、接口/类型别名
- `src/symbols.js` 新增 `extractTypeSignature` / `extractInterfaceOrType` / `extractOverloads`：提取泛型参数、参数类型注解、返回类型注解、重载签名、接口成员、类型别名右侧、变量/常量类型注解
- 产出直接融入 `buildSymbol` 的 `text` 字段，零依赖、~0.5ms/文件

### 文档检索侧：blindSpots 感知召回
- `src/tools/query-memory.js`：召回文档条目时，若查询词命中 `blindSpots`，追加警告行提示模型去读原文

## 0.3.2 (2026-08-31)

### TS Compiler API 增强器 (Phase 2 L2/L3)
- **L2 语义增强层**：用户项目安装 `typescript`（`npm i -D typescript`）后，插件自动激活，利用 TS Compiler API 推导返回类型、实例化泛型、提取接口与类型别名、丰富箭头函数签名
- **L3 磁盘缓存层**：增强结果按文件内容 SHA256 哈希缓存至 `.dsh-project-memory/type-cache/<hash>.json`，冷启动毫秒级复用，跨会话持久化
- **三级优先级队列**：P0 ACTIVE（`fs/observed` 读文件瞬间）> P1 RECENT（`watch` 变更后）> P2 BATCH（`index_repo` 批量）> P3 BACKLOG（启动补全历史），`setImmediate` 每任务后让出事件循环
- **零配置、零感知**：装 TS 重启 dsh 即可；无 TS 或 `enableTypeScript: false` 时优雅回退 L1 正则；TS 7.x 检测到警告并回退 L1
- **解析策略**：单文件 `createProgram`（快 10x），`createRequire(import.meta.url)` 兼容 ESM，解析优先级：配置 `tsPath` → 项目 cwd 向上 `node_modules/typescript` → 插件自身 `node_modules`
- **新增配置**：`tsPath`（可选指定 TS 路径）、`enableTypeScript`（默认 true，设 false 彻底禁用）
- **扩展名支持**：新增 `.mts` `.cts`
- **文档同步**：README.md / README.zh-CN.md 新增功能介绍与配置表
- **依赖升级**：cordis 4.0.2、schemastery 3.18.2、dsh-tools/llm 0.1.2-alpha.2

## 0.3.1 (2026-08-30)

### 存储：相对路径存储
- Entry 存相对路径（如 `src/main.js`），查询时按项目根解析绝对路径；项目搬家仅在根目录变更时需重新索引，兼容旧绝对路径 entry
- 所有写入路径（`index_doc` / `index_repo` / `watch` / `lazy`）统一传相对路径给构建函数
- `scanSymbols` / `buildDocEntries` 兼容旧签名（绝对路径 entry 仍可读）

### 设计取舍同步
- 移除「绝对路径引用」项，该限制已由相对路径存储方案解决

## 0.3.0 (2026-08-29)

### 存储：无锁同步事务重构
- 删除全部锁机制（`withStoreLock`、`dirLocks`、Promise 链锁）：写入统一走同步事务 `store.commit(fn)`，fn 成功后才原子落盘；单进程内天然串行，`remember`/`forget` 不再被 watch 重索引排队阻塞
- 新增幂等更新 `store.applyFileUpdate(rel, { expectedHash, ... })`：CAS 校验统一 null 处理；`deleted` 删除跳过 hash 对比；type/size 完整透传不猜测
- `watch`/`index_repo`/`index_doc`/`lazy` 全部改为「事务外计算 → 单次 commit 提交」：LLM 摘要、符号扫描等重活不持任何锁
- watch 修正：`seen.add` 前置保护全部遍历文件；dump 文件标记 `deleted` 更新 snapshot 但不索引；snapshot 只更新成功处理的文件，CAS 失败回滚下轮重试；索引失败删除 snapshot 自动重试
- watch 修复回归：snapshot 改用首轮采集的签名落定（而非 commit 后重新 stat），文件在计算窗口内被修改时下一轮能重新检出并重索引，恢复自愈语义；顺带去掉代码文件重复 push
- `watch_repo` 的 session watchlist 镜像同步去锁
- 测试 157/157 全绿

## 0.2.0 (2026-08-27)

### CJK 检索增强
- 链接侧：非拉丁符号名改用 CJK 后边界正则 `名(?![CJK])`，去掉前边界，解决 `调用用户服务` 漏链 `用户服务`；混合名（含字母数字）尾部同时挡 CJK 与字母数字，阻断 `用户服务V2管理器`/`用户服务V22` 误链
- 查询侧：BM25 增加精确短语乘法加分 —— 3+ 字 CJK 短语命中 `title`/`keywords` 时 `score *= 1.5` 并重排，自适应不压过高相关结果
- 查询侧：同义词表（`数据库连接池` ↔ `连接池` ↔ `DB pool`），查询展开后再走短语加分
- 健壮性：`buildBm25.score(undefined)` 不再抛错
- 测试：新增 CJK 链接边界、短语加分、同义词展开、空值保护回归测试

### 经验笔记 supersede 阈值收紧
- 双向重叠判定：`overlap / query_tokens ≥ 0.7` 且 `overlap / item_tokens ≥ 0.7`（原单向 0.6），减少短问题误吞长笔记

## 0.1.6 (2026-08-25)

### 存储
- 存储布局升级 v2（分片式）：`entries.json` 拆为 `shards/` 下每源文件一个自描述分片（relPath + 元数据 + 条目），单文件索引只写自己的分片，不再全量序列化；同进程内所有工具共享每项目单一 store 实例，热路径无全量读写
- 旧布局自动幂等迁移：首次加载检测旧 `entries.json`/`index.json` 即迁移为分片并移除旧文件，中途崩溃可安全重试
- watchlist/experience 写入改脏标记驱动，未变更不落盘

### 新增
- 新工具 `memory_stats`：列出记忆库总量（文件 / 条目 / 经验笔记）、最近索引时间与逐文件清单（Top 30），不看 JSON 即可回答"记忆库里有什么"
- `query_memory` 无命中时输出追加库存概况（N 文件 / M 条目 / K 经验笔记 / 最近索引时间），可区分"没索引过"和"索引了但没命中"

### 性能/质量
- JS/TS 与 Python 符号扫描器重写：字符级字符串/注释掩码（不再误扫字符串与注释里的伪声明）、多行签名续行、Python 缩进感知（此前缩进的类方法全部漏报）、JS 类方法上下文识别；零新增依赖
- Go/Rust/C 系/Shell 补上同款掩码（含 Rust 嵌套块注释、生命周期标记、Shell `${#}` 边界）
- doc↔symbol 链接对纯拉丁符号名启用词边界匹配：符号名 `run` 不再命中文档里的 `runtime`
- 修复掩码状态跨行泄漏：正则字面量里的引号、未闭合的单行字符串不再污染后续行
- README「已知限制」改为「设计取舍」框架，每条补充动机与边界说明

- 修复分片增量写引入的回归：`linkedSymbols` 在 `save()` 之后才计算，第二次 save 变 no-op 导致链接只存在于进程内存、重启即丢；对齐为链接后统一落盘
- 新增跨进程磁盘级回归测试：直接读分片文件断言链接已持久化

### 测试
- 测试从 121 项增至 146 项：扫描器掩码/续行/方法识别、存储迁移/分片/缓存语义、无命中内省、stats 工具、链接落盘探针
- JS/TS 与 Python 符号扫描器重写：字符级字符串/注释掩码（不再误扫字符串与注释里的伪声明）、多行签名续行、Python 缩进感知（此前缩进的类方法全部漏报）、JS 类方法上下文识别；零新增依赖
- Go/Rust/C 系/Shell 暂维持行级正则扫描
- 存量索引按内容哈希增量更新，升级后未变更的文件保持旧扫描结果；需要立即重建请用 `index_repo` 的 `reindex: true`

## 0.1.5 (2026-08-25)

### 修复
- **关键**：`cordis.patch.yml` 的 loader entry `name` 从已弃用的裸包名改为实际的 scoped 包名。此前从 npm / 市场安装后启动 dsh 必然崩溃（`Cannot find package 'dsh-project-memory'`）；本地路径安装的旧用户不受影响，但 npm 安装路径完全不可用
- 测试新增守卫：bundle patch 引用的包名必须与 package.json 一致，杜绝再次漂移

## 0.1.4 (2026-08-25)

### 修复
- watch 轮询改用每轮从磁盘重载的存储快照：此前 `addRoot` 时加载的内存副本永不刷新，外部（`index_doc` / lazy）新索引的条目既会被重复 LLM 摘要，又会在轮询保存时被旧快照整体覆盖丢失
- `watch_repo` 现在同时把目标 root 记入会话 cwd 的 store watchlist：此前非 cwd 项目的 watch 重启插件后不会恢复；停止 watch 时同步从两侧移除
- 损坏的存储 JSON 不再静默当空处理：解析失败时坏文件改名备份为 `*.{时间戳}.corrupt` 并输出错误日志后再空启动，避免下次写入覆盖原始数据
- doc↔symbol 链接对纯拉丁符号名启用词边界匹配：符号名 `run` 不再命中文档里的 `runtime` / `runner`

### 新增
- 发布 npm 包 `@yolk_vat-y/dsh-project-memory`，支持 `dsh plugin --profile web add @yolk_vat-y/dsh-project-memory -w` 直接安装；`publishConfig.access` 设为 `public`（scoped 包默认 restricted，不设置会导致他人安装 403）

### 测试
- 测试从 101 项增至 110 项：watch 外部写入不重索引、外部条目在轮询保存后存活、损坏备份、链接词边界、watch 会话镜像增删

## 0.1.3 (2026-08-23)

### 修复
- 项目根定位重写：`.git` / `.hg` / `.svn` 作为强边界向上无限爬（不再受 8 层限制）——深层路径（Java 式 9 层以上）不再静默把存储落在中间目录，monorepo 里就近的 package.json 不再把库从仓库根拆散；无版本控制时回退到弱标记 + 目录启发式，启发式命中按就近优先，且系统临时目录及其之上不参与定位
- DEFAULT_IGNORE 增加 `vendor` / `third_party` / `thirdparty` / `obj`，Go/C++/C# 项目的依赖与构建目录不再被索引进记忆
- Windows / macOS 大小写不敏感文件系统上，模型以不同大小写路径读取同一文件会生成双键索引，并被 watch 轮询反复"清理→重建"（每轮重复消耗 LLM token）；存储键统一按平台规范化
- `index_doc` 未显式传 `root` 时默认定位到项目根存储（与读到即索引一致）；此前落在文档所在目录，造成存储碎片和同一文档的双份索引费用
- chunker 对 `chunkChars ≤ 0` 的配置值不再死循环（此前会同步阻塞整个 dsh 事件循环）；非法 `maxChunks` 同样回落默认值
- watch 轮询间隔下限钳制到 1 秒（此前 `watchInterval: 0` 会以毫秒级频率全仓库扫描）
- `watch_repo` 工具的存储写入补上互斥锁——它是唯一绕过锁的写入方，与 lazy/watch 并发时可能丢失更新
- doc↔symbol 链接只按符号名匹配：此前泛化词（function/class 等）混进链接索引，文档摘要里出现"function"一词就会链接到项目全部函数符号；链接计数同步修正为按唯一对统计
- `maxFileSizeMb: 0` 对文本文档表示不限制（此前会变成 0 字节上限，拒绝所有非空文件）
- index_repo 对已变更文件不再计算两次 SHA-256

### 清理
- 移除无生产调用方的 `store.searchExperience` / `scoreExperience` 与 `isCjkText`
- 原子写失败时自动删除本次临时文件；进程崩溃的残留 `.tmp` 由下次保存兜底清理（超 60 秒）

### 文档
- 实测 dsh 版本覆盖更新至 0.1.1-rc.1

## 0.1.2 (2026-08-21)

### 修复
- BM25 词频信号失效：tokenize 去重导致 tf 恒为 1、标题 ×5 加权被抵消；检索层改用不去重分词，排序恢复词频与字段权重信号（supersede/forget 的重叠判定不受影响）
- watch 轮询索引失败后回滚 mtime 快照，下一轮自动重试；此前失败文件会被一直跳过直到再次修改
- Rust `pub fn` / `pub(crate) async fn` 公开函数纳入符号表
- lazy 索引对读取瞬间被删除的文件静默跳过，不再刷错误日志
- PDF 补上字节大小上限（此前只限页数），index_repo / watch / lazy 三条路径统一生效
- 修正 peerDependencies：cordis 实际为 ^4.0.1、schemastery 实际为 ^3.18.1（此前按 dsh 的 0.x rc 线声明，匹配不到任何已发布版本）；dsh-tools/dsh-llm 范围补充 0.1.1-rc 线

### 性能
- lazy 队列 code 文件优先处理，不被大文档的 LLM 摘要阻塞
- 文档分块摘要改为 4 并发池（保持块顺序），墙钟时间约降至 1/4，token 成本不变
- 存储写盘去掉缩进，体积约减半
- 扩展名过滤前置到项目根探测之前，无关文件不再白扫约 80 次 stat

### 行为变更
- CJK 查询不再绕过 `llmQueryExpansion` 开关：关闭时查询严格零 LLM 调用
- 跨语种召回改由索引时承担：文档摘要的 keywords 现要求同时覆盖文档语言与英文；旧索引随文件变更逐步获得双语关键词，或用 `index_repo reindex: true` 立即重建

### 文档
- README 新增"已知限制"一节（进程内锁、watch 持锁、损坏静默重建、绝对路径引用、forget 聚合删除、跨语种召回依赖索引时关键词）

## 0.1.0 (2026-08-20)

- 初始版本：文档（PDF/Markdown/txt）与代码符号的持久化项目记忆
- 读取时索引（lazy indexing）、增量刷新、watch 后台保鲜
- BM25 检索（含 CJK 查询扩展）与经验笔记（remember/forget）
- dump 反射转储自动过滤、并发写串行化