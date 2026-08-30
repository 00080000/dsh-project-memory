# Changelog

## Unreleased

### 符号层：只存身份牌，不存行为
- `src/symbols.js` `buildSymbol`：删除 `summary` 废话字段；`text` 不再截断，保存完整声明行（含签名）；返回一行身份牌 `fn(a: A, b: B): R — file.ts:42`；删除冗余 `sig` 字段

### 文档层：答案级摘要 + 自报盲区
- `src/llm.js` `extractDocEntry`：新增 `blindSpots` 字段（自报盲区，如 `// 未覆盖：部署细节、性能基准、v0.2 前 API`）；Prompt 要求 LLM 返回 `blindSpots`；摘要通过 `summarizeText()` 截断至 300 字符；`blindSpots` 追加在摘要末尾 `// 未覆盖：...`
- `src/doc-pipeline.js` `buildDocEntries`：新增 `hash` 字段（SHA256 内容哈希，用于更新检测）；新增 `blindSpots` 字段存入分片

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