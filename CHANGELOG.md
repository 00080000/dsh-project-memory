# Changelog

## 0.5.8 (2026-09-22) — 准入的可复现性 + dsh 0.1.7 兼容

### 兼容性修复（dsh 0.1.7 必崩）

- **`message.source.kind: 'plugin'` 会被 0.1.7 宿主拒绝，导致整轮运行失败。** 会话格式 v4 起
  `MessageSourceMap` 是"每个生产者声明自己的 kind"的可合并联合类型，**没有** `plugin` 兜底；
  宿主在编码落盘那一刻抛 `format v4 message requires a producer-owned source kind`
  （`session-format-v3-to-v4/src/message-sources.ts`）。现在写 `plugin:dsh-project-memory`
  ——这正是宿主自己的 v3→v4 迁移对本插件历史消息的改写结果，新写的与迁移后的旧消息是**同一个
  生产者身份**（已用宿主真实编码器验证：新 kind 通过 encode + native restore，旧 kind 被 encode /
  `assertV4MessageSources` / `assertV4SourceRowAdmission` 三处一致拒绝，v3 日志迁移后正好落到新 kind）。
- 自激闸门（`lastUserText`）从"看 `source.plugin` 字段"改为 `isOwnInjection()`，同时认三种历史形状
  （`plugin:dsh-project-memory` / `project-memory` / `plugin:'dsh-project-memory'`）。迁移会**丢弃**
  `plugin` 字段，所以旧判据在迁移后的历史上一律失效——那会让上一步的注入正文变成这一步的检索查询。

### 兼容性修复（dsh 0.1.7 面板拿不到会话）

- **会话列表快照结构变了，面板因此永远拿不到会话。** 0.1.7 的 `SessionListState` 是
  `{ ids, byId, phase, projectionsBySession }`，而插件读的是 `snap.current` 与 `snap.items`
  ——**两个字段都已不存在**（见 `session-controller/.../sessions/service.ts`）。于是
  `useSessionId` 永远返回 null：面板顶部显示「还没有会话」，项目/全局记忆视图报
  `同步失败: no session / commands service`。而**任务视图渲染的是 task-data-store 里的缓存
  快照，看起来正常**，所以这个故障极易被误读成"数据格式 / 旧版本兼容"问题。
  解析抽成 `src/client/session-id.js`（纯函数 + 单测），两种形状都读。这是本版第三个 dsh 0.1.7
  破坏性变更（前两个：`message.source.kind`、ui-primitives 图标名）。
- **面板跟随会话切换。** 光"解析出一个非 null 的 id"还不够：兜底取"列表里第一个非 blank"，
  它**不随用户切换对话变化**，面板会一直停在同一个会话上（从而显示另一个项目的任务）。
  0.1.7 判断"当前会话"的正式依据是 `SessionSummary.retainedBy.mainView > 0`：主视图正在 retain
  的那个就是用户正在看的那个（第一方同款判据，见 `ui-layout/DocumentTitle.tsx` 与 `ui-session`）。
  它就在**列表快照的 `byId` 行上**，而 retain 计数变化会 `list.set(...)` 重新发布快照
  （`session-controller/.../service.ts` 的 `publishRetention`），所以订阅 `ctx.sessions.list` 的
  面板会在切换时自动重渲染——这条必须走快照内字段，**不能另开 `retainInfo()` 订阅**，否则切换
  不会触发重渲染。优先级：`current`（旧形状） → `mainView > 0` → 第一个非 blank → 第一个。
- 记忆视图在没有活跃会话时**不再报「同步失败」**：面板顶部已经显示「还没有会话」，
  重复报错会让人以为记忆库坏了。

### `/` 菜单：命令有了图标和分组，且不再重复

- **三条宿主命令合并成一条 `/tasks`**（`src/commands/workflow.js`）。`/task` 与 `/insight` 的动作
  成为 `/tasks` 的子动词（`/tasks switch <id>`、`/tasks insight list project` …），由卡片按钮经
  `remote.commands.execute` 驱动。原因：**宿主命令只要注册就会出现在 `/` 菜单的「指令」小节里，
  插件无法隐藏**（`commands.list()` 与 `commands.execute()` 读同一个视图，`CommandDefinition`
  也没有 hidden 字段），三条命令就是三行去不掉的原始行，与自建分组形成重复。
  合并后菜单里的重复降到一行 —— 而那一行是插件执行宿主侧工作的唯一通道（插件没有自己的
  client→host RPC，`api/remotes` 的远程命名空间是宿主装配期写死的白名单）。
- `/tasks` **刻意不声明 `input`**：一旦声明就是 leadingInput，`ui-commands.matchEnter` 对带 input
  的命令一律返回 claim，手敲 `/tasks` 回车会被回填并要求再按一次回车。不声明则裸 `/tasks` 一次回车
  即执行，与合并前一致。代价：`/tasks switch x` 这类手敲带参行不再被认作命令（会作为普通消息发给
  模型）——这些动作的入口本来就是卡片按钮。
- 新增自建 `/` 触发器源（`src/client/slash.ts`）：三个视图入口（任务 / 项目记忆 / 全局记忆，复用
  面板已有的 `view.*` 文案）出现在带图标的「工作流」组里，标题按语言切换中英文。
  为什么必须自建源：`/` 菜单的「分组」就是触发器源，而宿主 `ui-commands` 只给第一方
  `definitionId` 白名单配图标和中文标题（`presentation.ts` 的 `HOST_FACES` / `SECTION_ROWS`），
  宿主 `CommandDescriptor` 也只有 `name/description/input`——第三方宿主命令改配置也变不出图标。
- 分组标题走**候选的 `section`**，不走 `slash.menu` 词典：该 namespace 由 ui-input-trigger 独占，
  `register('slash.menu','zh')` 会抛 `already has locale`，未知 key 则原样回显源名；
  MenuView 在「组内任一行带 section」时不渲染组标题行，只渲染 section 标题——标题文案因此回到
  插件手里，还能双语。
- 排序取 `order: 1`：排在宿主内置源（默认 0）之后，不抢主位置；没有能同时满足"在宿主之后"与
  "在所有其他插件之前"的取值。
- 兼容性：`inputTriggers` 是**软依赖**（不进顶层 `inject`，否则没有 slash 服务的宿主根本不会加载
  本插件，任务面板会一起消失）；整段注册两层 `try/catch`，注册失败只降级、不抛穿。本源不实现
  `matchSpace`/`matchEnter`，手敲命令与面板调用的行为完全不变。

### 注入精度

- `autoContext.hintMinCoverage` 出厂值 `0.30` → `0.45`。真实 store（43 条同源洞察）上，对照组场景
  「改 pptx 时间戳」以 cov 0.32~0.35 注入了 3 条无关提示：同源语料共享词多、IDF 分辨力被拉平，
  "矮子里拔将军"能过 0.30。0.45 落在实测分布的空隙（假阳性 ≤0.35、下一个真命中 ≥0.49）。
  8 个真实会话的注入字符从 33,143 降到约 30,367（−8%），对照组归零。
- `readiness-eval` 新增第 7 项棘轮，把 `hintMinCoverage ≥ 0.45` 钉住（合成标注集对 0.30~0.60 
  整段不敏感，保不住这个值，反例只在真实 store 上）。

### 使用记账（修一个会吃掉有用记忆的缺陷）

- `applyDecay` / `pruneItems` 判活跃度只看 `lastHitAt || updatedAt || createdAt`，而 `lastHitAt`
  此前**只**由 merge/reinforce 写（= 模型又写了一条相近知识）。于是"天天被注入、但没人重写它"的
  条目在 `decayDays`（90）后被自动归档——用得最多的反而等于没人用过。README 里"decay/capacity
  prune archived entries only"的说法与代码不符，一并更正。
