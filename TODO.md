# 待办 / 已知瓶颈

做完的条目挪进 CHANGELOG 对应版本。

## 短期：攒 0.2.0 的小件（按开发顺序）

### C1：CJK 检索增强 ✅ 已完成 (v0.2.0)
**两处改动，约 60 行**：

1. **链接侧**：`src/link.js` 的 `buildMatcher` —— 非纯英文符号名改用 **CJK 边界正则**  
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

### B3：长尾问句召回优化 🔜 下一项
- 核心已在 C1 解决（短语乘法加分 + 同义词表）  
- 补：`problem` 改写归一（同义词映射表复用）。中。

### D-1：pdfjs OPS 按需动态 import
仅 `collectLayoutStats` 分支用到。半小时。

### D-2：惰性孤儿清理
query_memory 命中时 stat 源文件，失效条目即时剔除。半小时。

各半小时。这批做完发 **0.2.0**。

## 中期：挂了触发条件的（等信号，不主动做）

### A3 锁范围缩小
LLM 摘要移出锁外（lazy / index-doc / watch.pollRoot / index-repo 四处），重校验哈希防竞态，index-repo 删除 sweep 短持锁。触发器：出现并行后台任务或 watch 与长文档索引的实际竞争。

### 异步 IO / 冷启动加载
触发器：真实环境热路径 median > 5ms 或冷启动 > 100ms。

### cleanStaleTmp 周期化
随异步改造顺带做。

## 搁置（等真实用户反馈）

- tree-sitter AST 解析（略重，扫描器）
- 多行签名扩展到其余语言
- 符号扫描极端形态（宏展开、复杂泛型边界）




## 备选：Layer 1+（0.3.0 候选）
- 轻量词典最大匹配（50KB 技术词表，仅 title/keywords 正向最大匹配，存储 <2%，零依赖）
- 经验层 SimHash 近似去重（替代 token 重叠，配合 B2）
- 符号链接带 kind 权重（class→class 强，class→function 弱）