# 待办 / 已知瓶颈

做完的条目挪进 CHANGELOG 对应版本。

## 短期：攒 0.2.0 的小件（按开发顺序）

### C1：CJK 检索增强 ✅ 已完成 (v0.2.0)
**两处改动，约 60 行**：

1. **链接侧**：`src/link.js` 的 `buildMatcher` —— 非纯英文符号名改用 **CJK 后边界正则**  
   `(?<![CJK])用户服务(?![CJK])`，解决 `用户服务` 误链 `用户服务管理器`；英文分支零改动。

2. **查询侧**：`src/util/search.js` 的 `buildBm25.score()` —— **精确短语乘法加分 + 重排**  
   - 提取 3+ 字 CJK 短语 → 命中 `title`/`keywords` 时 `score *= 1.5`（非固定加法，自适应不压过高相关结果）  
   - 加分后必须 `results.sort()` 重排  
   - 同步补 **同义词表**（`数据库连接池` ↔ `连接池`、`DB pool`），查询展开后再走短语加分

**删掉的旧思路**：文档侧 edge n-gram、整词入索引、`symbolNames` 字段、存储体积验收 —— 均无效或伪命题。

### C2：doc↔symbol 链接 CJK 符号名精确化 ✅ 已完成 (随 C1 同步)
随 C1 同步完成（同一正则机制），无额外工作量。

### B2：经验笔记 supersede 阈值收紧 ✅ 已完成
双向重叠 / 提高阈值（0.6→0.7）。小。

### B3：长尾问句召回优化 ✅ 已完成
- 核心已在 C1 解决（短语乘法加分 + 同义词表）  
- 经验层 `problem` 字段纳入短语加分：`buildBm25` 新增可选 `getPhraseFields` 回调，`rankExperienceScored` 传入 `(item) => [item.problem]`。同义词展开复用 `expandQuery`，单一数据源。中。

### D-1：pdfjs-dist 整体懒加载 ✅ 已完成
当前 `pdfjs-parser.js` 顶部静态 import `getDocument`/`OPS`，插件启动即加载 pdfjs-dist。
改为：模块内部 `loadPdfjs()` 懒加载，`parsePdf`/`parsePdfInfo` 调用时才 `import('pdfjs-dist/...')`。
`configurePdfjsWorker` 兼容同步/异步设置 workerSrc。
收益：非 PDF 项目零 pdfjs 开销；OPS 自然按需。半小时。

### D-2：惰性孤儿清理 ❌ 不做
**原方案**：query_memory 命中时 stat 源文件，失效条目即时剔除。半小时。
**不做的理由**：
1. 查询路径增加 stat 系统调用，延迟敏感路径不该加 IO
2. 孤儿只能是"源文件删了但分片没删" —— watch polling 已每轮扫描清理；启动时 `load()` 顺手清理不存在的源文件分片更自然
3. 现有机制已够用：`index_repo` 每轮扫描同步删，watch 每 15s 清理，`save()` 自动清理陈旧 tmp

### 版本说明
0.2.0 已发布（commit a0e1696）。后续小修正版本 0.2.x。

## 中期：挂了触发条件的（等信号，不主动做）

### A3 锁范围缩小
LLM 摘要移出锁外（lazy / index-doc / watch.pollRoot / index-repo 四处），重校验哈希防竞态，index-repo 删除 sweep 短持锁。触发器：出现并行后台任务或 watch 与长文档索引的实际竞争。

### 异步 IO / 冷启动加载
触发器：真实环境热路径 median > 5ms 或冷启动 > 100ms。

### cleanStaleTmp 周期化 ❌ 不做
现有机制：每次 `save()` 扫描目录清理 >60s 的 `.tmp`，开销极小（目录通常 <50 个文件），周期化收益微乎其微，维护成本不划算。

## 搁置（等真实用户反馈）

- tree-sitter AST 解析（略重，扫描器）
- 多行签名扩展到其余语言
- 符号扫描极端形态（宏展开、复杂泛型边界）




## 备选：Layer 1+（0.3.0 候选）——观察真实查询日志后再决定

- **轻量词典最大匹配**（50KB 技术词表，仅 title/keywords 正向最大匹配，存储 <2%，零依赖）  
  C1 已有"短语加分 + 同义词表"，解决了核心召回。词典分词主要补"未登录词"，维护成本高。若用户反馈特定术语查不到，再引入。

- **经验层 SimHash 近似去重**（替代 token 重叠，配合 B2）  
  B2 已收紧至双向 0.7，误覆盖风险大降。SimHash 适合海量去重，当前经验上限 2000 条，token 重叠足够。除非用户反馈误覆盖，否则不做。

- **符号链接带 kind 权重**（class→class 强，class→function 弱）  
  当前链接是二元的（有/无）。加权重需存储 `kind`，增加存储和查询复杂度。BM25 已按 title/keywords 权重区分。除非有明确 ranking 需求，否则不做。