- 新增 `recordHit()`，并把两个使用入口接上：`agent/pre-step` 注入成功后写 `hitCount`/`lastHitAt`
  **并立即落盘**（注入路径不走其它 `save()`，只标脏就会在进程退出时丢）；`query_memory` 命中
  insight 时记账（热路径只改内存 + 标脏，不强制落盘）。
- 语义是"曝光次数"，不是"被采纳次数"；记账不参与任何注入判据，失败静默。

### 影子记录（让阈值问题可以离线回答）

- 新增 `admission-shadow.jsonl`：**每步**一行（含零注入的静默步与对照组），带本步全部被评分的
  候选 + 判据特征（`rel` / `coverage` / `matched` / `support` / `terms` / `decision`）与场景
  （`query` / `ops` / `writes`）。主审计只在真的注入时写，静默步零痕迹 → "换个阈值会怎样"
  永远无法离线回答，也攒不出训练样本。`decision` 直接指出每条候选卡在哪一关。
- `scoreHints` 只做加法：影子候选单独一条路径，`hints` / `dropped` 的行为一字未改。
- 配置：`autoContext.shadowLog`（默认 true）/ `shadowMaxBytes`（默认 2 MB，超限轮转 `.1`）。
  只写盘、不进 prompt、不花 token；任何 IO 失败静默。

### 可复现性 / 工具

- `test/injection-scenarios.test.mjs`：`--selfcheck` 原先排在 `--store` 分支之前并
  `process.exit(0)`，导致 `npm run selfcheck:triggers` **恒定**打印合成池——README 承诺的
  "看你自己哪些条目推不动"从未真的读到过用户自己的条目。现在 `--store` 优先，未给时自动探测
  `./.dsh-project-memory/insights.json` 与 `~/.config/dsh-project-memory/global.json`。
- `--store` 模式新增**对照组硬闸门**：expect 为空的场景必须零注入，否则退出码 1；新增
  `--hint-cov <n>` 用于换一条底线重放（选阈值的扫描口）。
- **补声明准入旋钮**：`gateCooldownSteps` / `maxItemsPerSession` / `maxItemCharsPerSession` /
  `hintMinCoverage` / `hintMinMatched` / `hintMinSupport` / `legacyScope` / `auditLog` /
  `auditMaxBytes` 自 S2/S4 起就在 `cfgEngine` 生效、README 也一直写着，但从未进过 `Schema`——
  经 `cordis.patch.yml` 配置它们会被宿主按「not a declared property」拒掉，等于文档里的旋钮是假的。

## 0.5.7 (2026-09-20) — bug-fix release

发布前审计在 313 项全绿下发现并修复以下缺陷，新增 18 项回归测试（共 331）。

### 数据完整性

- 旧库迁移：`index.json` 损坏时会连带删除完好的 `entries.json`（静默清空整个 store）
- `store.load()` 不幂等，重复调用丢掉未落盘的变更
- 符号后到时 doc↔symbol 链接不落盘；畸形 shard/insight 条目会让所有读取抛错

### 召回与注入

- 提示通道覆盖率语料与 BM25 排序不一致：只匹配 `fix` 的查询会让整条提示通道沉默
- `recallItems` 改为每层各自 top-k（文档不再挤掉符号层）；任务级 draft 不再泄漏
- 未加引号的 CJK 文件名不再触发 `when.intents`
- `when.writes` 纳入人类消息里的路径（动手前可命中；读取路径不算）
- 会话条目字符额度不再截断常驻任务卡；`entryOn:false` 与显式 `0` 生效；`fitBody` 边界

### insight

- `applyDecay` 判据不可达，`decayDays` 完全失效
- 提升/降级同样收口 `maxProject` / `maxGlobalProcedures`
- 跨层移动保留 `hitCount`/`createdAt`/`triggerDerived`；global 也回填派生 trigger

### 索引

- watch 不再每轮重读重哈希所有未变文件；`index_doc` 补 `terms` 回填
- `readTextFile` 先 stat 再读；chunker `sourceLine` 不再漂移
- `export`/多行 interface 与 type 别名可被 L1 扫到；扩展名大小写不敏感
- 损坏 PDF 销毁 loading task；TS 增强器 type 别名与关闭开关
- scoped 依赖 tag 修正；畸形依赖不再清空全部 tags

### 工具与命令

- `query_memory(type:'task')` 读错步骤字段；空查询被拒绝
- 任务文件超限淘汰最冷文件；任务 id 补随机后缀
- `/insight edit` 合并 trigger 而非重建；`/task rename|todos` 保留内部空白
- 写类工具校验 root；`invocationContext` 补 `agent.session` 降级

### 重构（已在 main 上，无行为变更）

- 索引逻辑收敛为 `src/index-pipeline.js`；auto-inject 会话状态收敛为 `InjectionSessions`
- 命令处理器共用 `invocationContext` / `fencedJson`

未修的低优先级发现见 `RELEASE-NOTES-0.5.7.md` 的 backlog。

## 0.5.6 (2026-09-16) — injection admission (lessons/decisions/procedures stop arriving by coincidence)

### Changed (only what you are about to *do* can trigger an injection)

- **Trigger matching was a substring test over a haystack of everything the step had seen** (`humanText + tool arguments`, i.e. file contents included). Measured on a real session: 10 injections, **0 of them useful**, 5921 characters appended permanently — including a "recover deleted files" procedure pulled in by the literal string `dcterms` (it contains `rm`) and an "arXiv fetching" note pulled in by the `.pptx` file extension. A labelled 8-scenario evaluation set (now `npm run eval:injection`) scored **precision 0.48 / recall 0.72**.
- **A trigger now has a shape: `when` (ops / writes / intents) triggers, `guard` only narrows, `prevents` states what breaks without the entry.** `ops` are normalized action ids resolved from the tool call itself (`src/ops.js`: `file-write` / `file-delete` / `git-commit` / `release` / `npm-publish` / `render-doc` / `run-bench` / …); `writes` are the files this step is about to write; `intents` are human-message words matched only **after** stripping quoted spans, paths and filenames, and only above a minimum length/word-boundary rule (so `ppt` no longer matches `pptx`).
- **Corpus text can no longer trigger anything.** File contents are out of the haystack entirely, extension/name globs (`*.pptx`, `README*`) are ignored outright, and machine identifiers (`web_fetch`, `LAYOUT_16x9`) are filtered out of intent words.
- **Legacy triggers migrate in memory, idempotently and without rewriting your data**: `actions` → `when.ops` (dead ids mapped where possible, otherwise recorded), concrete `paths` → `when.writes`, `keywords` → `when.intents`, extension/name globs dropped, and weak actions (`git-add` / `git-commit`) dropped when the entry already has precise paths. `npm run selfcheck:triggers` reports what changed — against the live stores: **20 pushable / 4 pull-only, 8 dead action ids, 10 dropped globs, 3 dropped weak actions**.
- **Result on the evaluation set: precision 1.00, recall 1.00, and the control scenario (rename a `.pptx` timestamp, with the filename in quotes) injects nothing at all.**

### Changed (hint channel: relative *and* absolute, plus a frequency budget)

- **The statistical channel required only "half of this layer's top score"**, which a ranking satisfies even when the top score is itself noise — measured `relative:1.00` on entries sharing nothing with the step. It now also needs an **IDF-weighted coverage floor** (`hintMinCoverage`, default `0.3`) **and** at least two shared terms (`hintMinMatched`, default `2`). Query text is the human message *plus this step's write targets* — raw tool arguments are no longer a query.
- **Injections are now events, not a heartbeat**: `gateCooldownSteps` (default `2`) bounds how often the item channel may speak, and `maxItemsPerSession` / `maxItemCharsPerSession` cap the session. The resident task card is exempt (it is a state snapshot), and the budget is a ceiling rather than a target — when nothing clears the gates, nothing is injected.
- **Cache discipline is explicit**: injections are appended as a user message at the tail of history, so the cached prefix is never rewritten; the cost they add is resident cache-read tokens, not cache misses. Nothing is edited in place.

