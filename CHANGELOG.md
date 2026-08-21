# Changelog

## 0.1.1 (2026-08-21)

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

### 文档
- README 新增"已知限制"一节（进程内锁、watch 持锁、损坏静默重建、绝对路径引用、forget 聚合删除、CJK 查询扩展成本）

## 0.1.0 (2026-08-20)

- 初始版本：文档（PDF/Markdown/txt）与代码符号的持久化项目记忆
- 读取时索引（lazy indexing）、增量刷新、watch 后台保鲜
- BM25 检索（含 CJK 查询扩展）与经验笔记（remember/forget）
- dump 反射转储自动过滤、并发写串行化