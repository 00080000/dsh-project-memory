# dsh-project-memory

[English](README.md) | [简体中文](README.zh-CN.md)

[![ci](https://github.com/00080000/dsh-project-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/00080000/dsh-project-memory/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![npm](https://img.shields.io/npm/v/@yolk_vat-y/dsh-project-memory)](https://www.npmjs.com/package/@yolk_vat-y/dsh-project-memory) [![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/00080000/dsh-project-memory)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）agent 提供持久化的项目记忆。将文档（PDF / Markdown / txt）与代码符号索引进每个工作区独立的存储库，自动维护更新，召回时附源文件引用——文档自动交叉链接到其提及的代码符号。

> 插件在磁盘上维护一份精简的项目索引，每条记录指向具体的文件与行号；agent 需要快速了解项目时先查索引，无需重读整个项目。

## 特性

- **文档索引** — PDF、Markdown、纯文本按块切分并由 LLM 生成摘要，每条索引携带 `路径:行号` 引用回源文件。
- **代码符号表** — 通过零依赖的源码扫描器提取函数、类与方法名（字符串/注释掩码、多行签名续行、Python 缩进感知、类方法上下文），不使用 LLM token。
- **自动刷新** — `watch_repo` 后台轮询，按内容哈希识别新增或变更文件，仅重抽这些文件。
- **读到即索引** — 文件在模型**实际读取的瞬间**被索引（监听 `fs/observed`），索引是正常工作的副产品，而非额外的一次全量扫描。从未读过的文件不会被索引。项目根通过标记（`.git`、`package.json` 等）、README 加源码目录、或兜底到文件所在目录逐级识别。
- **文档 ↔ 代码交叉链接** — 文档提及某符号时记录为 `reference`；查询符号时同时带出描述该符号的文档。
- **BM25 检索** — 对文档、符号与经验笔记进行排序召回，可选 LLM 查询扩展以应对表述不一致。**CJK 增强**：精确短语乘法加分（3+ 字短语在标题/关键词命中 ×1.5）、同义词表（如 数据库连接池 ↔ 连接池 ↔ DB pool）、CJK 感知的文档↔符号链接边界。
- **经验笔记** — 记录问题 → 方案；相似问题覆盖而非重复；笔记仅在检索命中时返回。笔记数量有界：容量随项目规模伸缩（钳制在 100–2000），超限时淘汰最旧的笔记。**覆盖阈值收紧为双向 0.7 重叠**（原 0.6）；**经验 `problem` 字段现参与 CJK 短语加分**，提升长尾问句召回。
- **依赖极简** — 纯 JavaScript；唯一运行时依赖是 `pdfjs-dist`（PDF 文本提取），无需原生构建。

## 工作原理

设计遵循四个原则：

- **易失性** — 上下文是临时的，会话压缩即丢失。
- **持久性** — 索引存于磁盘，跨压缩与会话保留。
- **紧凑性** — 仅存摘要；索引规模约为其覆盖源码的 0.5%（示例项目中 8.8 MB 源码 → 49 KB 索引），检索替代了通读整个文件。
- **可核验性** — 命中在适用时携带 `路径:行号` 引用，agent 可对照源文件核实。

构建索引无需预先全量扫描：文件在模型读取时被索引，索引恰好覆盖实际处理过的内容。未变更的文件重读是空操作（内容哈希），因此索引的持续维护开销很低。

存储按项目独立存放，并跟随代码库变化：文件变更按内容哈希重新抽取，文件删除则同步移除。经验层仅检索，累积不影响上下文。

## 安装

实测覆盖 dsh **0.1.0-rc.7 → 0.1.1-rc.2**。更高的 rc 版本预期可用——插件只使用稳定接口（`defineTool`、`llm.stream`、`Schema`）——但未经逐一验证。宿主需提供 `@deepseek-ai/cordis` ^4.0.1 与 `@deepseek-ai/schemastery` ^3.18.1，已通过 peerDependencies 声明。

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
dsh plugin --profile web add /path/to/dsh-project-memory-0.2.0.tgz
```

每个被索引的项目在 `<root>/.dsh-project-memory/` 下有独立存储。如无需入库，可加入 `.gitignore`。

## 用法

以下工具由 **agent 自动调用**，无需用户手动输入。在对话中直接说自然语言即可——例如「给这个项目建个索引」或「auth 模块是干嘛的」，或者正常开发即可——agent 会自动调用对应工具。默认开启「读到即索引」（`lazyIndexing`）：模型读哪个文件，就顺便索引哪个文件，记忆在你干活的过程中自然积累。`watch_repo` 让显式监听的根目录在后台保持新鲜；`index_repo` 强制对项目做一次全量回填（未变更文件自动跳过）。

| 工具 | 用途 |
|---|---|
| `index_doc file_path` | 索引单个文档（PDF/MD/txt）：分块 → LLM 摘要 → 带 `路径:行号` 入库。未变更文件自动跳过。 |
| `index_repo root` | 索引整个项目：文档由 LLM 生成摘要，代码文件生成零 token 符号表。增量更新、清理已删除文件、文档与符号交叉链接。 |
| `watch_repo root` | 启用自动刷新：后台轮询检测新增/变更文件（mtime + 内容哈希），仅重抽这些文件。监听的项目在插件重启后自动恢复。 |
| `memory_stats root` | 查看记忆库内容：总量（文件 / 条目 / 经验笔记）、最近索引时间，以及按时间排序的逐文件清单。 |
| `query_memory query` | 对文档、符号、经验执行 BM25 检索，可选 LLM 查询扩展。返回带相对分数（0-100）、引用与文档→符号链接的排序结果。 |
| `remember problem solution` | 保存经验笔记。相似问题覆盖而非重复。 |
| `forget id_or_query` | 删除过期经验笔记。 |

## 设计

```
.dsh-project-memory/
  format.json      布局标记（v2，分片式）
  shards/          每个被索引源文件一个自描述 JSON
                   （{ relPath, record, entries }）——写入只落脏分片
  experience.json  问题 → 方案笔记（仅检索）
  watch.json       被监听根目录
```

v0.2.0 之前创建的库（单文件 `entries.json` / `index.json`）在首次加载时自动幂等迁移。同一个 dsh 进程内，所有工具调用共享每个项目的单一内存 store 实例，热路径索引只写发生变化的那一个分片。

- **增量** — 按文件内容哈希，仅重新抽取变更文件。
- **交叉链接** — 索引后将文档摘要与符号名匹配，命中符号以 `references` 挂载到文档条目，由 `query_memory` 带出。
- **查询扩展** — `llmQueryExpansion` 开启时，`query_memory` 让 `ctx.llm` 将查询改写为多个变体（同义词、中英、符号名猜测），再跨变体合并 BM25 分数；关闭时查询完全不碰 LLM。跨语种召回（中文问题命中英文内容）改由索引时承担：文档 keywords 要求同时覆盖文档语言与英文，doc↔symbol 链接也会从中文命中带出英文符号名。
- **一致性** — 事实层跟随代码库（哈希重抽 / 删除即移除）；经验层仅检索，配合覆盖与 `forget` 机制。每个记忆目录的写入按进程内互斥锁串行化；请避免多个 dsh 实例同时写同一项目存储。

## 设计取舍

以下是刻意的范围选择。

- **进程内锁** — 存储写入按记忆目录在一个 dsh 进程内串行化；两个 dsh 实例共享同一项目存储时后写覆盖先写。跨进程锁需要常驻守护进程，违背纯 JS 插件、无后台服务的定位，故明确不支持多实例共写。
- **watch 轮询持锁** — watcher 重索引变更文档（LLM 摘要）期间，`remember`/`forget` 会排队等待。轮询（mtime + 内容哈希）而非 `fs.watch` 事件驱动，是为了跨平台行为一致；重叠轮询靠同一把锁串行：安全，但大改动时可能堆积。间隔可用 `watchInterval` 调整。
- **损坏隔离重建** — 存储 JSON 损坏时该文件回落为空并在下次写入时重建；坏文件会改名备份为 `*.corrupt` 并输出错误日志，但该文件内的数据无法恢复。自动修复半写文件需要预写日志或嵌入式数据库，代价与收益不成比例——而隔离一个坏文件的成本几乎为零。
- **绝对路径引用** — 条目引用绝对路径；项目搬家后引用失效，重建索引即恢复。
- **`forget` 按关键词删除偏激进** — 关键词删除按 ≥0.5 token 重叠匹配，可能一次删掉多条；追求精确请用 id 删除。
- **跨语种召回依赖索引时** — `llmQueryExpansion` 关闭时，纯中文查询靠索引时捕获的双语 keywords 和 doc↔symbol 链接触达英文内容，查询侧保持零 LLM 调用。v0.1.1 之前建立的索引随文件变更逐步获得双语关键词，或用 `index_repo` 的 `reindex: true` 立即重建。
- **CJK 检索** — 短语加分与同义词展开完全在查询侧，不增加索引体积、不额外消耗 LLM token。链接边界仅对 CJK 使用正则边界，英文符号保持原有词边界行为。经验层 supersede 阈值（双向 0.7）为保守默认；若实测出现误覆盖/误漏报，可通过配置调整。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `memoryDir` | `.dsh-project-memory` | 每个被索引根目录内的存储目录 |
| `chunkChars` | 3000 | 每个文档块最大字符数 |
| `maxChunksPerFile` | 40 | 每文档最大块数 |
| `maxFileSizeMb` | 50 | 大于该值（MB）的文档（含 PDF）/代码文件跳过 |
| `maxOutputChars` | 8000 | `query_memory` 返回文本上限（字符） |
| `maxPdfPages` | 1000 | 未另行限制时 PDF 的页数上限 |
| `llmQueryExpansion` | false | BM25 检索前通过 `ctx.llm` 扩展查询（默认关闭，节省 token） |
| `expansionCount` | 6 | 扩展变体上限 |
| `lazyIndexing` | true | 模型读取文件的瞬间即索引（`fs/observed`） |
| `autoIndexOnFirstUse` | false | 插件加载时对当前工作目录做全量扫描（可选） |
| `watch` | true | 启用后台刷新 |
| `watchInterval` | 15 | 轮询间隔（秒） |

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
npm test          # 检查项：chunker / symbols / store / tools / BM25 / links / watch / lazy / config / dump / concurrency / restore / size limit
```

## 许可证

MIT