### Added (observability: this change is measured, not asserted)

- **`injection-audit.jsonl`** — one JSONL line per *actual* injection under `<root>/.dsh-project-memory/`, recording what went in, why it matched (`op:` / `write:` / `intent:` / hint coverage), what lost the budget (`budget` / `quota` / `cooldown` / `coverage:` / `thin:`), and the session budget snapshot. Rotation at `auditMaxBytes`; every failure is swallowed so the host request is never affected. Config: `autoContext.auditLog`.
- **`npm run eval:injection`** — 8 labelled scenarios (publish, trigger-debugging, stale source, benchmark, deleted doc, interview prep, and the clean control) over a 24-entry synthetic pool whose triggers are copied verbatim from the real ones. Asserts the ratchet, precision ≥ 0.90 and a clean control group. `--store <insights.json>` replays a real store; `--selfcheck` prints the trigger audit.
- **New suites**: `test/ops.test.mjs` (the action plane, including a regression for reading argument *values* rather than key names), `test/injection-budget.test.mjs` (cooldown/caps actually silence, 6 steps with 6 fresh entries → 3 injections), `test/injection-audit.test.mjs` (JSONL shape, rotation, silent failure, end-to-end wiring through `agent/pre-step`). Suite is now **313 tests**.
- **`trigger.when` / `trigger.guard` / `trigger.prevents`** are declared in the `save_lesson` schema, so new entries can be authored in the new shape.

## 0.5.5 (2026-09-15)

### Fixed (the README promised a benchmark the npm package did not contain)

- **`scripts/` was missing from `package.json`'s `files` whitelist, so the published tarball shipped a README that told users to run a script it did not include.** `README.md` / `README.zh-CN.md` are inside the package, and their *Performance → Reproduce it on your own project* section (plus the Development block) documents `npm run bench -- /path/to/your/project` and `node scripts/bench.mjs` — but `npm pack` contained only `src/`, `client/`, `cordis.patch.yml` and the three documents: no `scripts/bench.mjs`, no `scripts/bench-synthetic.mjs`. Anyone installing the plugin from npm and following the reproduce instructions found the file absent, which is exactly the "trust the numbers" position that section exists to avoid. `scripts` is now in `files`, so both harnesses ship with the package; they still need no dsh instance, no network and no model calls, since they import only `src/`. Verified with `npm pack --dry-run` (tarball now lists `scripts/bench.mjs`, `scripts/bench-synthetic.mjs`, `scripts/bench-store.mjs`).
- **`bench/` stays local-only** — it is git-ignored and has never been tracked. It holds the raw measurement logs (`bench/results/`) and the scratch profilers; the synthetic harness it used to contain is `scripts/bench-synthetic.mjs`. Note this is a *packaging* fix only: those harnesses were already on GitHub, so "the README references a script that is not in the repository" was never true for the git remote — it was true only for the npm tarball.
- **Both READMEs advertised a stale test count.** They still said `280 tests` (the pre-0.5.5 number) while the three unreleased fixes above took the suite to **286**; the figures are now the measured ones (core 180 → 184, host-contract 7 → 9, everything else unchanged).

### Fixed (silent injection re-sent memory that was already in context)

- **Dedupe was whole-block, so a benign change anywhere re-sent every item.** The only guard was a fingerprint of the whole injected block, and that block changes for reasons that have nothing to do with the memory being new: the resident task card advances, the observed tool-call window slides, and `fitBody` re-truncates the last item whenever the remaining budget shifts. Measured on a real 66-step session: **20 injections carrying 41 item-sends for 9 unique items — 78% of them re-sends**, including the same 1732-char procedure three times and another 1008-char one six times.
- **Items are now remembered per session** (`sessionId → insightId → { hash, step }`) and an unchanged, already-injected item is filtered out of `buildInjection` **before** budget scheduling, so the budget it used to occupy goes to new items instead. The hash is over the injected body, so editing an insight re-injects it immediately. Only items that actually made it into an appended message are recorded — a budget-dropped item was never seen and must stay eligible. Per-session memory is capped (600 items) like the other session tables.
- **Why "once per session" is safe as the default:** the host session history is append-only — `agent-loop` has no compaction, and `agent/inbox/spliced` only touches the *pending* inbox. A re-send is therefore pure duplication. `autoContext.reinjectItemsAfter` (default `0`) exists for setups where history is trimmed outside the plugin: `N > 0` allows the same item again once `N` pre-steps have passed (it still has to change the block to be observable, since an identical block is already in history).
- **Regression:** two handler-level checks drive one session across steps and assert that a task-card advance no longer re-sends the procedure, that a fully unchanged step injects nothing at all, and that `reinjectItemsAfter: 2` re-injects on the third step; plus one schema check for the default. Suite 283 → **286** checks.

### Changed (the budget-drop audit is now opt-in — the user's terminal stays clean)

- **`auto-inject` no longer prints `degraded: … insights kept out by budget` unless the operator asks for it.** The line exists so a budget drop can never be *silent*, but the terminal is the **user's** surface, and a drop is **normal priority-based degradation, not a failure**: the resident task card and authored triggers take the 1200-char budget first, and lower-priority hints lose out. On a real host one `dsh web` start printed five such lines (four from a single busy project store, one global), which reads as "the plugin is broken" — exactly the first impression that gets a plugin uninstalled. New `autoContext.budgetLog` selects the level: `off` (**default**, never prints), `once` (at most one line per session, on the first drop), `all` (one line per changed dropped set — the previous behaviour). Accounting itself is unchanged in every mode: the per-session dedupe and the 200-session cap still run, so switching the log on later still reflects the current state. `README.md` / `README.zh-CN.md` document the key in both the `autoContext` row and the `cordis.patch.yml` example.
- **Regression:** the degraded check now drives two steps of one session (two different dropped sets) and asserts: silent by default, silent for `off`, ≥2 lines for `all`, exactly 1 line for `once`. Three schema checks were added as well — the *resolved default* is `off`, an explicit `budgetLog` survives `Config` and reaches the engine, and an unknown value is rejected — because the last config-default bug in this file was exactly this class (a key the engine reads but the schema does not declare). Suite 280 → **283** checks.

### Fixed (the silent-injection hint gate was dead in production)

- **A config schema default pinned the `legacy` hint gate on, making the shipped relative threshold dead code.** `autoContext.relevanceMin` carried `default(0.25)`, so `cfgEngine()` always saw a number and therefore always chose the legacy branch — `normalizedTokenOverlap >= 0.25`, the very judgement PR2 replaced because natural-language messages measure 0.014–0.057 against an insight and can never pass it. The documented default (`signalMinRatio: 0.5`, BM25 relative to the layer's top score) was unreachable in a real host, so only authored triggers could ever inject. The default is removed (the key remains, for explicitly opting back into the old behaviour), and `entryMaxInsights` / `signalMinRatio` / `editedMax` / `skipEchoSelfTodo` are now declared in the schema rather than being read by the engine but absent from it. The test suite could not catch this because every readiness test builds its config object by hand and never goes through `Config`.
- **Regression:** 4 new checks asserting that the *resolved default* config yields `relevanceMin: null` and `signalMinRatio: 0.5`, that an explicit `relevanceMin` still restores the legacy gate, and that the engine-only keys round-trip through the schema. Suite 276 → **280**.

### Added (standalone benchmark — `scripts/bench.mjs`)

- **`npm run bench -- <projectPath>` measures the shipped index/query path on a real project, with no dsh instance, no network and no model calls.** It walks the project, builds its store in a temp directory (never the project's own `.dsh-project-memory`), and reports: cold index split into read+hash / extract / commit; cold load measured from a *copied* store (so the in-process store cache cannot fake it); IDF rebuild, cold and hot query latency through the real scorer (p50/p95/max over `--samples`, default 100); single-file hot re-index sampled **evenly across file sizes**; store size and bytes/entry; and whole-chunk `terms` versus the ≤300-char summary. Flags: `--json`, `--no-pdf`, `--keep`, `--max-files` (default 20000), `--queries <labeled-set.json>` (runs the hit@5 / hit@10 / MRR method on your own corpus).
- **The READMEs now point at it** (`Performance → Reproduce it on your own project`, plus the Development block) instead of asking readers to trust the tables. The labeled-set figures in Design tradeoff #4 are scoped to their internal corpus, with the method shipped; the docs also state the two caveats found while building it — `read+hash` is OS-page-cache sensitive, and real projects score slower than the synthetic corpus.
- **Retired the local-only harnesses it replaces** (`test/ablation*.mjs`, `test/doc-coverage*.mjs`, `test/gen-queries.mjs`, `test/simulate-agent.mjs`, `test/queries.json`) together with the dead `.gitignore` entries for them and for the August debug scaffolding.
- **The synthetic harness ships too.** `bench/microbench.mjs` moved to `scripts/bench-synthetic.mjs` (`npm run bench:synthetic -- 5000`), so the synthetic table is reproducible as well; `bench/` itself stays local-only.
- **Every published number re-measured on 2026-09-14** (Node 24.19, WSL2, 20 vCPU): 5k-file cold index 269 ms avg (p50 267), cold load 40 ms, cached query over 20k entries p50 2.6 / p95 5.4 ms, hot single-file re-index p50 2.4 ms, 10k-file cold index 551 ms avg, cold load 90 ms, IDF rebuild 106 ms at 40k entries (57 ms at 20k, 12 ms at 4k), symbol scan 12.9–19.2 µs/file. Table captions now name the hardware and the reproduce command; the real-project example quotes the warm-cache run and states the cold-cache first run (787 ms vs 253 ms) instead of hiding it. `README.md`, `README.zh-CN.md` and the local interview cheat sheet were updated together so no two documents quote different numbers.

### Docs (README realigned with shipped behaviour)

- **`README.md` / `README.zh-CN.md` re-synced with the code.** Removed claims that documented superseded behaviour: the client-plugin contract version (0.1.2-rc.1 → **0.1.5-rc.1**, bumped in v0.5.3); the auto-created task title rule (v0.5.3 reversed it to **first todo entry → first human message**, and added the subagent exception); and the write path (`O(1) version bump` → only a **dirty** write bumps the version, so the 15 s watch poll cannot clear the IDF cache). `blindSpots` is now described as always empty rather than "empty for newly indexed documents"; the IDF-rebuild note carries its scale; `index_repo` / `watch_repo` document the missing-root guards. De-duplicated two feature bullets that restated each other (document `terms`; L1 regex vs. symbol memory). The Chinese README no longer claims multi-instance writes are safe — it now carries the same in-process-only lock caveat as the English one.
- **Two design-tradeoff entries corrected.** (a) "Subagent sessions never auto-create tasks" was stated as a feature; it is a deliberate non-goal, so it moved to a new tradeoff **§11 "Subagent sessions are out of scope for now"** ("not designed yet", with the cost stated) and the feature bullet now only points at it. (b) **§6 "Explicit `remember` over implicit learning" was factually wrong**: v0.5 ships `reflection-pipeline.js`, an opt-in LLM path that *does* infer lessons/decisions from the conversation on task switch-away/archive, and promotion runs automatically inside normal writes. §6 is now **"Model-facing memory: the agent writes, and no human has to be in the loop"** and states the actual policy: any scope writable by the agent at any time, promotion deterministic on `sourceTaskIds` corroboration (≥2 → project, ≥ `globalPromoteTasks` → global), and **`draft` described as a provenance label plus a corroboration threshold — not an approval queue** (a draft graduates on corroboration, which is intended; the panel is an optional inspection surface, not a step in the write path).

### Fixed (console noise: watching the temp dir, PDF warnings, repeat failure logs)

- **The shared temp directory is no longer watchable.** `WatchManager.addRoot()`, `restorePersisted()` and `watch_repo` now refuse a root that is the filesystem root or `os.tmpdir()` (`isUnwatchableRoot()` in `src/util/fs.js`), and a persisted entry for one is self-healed out of the watchlist on the next start. This was the root cause of a real spam loop: reading any file directly under `/tmp` made `findProjectRoot` fall back to `/tmp` as the project root, `src/lazy.js` then auto-registered it as a watch root, and every 15 s poll re-indexed every file left under `/tmp` — including the test suite's deliberately broken `pm-pdf-*/big.pdf` fixtures, which printed `Invalid PDF structure` on every poll and re-created `/tmp/.dsh-project-memory` forever. Subdirectories of the temp dir (a project that genuinely lives there) still work.
- **pdf.js warnings are silenced** (`verbosity: 0` added to `PDFJS_OPTIONS`). `Warning: Indexing all PDF objects` is pdf.js's own recovery path for a broken or non-linearized PDF. It is not actionable from here, and a failed parse already reports its own error.
- **A permanently failing file is reported once, not every poll.** `watch` still retries a failed index every interval by design (so a file that gets fixed is picked up), but it now remembers the last reported error per file (`state.failures`) and stays quiet until the message changes or the file indexes successfully.
- **Tests:** suite 269 → **276** checks: a repeatedly failing file logs once, `watch_repo` / `addRoot` refuse the shared temp dir, the refusal is not persisted, `addRoot` refuses the filesystem root, and `restorePersisted` drops an unwatchable persisted root.

### Fixed (watch / save hot path)

- **A no-op `save()` no longer rewrites the store.** `commit()` always called `save()`, and `save()` ran `mkdirSync`, bumped `_version` and cleared the IDF cache even when nothing had changed. Since `watch` calls `commit()` for every watched root every 15 s, this (a) wiped the query-side IDF cache on every poll — cancelling the v0.3.4 IDF-reuse optimization whenever `watch` was on — and (b) **re-created the memory directory of any persisted watch root that no longer existed**, so a deleted root came back every 15 s. `save()` now returns before touching the disk unless something is dirty; stale `*.tmp` cleanup still runs unconditionally.
- **Dead watch roots are dropped instead of re-created.** `WatchManager.addRoot()` now refuses a root that does not exist, `restorePersisted()` removes such roots from the persisted watchlist on startup, and `watch_repo` rejects a non-existent root rather than persisting it.
- **Tests:** suite 231 → **235** checks. New: `no-op save() keeps the IDF cache` / `dirty save() invalidates the IDF cache`, plus `restorePersisted skips a root that no longer exists`, `a dead root is dropped from the persisted watchlist` and `addRoot refuses a non-existent root`.

### Fixed (Task Panel / 「隐藏提示信息」开关)

- **The hints toggle now hides every hover tooltip, not just two.** `showHints` was only wired to the step-edit hint and the drag-cancel button; the drag handle, panel-style / view-cycle / minimize / close buttons, card title rename hint, step status tooltip, file-path copy hint, mini-bar hint and the memory-view hints all ignored it — so clicking the button changed almost nothing. Every `title` hint in the panel now honours the switch (the toggle's own tooltip is kept so it stays discoverable).
- **The preference lives in the UI store and persists.** `showHints` moved from component-local state to `dsh-pm-task-panel-ui` (localStorage, default on), so it survives refreshes and remounts instead of silently resetting to “show”; the button dims and sets `aria-pressed` while hints are off, giving feedback without hovering.

### Fixed (index_repo root validation)

- **`index_repo` no longer builds a store for a root that does not exist.** Both the tool and `autoIndexOnFirstUse` only ran `path.resolve()` first: on Linux/macOS a Windows-style path such as `D:\project\foo` resolved to the relative `<cwd>/D:\project\foo`, and the store's `mkdirSync` then created that literal directory together with its `.dsh-project-memory` (verified: `new ProjectMemoryStore(dir).load().commit(…)` creates every missing parent). `assertIndexRoot()` (`src/util/fs.js`) now rejects a missing or non-directory root before anything is written, and names the Windows-path case in the error message. `index_doc`'s file check and `watch_repo`'s `existsSync` guard are unchanged.
- **Tests:** `test/doc-index.test.mjs` gains 1 check (suite 7 → 8, total 237 → **238**): a missing root and a Windows-style path are both rejected with zero filesystem side effects.

### Added (unified recall: the insight layer becomes searchable — PR1)

- **`query_memory` now searches insights.** `type: 'insight'` was added, and `type: 'all'` appends an `## Insights (lessons / decisions / procedures)` section. Before this, lessons/decisions/procedures had **no retrieval path at all**: `util/search.js` had no insight ranker and the tool's `type` enum had no insight value, so a lesson could only reach an agent through silent injection. Verified against this repository's own store: the "public face" lesson (`ins_3dcc7458`) now returns at score 100 for a natural-language query.
- **New `src/recall.js` — one retrieval core, ranked per layer.** Every layer gets an adapter to the same entry contract (`title` / `keywords` / `summary` / `terms` / `sourcePath` — the shape `weightedFieldText` already scores), its own top-k, and a layer prior. Cross-layer order is only ever a *hint* (`flat`); it is never spliced into one score, because the doc/symbol streamer and the in-memory BM25 have different scales. `query_memory` routes doc / symbol / experience / insight through this single call, so the experience layer no longer carries its own scoring path inside the tool.
- **Scope visibility follows the session binding.** `project` / `global` insights are visible to every session; `task`-level insights only to a session bound to that task (`select_task`). Drafts stay out of recall. The v0.4 `experience.json` → `insights.json` migration shadow (`kind: 'experience'`, `source: 'migrate'`) is excluded from the insight layer so a note is not listed once as an insight and again as an experience — convergence the store's own comment had deferred to this PR.
- **Normative-heading prior.** A doc chunk whose heading matches the multilingual normative set (必须 / 禁止 / 铁律 / rules / must / must not / do not …) is boosted ×1.5 within the doc layer: deterministic, model-free, no new dependency. This is the "「必须遵守」never surfaced" case — `test/recall.test.mjs` first pins today's term-frequency ordering, then asserts the prior flips it.
- **Invariants held:** indexing still never calls a model (no index-time LLM), recall adds no LLM call (`llmQueryExpansion` remains opt-in, default off), and the plugin still has exactly one runtime dependency.
- **Tests:** new `test/recall.test.mjs` (8 checks); suite 238 → **246**.

### Added (readiness: triggers for every insight kind, two windows — PR2)

- **`trigger` is no longer procedure-only.** Any lesson / decision / procedure may carry `trigger: { keywords, symbols, actions, paths, scope }`. A hit injects the entry **before the action**, in full, at priority 1 — deterministic, auditable (`reasons[].why`), and independent of wording. `actions` are normalized ids (`git-commit`, `npm-publish`, `go-public`, …) matched by a small lexicon that also reads **human intent** ("提交 / 发包 / 公开"), so the block arrives while the model is still planning instead of after it acted.
- **Two windows, one matcher.** The pre-emptive window matches the turn's human text; the reactive window matches `tool/call` arguments observed through `session/event`. DSH has no pre-tool interceptor (`tool/call` is appended after the call is decided), so these are the only two honest windows — both feed one `ReadinessContext`.
- **The hint gate became scale-free.** It used to be `normalizedTokenOverlap(humanMessage, insight) >= 0.25`, normalized by the **larger** token set, so a real message measured 0.014–0.057 and could never fire. It is now the recall core's BM25 plus a **relative** threshold (`autoContext.signalMinRatio`, default `0.5` = at least half of the layer's top score), with zero-score candidates always dropped. The old judgement stays reachable only by explicitly setting `relevanceMin` (undocumented knob; profiles that set it keep the old behaviour).
- **Budget is a schedule, not a number.** Resident task card → trigger hits (full) → hints (truncated). Every decision is recorded as `reasons` (why injected) or `dropped` (why not), so silence is never the only signal. Procedures still inject **only** through the trigger channel, so a statistical hit cannot bypass `trigger.scope` profile filtering.
- **Measured against this repository's own store:** the original commit-turn message ("…你顺便提交一下…") now injects the public-face lesson via `hint:relative:1.00`; reworded and relying on an observed `git commit`, only an authored `trigger.actions` reaches it (`trigger:action:git-commit`) — the two channels are complementary, not redundant.
- **Tests:** new `test/readiness.test.mjs` (10 checks); suite 246 → **256**.

### Added (write path + measurement: derived triggers, v1→v2, degraded, labeled eval — PR3)

- **Derived triggers are additive and never force-inject.** `deriveTrigger()` builds `{ keywords, actions, paths }` from an entry's own text with the same deterministic lexicon and path scanner the readiness matcher uses (bounded: ≤ 6 / ≤ 4 / ≤ 6), and stores it as `triggerDerived`. It only feeds the entry's search text, so it improves recall; whether an entry is injected **deterministically** is still decided solely by the authored `trigger`. This is the "explicit over implicit" trade-off carried through to injection.
- **`insights.json` v1 → v2, lazily and idempotently.** On load, entries without `triggerDerived` are back-filled in memory (pure, model-free, no field rewriting); the next commit writes `version: 2`. A second pass is a no-op.
- **The write path accepts the full trigger.** `normalizeInsight` no longer whitelists `keywords`/`symbols`/`scope` only — it keeps `actions` and `paths` too, and a trigger consisting *only* of `actions`/`paths` is no longer dropped. `save_lesson`'s schema exposes both, and its descriptions now say "any kind", not "procedure".
- **Silence is not the only signal.** When the budget keeps entries out, `installAutoInject` logs one `degraded` record per session and drop-set (`… kept out by budget — id(reason), …`) instead of silently shrinking the injection.
- **The relative threshold is now a measured parameter, and the measurement ships.** `test/readiness-eval.test.mjs` holds a labeled set (8 cases: trigger-on-intent, trigger-on-observed-action, path glob, keywords, procedure scope filter, strong-vs-weak hint, no-match, budget scheduling) and sweeps `signalMinRatio`:

  | signalMinRatio | precision | recall |
  |---|---|---|
  | 0.20 | 0.78 | 1.00 |
  | 0.35 | 1.00 | 1.00 |
  | 0.50 (shipped) | 1.00 | 1.00 |
  | 0.70 | 1.00 | 1.00 |

  The shipped default sits in the safe zone with margin, and 0.20 visibly admits weak matches — so the number is justified by data rather than chosen by feel. The table is the **9-case** set measured after the hint-precision fix below (the `0.20` figure was 0.86 on the earlier 8-case set; adding "缩写巧合（PR）不得命中" turns one more row into a genuine weak match, `7/9 = 0.78`). It lives under `test/` (CI-enforced, shipped) rather than the git-ignored `bench/`, deliberately: a threshold that only exists on one machine is not a threshold.
- **Tests:** new `test/insight-derive.test.mjs` (6 checks) and `test/readiness-eval.test.mjs` (4 checks, including the sweep table); suite 256 → **266**.

### Fixed (readiness hint precision: query source, acronym noise, stub truncation)

- **The readiness query is the last *human* message again.** `lastUserText()` accepted any `role: 'user'` message — and the injection itself is appended as a user message, so the previous step's injected block became the next step's query (**self-query**). Visible symptom: the injected set kept changing in a way the human message could not explain. It now prefers `source.kind === 'user'` and keeps the sourceless fallback for older hosts and tests.
- **A 1–2 character latin token is no longer hint evidence.** Measured on this repository's own store, the message "PR 干嘛…" put an unrelated "automatic security PR" lesson at the top of the insight layer on the strength of the acronym `PR` alone, i.e. `relative:1.00`. `hintQueryText()` drops *standalone* 1–2 character latin tokens; path-shaped tokens are preserved so `src/util/fs.js` still contributes `src`/`util`. Authored triggers are untouched: deterministic matching stays literal.
- **No stub truncations.** A body that cannot fit its channel's useful minimum (trigger 48 chars, hint 120 chars) is dropped and recorded instead of emitting `- [ins_…] procedure ` — a fragment that costs tokens and conveys nothing.
- **Eval set grew to 9 cases** (added "缩写巧合（PR）不得命中"). The shipped `signalMinRatio 0.5` still scores `precision 1.00 / recall 1.00`; the `0.20` column now shows two *genuine* weak matches (`h-weak`, and `a-pr` on 检查), which is precisely the evidence that 0.5 — not 0.2 — is the right shipped point. Measured after the fix on the real store, the same message yields `[trigger:重启, hint:提交]` instead of `[trigger:重启, hint:PR, hint:提交]`.
- **Tests:** `test/readiness.test.mjs` 10 → 13 checks; suite 266 → **269**.

## 0.5.4 (2026-09-12)

### Changed (indexing: model-free by design; whole-chunk retrieval terms)

- **Indexing never calls a model — by construction.** `buildDocEntries(relPath, filePath, opts)` no longer accepts an `llm` parameter, so index-time code cannot reach a model even by accident. `src/doc-pipeline.js`, `src/watch.js`, `src/lazy.js`, `index_doc` and `index_repo` no longer resolve or pass a route. A stub-model run over 289 files / 2141 entries records **0 calls**.
- **Retrieval terms cover the whole chunk.** The old shape made the whole chunk's searchable body the ≤300-char `summary` (`util/search.js` `weightedFieldText`), so a 3000-char chunk had roughly 90% of its text invisible to `query_memory`. Each doc entry now also carries `terms` — a bounded (≤160), deterministic, stop-word-filtered literal term set covering the **entire chunk** (`src/doc-index.js`, built from the existing `tokenizeRaw`). `summary` stays short for the injection budget; `terms` is search-only.
  - Measured on this repository's docs (179 chunks): reachable unique chunk terms go from **27.3% to 100%**; terms that appear only beyond character 300 go from **0% to 100%** entryHit@5, while already-answerable queries keep their ranking (MRR **0.958** with `terms` vs **0.955** without). Zero model calls.
  - `linkEntries` now includes `terms` in its haystack for the same reason: a symbol mentioned late in a chunk links again.
  - **Existing stores are back-filled automatically.** `index_repo`, `watch` and `lazy` treat a doc record whose entries lack `terms` as needing re-extraction even when the content hash is unchanged (`docEntriesNeedBackfill`), so the coverage fix reaches stores indexed before 0.5.4 without a manual `reindex: true`. It is a one-shot pass: once entries carry `terms`, the hash skip resumes.
- **Rule-based keywords** (`extractKeywords`: title-weighted top terms) replace the previous placeholder 5–10 keywords, so `keywords` is deterministic and reproducible. Bilingual keyword expansion and self-reported blind spots are intentionally **not** produced at index time: the `blindSpots` field and its rendering are retained for compatibility, but new entries leave it empty.
- **Recall-time opt-in LLM is routed explicitly and visibly.** `config.llmQueryExpansion` (default off) and `reflection.enabled` (default off) are the only remaining model calls, and both are recall-time and opt-in. They resolve `provider`/`model` through `src/llm-route.js` (config override → session `requestHeader().config` → agent options → last-seen `request/header` route). When no route is available or a call fails, search falls back explicitly and records a one-time `degraded` entry rather than failing silently.
- **Tests:** `test/doc-index.test.mjs` (new) pins summary ≤300 / terms covering past char 300 / BM25 hitting a post-300 term / zero model calls at index time even with a routed `exec` / deterministic bounded `extractTerms` / the automatic back-fill. `test/llm-route.test.mjs` covers the recall-time routing contract. `test/run-test.mjs` asserts watch indexing makes **zero** model calls and that doc entries are structural.

### Changed (injection semantics + signals)

- **The injected block now declares `form: 'snapshot'`, not `'notice'`.** The autocontext block is current state that a later injection supersedes; `notice` means "a one-off account of something that just happened", so the old declaration was semantically wrong for both the transcript UI and the model. The channel is untouched (still appended through `agent/pre-step` as a plugin `user/message`). The host's `ContextFormed` is a discriminated union (`packages/llm/llm/src/message.ts:81-96`), so `snapshot` carries `sections: [{ name, text }]` and must **not** carry `notice`'s `summary`; the section is named `project-memory` and its `text` is exactly the assembled block.
- **Per-file `reads` / `writes` counters are now collected.** `task.fileMeta[rel]` gained `reads` and `writes` alongside the retained `n` (which stays the read+write total for old tasks). This is **collect-only**: `hotSortFiles`, the resident "editing now" list and the dedupe fingerprint still read only `lastWriteAt` / `lastReadAt`, so no ordering or injection behaviour changes. It starts collecting the one signal a full-index memory plugin cannot observe — what the model actually read.
- **`query_memory` memory rows carry a status placeholder.** Each doc/symbol row now prints `- status: <value>`, defaulting to `exact` for every entry (the vocabulary is `exact | needs-verify | re-verified | refreshed | demoted`). No state machine is implemented yet; this is a forward-compatible output contract so real values can land later without changing the rendering again.
- **Tests:** suite 227 → **231** checks. `test/host-contract.test.mjs` now drives a real injection and pins the source shape (`form: 'snapshot'`, `sections[0].name`, no `summary`); `test/taskbridge.test.mjs` pins `reads`/`writes`/`n`; `test/run-test.mjs` pins the `status` placeholder on doc and symbol rows.

### Files
- src/doc-index.js (new), src/doc-pipeline.js, src/llm.js, src/llm-route.js (new), src/util/text.js, src/util/search.js, src/link.js, src/index.js, src/watch.js, src/lazy.js, src/reflection-pipeline.js, src/auto-inject.js, src/setup/taskbridge.js, src/tools/index-doc.js, src/tools/index-repo.js, src/tools/query-memory.js, src/tools/task-tools.js, src/commands/task-actions.js, test/doc-index.test.mjs (new), test/llm-route.test.mjs, test/host-contract.test.mjs, test/taskbridge.test.mjs, test/run-test.mjs, test/reflection-pipeline.test.mjs, package.json, CHANGELOG.md

## 0.5.3 (2026-09-10)

### Changed (DSH 0.1.5-rc.1 compatibility)

- **devDependencies aligned with the 0.1.5-rc.1 host**: `@deepseek-ai/dsh-tools` and `dsh-llm` moved from `0.1.1-rc.2`, and `dsh-client-locale` / `dsh-client-store` / `dsh-client-ui-primitives` / `dsh-client-ui-slots` from `0.1.2-rc.1`, all to `0.1.5-rc.1` — type-checking and bundling now run against the same declaration surface the host ships.
- **Dropped `@deepseek-ai/dsh-client-runtime`** from `devDependencies`, `dsh.client.inject` and the client `CLIENT_EXTERNALS`: upstream deleted the package in 0.1.5 (`refactor(client): migrate consumers and remove Runtime`, npm stops at `0.1.1-rc.2`). The bundle only ever required `react`, `react/jsx-runtime` and `dsh-client-ui-primitives`, and the host skips unknown `inject` rows, so this is dead-config cleanup rather than a behaviour change — but a stale row would break any future re-bundle that treated it as an external.
- **Added `@types/react` / `@types/react-dom` (^18.3) as devDependencies**: 0.1.5's `dsh-client-ui-primitives` no longer pulls `react`/`react-dom`, so a clean install left `tsconfig.client.json`'s `types: ["react","react-dom"]` unresolved.
- **Regenerated `package-lock.json` via a clean install**: the old lock pinned an entire `0.1.1-rc.2` / `0.1.2-alpha.2` peer tree, which made `npm install` fail with ERESOLVE once the direct devDependencies moved to 0.1.5-rc.1.
- **Rebuilt `client/client.js`** (99.96 kB, 23.4 kB gzip) against the new externals; the entry contract is unchanged (`window.__ModuleLoader__.load({ id, factory })` plus `exports.name` / `exports.inject`).
- **Verified the consumed host surface is unchanged in 0.1.5-rc.1**: `defineTool`, `ctx.tools.register`, `BlockAssembler.push/message`, `createUserMessage`, `LlmRuntime.stream`, the `agent/pre-step` waterfall and its `{ kind: 'enter', messages }` decision, `fs/observed`, plugin message source `form: 'notice'`, and the client slots `shell.overlay` / `conversation.chat.commandview` with services `slots` / `sessions` / `remote` / `remote.commands` / `locale`. Suite green (219 checks).

### Fixed (task auto-adoption)

- **Subagent sessions no longer mint project tasks**: every delegated child runs `todo_write`, so the bridge's auto-adopt path created one project task per child, titled from the child's prompt — a multi-audit turn could add several. Auto-creation (and auto-binding) is now skipped when the host session header marks a delegated child (`origin: 'subagent'` or `delegationDepth > 0`); `parentSession` is deliberately *not* used as a signal because it is fork/seed lineage, and a user-forked top-level session still needs tasks. Merging subagent work back into the parent task is left to a future design.
- **Auto-created task titles prefer the todo list**: `pickTitle` preferred `meta.firstHuman`, the first human message recorded *since the plugin started* — after a host restart that is a mid-conversation message, so an aside such as "刚刚你卡死了，注意点" could name a task whose steps belonged to something else. The first todo entry now wins and the human message (preferring the segment after the last `：` / `:`) is the fallback. `test/taskbridge.test.mjs` 11 → 15 checks.

### Files
- package.json, package-lock.json, tsdown.config.ts, client/client.js, src/setup/taskbridge.js, test/taskbridge.test.mjs, CHANGELOG.md

## 0.5.2 (2026-09-09)

### Changed (file hotspot + resume info)

- **Task files now stay in "hot" order (writes first)**: `task.files` is kept sorted by recency-weighted activity — written/edited files always precede read-only ones, ordered by last-write then last-read time; a read never outranks a written file. Every surface reads `task.files` in order, so `select_task` resume, `query_memory` task rows, `/tasks` and the task panel all surface the hottest files first. Per-file metadata (`fileMeta`: `lastWriteAt` / `lastReadAt` / touch count `n`) is additive and old tasks stay compatible.
- **Resident task card shows ≤3 "editing now" files**: the silent-injection task block appends `编辑中: a.ts, b.ts` for recently written files (`autoContext.editedMax`, default 3).
- **No echo of the task card when the model maintains its own task list**: when the most recent progress is the model's own `todo_write` with no newer human message (`lastTodoAt > lastHumanAt`), the resident task card is suppressed (saves tokens) while relevant project/global insight injection is kept. `autoContext.skipEchoSelfTodo` toggles it (default on).

### Changed (cold-index I/O)

- **Single-read indexing — cold index ~4× faster**: every indexing path read each file twice (`await sha256OfFile()` for the hash, then `readFileSync()` for the body) and paid a per-file `async readFile` thread-pool round-trip. New `readFileForIndex()` does one synchronous read and hands the same buffer to both `createHash('sha256')` and `toString('utf8')`; `index_repo`, `watch`, and lazy read-on-observe all use it. Unchanged files are still hashed without decoding. Synthetic 5,000-file corpus (WSL2, Node 24): cold index 1,093 ms → 272 ms (4.0×); the `read+hash` phase drops from 70% to 11% of the pipeline. Tests green.

### Fixed (host-contract + watch robustness)

- **`agent/pre-step` could still crash every step** — the listener called `next()` outside any guard, so a missing/renamed continuation rejected it (`next is not a function`, the exact 0.5.1 failure mode); and when a downstream listener returned `undefined`, the plugin forwarded that `undefined`, making the host read `decision.kind` off `undefined` and abort the step. Both now degrade to a valid `enter` decision built from `payload.messages`; genuine downstream errors still propagate. Regression test `test/host-contract.test.mjs`.
- **Watch poll storms** — `start(NaN)` / `start(undefined)` produced `setInterval(fn, NaN)`, which Node silently rewrites to a 1 ms interval, saturating the event loop so the agent stopped responding; invalid intervals now fall back to 15 s. `poll()` had no re-entrancy guard, so a slow poll (large repo, or doc LLM summaries) overlapped the next tick and stacked concurrent indexing; a re-entrancy flag now skips overlapping ticks.
- **`WatchManager.restorePersisted()` dropped persisted watch roots** — it ignored `load()`'s return value, so on a `storeCache` hit it iterated the empty new instance instead of the loaded one; it now uses the returned store.

### Changed (injection + cache hygiene)

- **Removed the unused `wrapLlmStream` helper** — silent injection is wired solely through the host's `agent/pre-step` seam; the `llm.stream` wrapper could never intercept the host's internal reference, so it was dead code (and its tests went with it).
- **Per-session injection fingerprint** — the "already injected" fingerprint was one shared value, so concurrent sessions could suppress each other's injection; it is now keyed per session (bounded).
- **Injection no longer re-fires on hotspot churn** — the dedupe fingerprint now covers only stable content (task title/steps/insights plus matched insights); the volatile `编辑中` file list still appears in the injected block but no longer triggers a re-injection on every file write.
- **Bounded store cache, synchronous effect** — `ProjectMemoryStore`'s cross-project cache is capped so long-running multi-project use cannot grow without bound; the optional `autoIndexOnFirstUse` effect is now a proper synchronous disposer instead of an async callback.

### Files
- src/setup/taskbridge.js, src/auto-inject.js, src/util/fs.js, src/store.js, src/index.js, src/tools/index-repo.js, src/watch.js, src/lazy.js, test/auto-inject.test.mjs, test/host-contract.test.mjs, package.json, README.md, README.zh-CN.md

## 0.5.1 (2026-09-08)

### Fixed

- **Silent injection could crash every agent step (`next is not a function`)** — the `agent/pre-step` listener registered with the host waterfall arguments reversed (it consumed the event payload as the continuation, then called it). Signature corrected to the host contract `(payload, next)`; project root and session id now come from `payload.agent.session` (`header.cwd` / `id`).
- **Silent injection crashed with `Cannot read properties of undefined (reading 'kind')`** — injected `[Memory Inject]` messages were bare `{ role, content }` objects, but the host reads `message.source.kind` while assembling requests. Injection now builds full host messages via `createUserMessage` with a plugin `source` (`form: notice`, the same pattern as the host's own plan-mode narration).
- Both paths stay inert on any error or missing session cwd: they return the host's default decision and never break the request.

### Changed (task panel editing)

- **Click vs. double-click discrimination on card heads**: single-click expand/collapse waits ~250 ms to rule out a double-click, so double-click-to-rename no longer fights layout shifts (the first click no longer toggles before the second click lands, and a double-click no longer toggles twice).
- **Auto-growing inline editors**: step and task-title editing switched from single-line inputs to content-sized textareas (capped, then internal scroll); Enter commits, Shift+Enter inserts a newline, Esc cancels.
- Step content renders with `white-space: pre-wrap`, so committed multi-line text stays readable.

### Files
- src/auto-inject.js, src/client/TaskComponents.tsx, src/client/TaskPanel.module.css, client/client.js (+ map), package.json

## 0.5.0 (2026-09-07)

### Added — v0.5 tiered insight memory (lessons / decisions / procedures)

- **Single insight entity across three scopes**: task (private drafts inside tasks.json) / project (.dsh-project-memory/insights.json) / global (~/.config/dsh-project-memory/global.json). One schema, one dedupe, one capacity policy.
- **New model tool save_lesson** — write at any scope (explicit scope > task_id > bound task > project). Bidirectional token-overlap dedupe: >= 0.7 merges, 0.65~0.7 reinforces (task-hit accumulation, no content write).
- **Promotion = scope change, not a copy**: the same insight hit by 2 tasks auto-promotes task → project, 3+ tasks project → global (sourceTaskIds accumulate; no double-write ever). Manual promote/demote available via panel.
- **Soft archive**: archived:true hides from recall/injection and stays restorable; capacity decay (decayDays, hitCount==0) and overflow prune only archived entries.
- **Secret filter on write**: token/private-key/password-shaped content is rejected before persisting.
- **Non-destructive migration**: v0.4 experience.json notes are imported into insights.json once (kind: experience, source: migrate, migratedAt marker); legacy experience file keeps serving remember/forget/query_memory until the recall-unification PR retires it.
- **Reflection pipeline (PR 1b)**: optional LLM reflection (reflection.enabled: false by default) that only writes task-level drafts (source: reflect) on task switch-away/archive with cooldown + content-digest gating and silent failure. reflectTaskAfter / isReflectDue / fireReflect + test.
- **Silent injection engine (PR 2)**: entry resident block + relevance-gated injection; project-profile tags (package.json/go.mod/Cargo.toml); scope-tags intersection filter for global procedures; content fingerprint dedupe (60 s window); fully inert (returns the default decision) on any error or missing session cwd. Wired via the host's official **agent/pre-step** seam (`ctx.on('agent/pre-step', …)`, appending a plugin-source `[Memory Inject]` UserMessage to each step's `enter` messages) — patching `llm.stream` cannot intercept the host's internal reference. `installAutoInject` in index, `autoContext.enabled: true` default.
- **TaskPanel memory views (PR 3)**: header button cycles Task / Project / Global; lists + actions confirm/promote/demote/archive/restore/delete/edit + create form (procedures carry an "as Skill" trigger); task cards now show their insights inline. New user command /insight (server side commands/insight-actions.js: list/save/edit/actions).
- **New config groups**: insight.* (dedupOverlap 0.7, reinforceBand 0.65, maxProject 100, maxGlobalProcedures 200, promoteConfidence 0.7, globalPromoteTasks 3, decayDays 90, globalFile), reflection.* (enabled false, cooldownMs 1800000, maxLessonsPerReflect 3, maxDecisionsPerReflect 2), autoContext.* (enabled true, maxTokens 400, relevanceMin 0.25). select_task cards now include insights.

### Files
- src/similarity.js, src/insight-store.js, src/global-seed.js, src/types.js, src/tools/lesson-tools.js, src/reflection-pipeline.js, src/auto-inject.js, src/project-profile.js, src/commands/insight-actions.js, src/client/MemoryView.tsx
- Changed: src/store.js, src/index.js, src/tools/task-tools.js, src/commands/tasks.js, src/commands/task-actions.js, src/client/{TaskPanel,TaskComponents,task-data-store,locales}.ts(x), TaskPanel.module.css, package.json
- Tests: insight-store 11 / reflection-pipeline 5 / auto-inject 9 / insight-actions 7 (total 209, exit 0)

### Notes
- Design rationale, deviations (non-destructive migration; reflection triggers subset; auto-inject host verification) and the live-verification checklist live in PLAN-v0.5.0.md §10–§12.
- Requires a dsh web restart to load the new server code and rebuilt client bundle.

### Fixed
- **/insight flooding the conversation**: `/insight list` returns a large JSON payload; it is now registered into `conversation.chat.commandview` (with `/tasks`, `/task`) and renders as a one-line summary, so switching memory views no longer dumps megabytes of JSON into the chat. Task-card memory labels localized (`mem.section-label`).
- **Task panel "任务面板（点击重试）" crash (`Cannot read properties of undefined (reading 'filter')`)**: root cause was a latent BroadcastChannel bug — its handler used a functional updater but `setDataState` only accepted a plain object, so the first cross-tab sync replaced the store with a function and `data.tasks` became undefined. `setDataState` now accepts object or updater and always normalizes to the full shape; `TaskPanel` reads defensively (`Array.isArray(data.tasks)`).
- **Memory view infinite refresh loop flooding the conversation**: `refresh`'s `useCallback` included `loading` in its deps while the effect re-ran it, so every `loading` toggle recreated `refresh` → effect → `/insight list` → … (each command execution appends a chat node). Now guarded by refs (`inflightRef` + 800 ms `lastRunRef`) with `loading` kept out of the dependency array; a memory view fetch happens once per scope change/mount only.

## 0.4.4 (2026-09-06)

### Added
- **Task data/UI store separation**: `task-data-store.ts` (server-synced data + BroadcastChannel cross-tab sync) and `task-ui-store.ts` (local UI state + localStorage) completely decoupled
- **Explicit panel open**: panel only opens on `/tasks`, `/task` (list form), or model calling `show_task_panel` tool
- **Cross-tab data sync**: BroadcastChannel broadcasts only tasks/archivedCount; UI state (closed/minimized/position) stays per-tab
- **Model tool `show_task_panel`**: model can now explicitly summon the panel via event bus

### Fixed
- **Default hidden on startup**: `closed: true` forced, ignores localStorage residue
- **No auto-open on page refresh**: UI `closed` state not persisted, refresh = hidden
- **No auto-open on session switch**: only data syncs in background; panel closed = no `/tasks` command
- **MiniBar collapse crash**: fixed `useTaskDrag` hook called in event handler (React hooks rule violation) causing "任务面板（点击重试）" error boundary
- **Command node side effects**: `TaskCommandNode` now only syncs data; list commands explicitly call `open()`

### Refactored
- Removed legacy `task-store.ts` (232 lines)
- Split into 4 single-responsibility modules:
  - `task-data-store.ts` — server data + cross-tab sync (~180 lines)
  - `task-ui-store.ts` — local UI state + localStorage (~120 lines)
  - `task-hooks.ts` — `useTaskDrag` / `useTaskEdit` (~150 lines)
  - `TaskComponents.tsx` — `MiniBar` / `TaskCard` presentational (~330 lines)
- `TaskPanel.tsx` slimmed to container (~380 lines): data fetching, command bridging, event listening

### Tested
- Unit tests: 166 passed
- TaskBridge integration: 11 passed
- Client build: ✅
- Full harness build: ✅

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