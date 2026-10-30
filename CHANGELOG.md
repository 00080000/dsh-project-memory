## 0.6.8 (2026-10-30)

**兼容**：条目上多一个可选的 `mtimeMs`（旧条目缺省时按老行为整读 + 哈希）。无新增配置键，无破坏性 store 变更。懒索引不再对已有记录的文件问 gitignore，新文件仍问。

### 性能：懒索引去掉每文件的固定开销

- `planFileIndex`：mtime + size 未变直接返回，不读盘、不哈希。
- 新增 `refreshMtime()`：内容未变但 mtime 变了（touch / checkout 还原）时记回新 mtime。
- `indexFile` 拆成规划与落盘两段，新增 `indexObservedBatch()`：一次 flush 每个 store 只 commit 一次。
- 项目根按目录缓存 5s，但只缓存**由标记推出**的根：会话根兜底是"这一带还没有标记"的推断，不入缓存——`git init` / `npm init` 在子目录里建出项目时，缓存会让文件先落进会话根的 store（真根出现后就多一份重复条目）。无标记目录因此仍按次走一遍祖先（与加缓存前一致）。
- 新增 `isGitIgnoredBatch()`：一条 `git check-ignore --stdin -z` 判一批；gitignore 判定挪到确认有变化之后。
- `watch` / `index_repo` / `index_doc` 也记录 `mtimeMs`。
- 新增 `test/lazy-batch.test.mjs`。

**实测**（同会话旧 vs 新）：12k 文件 / 48k 条目的 store、WSL 挂 `/mnt/c`（NTFS 悲观代理）下，重复读 66.0 → 0.9 ms p50、改一个文件后单独索引 96.5 → 32.7 ms p50；本机 ext4（200 文件 git 仓库）重复读 1.4 → 0.007 ms、改文件 1.7 → 0.19 ms。四个真实语料（vue / voice / harness 3k / 全树）同会话 A/B 的冷索引、查询与 watch 内核重索引都在 ±5% 噪声内（小语料冷加载本身抖动大，vue 7–11 ms）。

### 修复

- 构建：产物改为跨平台确定。lightningcss 的 `[hash]` 会把 `filename` 算进类名，此前传的是绝对路径，换台机器构建就整套换类名；现改用相对 POSIX 路径。`.gitattributes` 统一 LF（sourcemap 的 `sourcesContent` 会原样嵌入源文件行尾），CI 增加产物一致性校验。
- `test/lazy-batch.test.mjs`：不再用 `utimes()` 还原 mtime（Windows 上无法逐位还原），改为直接改写记录里的 mtime。
- `index_doc`：先 stat 再读正文，记录里的 mtime 不会比内容新。
- 懒索引的根缓存：会话根兜底不再入缓存（判据是 `findProjectRootWithSource()` 的 `source`，不靠 `root === sessionRoot` 猜）——子目录里 5s 内新建的 `.git` / `package.json` 立刻生效。

**测试**：`npm test` **892 项 / 51 个文件**全绿；`npm run typecheck` 通过。新增 `test/lazy-batch.test.mjs`（7 项：mtime 快路径、touch 后回填 mtime、批内一次 save、批量 gitignore 与逐个判定一致、会话根兜底不缓存）。

## 0.6.7 (2026-10-28)

**兼容**：无新增配置键，也没有破坏性的 store 变更——条目上只多一个可选的 `explicit` 标记（旧条目缺省即按非显式处理）。一处判据语义变化：原生 Windows 壳现在签 `windows` 而不是 `wsl`，写了 `guard.hosts: ['wsl']` 又想覆盖原生 Windows 命令的条目要改成 `windows`。老 profile 与旧 store 直接升级。

### 修复：Windows 上重启后的残留写锁把写入永久挡死（且默认静默）

锁的"pid 复用"判定只读 `/proc/<pid>`（Linux-only），Windows 上 `processStartMs()` 恒为 `null`；而 `lockIsStale()` 对"同机 + pid 存活"是绝不回收。于是崩在写盘途中、或断电/强杀留下的 `.write.lock`，在重启后一旦旧 pid 被系统服务复用，就永远被当成"活锁"：`save()` 每次返回 `false`（`lastSaveOk=false`，但按设计默认不打印），重试 5 次（≈20s）后放弃，退出 flush 也拿不到锁——记忆静默丢失，只能手删 `.write.lock` 或重启 dsh。现在锁内容多一个 `boot`（`Date.now() - os.uptime()*1000`）；`at`/`boot` 早于本次开机即判残留。**这条只对同机锁生效**：跨机锁仍只按 mtime 判（网络盘上另一台机器的 `at` 早于本机开机是常态，套用会抢掉真正在写的机器——原作者"宁可等也不能双写"的取舍保留）。另加 `acquireDirLock({ maxHoldMs })` 兜"同一次启动内 pid 被复用"：`save()` 传 10 分钟，默认 `0` 表示不设上限、维持原契约。

### 修复：`when.writes` / `guard.paths` 在 Windows 路径上永不命中

写入期 `normalizeCitationFiles()` 把 `writes` 归成项目相对、`/` 分隔；匹配侧却只比"整串相等"与"basename"，于是候选是 `D:\proj\src\a.ts`（工具参数）或 `src\util\fs.js`（模型的常见写法）时，带目录的判据一个都不命中——能命中的只有裸文件名。现在两侧都先把 `\` 归一成 `/`，判据除整串相等外再按**路径分段边界**匹配后缀（`(?:^|/)…$`）；`notlib/a.ts` 仍不会被 `lib/a.ts` 命中，`src/*.ts` 这类 glob 对绝对候选也成立。路径 token 抽取（`util/path-token`）同样认两种分隔符并统一输出 `/`，`intentText()` 剥引用时也不再漏掉反斜杠写法。

### 修复：动作面认不出 Windows 命令形态

`npm.cmd run bench`、`node scripts\bench.mjs`、`del`/`copy`/`move`/`Set-Content`、`pwsh -Command "git push"`、`cmd /c npm publish`、`"C:\Program Files\nodejs\npm.cmd" publish` 全部退化成兜底 op `shell-run`：`trigger.when.ops` 里的 `run-bench` / `file-delete` / `git-push` / `npm-publish` 因此永不触发，反而落进 `shell-run` 的误召面。现在命令头剥两种分隔符与 `.exe/.cmd/.bat/.com/.ps1`，`pwsh|powershell|cmd` 进外壳递归（认 `-c` / `-command` / `/c`），补一组 Windows 写盘命令，`bench`/`render` 的路径类正则也认 `\`，`2>nul` 不再当成写文件。

### 修复：原生 Windows 壳被标成 `hosts: ['wsl']`

`pwsh.exe` / `cmd.exe` 的命令文本被当成 WSL 签名，于是 `guard.hosts: ['wsl']` 的条目在原生 Windows 上会被放行（它本该只在 WSL 里生效）。现在原生壳签 `windows`，只有 `/mnt/c/…` 这类路径才签 `wsl`。**已存条目**若写了 `hosts: ['wsl']` 却想覆盖原生 Windows 命令，需要改成 `windows`；WSL 签名的含义没变。

### 修复：同一个 store 因大小写不同建出两份实例

`storeCache` 用 `path.resolve(dir)` 当键：`D:\proj\.dsh-project-memory` 与 `d:\PROJ\.DSH-PROJECT-MEMORY` 在 Windows/macOS 上是同一个目录、字符串却不同，于是并存两个实例——双份内存，且一边未落盘的条目另一边看不见（`load()` 从盘上读）。现在多一层 `storeKey()` 别名表做命中，缓存键本身仍是真实解析路径（告警与诊断输出里的路径不变形），逐出时别名一起删。

### 修复：`git` 子进程在 Windows GUI 宿主里闪控制台窗

`execFileSync('git', …)` 没传 `windowsHide: true`。Electron 打包的 dsh 没有控制台时，每次 `index_repo`（`git ls-files`）与 `isGitIgnored()`（`git check-ignore`）都可能闪一个窗口。

### 修复：带 UTF-8 BOM 的 SKILL.md 解析不出 frontmatter

记事本保存的 `SKILL.md` 以 `\uFEFF` 开头，`^---` 匹配不上，frontmatter 整段被忽略，skill 的 name / description 静默回落默认值。现在解析前先剥掉 BOM。

### 修复：`when.writes` 里的 `?` 让整个 pre-step 注入静默失效

glob 只支持 `*`，但 `?` 没转义；模式以 `?` 开头（`?.md`）时 `new RegExp('^?…')` 抛 `SyntaxError`，而它在每步的 `collectTriggered` 里，异常被 pre-step 兜住后 trigger + 提示 + 任务卡全部不注入。现在 `?` 按字面量转义。

### 修复：长中文消息在 `intentText` 里回溯爆炸

非 ASCII 文件名的正则用两条 `\S*` 夹字符类；无空格、无 ASCII 点的长中文串（4000 字实测 12s）会把一步 pre-step 卡住。改成按 token 判断，线性。

### 修复：`guard.paths` / `not_paths` 不认人类消息里的写意图

`when.writes` 用「已观察写调用 ∪ 人类消息路径」，guard 只看前者：人类说"改 `src/x.js`"时，带 `guard.paths: ['src/x.js']` 的条目永远不放行，`not_paths` 也挡不住。两处现在共用同一份写目标。

### 修复：超大文档先整份读入再拒绝

`planFileIndex` 的体积闸门只对代码文件生效，文档的检查在 `extractTextFromFile` 里——那时 `readFileForIndex` 已经把整份文件读进内存（300 MB 实测 +300 MB RSS），watch 每轮重付一次。现在按 size 在读盘前统一判 `OVERSIZE`。

### 修复：显式 `index_doc` 的 .gitignored 文件被下一轮扫描删掉

扫描清单来自 `git ls-files`（不含被忽略的文件），清理把"没扫到"当成"已删除"，于是显式索引的文档活不过下一轮 watch / index_repo。现在 `index_doc` 在记录上打 `explicit`；清理时，显式索引且文件仍在盘上的条目跳过，文件真被删了仍会清。

### 修复：非锁原因的写盘失败没反映到状态与退出 flush

`save()` / `GlobalStore.commit()` 的写事务只有 `finally`：EISDIR / ENOSPC 等异常直接抛出，`lastSaveOk` 仍为 true，脏 store 也不在退出 flush 的登记表里。现在异常路径置失败标志并登记，故障消失后同一份脏数据会补写。

### 修复：锁文件不可读时 `acquireDirLock` 忙等

锁文件存在但读不出来（EACCES、或该路径是个目录）时，抢锁循环既不 sleep 也不看 deadline，会把事件循环按住直到它变得可读。现在按 10ms 间隔重试，到 deadline 返回 `null`（调用方按"这次没拿到锁"处理）。

### 修复：watch 的 mtime 快照不清理已删除的文件

`pollRoot` 只往 `state.snapshot` 里写、从不删，删掉或改名的文件会一直留在里面；文件若以同样的 `mtime:size` 回来，就会被当成"未变"而永远不重建。现在扫全的轮次里同步剪掉本轮没见到的键（截断轮不剪，与 store 的 `unseen` 同一口径）。

### 修复：`npm run bench` 不算 `run-bench`；全局 flag 之后的子命令不识别

只认 `scripts/bench.mjs` 这类带路径的参数，README 里的 `npm run bench` / `npm run bench:peak` 全部漏召（`when.ops: ['run-bench']` 的条目永不触发）。现在 npm script 名本身也算；`pnpm -C x run bench` / `npm --prefix . publish` 这类"全局 flag 在子命令之前"的写法也一样识别。顺带：`bash -lc` / `sh -ec` 的合并短选项也会递归解析。

### 修复：非 Node 项目的 projectTags 缓存永不命中

缓存用 `package.json` 的 mtime 做键，没有这个文件时 `stat` 抛错，于是每次调用都重读 go.mod / Cargo.toml。现在键是三份清单的 mtime（缺失记 `-`），Go / Rust 项目也能命中缓存，清单变化仍会失效。

### 修复：俄语查询在 insight / experience 层被重复词干

Snowball 词干不幂等（`память → памя → пам`）。`recallItems()` 先把查询 tokenize 成词干、打分器又 tokenize 一次，导致俄语 lesson / decision / experience 的单字/多字查询大量查不到（doc 层不受影响）。现在 `gatedQueryText()` 用 `tokenizeRaw(..., { stem: false })` 只做过滤，真正的打分器词干一次。回归直接走 `recallItems()` 的 insight 与 experience 两个桶。

### 修复：store 目录 / `.gitignore` 被外部删除后不自愈

`_storeDirReady` 缓存把“上次写过”当成“这次还在”，目录被 `git clean -fdx` / 用户清理后锁永远拿不到，写盘一直失败；`_selfIgnoreReady` 同理会把 store 留在 git 可提交状态。现在 dirty save 命中缓存时补一次目录 stat，失配就重建并让 shards / format / ignore 三处状态失效；`acquireDirLock(ensureDir:false)` 也在 `ENOENT` 上补建一次。自我忽略不再缓存“已存在”。

### 修复：向量运行时并发加载 / 目录切换互相 close

新增 `runtimeLoading` 单飞：同一 `(dir, fingerprint)` 的冷启动只 `loadLeanvec()` 一次。换运行时前先清掉引用旧 `lv` 的 indexCache，再 close 旧 fd；索引缓存 key 带上运行时目录，避免用旧闭包服务新目录。并发 injection + 写入去重、或同一模型内容从两个路径加载，都不会再静默退化成空向量。

### 修复：多实例下任务级条目合并丢更新

任务级 insight 的增删/编辑不 bump `task.updatedAt`，按整条任务时间戳选一侧会丢另一边的新增。现在用上次成功落盘时的 insight id 基线做三方合并：新增补写、本地删除不复活、同 id 取 `updatedAt` 新者。整条任务删除的墓碑逻辑不变。

### 修复：watch 异步轮询的定时器重复 / stop 后扫描

异步 `poll()` 期间 `setSessionActive()` 会先排一个定时器，`_tick()` 结束又排一个并覆盖句柄，导致待触发定时器翻倍、`stop()` 只能清掉一个。现在 `_tick()` 只在没有待触发定时器时续排，入口与结束都检查 `_stopped`；`start()` 在轮询中不重复排。

### 修复：旧 source 形状的自注入被当成人类消息

`isOwnInjection()` 认迁移前 `{ plugin: 'dsh-project-memory' }` 形状，但 `installCallObserver()` 只判 `source.kind`，于是自己的注入块进入 `humanText`，下一步拿它当 query（自激）。现在 observer 与 `lastUserText()` 共用同一个自注入判据。

### 修复：俄语意图词未归一 ё / 词形

`isIntentWord()` 会归一，`matchIntent()` 却拿原文做字面匹配：`ёлка`/`елка`、`миграция`/`миграции` 都不命中。现在两侧先 `normalizeRuWord()` 做词边界精确匹配，未命中再按 Snowball 词干比对词形；`город` 仍不命中 `городской`（词干不同）。

### 修复：global store 退出 flush 计数

`GlobalStore.flushPending()` 返回 `commit()` 的 `fn` 返回值（通常 undefined），`flushDirtyStores()` 把已成功落盘的 global store 计成 0。现在显式返回 `lastCommitOk`。

**测试**：`npm test` **885 项 / 50 个文件**全绿；`npm run typecheck` 通过。新增 `test/windows-compat.test.mjs`（11 项：跨开机残留锁、跨机锁不被误伤、`maxHoldMs`、反斜杠/绝对路径的 `writes` 与 `guard`、Windows 命令形态、`hosts`、路径 token、store 缓存键、BOM；判据都在字符串/时间层面，Linux CI 同样能跑，"同实例"那条按 `win32/darwin` 分支断言）与俄语词干固定样例 `test/fixtures/ru-stems.json`（200 个词形，与 snowballstemmer 3.1.1 一致）。

## 0.6.6 (2026-10-27)

**升级注意**：这是一次**行为变更**——注入会变少。没有新增配置键、没有 store 格式变更，老 profile 直接升级。变化只在"什么时候允许全文注入"：子代理提示词、其它工具的参数、后台任务 / 子代理通知，以及人类消息里的删除 / 清理 / 渲染 / 基准类词，不再触发全文注入。

### 修复：注入的"这一步在做什么"取错了来源

**证据**（用插件自己的审计日志复盘一次真实会话——作者在插件仓库里跑 30–40 分钟审计，含 4 个子代理）：17 次注入 / 8,654 字符，可判定与本步任务无关 **6.2k（72%）**。其中：

- `find src client test scripts bench docs -type f` → `run-bench`（只是目录名 `bench`），4 条基准 procedure、1,777 字符；
- 子代理提示词里的"删除后的悬空状态""版本迁移" → 父会话 `file-delete` / `migrate` 连续 8 步；
- 子代理报告里的"发布 / 渲染" → `intent:release`（1,050 字符）/ `intent:渲染`（1,200 字符）；
- 旧一代 shadow 日志 386 行里只有 **31 步（8%）**有非空 query：会话中段根本没有真人消息。

**根因与改法**：

1. `agent/pre-step` 的 `messages` 是宿主的 claimed **delta**，不是完整历史。旧实现把 delta 里最后一条 user 消息当"人的话"，于是 `agent-message`（子代理报告）/ `subagent-settled` / `tool-jobs` / `time-context` 都成了查询。现在 `lastUserText` 只认 `source.kind === 'user'` 或无 source 的老宿主；每会话缓存最后一条真人消息（`session/event` + `user/message`），delta 里没有就回退到它。shadow 新增 `querySource: delta|session|none`。
2. 动作面只从**结构化工具调用**归一（`activityFromCalls`）；`injectForStep` 不再把全部 observed 调用拼成 `actionText`。`subagent` / `remember` / `save_lesson` 的参数不再变成父会话的动作。
3. `classifyShellCommand` 改成**分段 + 命令头匹配**：剥 heredoc、跳过 `sudo` / `env` 包装、引号内的 `>` 不算重定向、`bash -c` 递归一层。目录名、grep pattern、`node -e` 正文里的词不再是动作。
4. 人类消息里的动作词分级：只有不可逆外部动作（`git-commit` / `git-push` / `npm-publish` / `release` / `deploy` / `go-public`）允许先发；`删除 / 清理 / 渲染 / 基准 / 取网页` 只记进 `opsIntent`（shadow 可见），不触发全文。观察到的 `rm` 仍然触发。
5. `buildReadinessContext` 不再被二次归一：`buildInjection` 收到已构建的上下文时只补 tags，避免第一遍的 `actions` 输出在第二遍被当成"调用方声明的动作"重新信任（否则散文里的 `file-delete` 会绕过过滤）。

**已知残留**（下一版，单独提交）：legacy trigger 的 `keywords` 被归一成 `when.intents` 后仍会匹配散文（"清理一下 README 的措辞"可能命中一条 `keywords:['清理']` 的条目）。把"legacy 派生词 → hint-only"需要重标 `readiness-eval` 与 `eval:injection` 基线。

### 修复：跨进程写的三条数据安全问题（多开 dsh）

**背景**：审计给出三条可复现缺陷，全部发生在"两个 dsh 实例共用一个 store"这个插件明确支持的场景里。

1. **锁可被抢，release 无所有权校验**。旧锁只有 mtime：持锁超过 10s 就被第二个进程当成死锁抢走；原持有者到点 release 又无条件 unlink，把对方的锁删掉，第三个进程随即进入——实测三者同时"持锁"。
   现在锁内容带 `{pid, host, token, at}`：同机 pid 活着就绝不回收（Linux 上再用 `/proc/<pid>` 的启动时刻识别 pid 复用）；release 校验 token，不删别人的锁。
2. **崩溃残留锁 + 重试预算 < staleMs → save 静默跳过，工具仍报成功**。旧逻辑 3 次重试 ≈ 8.3s，永远够不到 staleMs=10s；失败只 `console.error`，工具照样返回 "Saved …"（实测 `insights.json` 根本没生成）。
   现在同机死 pid 的锁**立即回收**；`save()` / `GlobalStore.commit()` 返回失败并置 `lastSaveOk` / `lastCommitOk`，但**默认静默**——记忆写入是幂等的、失败成本低，终端与回复里的提示已经够多。**正确性不靠重试**：写路径默认同步等锁最多 **15s**（另一个进程的写通常只有毫秒级）；仍失败才进入后台重试，并且进程退出 / 插件卸载时还有一次同步 flush（`src/util/flush.js`）——用户结束对话就会关 dsh，不会等 20s 的重试。需要排查时设 `DSH_PROJECT_MEMORY_DEBUG=1` 才打印一行（每个 store 每进程一次）。
3. **跨进程删除被复活**。A 加载后持有旧快照，B `forget` 落盘，A 下一次 save 把"磁盘没有但内存有"当成"本地新增"写回——"真删、无撤销"的承诺失效（任务同形；global 层同形）。
   现在合并规则是：磁盘缺失的条目只有**本进程新建**的才补写，否则视为对方已删、从内存里丢掉。顺带修掉一个更直接的变体：`tasks` 合并从不清理 `_deletedTaskIds`，删任务会在**同一次 save 里**被自己刚读到的磁盘副本写回来。

**测试**：新增 `test/store-lock.test.mjs`（10 条，含两个真子进程的删除复活回归、同步等锁与退出 flush）。`npm test` **835 项 / 48 个文件**全绿。

### 新增：把用法做成宿主 skill

`skills/project-memory/`：`SKILL.md`（唯一事实源，frontmatter 提供 name / description，注册时剥掉）+ `scripts/pm-digest.mjs`（零依赖体检：store 大小、insight / 任务计数、trigger 覆盖、绑定数）。`apply()` 用 `ctx.inject(['skills'], …)` 注册，`resourceBase` 指向包内目录；没有 `skills` 服务的宿主静默跳过。`package.json files` 加 `skills`。

**测试**：`npm test` **825 项 / 48 个文件**全绿；`npm run typecheck` 通过。新增 `test/signal-source.test.mjs`（端到端：通知不算人话 / 回退会话缓存、subagent 参数不产 op、目录名不产 `run-bench`、散文删除只记录）与 `test/skill.test.mjs`。

### 性能：Windows / NTFS 上大量小文件（不 OOM，但会被"每次 save 的文件操作数"拖慢）

**实测**：同一份 400 个小文件，`WSL 挂 /mnt/c`（9p，NTFS 的**悲观**代理）与 ext4 对照：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 首次索引 400 文件 | 11.4 s（28.4 ms/文件） | 8.2–9.5 s（20–24 ms/文件） |
| 单文件"改 → 懒索引" p50 | 178 ms | 46 ms（−74%） |
| 同上，ext4 | 1 ms | 1 ms |
| `findProjectRoot`（每次懒索引都走） | 119 ms | 14 ms |
| watch 对 400 文件做 stat | 843 ms，事件循环被按住 834 ms | 74 ms，最大卡顿 1 ms |
| 3k / 10k 小文件索引峰值 RSS | — | 83–85 MB / 112 MB |

**改了什么**：

- `findProjectRoot`：每层祖先从"11 个 marker × 2 组标记各做一次 `existsSync`"改成**一次 readdir + 一趟向上遍历**（VCS 仍优先于 PROJECT；`a marker above the cwd still wins` 的契约由 root-guards 87 项守住）。
- 每次 save 里不必要的文件操作：`shards/` 的 `.tmp` 清扫 60 s 一次（store 根目录仍每次扫，崩溃残留立刻收）；`.gitignore` 存在性只查一次；store / shards 目录 mkdir 只在首次执行；分片/辅助文件的原子写不再每次 mkdir（目录被外部删掉时按 ENOENT 补建重试）。
- `writeJsonAtomic`：`EPERM` / `EBUSY` / `EACCES` 重试 3 次（Windows 上杀毒软件与搜索索引器会瞬时占用 rename 目标）。
- watch 轮询：同步 `statSync` 循环改成 `fs/promises.stat` + 16 并发。**这是"卡"的主因**——同步循环会把整个 dsh 事件循环按住（400 文件 843 ms；12k 文件按比例是几十秒），异步后主线程只等 I/O。
- 新增 `npm run bench:edits`（`scripts/bench-edits.mjs`）：任意目录跑首次索引 + M 次单文件更新，报 p50/p90/峰值 RSS。Windows 原生请 `--dir C:\Temp\xxx` 量真实数字；上面的 9p 数字是上界。

**OOM**：大量小文件不是 OOM 面（3k 文件峰值 ~85 MB、10k ~112 MB，线性 ~3 MB/1k 文件）。OOM 面仍是**单个大文件**（`maxFileSizeMb: 10` → 最坏 +300 MB RSS）与 PDF 首次解析的 ~175 MB 底座，见 README「单文件内存预算」。

**没做**：分片打包（仍是一文件一 shard：12k 文件在 NTFS 上就是 12k 个 4 KB 块 + 12k 次 write+rename，这是下一档结构性优化）；watch 每轮仍用同步 `git ls-files` 子进程。

### 修复：非拉丁文字（俄语 / 西里尔）检索完全失效（issue #9）

**症状**：整句俄文查询切不出任何 token → 候选集恒为 0，提示通道与 `query_memory` 永不命中；俄文条目即使进了 store 也不可检索、不参与去重。阈值怎么调都没用，因为闸门前面没有输入。

**根因**：`tokenizeRaw` 只认 `[a-z0-9_]+` 与 CJK，西里尔在循环里不产生 token——"是不是词"被绑死成了"是不是这两种书写系统"。

**改法**：

- `src/util/ru.js`（新）：切词 + 俄语虚词表 + **Snowball Russian 词干**。词干是逐句移植参考实现，并用 snowballstemmer 3.1.1 做了 8,354 个词形（含 6,000 个随机词）的逐词一致性对照。≤3 字符不词干（否则 `ИИ → и`）。
- `tokenizeRaw` 接入西里尔分支；**拉丁与 CJK 的输出逐字节不变**（老阈值不在这次重标定）。
- 闸门按文字系统分派：`gatedQueryText` 不再把 2 字母俄文当"短拉丁噪声"；`isIntentWord` / `matchIntent` 改用 Unicode 词边界（`город` 不再命中 `городской`），长度门槛 ≥3。
- 索引迁移：`TOKENIZER_VERSION = 2` + doc 条目 `termsVersion`。旧 store 的 doc `terms` 会**一次性回填**（内容哈希未变也重抽），否则旧索引里的俄文永远补不上。
- leanvec `0.2.0`（optionalDependency 同步到 `^0.2.0`）：词表**纯追加** 8,000 个西里尔行（77.0 → 84.8 MiB），并修了"只剩词边界 `▁` 时仍返回向量"的缺陷——未覆盖文字现在返回 `null`，不再出现"任意两条同脚本文字余弦恒为 1.0"进而被向量去重误覆盖。同版本把嵌入表改成**按行懒加载**：向量层常驻内存从约 126 MB 降到约 41 MB，加载耗时 119 → 46 ms（`src/vector-index.js` 传 8 MB 行缓存并在换模型时 `close()` 旧 fd）。

**升级注意**：

- 升级后首次索引/巡检会对旧 doc 条目做一次 `terms` 重抽（一次性 CPU 尖峰，文件内容不变）；中文 / 英文的检索分数与行为不变。
- 俄文条目从此参与去重（`dedupOverlap` 是同一把尺子）。若老 store 里积了多条同义俄文笔记，升级后可能被合并/提示——这是修好的表现，不是新 bug。
- 未覆盖的文字（希腊 / 希伯来 / 阿拉伯 / 泰文）仍是纯词法，向量层对它们返回 `null`（明确降级，不猜）。
- **发布顺序**：leanvec `0.2.0` 必须先于本版发布。本版把 optionalDependency 提到 `^0.2.0`，若环境里仍是 `0.1.0`，俄文标题会被编码成同一个常量向量，向量去重可能误覆盖（正是 0.2.0 修掉的缺陷）；词法检索不受影响。

## 0.6.5 (2026-10-24)

**升级注意**：`allowUnsafeRoots: true` 的作用面比 0.6.4 大。此前它只放开**显式**工具调用与 `autoIndexOnFirstUse`，懒索引、会话审计与 TaskBridge 即使开着也始终不动；现在它放开内置名单的**所有**根判定入口，这三条链路会在放行的目录里建 store、写审计。只想放开某个目录时用 `roots.allow`（精确匹配，不影响 `deny` / `exclude`）；家目录、系统目录如非必要仍建议保持 `false`。

### 新增：可配置的项目根名单（issue #8）

**背景**：哪些目录能当项目根此前是硬编码的——文件系统根、家目录、临时目录与系统/包管理器前缀。唯一的旋钮 `allowUnsafeRoots: true` 是整体开关：既不能只放开一个目录，也不能只多排除一个目录。

**改法**：`Config` 新增 `roots`，三组都支持 `~` / `~/...`；非绝对路径忽略并在 stderr 告警一次（相对路径会按宿主 cwd 解释，不可预测）；Windows 下大小写不敏感。

- `roots.allow`：即使命中内置名单也允许作根，**精确匹配**；文件系统根不在此列。
- `roots.deny`：这个目录不能当根，**精确匹配**；子目录仍可各自成根。
- `roots.exclude`：这棵子树里的文件一律不进索引，**路径边界前缀匹配**（含子目录）；也不会在子树里推出新根。

优先级 `exclude` > `deny` > `allow` > 内置名单。`allowUnsafeRoots: true` 保留为兼容开关，只作用于内置名单、`deny` / `exclude` 仍然优先——它的作用面变化见上面的升级注意。

**生效面**：判定收敛到 `util/fs.js` 的 `compileRootPolicy()` / `rootRejection()`，以下入口共用同一结论——显式工具调用（`index_repo` / `index_doc` / `remember` / `query_memory` / `stats` / 任务工具）、懒索引、watch 轮询、会话审计、TaskBridge。`listProjectFiles()` 的 walk 与 git 两条分支都应用 `roots.exclude`；父根的完整扫描会跳过被排除子树，并清掉之前索引过的条目。

**自愈**：新增 `deny` / `exclude` 后，已经登记在 `watch.json` 里的根会在下次启动时自动摘掉，不需要手删。拒绝文案会说明命中的规则，并指出要改的字段（`- id: project-memory` 的 `config:` 下）。

**测试**：新增 `test/root-policy.test.mjs`，覆盖精确/前缀语义、优先级、`~` 展开、相对路径告警、Windows 大小写、walk/git 两条扫描分支、watch 自愈与各入口的一致性。`npm test` **810 项 / 45 个文件**全绿；`npm run typecheck` 通过。

## 0.6.4 (2026-10-23)

**0.6.3 之后的收口**：11 个提交全部是修复与内部整理，没有新增工具、没有删除配置项。用户能感觉到的变化集中在三处——语料开始跟随 `.gitignore`、几个"设成 0 本该关闭"的旋钮真的关闭了、面板里改一步不再整份回写。**升级前请读第一条与「向量层」那条**。

### 修改：索引语料改走 git 清单，`.gitignore` 与嵌套规则生效

**问题**：`walkDir` 是纯文件系统遍历，`.gitignore` 里写着的构建产物、内部文档、私有笔记一律进语料——用户 `index_repo` 之后才发现"这东西不该被记住"。

**改法**：

- 新增 `listProjectFiles()`：git 工作树走 `git ls-files -z --cached --others --exclude-standard`（已跟踪文件 + 未被忽略的未跟踪文件），嵌套 `.gitignore` 一并生效；非 git 目录回退 `walkDir`（忽略规则不生效，与旧版一致）；之后再叠 `DEFAULT_IGNORE` 段名与 `maxScanFiles` / `maxScanDepth` 上限。
- 子模块只以 gitlink 出现，`statSync().isFile()` 为假直接丢弃；已删除但未暂存的路径也不会因此复活。
- 「读到即索引」对单个文件用 `git check-ignore -q` 判一次；显式 `index_doc` 不受此限。
- 扫描被截断（`capped`）时照旧**不清理**未见文件：没扫到 ≠ 被删了。

**升级注意**：老 store 里以前从被忽略路径索引进来的文件、以及子模块里的内容，会在升级后第一次**完整**索引时计入 `removed` 并删掉——那是派生索引，把文件重新纳入跟踪或显式 `index_doc` 即可重建。`index_repo` 的报告措辞也从 `code symbols updated` 改为 `code files updated`。

### 修复：两个进程同时写同一份 store 会互相覆盖

**问题**：`save()` 的"读—改—写"没有跨进程保护，后写的一方整段覆盖先写的一方：`insights.json` / `tasks.json` / `binding.json` 的改动直接丢。分片撞车时旧实现还会"跳过写入但内存以为写了"，进程内与磁盘长期分叉。

**改法**：

- `acquireDirLock()`：在 store 目录下用 `openSync('wx')` 原子建 `.write.lock` 并写入 pid；2 秒内每 10 ms 重试一次，锁文件 mtime 超过 10 秒判为 stale 直接删；拿不到锁就**保留脏状态**、100 ms 间隔最多再试 3 次，只警告一次，而不是让工具调用失败。
- 锁内先 `_mergeAuxFromDisk()`：`insights` / `tasks` / `binding` / watchlist 按 `updatedAt`（任务用 `updatedAt || lastActiveAt`）取较新的一侧，平局取本地；本地删除用墓碑集合防复活；watchlist 取并集减墓碑。
- 分片冲突以"加载时 sha"为基线：磁盘 sha 既不是基线也不是本次写入 → 按 `indexedAt` 收敛（本地更新则覆盖，磁盘更新则读回内存），并只提示一次。
- 缓存逐出前先 `hasDirty()` 再 `save()`：延迟落盘之后，LRU 逐出不能把还没 flush 的任务热点直接扔掉。

**代价**：重试耗尽、或进程在 flush 前退出，仍可能丢掉这一回合尚未落盘的热点计数（正文写入同样依赖这次 flush）。

### 修复：经验层与洞察层各用一套打分器，`save_lesson` 写出的条目恒 0 分

**问题**：`save_lesson` 写出的 experience 条目没有 `problem` / `solution`，而旧 `rankExperienceScored` 拼给 BM25 的文档是三个字面量 `undefined` → 该条目**恒 0 分**；洞察桶又按 kind 排除了 experience，于是两条召回路径同时断掉：条目在库里，查不到，`query_memory` 还会印出 `Problem: undefined`。同一处还有两个连带问题：只给 `pattern` 的 lesson，`vectorText` 只认 title/problem/body，空串让 `vectorNear` 返回 null，0.9 自动覆盖与 0.7 近邻提示整体失效；只给 `choice` 的 decision，标题落成 `(untitled)`。影子审计里 `rel` 的分子是 BM25 分、分母却是融合 top，实测能到 5.925。

**改法**：经验层改用洞察层同一个 `insightToEntry` + `rankEntriesMergedScored`，命中后用 `byId` 换回原条目，`rankExperience(Scored)` 删除；`normalizeInsight` 的标题链补 `choice`；`vectorText` 用同一条链（title → pattern → problem → choice → topic → body）并截 200 字符；影子记录新增 `lexTop`，`rel = 词法分 / lexTop`，真实排序判据仍用融合分；渲染侧 problem→title、solution→fix→choice→body 兜底。

**影响**：experience 恢复可召回（短语加分、同义词展开都生效），不再输出 `undefined`。影子 `rel` 从"可以大于 1"变成"≤ 1"——按旧刻度做过的离线重放需要重标定。

### 修复：相关性闸门被整条关掉；缺向量分的条目按本轮均值补

**问题**：`matchedFloor` 的旧签名带 `hasVector`，只要 `Boolean(rerank)` 为真就整条通道不再筛。于是"装了 `leanvec` 但本轮给不出余弦"（查询编码失败、`embed` 抛异常、返回空 Map）时，单片段就 3.13 分的那种弱命中全漏进来——注释承诺的"逐字段退回纯词法"从来没成立过。另一头，缺向量分的条目按 `score = rel` 排序，等价于隐式补了一个 `α·0.5`；真实 store 里 7381 对余弦的中位数只有 0.28，查询→标题的 top-1 多在 0.51–0.63，于是"低余弦"条目反而被"完全没有向量"的压住。

**改法**：`matchedFloor(scored, queries)` 去掉 `hasVector`，改判 `typeof r.vector === 'number' || (r.matched ?? 0) >= need`（`need = min(2, 查询词数)`）；顺序改为 融合 → 逐条闸门 → 截断 `limit`，经验层与洞察层同序；一条余弦都没有时 `fuseVectorHits` 原样返回未归一化的 `scored`，闸门对全体生效；缺分按 `neutral = 本轮已有余弦的均值` 补：`score = (1-α)·rel + α·(v ?? neutral)`。

**影响**：向量层开着但部分条目无分时，这两层单轮可能**少于** `limit` 条（旧行为是整条通道不筛）；全量编码失败时与纯词法逐字段一致；低余弦条目不再被无分条目反超。

### 修复：`vectorAlpha: 0` 连带关掉写入去重，`autoMergeCos` / `hintCos: 0` 的语义反了

**问题**（四个都是"以为自己关了、其实全开或全关"）：

- `forget` 只删条目，`vectors.json` 里那行 256 维均值池化还在——"真删"名不副实，下个进程还会把它复用回来。
- 写入侧的去重复用了召回侧的重排器，而后者 `alpha === 0` 直接返回 null：`vectorAlpha: 0`（只想关重排）会静默停掉 0.9 自动覆盖与 0.7 近邻提示。
- `autoMergeCos: 0` / `hintCos: 0` 在旧代码里是 `top1 >= 0` 恒真：设 0 等于"每条写入都覆盖最近一条 / 每次都给提示"，而设 0 恰恰是关闭它最自然的写法。
- `vectorDir` 拼错和"没装 `leanvec`"在输出上毫无区别。

**改法**：

- 新增 `autoContext.vectorDedup`（默认 `true`），写入侧去重与 `vectorAlpha` 解耦；`createVectorCosine` 独立于 alpha。
- `autoMergeCos` / `hintCos` 设 0 现在是**关闭**（`!(cos > 0) → null`）。
- `forget` 同步清向量行：内存索引同时删 `usable` 快照与 `entryMap`（只删后者会被下次打分复活），磁盘 `vectors.json` 按 stride 重写；不加载模型，异常吞掉。
- `memory_stats` 多两行：向量层状态（`off` / `re-rank alpha` / `write-dedup`）与索引统计（rows / live / stale / KB / model / updated），`vectorDir` 配错不再静默。
- 新增实验性 `vectorItemMin` / `vectorSpeakMin`（绝对余弦闸门，不设即关，未标定）。

**影响**：`vectorAlpha: 0` 只关重排，写入去重默认仍开（会加载模型）；`forget` 之后 `vectors.json` 会缩行、条目不再复活。`vectors.json` 格式未变（version 1 + ids / hashes / blob）。

### 修复：自动覆盖的绝对阈值在密集语料里会改错条目

**问题**：0.9 只对"当前语料 + 当前模型"成立。语料一模板化（大量同句式条目），池内最近邻余弦整体抬到 0.9 附近，0.9 就会去覆盖**不同**的知识；换模型、换向量表也会整体平移尺度。而自动覆盖是破坏性写入——直接改写既有条目正文，误合并等于静默丢数据。

**改法**：`vectorNear` 顺路累计有限余弦的 n / Σv / Σv²，返回 `mu` / `sigma` / `n`；μ 与 σ **排除候选自己**（`restN = n - 1`、`restSum = sum - top1`、`restSumSq = sumSq - top1²`，`restN > 1` 才算总体标准差）；`autoMergeTarget` 的门槛改成 `floor = max(autoMergeCos, mu + 3σ)`，仍要求 `top1 - top2 >= autoMergeMargin`。`AUTO_MERGE_SIGMA = 3`：池 ≤300 时随机撞上的最大余弦约在 μ+2.9σ。只收紧不放宽——真实 store（122 条 / 7381 对）mean 0.281、sd 0.104 → μ+3σ ≈ 0.59 < 0.9，行为不变。

**影响**：密集语料里 0.92 不再自动覆盖（宁可多存一条，不改错一条）；稀疏与中等密度池逐字段不变，`hintCos` 的 0.7 提示带不受影响。

### 修复：`query_memory` 的分节按固定顺序，最相关的常常落在最后

**问题**：结果按写死的分节顺序拼（Memory → Insights → Experience），分节内部有排序、分节之间没有。最相关的那条落在第三节时，被前面几节的弱结果挤到 4k 字符之后——分数明明是它最高。

**改法**：每个分节取一个 `bestHint`（最佳条目的 `rel × 层先验`：insight 1.15、doc/symbol 1.0、experience 0.9，与 `recallItems` 的 `flat.hint` 同口径），按它降序排段后再拼输出；稳定排序，同分保原序。只决定段落先后，不参与打分、不改任何条目自己的 `score`。

**影响**：同一查询的输出分节顺序会变（doc-only 查询仍 Memory 在前）；条目分数、数量与 token 总量不变。

### 修复：符号的一行声明落盘了却不参与检索

**问题**：符号条目存了 `text`（签名 / 重载 / 类型体），但 `weightedFieldText` 只拼 title、keywords、summary、terms——于是"哪些函数收 union 类型""谁返回 `Promise<void>`"这类只能从签名回答的问题，检索侧完全看不到。顺带修掉 `query_memory` 里符号标题缺失时输出的 `- undefined`。

**改法**：`weightedFieldText` 并入 `entry.text`（只落盘不检索等于白存）；渲染侧用 `text || title` 兜底。符号仍是每个一行、不新增字段，落盘体积不变；标题仍保留 5 倍权重，名字命中不会被签名盖过。

**影响**：带参数、返回类型或类型体的查询能命中符号；`query_memory` 的符号段会显示一行声明。

### 修改：工具 schema 压到约 5.4k 字符，并加了预算守卫

**问题**：工具描述与参数 schema 每次请求都要随上下文带上，是固定成本；0.6.x 期间它逐条膨胀到约 9100 字符。

**改法**：12 个工具的描述收敛成一句、参数说明去掉重复语义（`enum` / `required` 保留），`index_repo` / `query_memory` / `save_lesson` 等逐个重写；新增 `test/tool-schema-size.test.mjs`，把"描述 + 参数 schema"的总长钉在 5600 字符以内（当前 **5367** 字符 / 12 个工具，含工具名约 5493）。

**影响**：每轮固定开销降约 43%；工具行为与参数契约不变。

### 整理：审计写入器归一、global store 单例、`steps` 纳入密钥检测

- 影子审计与主审计共用一份配置归一（`cfgSideLog()`：默认开、只认显式 `false`、非法上限退回默认值）与一个写入器；两者只剩文件名与默认上限不同（审计 256 KB、影子 512 KB，各留一代 `.1`）。日志名、字段、轮转行为全不变。
- `GlobalStore` 按文件路径复用实例（与 project store 的 `storeCache` 同语义）：两个工具 / 会话交错读写同一份 `global.json`，不再后写覆盖先写。
- 向量缓存的键加上模型指纹；taskbridge 的会话 Map 改成有界并在 `disposed` 时清理。
- `remember` 的 `source_file` 走 `normalizeCitationFiles()`：项目外的路径丢弃并回报，不再把任意绝对路径写进记忆。
- `containsSecretFields` 的默认字段加上 `steps`：流程类条目此前只查前八个字段，`steps` 数组里的密钥 / token 形态逃过检测。
- `index_repo` 透传 `allowUnsafe`，与其它工具对排除名单的处理保持一致。

### 修复：面板改一步要回写整份 steps；草稿会污染 project/global；切页把命令写进会话

**问题**（这一批的症状都在"看不见的写放大"上）：

- 改一步状态就 `todos` 回写整份 `steps`：两个动作并发时互相覆盖，步数一多还带上整个数组。
- 反思草稿（`draft` / `source: reflect`）参与 project/global 的自动合并与自动提升——LLM 草稿能改写手写知识。
- 每切一次记忆页就发 `/tasks insight list`，会话里堆一串命令节点，历史被这些噪声占满。
- 文件工具每次调用写一次 `tasks.json`；拖动每 `mousemove` 写一次 localStorage，小窗口下卡片还能被拖出视口；"编辑中"的行不进去重指纹，写文件后模型一直看到旧的文件列表。
- 归档后 `binding.json` 仍指着那个任务；`_pruneBindings` 遇到畸形 JSON 直接抛错。

**改法**：

- 新增三个原子子命令 `/tasks step <i> <status>`、`/tasks step-text <i> <json>`、`/tasks step-move <from> <to>`（落点由服务端按拖拽语义算），RPC 收进 `src/client/commands.ts`（15 秒 AbortController、信封与错误归一）；拖动只进本地 state，`mouseup` 才写 UI store，位置 clamp 在视口内；卡片头从 `button` 改成 `div[role=button]` 并补键盘处理。
- 草稿或 `source: reflect` 的条目跳过 project/global 合并与跨任务提升；跨任务池过滤 draft；显式编辑即转正（无变化也算确认）。
- 切页命中 30 秒缓存（键 `session|root|scope|boundTaskId`，换项目、换绑都会失效），列表型命令节点不再渲染；面板只在打开 / 切回任务页时补数据。
- 文件热点延迟落盘（`commit(..., { save: false })`），`turn/end` 与 `session/disposed` 统一 flush；缓存逐出前先落盘。
- 归档与 `load()` 时清理绑定；`_pruneBindings` 加形状防御。

**影响**：切页不再在对话里留行；换项目 / 换绑任务不串列表；`tasks.json` 写入频次明显下降。**已有草稿不再自动提升**，需要显式确认才进入 project/global。

### 整理：示例与文档里的专名中性化

README 双语与 CHANGELOG 里的具体框架名、硬件与机器信息、内部文件名换成中性写法；测试夹具里的内部文件名改成 `notes.md` 这类占位。零运行时行为变化。

**测试**：`npm test` 720 → **756 项 / 44 个文件**（新增 `gitignore-index` / `store-concurrent` / `tool-schema-size`；`insight-store`、`recall`、`recall-vector-fusion`、`vector-index`、`auto-inject`、`client-toolview`、`client-task-sync` 等在既有 `ok` 块内补断言）；`npm run typecheck` 通过；`npm run build:client` 重建与提交产物零差异。

## 0.6.3 (2026-10-20)

### 新增：删除留痕——`forget` 仍真删，但最近 5 条可从 `deleted.json` 找回

**问题**：删除是**不可逆**的，而 `forget` 的关键词通道是模糊匹配——判据本身没错（查询侧覆盖率是旧经验层的既定口径），但一次传错词就是一次没有痕迹的永久删除：实测 `forget 'x'` 一次删掉 9 条 global 记忆（真实事故，9 条已按原 id + 原始 `save_lesson` 参数从会话日志恢复）。

**改法**（保持"真删、无撤销"语义不变，只补可恢复性）：

- `removeMemory` 在真正移除前，把**即将被删的完整条目**（正文、字段、`home`，task 级带 `taskId`）追加进该层 store 同目录的 `deleted.json`：项目 / 任务级落 `<root>/.dsh-project-memory/`，global 级落 global 文件同目录。滚动保留最近 **5** 条（`DELETED_KEEP`），最新在前。
- 留痕是**旁路**：写失败只丢留痕，绝不让删除本身失败；`recordDeleted()` 同样供面板的 `/tasks insight delete` 三个分支复用（面板删的也能找回）。
- `forget` 的删除回报末尾直接给出留痕文件的**真实路径**（描述里静态说不清项目目录在哪，路径随 `memoryDir`/会话根变化），并说明"读它、重新存一次即可恢复"。**不新增命令**：模型/人自己去读那个文件。
- 代价：盘上多一份最多 5 条正文的副本。不需要恢复能力的可以删文件，删了下一次删除会重新建。

### 修复：读路径传错 `root` 会在别处造出目录和空 store

`query_memory` / `memory_stats` 此前只做安全校验、不验根存在。可选的向量层（`leanvec`）在空 store 上会落 `vectors.json`，于是**拼写错误的 root 会在任意可写位置建出 `<root>/.dsh-project-memory`**，回报却是 "No memory matches"——看起来像"这个项目没有记忆"。两处补 `assertIndexRoot`（与 `index_repo` / `watch_repo` / `forget` / `save_lesson` / 任务工具同一道护栏），并加跨工具回归：不存在根一律拒绝且**不产生任何目录**。

### 修复：容量裁剪会归档"仍被会话绑定"的任务，把一次会话拆成两条记录

`pruneTasks()` 按 `lastActiveAt` 一刀切，一个长期挂着的绑定任务会被更新的任务挤成最旧而静默归档；会话回来写 todo 时 taskbridge 按"归档＝停止同步"处理，于是**另建一条新任务**——同一会话的历史被静默拆开，原条目成归档孤儿。裁剪现在跳过仍被任何会话绑定的任务（加起来的历史更值钱：上限只是启发式，而"别把正在做的任务从脚底下抽走"是正确性）。想真正停掉一个任务，先解绑或显式归档。

### 修复：跨标签页任务广播不区分项目

`BroadcastChannel` 名是固定的（同源所有 dsh 页面共用），消息体只带任务数组：在 A 项目点一下刷新，B 项目的面板就被贴上 A 的任务列表（而它保留自己的 `boundTaskId`，表现为"绑定莫名丢了"）。`/tasks` 载荷新增 `root`，广播按项目根作用域过滤（无根或本页未知根一律不接受），判定收进零依赖纯函数模块 `src/client/task-scope.js` 以便单测。

### 修复：打开/切换面板会往会话历史里写 `todo/write`

面板 `refresh()` 在"新 boundId 与内存里的不同"时会补一次 `/tasks switch`。那是多余的：宿主 todo 清单是 `sessionProjections` 的 `todos` 单元（由 `todo/write` 折叠），重启/换标签页都会从日志重建；而 switch 会 `session.append('todo/write')`，等于"看一眼面板"就写一次会话历史、顺带刷新任务的 `lastActiveAt`。绑定动作都有明确入口（`select_task` / `/tasks switch` / 面板按钮），各自由 `adoptStepsToSession` 推清单，不需要巡检式补写。

### 新增：测试保真闸门——测试必须跑在 lockfile 声明的宿主版本上

0.6.2 声明 devDependencies 升到 `0.2.1-rc.2`，但 `node_modules` 里仍是 `0.2.0-rc.2`（且 `cordis` 4.0.4 不满足四个 client 包的 `~4.0.5` peer）——当时的"全绿"与"已适配新宿主"都建立在不匹配的依赖上。`host-contract` 新增可判定检查：每个 `@deepseek-ai/*` devDependency 的**实际安装版本必须等于 lockfile 版本**（不等则报"先跑 npm ci"并列出差异），并校验 client 包对 `cordis` 的 peer 区间被实际安装版本满足。

### 修复：`2>/dev/null`、`2>&1` 被当成"写目标"，让读命令误触发 `when.writes`

`ops.js` 的写盘判据里，重定向一支是 `>>?\s*\S`——它把**丢弃输出**也算成写文件。实测 `ls .agents 2>/dev/null | head` 抽出 `targets=['.agents']`、`cat package.json 2>&1` 抽出 `['package.json']`，而 `ops.targets` 正是 `when.writes` 的匹配面：列目录 / 看文件会误触发一条 `writes:['package.json']` 的教训。现在 `>` / `>>` / `2>` 之后是 `&`（合并 fd）或 `/dev/null`（丢弃）时不算写，`> file`、`2> file`、`1>> file` 照旧算。

**测试**：`npm test` 705 → **720 项 / 41 个文件**（新增 `client-task-sync`；`insight-store` +1、`host-contract` +1、`taskbridge` +1、`root-guards` +8，其余在既有 `ok` 块内补断言），`npm run typecheck` 通过。

## 0.6.2 (2026-10-17)

`npm test` **705 项 / 40 个文件**；`npm run typecheck` 通过。

### 兼容：dsh 0.2.1-rc.2

- **开发依赖对齐新宿主**：`@deepseek-ai/dsh-tools` / `dsh-llm` / 四个 client 包从 `0.2.0-rc.2` 升到 `0.2.1-rc.2`，`package-lock.json` 重新生成；`client/client.js` 按 0.2.1 的 seed 模块重建。
- **补 `dsh.engines.dsh` 声明**：0.2.1 起插件兼容性检查先读 `engines.dsh`，只有缺省时才回落到 `peerDependencies` 里的 `@deepseek-ai/dsh-*` 范围。这里写的是插件本来支持的区间（0.0.1-rc.1 起、0.3.0-0 之前），与 peer 范围保持一致。
- **0.2.1 的破坏性变更逐项核对**：client primitives 删除 `projectUserText` / `UserTextReferences`（本插件未使用）；`tool-presentation` 的 `both` 模式被删除（本插件未声明）；slots 只新增 `inline` / `keyed` 可选字段（增量兼容）；`session.header.cwd` 不再是当前执行目录，取值已收口到 `workingDirectory` 服务（0.6.1 起）。
- **验证**：在干净的 0.2.1 profile 里用 `dsh plugin add <tarball>` 安装打包产物，配置能组装、插件能激活，无 `ERR_MODULE_NOT_FOUND`；本仓库 `npm run typecheck`、`npm test` 全绿。

> 注意：0.2.1 拒绝 `webserver.host` 通配地址（`0.0.0.0` / `::`），旧 profile 需改成具体地址（如 `127.0.0.1`），否则桌面端启动失败后会重置 profile 的 bundle 列表。

### 修复：0.6.1 新代码引入的三处回归（空根副作用 / 重放超上限 / Schema 漏声明）

- **`store.load()` 重新变成"空根零副作用"**：统一存储把 `experience.json` 导入的早退删掉了（`_migrateExperienceToInsights` 只判 `migratedAt`），于是**没有 `insights.json`、也没有旧经验**的全新根，只 `load()` 一次就会 `mkdirSync` 并写一份空 `insights.json`。`audit.js` 的 `auditDirReady` 靠"目录已存在"放行、`auto-inject` 靠 `store.hasContent` 决定要不要 `save()`——两处闸门同时失效后，容器目录会被 `resolveProjectMemoryRoot()` 当成项目根（issue #5 同类）。改法：导入落盘那支要求 `legacyOnDisk || legacy.length > 0`；旧文件归档是**另一支**、单独判 `legacyOnDisk`，三种真实升级形态都不受影响。
- **动作后的重放不再超过宿主单页上限**：`reloadWindowRequest()` 返回 `limit = 已加载条数`（客户端注释还写着"正常永远走 PAGE_SIZE=30"），而宿主 `INSIGHT_PAGE_MAX=200` 是**静默**截断；重放又是替换式 `setRows`，于是滚到 500 条再点任意动作，列表被打回 200 条。改法：客户端用 `HOST_PAGE_MAX=200` 夹住 `limit`，载荷回报的 `nextOffset` 让哨兵继续把 200..N 追加回来。`client/client.js` 已同步重建。`test/insight-paging.test.mjs` 加一条交叉断言，把客户端常量与宿主 `INSIGHT_PAGE_MAX` 钉在一起（browser bundle 进不了服务端模块，只能靠测试防漂移）。
- **`insight.*` 四个旋钮补进 Schema**：`autoMergeCos` / `autoMergeMargin` / `hintCos` / `maxForgetMatches` 在 `cfgInsight` 里读取、README 与 `types.js` 也写了，却没在 `src/index.js` 的 `Config` 里声明——与 0.5.8 给 `autoContext` 补声明是同一类问题：走 `cordis.patch.yml` 配它们，能不能活到代码取决于宿主是否按 `additionalProperties: false` 校验，但无论哪种，文档与 Schema 已经不一致。新增 `test/config-schema.test.mjs`：凡 `cfgInsight()` 会算出的数值键都必须在 `Config.insight` 声明，且 Schema 默认值等于运行时兜底值。

**测试**：`npm test` 701 → 705 项 / 39 → 40 个文件（新增空根零副作用、客户端上限三条、契约交叉断言、Schema 一致性）；`npm run typecheck` 通过。

### 修改：统一存储——`experience.json` 退休，经验笔记成为 `kind:'experience'` 的 insight

**问题**：同一个概念有两个真相源——`experience.json` 服务 `remember`/`forget`/`query_memory`，`insights.json` 里又躺着一份 `source:'migrate'` 的**影子副本**，靠 `visibleInsights` 里一个特判（排除 `kind:'experience' && source:'migrate'`）才不至于在 `## Insights` 与 `## Experience` 里各出现一次。写入、删除、容量、向量索引各维护一套，正是"结构有点乱"的来源。上一版把 `forget` 做成了全层一套，但底下仍然是两套存储。

**改法**（insight 是唯一实体，`kind` 只是语义）：

- **`experience.json` 降为一次性导入源**：加载时导入 `insights.json`，导入成功即改名 `experience.json.migrated` 只读归档（不删，升级后想人工比对还有原文）。归档那一步与"导入"**分开判**：0.5.x/0.6.x 用户的 `migratedAt` 早就写上了、文件却还在，只看 `migratedAt` 的话旧文件永远收不走。写盘失败则不收文件（宁可留着，也不丢数据）。
- **删掉旧层 API**：`addExperience` / `findSupersede` / `pruneExperience` / `removeExperience` 与 `store.experience` 的读写全部移除；容量归 insight 层的 `maxProject`（归档优先、超限才物理删），删除归 `forget` / `removeMemory`。
- **`remember` 改走 `saveInsight`**（`kind:'experience'`、project 级），于是它与 `save_lesson` 共享同一套去重 / 自动覆盖 / 近邻提示 / 就地更新。工具描述里删掉 "never auto-injected"：那条承诺早已名不副实——`auto-inject` 的候选池（`insightCandidates`）一直是从 `insightItems()` 全量取的，影子条目本来就在池子里。
- **召回按 kind 分工**：`experience` 桶改由 `kind:'experience'` 的条目供给，`insight` 桶排除它（同一份池子、两边互斥，否则同一内容会同时出现在两个分节）；`visibleInsights` 里的影子特判删除。`query_memory` 的经验桶现在也记 `hitCount`（同源了），`source` 显示兼容导入时落在 `files[0]` 的路径。
- **`insights.json` version → 3**：形状与 v2 相同（纯语义升级，v1/v2/v3 都能直接读），只是标记 `kind:'experience'` 从影子变成一等实体。

**升级路径**（至少覆盖 0.5.0，三种真实形态都有测试）：只有 `experience.json`、没有 `insights.json` 的 0.4/0.5.0 store；`migratedAt` 已存在但旧文件还在的 0.5.x/0.6.x store；v1/v2 `insights.json`。都能直接加载，导入幂等、不重复。
**降级注意**：回到 ≤0.6.x 的老版本后，那些笔记在旧版里查不到——老版本从空的 `store.experience` 出发、又用特判排除 `source:'migrate'` 的影子。**数据没丢**（仍在 `insights.json`），只是旧版本不再展示。

**测试**：新增迁移归档 / 已迁移老 store 也要归档 / 无 insights.json 的旧版形态 3 项；删掉随能力一起消失的用例（经验层容量与动态上限、`store-cache` 的"经验写入"失效探针、run-test 的 `addExperience` 系列），并把 `supersede boundary`（共享前缀不互相顶掉）改到新写路径上继续钉住。707 → 701 项。

### 修改：`forget` 通吃全层（教训 / 决策 / 流程 / 经验笔记，task / project / global）

**问题**：`forget` 只删旧的 `experience.json`（`store.removeExperience`），insight 层**没有删除入口**——模型发现某条记错了、过时了，只能新写一条"本条修正 ins_xxx"，于是矛盾的两条长期共存、又都在注入候选里（真实使用里出现过好几对这种"新条目声明修正旧条目"的记录，被修正的那条一直在注入）。写入侧上一版已经能就地改，删除侧一直缺着。

**改法**：新增 `removeMemory({ store, globalStore, idOrQuery, maxMatches })`，把四个 home（task 内嵌 / project / global / 旧经验层）当成一个记忆空间来查：

- **精确 id 优先**：命中即删那一条，不被当成关键词。
- **关键词**沿用旧经验层**一直以来的判据**——查询侧覆盖率（命中词 / 查询词数）≥ 0.5，而不是排序/去重用的两侧取大：删除查询通常只有一个词，用两侧取大会被长正文稀释到接近 0，"删掉 pnpm 那条"就永远删不掉。换层不顺带改判据。
- **上限保护**：关键词命中超过 `insight.maxForgetMatches`（默认 10）时**一条都不删**，只列出候选（id + 标题 + 所在层）让人给更具体的词或逐个 id。删除是真删且无撤销，一次 `forget 'pnpm'` 扫掉十几条精选记忆不可接受。
- **回报说清删了什么**：`Removed N memory entries:` + 每条的 `id《标题》(层)`。旧实现只回一个计数，事后无法审计。

`save_lesson` 的近邻提示同步补上"确认过时的用 forget 删掉它"，写入与删除两条路闭环。`test/insight-store.test.mjs` 新增 2 项（+2）：精确 id 删 project / global / task（global 要验落盘）、关键词删旧经验层、上限保护超限不删、无匹配不炸，以及 `forget` 工具端到端的回报内容。

### 新增：写入期向量带（相似度 ≥0.9 自动覆盖、≥0.7 提示近邻）+ `save_lesson` 带 `id` 就地更新

**问题**：写入期的自动管理实际上没在工作。真实 store（47 条 live / 1081 对）实测：`insightMatchText` 的词法重叠 **max 0.256**，而 `cfgInsight` 的合并带是 **0.70**——那条通道只在"逐字重写"时才可能触发。同时 `mergeInto` 的 `if (b && !existing[f])` 是**有值就丢掉新文本**，于是"我记错了、改成正确的"永远落不进去（只加 hitCount），而模型手里又没有修改既有条目的工具。

**判据**：写入时把条目标题喂给可选向量层（`leanvec`），取池内余弦最近的一条：

- **≥0.90 且领先第二名 ≥0.05 → 自动覆盖**该条目的正文字段（只覆盖本次显式给的字段），被挤掉的旧值进 `prev`；
- **≥0.70 → 不合并，只在返回里提示近邻 id**，由模型决定要不要带 id 重写；
- 0.90 的余量：真实池内余弦 max 0.655，而让一个本地小模型把同一条知识改写一遍后与原文的余弦 min 0.688 / p50 0.809，所以 0.90 落在"只会命中逐字级再记录"的位置；0.70 在全部 1081 对真实条目上零噪声（0.65 会开始误伤 1/1081）。
- 成本：每次写入 **≈0.2ms**（编码 0.09ms + 池内点积 0.089ms）；模型加载 ~118ms/~120MB 是一次性的，注入路径本来就已经付过。`leanvec` 不在时 `cosine` 为 null，逐字段退回原来的纯词法带（行为不变）。

**覆盖语义修正**：`mergeInto` 从"有值就不动"改成"新值落地 + 旧值进 `prev` 单槽"。`prev` 不是历史——每个字段只留上一版，O(1)、不折叠、不压实，刚好够"误覆盖后写回"；它跟着条目跨层移动（`carryUsageFields`），所以 promote/demote 不会把它丢掉。提升路径只传成员/文件/符号/置信，不传正文字段，语义一字未变。

**`save_lesson` 新增 `id`**：给了 id 就是就地更新，只覆盖本次显式传的字段，忽略 `scope`——条目留在原来的层（global → project → 各任务，`findInsightAnywhere` 负责定位）。未知 id **显式失败**，绝不静默新建。带 id 时跳过向量加载（不需要比对）。

**测试**：`test/insight-store.test.mjs` 新增两组（判定矩阵用注入的 fake cosine，不依赖 leanvec）+3 项：0.95 自动覆盖且旧值进 `prev`、0.80 只提示、0.50 不提示、0.95/0.93 领先不足不覆盖、跨层就地更新、未知 id 失败、`prev` 跨层保留，以及工具端到端的 id 更新/写回。

### 修复：dsh 0.2.1 起 `session.header.cwd` 不再是「当前工作目录」

0.2.1 引入 `@deepseek-ai/dsh-working-directory`：`header.cwd` 变成**原始项目身份 / 权限根**，而 `working_directory({cd})` 改的是会话投影里的当前执行目录，**不写回 header**。本插件的根解析（索引 / 检索 / 懒索引 / 审计注入 / 任务桥）此前一律读 `header.cwd`，于是用户 cd 到另一个项目后，记忆仍然读写**原项目**的 store——不报错，只是静默错根。

取值现在收敛到 `src/util/session-dir.js` 的 `sessionWorkingDir()`：`ctx.get('workingDirectory').get(session)` → `session.header.cwd` → `agent.session.header.cwd`。新服务用 `ctx.get()` **软探测**（不能进顶层 `inject`，那是装配期门控，老宿主上会让插件整个不挂载），服务缺失或抛错都回退 `header.cwd`。没 cd 过时该投影的 `init` 就是 `header.cwd`，两者恒等，因此对既有行为是 **no-op**。`test/session-dir.test.mjs` 9 项钉住每条取值路径。

### 新增：记忆列表新→旧排序 + 增量加载

**排序**：任务 / 项目 / 全局三个 scope 此前是插入序（旧→新），首屏看到的是**最旧**的条目。现在按 `updatedAt↓ → createdAt↓ → id↑` 排出**确定性全序**（面板先看到刚学到的），并列条目也有稳定次序；排序不就地修改 store 自己的数组。

**分页**：`/tasks insight list <scope> [offset] [limit]`，省略参数 = 旧的"返回全部"，老客户端 bundle 不受影响。载荷新增 `total` / `offset` / `nextOffset`，`count` 保留为总数；单页封顶 200，畸形参数**显式报错**而不是静默降级成 0 或全部。

**客户端**：首屏只取 30 条，滚到底前 600px 由 `IntersectionObserver` 预取下一页并追加（按 id 去重）。动作后重放 `0..已加载条数` 的**前缀**，而不是重置回第一页——否则正在看第 5 页的用户会被弹回顶部。页脚常驻「已显示 N / 总数」，加载指示延迟 150ms 才出现以免本地快请求闪一下，失败给可点重试；环境没有 `IntersectionObserver` 时退化成手动「加载更多」。离屏行用 `content-visibility: auto` 跳过 layout/paint（DOM 仍在，保留 find-in-page 与无障碍，避免手写可变行高虚拟列表）。

分页决策抽到 `src/client/paging.js`（纯函数，客户端 React 测试替身验证不了滚动行为）：`test/client-paging.test.mjs` 8 项 + `test/insight-paging.test.mjs` 10 项覆盖边界——逐页拼接必须等于全量（不重叠不漏条）、越界不谎报"还有下一页"、老宿主形态降级。

并发协调另抽成 `createRequestGate()` 并单独钉住一条**开发中真踩到的 bug**：早期用"有在途请求就 return"的布尔守卫，于是上一页还在飞的时候切 scope，新请求被直接丢掉、过期响应又被丢弃 → 新列表永远空白，只能手动刷新。现在语义拆成两件事：过期响应按"序号 + 作用域"丢弃，新请求照发（只有同一个 `scope|offset|limit|append` 在飞时才去重）。

## 0.6.1 (2026-10-15)

`npm test` **650 → 675 项 / 36 个文件**；`npm run typecheck` 通过。

### 修复：物化后的 `searchText` 不在 storeCache 的上界里

`residentBoundBytes` 只数 `_textChars`，而 `allEntries()` 物化 `searchText` 时只 bump 物化版本、不补这笔文本量。于是上界停在物化前的水位，门禁据此跳过精确计量与逐出——实测最多到预算的 **2.06 倍**（真实语料 1.07~1.15 倍）。现在物化按文件记进 `_textChars`，与写路径同一套替换语义。

### 修复：`load()` 之后写进来的辅助集合不在上界，也不在失效键里

`experience` / `insights` / `tasks` / `binding` / `watch` 的增长既不进 `_textChars`，也不进版本戳（原先只有 `_entriesVersion` 与 `_materializeVersion` 两维），所以精确估算停在旧水位、上界还是骨架常数——单 store 实测上界 **1024 B**、实际 **19.08 MB**。现在版本戳加一维内容版本（每个写口 bump，含 `markTasksDirty`），上界补一条辅助集合的腿（按内容版本记忆化；这几个集合条目数小，逐节点求和不进冷加载热路径）。

### 修复：直接改 task 内容后没标脏，改动不落盘、驻留账也不失效

`/tasks rename|todos|switch|archive`、`select_task`、`archive_task` 与 TaskBridge 的三个事件写口都是直接改 task 对象：有的只置 `_dirtyTasks`（漏掉本次新增的内容版本，上界继续停在旧水位），有的连脏标记都不置——`save()` 于是早退，改名 / 归档只活在内存里。现在统一走 `markTasksDirty()`（标脏 + 内容版本），`test/taskbridge.test.mjs` 16 → **19** 项钉住这三条写路径的落盘与失效。

## 0.6.0 (2026-10-13)

`npm test` **616 → 650 项 / 34 → 36 个文件**；`npm run typecheck` 通过。注入场景集 8 → **13** 个，另加 3 个 hint-only 场景。

### 新增：可选语义层（只重排经验 / 洞察两层）

可选依赖 `leanvec` 随安装默认可用并自动启用（约 79 MB、约 +130 MB RSS）；未安装或 `vectorDir: 'off'` 时逐字段退回纯词法。只改这两层排序，返回条数与文档/符号层不变；`vectorAlpha` 默认 `0.5`。

实测（36 条**刻意改写成不含原词**的查询 / 115 条池）：

| 策略 | hit@1 | hit@3 | hit@5 | hit@10 |
|---|---|---|---|---|
| BM25 单路 | 39% | 50% | 58% | **69%** |
| 纯向量替换 | 22% | 36% | 42% | 53% |
| 融合 α=0.5 | **42%** | **53%** | **64%** | **72%** |

**纯向量替换明显更差**，加权融合每个 k 都更好（中位名次 2 → 1）；同批数据还测出"用余弦当绝对阈值"不可行（换文本变体就剪掉 100% 的条目）。所以向量只做排序、不做门槛。

- 索引持久化在 `vectors.json`（实测 151 KB），两级失效（模型指纹 / 逐条文本哈希）：冷启 183 ms、热启 91 ms。指纹变了或文件损坏都当"没有"重建，不抛。

### 新增：检索路径的最小相关性闸门

`query_memory` 与经验/洞察层要求**命中的不同查询词数 ≥ min(2, 查询词数)**（单词查询不受影响）。修的是 `zzz-no-such-topic-xyz` 靠 `-` 切出的片段 `no` 命中一条无关经验（3.13 分）的真事故。

⚠ **只在没有向量层时生效**：A/B 实测对纯 BM25 无影响（hit@10 69% → 69%），却砍掉向量的 3 条救援（72% → 64%）。语义层出厂默认即启用，因此默认装法下这条闸门不生效。

另有一条与向量层无关、两种模式一致的规则：经验/洞察两层的查询词里，**拉丁片段短于 3 个字符的直接丢弃**（tokenizer 从 `no-op` / `--no-edit` 切出来的 `no`、`op` 没有独立语义，却因为稀缺拿到不低的 BM25）。doc/symbol 层不适用——`js` / `id` 这类短标识符本来就该命中。

### 性能：冷加载不再为 storeCache 记账扫全库

0.5.13 把 storeCache 的驻留估算从"读盘文本量换算"改成对内存对象图精确计数——账准了，代价却记在每次 `load()` 上：**逐串 `Buffer.byteLength` 扫一遍全库**。当时记的是"冷加载 +8~11%"，这次在同一棵树（12,634 文件 / 80,231 条目）上用同一个**空进程**口径交替实测是 **+18%**（0.5.11 255 ms → 0.6.0 301 ms）。

现在精确计量只在**真有可能逐出**时才做：条数超上限，或保守上界（内存文本字符数 × 4 + 骨架常数）就已超字节预算。文本字符数按文件**替换式**累计（读盘分片 / 写条目 / 非分片 JSON 三条路径），重写同一个文件不会算两遍；在真实语料上标定的上界 / 精确值比是 1.16~1.74 倍。预算宽裕时（单项目常态）一次遍历都不做。

| 空进程冷加载（80,231 条目） | 0.5.11 | 0.6.0 修前 | 本次 |
|---|---|---|---|
| 实测（交替三轮） | 255 / 258 / 255 ms | 301 / 300 / 301 ms | **251 / 246 / 256 ms** |

- 同一个进程里再 load 第二个大 root 时仍会结算一次——那正是预算可能被撞上的情形。`bench --json` 现在把两个口径分开：`coldLoadMs` 只记空进程冷启动，`secondStoreLoadMs` 记同进程第二个 store；合成基准的冷加载也改成独立进程量（同进程连 load 5 份副本会攒下 5 个 store，既绕不开结算也不是"冷启动"）。
- `test/store-cache.test.mjs` 34 → **43** 项：新增"预算宽裕时不精确计量（无版本戳）""上界 ≥ 精确值且不超 8 倍""写进来的条目计入上界""同一文件重写是替换而非累加"。
- README 双语的性能表按新口径重测（冷加载：前端语料 8 ms、文档工作区 10 ms、3k 切片 70 ms、整棵树 278 ms）。

### 测试与修复

- 新增 **5 个自然语言对照**与 **3 个 hint-only 场景**（提示通道召回 0/3、精度 1.00，只报告不设门）；其中 1 条对照在基线上就注入一条无关经验，属**已知缺陷并钉住上界**。
- 新增 `test/recall-vector-fusion.test.mjs`（13 项）与 `test/vector-index.test.mjs`（10 项），都不需要 leanvec。
- `test/run-test.mjs` 读真实的全局 insight store，导致 `no-hit query shows store overview` 随经验条数变红（乱码查询被 `no` 片段命中）。现在 globalFile 指向临时文件，测试**密闭**。

## 0.5.16 (2026-10-11)

`npm test` **592 → 616 项 / 30 → 34 个文件**；`npm run typecheck` 通过。

### 性能：`chunkText` 不再对整份正文物化（只对有 section 结构的文档有效）

原实现先把整份正文 `split(/\r?\n/)`，再把所有 section 的正文同时留在内存里。现在逐行扫描，
一个 section 处理完就放掉，攒够 `maxChunks` 就停。

省内存靠的是**提前停**：chunk 按文档顺序产出，够 40 个之后剩下的输入永远不会被保留，所以
**只在文档有 section 结构（`#` 标题，或 PDF 每页的 `## Page N`）时**才省。

107 MB 语料实测（独立子进程 + `--expose-gc`，量 `chunkText` 自己额外占用的增量 RSS）：

| 语料 | 旧 | 新 |
|---|---|---|
| 12000 个 `#` 小节 | 45.8 MB | **0.6 MB** |
| 整篇无标题 | 116.1 MB | 111.3 MB（没有实质改善） |

无标题的长文本（单页大 PDF、纯 txt）仍会把整份内容攒在 section 缓冲里；要覆盖那种情形得把
切分做到 section 内部，本次没做。

这次改动不改输出，所以判据是与旧实现逐字节一致：`test/chunker.test.mjs` 把旧实现当参考实现内联，
边界输入（14 种 × 6 组参数）与随机语料（1200 例，定种子）全部一致；另核过仓库 151 个真实文件 /
604 例，零不一致。`eval:injection` 逐项不变。

- `parsePdf` 那侧的第二份全文未动（`buildMarkdown` 仍把所有页拼成一份字符串）。

### 修复：legacy `trigger.scope` 不再被当作过滤条件

`readiness.js` 的注释写的是"`scope` → 默认忽略"，但 `src/index.js` 的 schema 默认值是 `filter`，
两处不一致。结果是唯一带 `scope` 的条目（「发版流程」）永远无法命中：它的
`scope=['release','npm','dsh-project-memory']` 与项目画像 tag 无交集，guard 直接判死。

- 默认改为 `ignore`（`src/index.js` 的 schema 与 `cfgEngine` 两处同时改）。显式配
  `legacyScope: 'filter'` 可保留旧语义。
- 验收：`cfgEngine({}).legacyScope === 'ignore'`，另加一条定向断言——场景 A 必须注入 `p_npmpub`
  （只掉这一条是 14/15 = 0.93，仍在 0.9 地板之上，地板抓不住）。
- 两条断言旧行为的测试按新契约改写：`test/auto-inject.test.mjs`、`test/readiness-eval.test.mjs`。
- `npm run eval:injection`：命中 14 → 15、857 → 907 字符，假阳性与漏召仍为 0。

### 变更：合成评测集从「逐位棘轮」改成「冒烟 + 地板」

原来要求 `precision/recall ≥ 1.00`，钉的是当前实现的行为；合成场景由写 trigger 的同一个作者构造，
测不出漏召，而真实改进（比如上面那条 scope 修复）会被当成回归拦下。现在只保留两条硬门：
对照组零注入（`--store` 模式失守即退出码 1）与 P/R 地板 0.9。历史基线留在注释里
（v1 P0.48/R0.72；v2 P/R 1.00/1.00）。

### 修复：客户端半边不再「静默消失」——顶层 inject 去门控，缺服务改为降级挂载

用户侧的现象是：面板没了、`/` 菜单里的「工作流」组也没了，**浏览器控制台一行报错都没有**。
病因在 cordis 的**顶层 `inject` 是装配期门控**：声明的一项在当前客户端装配里不可用，
`apply()` 根本不会被调用 —— 插件既不挂载也不报错。插件的五个必需服务（`slots` / `sessions` /
`remote` / `remote.commands` / `locale`）里只要有一个对不上（宿主换装配、服务改名、加载顺序），
就是这种形态；0.1.7 会话快照变更、0.2.0 装配差异都踩过。

- **顶层 `inject` 置空**（`src/client/client.ts`），必需服务的检查挪到运行时：新增
  `src/client/services.ts` 的 `service()` / `missingServices()` —— 先 `ctx.get(name)`（cordis 里
  **不需要 inject**），老宿主回退属性访问，两条路都**永不抛出**。`slots` 改走嵌套
  `ctx.inject(['slots'], …)`：现成的直接用，没有就等它，等不到也不影响插件挂载。
- **缺什么就说清楚**：`apply()` 仍照常跑完，面板顶部显示
  `插件降级：缺少客户端服务 <names>`（`panel.degraded`，中英双语），宽限期（3s，装配是异步的，
  apply 时服务没到位不算缺）之后仍缺则打**一条** `console.warn` 点名缺失项 —— 这行日志正是
  「静默」的反面。服务齐全时行为与之前完全一致，不新增任何输出（不误报）。
- **数据通道缺失不再抛**：cordis 里 `ctx.<service>` 在"没有 inject 又没有实现"时**抛错**而不是
  返回 undefined，所以 `TaskPanel` / `MemoryView` / `slash` 里所有 `ctx.remote` / `ctx.sessions` /
  `ctx.locale` 取值一律改走 `service()`；面板的「还没有会话」在 `sessions` 服务本身缺失时不再显示
  （那会误导成"没有会话"，真正原因由降级行给出）。
- **刻意不做「服务迟到唤醒」**：去掉顶层 inject 后 `apply()` 会更早跑，自然想挂一个"服务到齐就
  叫醒面板"的通知。但那条路的判据与 cordis 的注入门控**不完全等价** —— 门控看"实现存在且 provider
  活跃"，而 `ctx.get()` 返回的是实现的 **value**；服务"已 provide、值还是 undefined"时两边结论相反
  （门控满足 → 立刻回调 → 重渲染 → 探测仍说缺失 → 再注册 → 又立刻回调），就是**永不停止的重渲染
  循环**（表现：单个标签页永久未响应、风扇满载，新开标签页却正常）。客户端半边因此立一条规矩：
  **不引入任何会自己触发渲染的机制**；缺服务的提示只在渲染时现算（面板本来就会随 store / 会话变化
  重渲染，降级行会自然消失）。
- **测试**：新增 `test/client-degraded.test.mjs`（5 → 7 项）——顶层 inject 必须为空、贫服务宿主上
  `apply()` 跑完且不抛、宽限期前不报/宽限后恰好一条且点名每个缺失项、服务齐全时不误报、
  **面板真的渲染出降级原因**（不只是打日志），外加一条静态守卫禁止 `src/client` 里再出现
  `ctx.<必需服务>` 直取。`test/client-slash.test.mjs` 的 inject 断言同步改成"顶层为空 + 嵌套注入"。
- **范围**：这是插件侧兜底。宿主层（客户端插件加载/装配）若不改，其他插件仍会是同样的静默形态；
  `client/client.js` 已按新源码重建入库。

### 修复：客户端把 `remote.commands` 读错了门 —— 面板常驻「缺少客户端服务 remote.commands」

上一节去掉顶层 `inject` 之后，服务改由 `service()` 现读；但 `service()` 把路径按 `.` 拆开、顺着父服务
取属性（`ctx.get('remote')` 再取 `.commands`），而**属性路径同样是 inject 门控的**。cordis 里子命名空间
是**独立注册的扁平服务**（名字就叫 `remote.commands`，由 gateway 的 `RemoteNamespaceService` 在嵌套
fiber 里 `provide`）：读它不需要 inject 的**唯一**路径是 `ctx.get('remote.commands')`；顺着父服务取属性
会走 ctx 代理，抛 `cannot get property "remote.commands" without inject`，被软探测吞掉 → 判成"缺失"。
于是**宿主明明提供了它，面板却常年挂着降级行**，数据通道（`/tasks`、`/insight` 的 `execute`）也一并不可用。
宿主自己读子命名空间用的正是整名写法（`ctx.get('remote.probe')` / `ctx.get('remote.credentials')`）。

- `service()` 改成**整名优先**（`ctx.get('remote.commands')`），读不到再回退属性路径（老宿主 / 把子
  命名空间挂在服务对象上的形状）；`TaskPanel` / `MemoryView` 的取值点从 `service(ctx, 'remote')?.commands`
  改成 `service(ctx, 'remote.commands')`。
- **宿主替身的形状修正**：`test/client-degraded.test.mjs` 原来的假宿主是 `ctx.remote = { commands }`
  （没有 `ctx.get`、也没有 inject 门控）—— 它验证的是自己的假设，所以线上坏、测试全绿。现在按真实装配
  建模：扁平服务表 + `ctx.get(name)` + 属性读按 inject 门控抛错，`remote` 服务对象上**没有** `commands`。
- **回归闸门（+2 项）**：真实宿主形状下必须不误报、面板不渲染降级行，且数据通道**真的 `execute` 一次**
  （只断言"没显示降级"会漏掉"通道仍然不通"）；老宿主形状（属性回退）也必须通 —— 两条路都锁住。
  静态守卫加一条：禁止 `service(ctx, 'remote')?.…` 这类顺父服务取子命名空间。
- 顺带：slash 的嵌套 `ctx.inject` 从 `['inputTriggers', 'sessions', 'remote.commands']` 收成
  `['inputTriggers', 'sessions']` —— 那三行菜单只开面板页、**不发宿主命令**，多写一个依赖就是多一种
  "菜单组永不出现"的静默形态。
- **验证**：`npm test` **610 项 / 33 个文件**、`npm run typecheck` 通过；`client/client.js` 已重建入库。

### 修复：引用路径的写入期约束 + 删掉 `blindSpots` 死字段

两件都是同一种形状的债：**schema / 文档承诺了，实现里没人管**。

- **`insight.files` 只收项目内相对路径**（此前零校验）：`save_lesson` 的参数描述一直写着「项目相对
  路径」，但项目外的绝对路径会原样落盘 —— 实测本仓库 144 处引用里 **3 处项目外、6 处真悬空**，
  事后只能靠审计发现"查不到"。现在写入期收敛：反斜杠归一、`./` 前缀去掉、重复合并、
  **项目内绝对路径 → 项目相对路径**，其余（项目外绝对 / `..` 逃出根 / 没有根时无法判定的绝对路径）
  **丢弃并把数量写进返回文本**（不静默少几行）。两条写入路径共用同一个纯函数
  `normalizeCitationFiles`（`src/util/fs.js`）：工具 `save_lesson` 与面板编辑（`/tasks insight edit`）。
  **刻意不做**生成物识别（`lib/`、`dist/` 既可能是产物也可能是源码，误拒的代价大于收益）。
- **删掉 `blindSpots`**：写侧（`src/doc-pipeline.js`）恒写 `''`，读侧（`src/tools/query-memory.js`）
  的分支因此永不触发 —— 133 个分片里非空 **0**。声明了却没有任何写入方的字段就是谎，删字段与那段
  死分支（`test/doc-index.test.mjs` 的断言从 `blindSpots === ''` 改成"字段不存在"）。
- **测试**：新增 `test/citation-paths.test.mjs`（6 项）——纯函数三层（相对保真 / 项目内绝对转相对 /
  项目外与逃出根丢弃并回报 / 无根时不猜）、**真工具 `save_lesson` 落盘已归一且返回文本点名丢弃数**、
  外加静态守卫禁止 `blindSpots` 回到 `src/`。602 → **608 项 / 33 个文件**。

### 变更：轮询只在没人用的时候发生（会话期间静默，回合结束立刻补扫一次）

轮询是插件里唯一"用户没在等、却仍在花机器"的地方：旧实现只按"有没有改动"退避（30s 起、无变化
翻倍、封顶 2 分钟），**有人在跑回合时照样按节拍扫**，扫描时机正好撞上用户打字 / 模型跑工具的那一刻。
现在把"有没有人在用"也变成调度信号（信号取自宿主已有的 `session/event`，零新增配置键）：

- 会话进行中（`turn/start` / `step/start` → `turn/end`）：节拍压到 `max(watchInterval×10, 5 分钟)`
  作兜底 —— 活跃 ≠ 停摆，外部编辑器改文件、或回合始终不结束（崩溃 / 长任务）时索引仍会自愈。
- 最后一个会话结束：取消待跑的轮询，**立刻合并扫一次**这一轮攒下的改动，然后回到常规节拍
  （有改动回 base，没改动继续退避）。多会话用 Set 记：任一在跑即活跃；`session/disposed` 兜底摘标记。
- 失败方向是"更慢"而不是"坏"：事件名将来变了 → 永远不活跃 = 与旧版一致；`turn/end` 丢了 → 停在
  5 分钟兜底，不会卡死。**代价**（明确记账）：长回合里索引最多陈旧 5 分钟（多会话同项目时才明显）。
- 成本口径（免得下次再吵）：一轮 poll 在本仓库是 `walkDir` **7ms**（178 文件，含 stat 的实测
  58–87ms），空闲 60 秒实测整进程 **0.32 秒 CPU ≈ 0.5% 单核**、store **零写入** —— 这一版买到的是
  "交互期一行 I/O 都不做 + 成本可解释"，不是性能修复。
- **测试**：新增 `test/watch-idle.test.mjs`（5 项，不打真实定时器）——间隔口径、活跃期不扫描、
  多会话任一在跑即活跃、回合结束的节拍恢复（有改动回 base / 无改动继续退避）、`watch: false` 与
  `stop()` 之后活跃信号不抛错也不复活定时器。

### 修复：`budget` 掉落的两维数字在审计面被抹掉

`57b464c` 给 `dropped` 加了 `remaining` / `need`（理由写在代码里："还剩 38 字符、这条最少要 120"
与"根本没预算"在日志里长得一样，配额逼近上限时那条**永久静默的细缝**因此不可诊断）。
但 `auditRecordFrom` 把它们投影掉了，落盘的只有 `{id, channel, reason}` —— **源码里有、日志里永远没有**。
本仓库实测 **186 次** budget 掉落（hint 153 / trigger 33）全部无纲；而
`test/injection-budget.test.mjs` 断言的是 `buildInjection` 的**内存产物**：
两处各自有测试，接缝没人测。

- 审计投影原样保留这两维。只对带数字的条目落键 —— coverage 等没有量纲的掉落占绝大多数，
  不该为此多出两个 `null`。
- **回归**：`buildInjection` → `auditRecordFrom` → `appendInjectionAudit` → 读回最后一行，
  断言 `remaining: 30` / `need: 120` 真的落到盘上（回退修复即失败）。
- **验证**：`npm test` **610 → 611 项 / 33 个文件**、`npm run typecheck` 通过。

## 0.5.15 (2026-10-06)

`npm test` **563 → 592 项 / 30 个文件**；`npm run eval:injection` 逐项不变
（命中 14 / 假阳性 0 / 漏召 0，P/R 1.00/1.00，7 次注入 857 字符）。

### 变更：工具 schema 预算瘦身 —— 每次请求固定开销 -356 token（粗估）

工具定义是**每次请求都付**的固定开销（12 个工具一万多字符），这一版删掉重复与过时文本，
并给这件事配了一个可回归的实测脚本 —— 起因就是实际使用时模型抱怨工具描述太长。

- `save_lesson` 把 `kind` / `scope` 语义在**工具描述**与**参数描述**里各写了一遍 —— 等于付两遍钱。
  现在只在参数上写一次，语义一条没少。
- `trigger` 的四个**旧字段**（`keywords` / `actions` / `paths` / `scope`）不再占描述预算：schema 形状
  保留（历史条目与旧调用照常解析），语义见 README 与参数描述。
- 8 个工具各自重复的 `root` 说明统一成一句「项目根目录，默认当前工作目录。」
- 新增 `scripts/tool-schema-size.mjs`（`npm run schema:size`）：用真实的 `defineTool` 投影算出每个工具
  实际发出的字符数。**口径**：字符与 token 分开报，且 token 按语种加权（CJK 1 token/字符、其余 4 字符/token）——
  拿一个固定的「字符/token」系数去乘中英混合文本，会把「英文改中文」掉下来的字符数误当成 token 省下来了。
- 实测（同机 A/B，对上一个提交建 worktree 跑同一个脚本）：**10,341 → 8,388 字符（-18.9%）**、
  **3,040 → 2,684 token 粗估（-356，-11.7%）**。字符降幅明显大于 token 降幅，正是因为其中一部分
  文本由英文改成了中文；**真正的 token 节省来自删掉的重复描述与旧字段说明**，不是换了语种。

### 修复：读不到的目录被当成「已删除」，静默清掉派生索引

`walkDir` 对 `readdirSync` 失败直接 `catch { continue }`：那棵子树既不进 `seen`，又不置
`truncated`，而 `index_repo` 只在 `truncated` 时跳过 unseen 清理 —— 于是读失败的目录下的既有
条目被当「本轮没见到 = 已删除」清掉，下一次索引再把它们建回来。

- `walkDir` 新增 `unreadable`（失败的目录）与 `capped`（撞 `maxFiles`/`maxDepth`），
  `truncated = capped || unreadable.length > 0`。**读不到 ≠ 不存在**，两者都按"扫描不完整"处理。
- `index_repo` 的报告区分两种截断：`could not read N director(y|ies) (permissions?): …` 与
  `scan truncated at the safety limit (maxFiles=…, maxDepth=…)` —— 旧文案会把权限问题谎报成撞上限。
- watcher 同样分类告警（每个根一次），并照旧不传 `unseen`。
- 后果本来就有界：`removeFile()` 只删 `files`/`entries`（派生索引），insights / tasks /
  experience 与源文件都不动 → 重新索引即恢复。但失败是静默的，所以照修。
- 测试：`walkDir` 报 `unreadable` 且 `truncated`（`capped=false`）；EACCES 目录下的既有条目
  在重跑 `index_repo` 后**仍在**，报告点名"读不到"。Windows / root 下 chmod 拦不住 `readdir`，
  该用例显式跳过并打印原因。

### 修复：`a b.md` 与 `a_b.md` 撞同一个 entry id，检索静默少结果

id 前缀规则 `replace(/[\\/:\s]/g, '_')` 曾在**三处各写一份**（`doc-pipeline.js` 的 `relativeId`、
`symbols.js` 的 `buildSymbol`、`enhancer.js` 的 `applyEnhancedSymbols`），且把 `/ \ : 空白` 全部
映射成同一个 `_`。于是 `a b.md`、`a_b.md`、`a/b.md`、`a:b.md` 生成同一个 `${prefix}#0`。

撞 id 的代价不是"不好看"：`rankEntriesStreaming` 按 id 合并多查询命中，两条不同文件的条目会被
合成一条、低分的那条**静默消失**。

- 新增 `src/util/entry-id.js`：`entryIdPrefix(relPath)` 单射编码 —— `/` → `_`（保持
  `src/foo.js` 可读），其余风险字符（`\` `:` 各空白 `_` `%` `#`）→ `%` + 码点十六进制。
  三处副本全部改为调用它。
- 单射理由：输出里的 `%` 只可能来自转义（源里的 `%` 一定是 `%25`），每个风险字符的转义串互不
  相同且都不是 `_`；其余字符原样输出。CJK 不受影响（不像 `encodeURIComponent` 会把每个字变成
  9 字节，那会让 id 变长、把 store 撑大）。
- 存量 store 不需要迁移：id 不是存储键（键是 `relPath`），旧 id 照常可比对；文件变化时自然换新。
- 测试：15 个互相"危险"的路径 → 15 个不同前缀；符号表路径同款单射；端到端 —— 索引
  `a b.md` + `a_b.md` 后两个 doc id 不同，且**两条都留在检索结果里**（旧规则下必为 1 条）。

### 内存：剥离派生字段不再用 `delete`（1196 B/条 → 406 B/条）

`stripPersistedDerived` / `withoutPersistedDerived` 原本 `{...entry}` / 原地 `delete` 掉
`linkedSymbols` / `searchText` / `typeSig`。`delete` 会把 entry 推进 V8 字典模式，之后每个属性
都变成哈希表项 —— 加载路径上这是常驻内存（`storeCache` 里所有 store 都算），写盘路径同款浪费。

- 改为**按非派生键重建**：没有派生字段时原对象返回（零分配热路径），有则重建；
  值为 `undefined` 的键（`typeSig: undefined` 是 enhancer 的实现细节）也不再占槽位。
  `__proto__` 用 `Object.defineProperty` 写入，避免 `out[key] = value` 走去改原型。
- 实测（20k 条真实条目形状，`--expose-gc`）：字典模式 **1196 B/条** → 重建 **406 B/条**；
  按本仓库量级（10^5 条目）折算，加载后驻留省 10^1 MB 量级。
- 测试：行为面（键集、原对象不被改、零分配路径、存量 store 加载即剥离 + 下一次 `save()` 压实
  磁盘）＋ 形状面（子进程 `--expose-gc` 对照旧 `delete` 版本，断言至少省 25%）。

### 加固：TS 增强队列有上界，且正文/解析推迟到出队时

`enqueueEnhance` 原本在入队时就同步读正文 + `deepParseWithTS`（同步跑到第一个 `await`），
于是 `index_repo` 对整棵 TS 树一次性入队 = 同时持有**所有**文件的正文与符号数组；队列本身也没有
任何 cap。长驻 `dsh web` 的 RSS 单调爬升就是这个形状。

- 任务体推迟到出队：入队只读一次文件算 `cacheKey`（16 字节），正文与解析结果不留在队列里，
  真正读正文/解析/提交发生在 `runEnhance()`。队列每条只剩元数据。
- 队列有界：`ENHANCE_QUEUE_MAX = 20000`（与 `maxScanFiles` 默认同量级，正常仓库够不到，是兜底阀）。
  满了先挤队尾（最不紧急的），挤不动就丢新来的那条；被丢/被挤掉的任务 promise **立刻 resolve**
  （调用方都是 fire-and-forget，不能让谁悬着），丢弃计数与一次告警不静默，
  `index_repo` 把它写进报告（`N file(s) skipped TS enhancement …`）。
- 去重语义不变（同 relPath 同内容复用，内容变了换掉 —— 被换掉的那条 promise 同样 resolve）。
- 测试：入队上限收窄到 3 后断言队列不超上限、**同步阶段只解析 1 个文件**、超限计数 +1、
  所有 promise 都 settle、队列最终排空且增强结果仍落进 store。

### 加固：`maxFileSizeMb` 降到实测安全区（50 → 10 MB），并补上峰值系数

`maxFileSizeMb` 是**单文件内存闸门**，但它的默认值 50 从 v0.1 起就没量过。这回补上阶梯实测
（新增 `scripts/file-peak.mjs` / `npm run bench:peak`：1 / 2 / 4 / 8 / 16 / 32 / 50 MB，每档一个独立
子进程 + `--expose-gc`，对「峰值 RSS = a + b × 磁盘 MB」做最小二乘）：

| 语料（50 MB 单个文件） | 边际系数 b（峰值 RSS / 磁盘） | 实测峰值 RSS |
|---|---|---|
| 典型源码（≈1 个声明 / 1.2 KB） | **9.6×** | 590 MB |
| 符号密集代码（≈1 个 / 240 B） | **20.6×** | 1 189 MB |
| 文本型 PDF（未压缩流，≈0.9 字符/磁盘字节） | **19.0×** | 1 194 MB |

- 结论：**旧的 50 MB 允许单个文件把宿主进程推到 ~1.2 GB RSS**（还有一次最长 12.5 s 的同步解析），
  这正是 issue #5 那类 OOM 的形状。原先文档与计划里写的「峰值是它的 2–4 倍」**低了 5 倍**。
- 默认值改为 **10 MB**：最坏情况单文件增量 ≈ **+300 MB RSS**（20.6 × 10）。误伤面实测很小 ——
  实测多个真实项目里只有 1 个文件超过 10 MB（一个 28.7 MB 的生成物，
  也正是最该跳过的那类：生成的、符号密集、索引收益低而内存最贵）。旋钮仍可调高，
  双语 README 的配置表与「单文件内存预算」一节都写明了各自系数。
- 口径提醒：heap 峰值受 GC 时序影响会**非单调**（同一档符号密集语料，32 MB 量出 625 MB、
  50 MB 反而 328 MB），所以脚本以 **RSS 为主口径**，heap 只作参考。
- 顺手清账：`parsePdfInfo()` 零调用方（且自己会整份读盘）→ 删除。

### 文档：README 测试数断言审计

README（英/中）的测试数此前停在 561，而 `npm test` 实测已是 563（`readiness` 15→16、
`ops` 6→7 两处漏更）。本次与新增用例一起对齐到 **592**，逐项相加与实测一致。

## 0.5.14 (2026-10-02)

`npm test` **540 → 561 项 / 28 → 30 个文件**；`npm run eval:injection` 逐项不变
（命中 14 / 假阳性 0 / 漏召 0，P/R 1.00/1.00，7 次注入 857 字符）。

### 修复：`/` 菜单里「工作流」三行点了没反应

同一个病根：**UI 动作被写成了宿主命令**。那三行的实现是
`remote.commands.execute(sessionId, '/tasks insight list project')` —— 命令在宿主侧确实执行了，
但客户端渲染命令节点的是按**命令名**分发的 `TaskCommandNode`（`key: 'tasks'`）：它拿到
`name === 'tasks'` 就用**任务**解析器去解**记忆**载荷，`parseTaskPayloadText` 必然返回 null，
于是对面板零影响，只在对话里留下一个 `/tasks 已执行` 节点。用户看到的就是「点了没反应」。

根因是面板的视图页是 `TaskPanel` 组件**内部**的 `useState('task')` —— 组件外面没有任何可寻址
的落点，所以菜单行只能绕宿主命令，而那条路又够不到面板。

- `view` 移进 UI store（`task-ui-store.ts`）：新增 `PANEL_VIEWS` / `normalizeView()` 与
  `setView()` / `openView()`，持久化且可从组件外寻址；面板的切页按钮改为读它（不再各抄一份）。
- `/` 菜单三行改为**纯客户端**：`consumeSpan()` 之后直接 `openView(view)`，不再发宿主命令
  （`SlashSourceDeps.run` 随之删除，`client.ts` 里的 `runCommand` 变成死代码也删掉）。
- 候选不再携带 `line` 字段。
- 测试：`test/client-slash.test.mjs` 的点击语义改为断言 **localStorage 里的 `view` / `closed`**
  （旧断言是"命令行映射正确"，正是它把 bug 放了过去），并加一条"视图入口不得携带命令行"。

### 修复：`show_task_panel` 从来没有打开过面板

这个工具读 `exec.ctx` 再 `emit('dsh:task-panel:show')`，而宿主契约里**没有 `ctx`**：
`ToolRunContext` 只扩了 `deferContext()` / `concludeTurn()` 两个自有成员
（`packages/core/tools/src/index.ts:418`）。于是它每次都只返回「无法获取上下文」，
那个事件名也是编出来的 —— 面板从未被它打开过。

面板的 `closed` / `minimized` 是**浏览器侧** UI store 的状态，宿主进程碰不到，所以正确的
位置是宿主给出的扩展点：`ui-tool` 在 `conversation.chat.node`（key `tool-call`）下声明了按
**工具名**分发的子槽 `tool.call.toolview`（契约原文：*"Any name is allowed, including tools
registered by your package. Register with `key: '<tool name>'`"*）。

- 新增 `src/client/ShowTaskPanelNode.tsx`：认领 `show_task_panel` 这个 key，工具结果一渲染
  就调 `taskUIStore.open()`。**只在现场执行时打开** —— 历史节点（刷新 / 切会话后）会直接以
  `result` 阶段挂载，那时只展示不开面板，否则每次打开会话都弹一次（与 `/tasks` 命令节点的
  `live` 判据同款）。
- 宿主侧删掉那段触碰不到 `ctx` 的代码，改为只让调用真实发生并返回可读结果。
- 测试：新增 `test/client-toolview.test.mjs`（5 项：注册 key、历史回放不弹、现场执行弹、
  槽缺失时降级、畸形 ctx 不抛）+ `test/task-view.test.mjs` 补一项（不依赖 `exec`）。

### 性能：影子日志瘦身 2×，单项目日志上限 4.5 MB → 1.5 MB

`admission-shadow.jsonl` 的体积 **90.6% 是 `candidates`**（实测 210 行 / 965 KB，候选占
875 KB），而真实 store 单步就能产生 40~60 条（中位 42）。三处都是纯冗余：

- `support` / `terms` 是**查询级**量，同一个 pre-step 内逐条恒定（实测 139/139 步）→ 提到行级；
- 候选只可能来自提示通道（trigger 在 `injected` / `dropped` 里）→ 不再逐条记 `channel`；
- 候选按分数降序、`decision === 'cand'` 必然在最前 → **全部 cand + 按排名补足到 16 条**，
  截断前的总数记在 `candidatesTotal`，不静默。

实测单行 **6071 B → 2935 B（48%）**。同时把 `shadowMaxBytes` 默认 2 MB 降到 512 KB：
轮转只保留一代 `.1`，所以单项目日志硬上限从 `2×2MB + 2×256KB ≈ 4.5MB` 降到 **≈1.5MB**
（按每行 ~1.5KB 算仍有 ~680 步历史窗口，远超"离线重放最近历史"所需）。
日志**本来就是有上限的**（`rotateIfOversized` 覆盖旧的 `.1`，不是无限追加）；
要彻底不要日志，`autoContext.shadowLog: false` 即可。

### 修复：会话配额把长会话的后段永久致盲

`maxItemsPerSession` / `maxItemCharsPerSession` 从 12 / 4000 抬到 **60 / 24000**。它们是**保险丝**，
不是节流阀——节流一直由单轮 `maxTokens` 与 `gateCooldownSteps` 负责，但默认值太小、真实用量
确实到得了：实测 5 个 root 的 2781 个 pre-step（含轮转历史）里 **11/81 个会话打满**，打满之后
再无条目注入（`session-chars` 1115 步 + `session-items` 119 步），且**全部尾部失明步的 72% 来自
这 11 个会话**（最坏的一个 223 步里 168 步静默，末次注入停在 step 54）。机制一行未改，显式配小值
即可复现旧行为。

### 修复：配额邻近上限时的「细缝」静默不可诊断

配额逼近上限却未触顶时（实测 `4000 − 3962 = 38` 字符），每条候选都过得了全部门槛，却永远塞不下
最小正文（提示 120 / 触发 48），于是**永久**静默——而日志里只有一条无量纲的 `budget`。
现在丢弃会带出 `remaining` / `need` 两个数字。

### 修复：注入判据的观测缺口（三处）

- 会话限流命中时 `hintCands` 被整个置空，静默步**一个候选都不落盘**（实测 1420 步全空）→
  改为照旧评分、只不注入，影子记录才答得出「不限流这一步会注入什么」。
- `buildInjection` 的空块早退分支漏掉了 `candidates`，把候选一并丢了。
- 候选只有门槛结论、没有预算结论 → 每个候选新增 `outcome`
  （`injected` / `budget` / `quota` / `idle` / `gate` / `unscheduled`），与 `decision` 正交；
  影子行另记 `scoreQuery`（**实际**用于评分的 intent + 写目标拼合，与人类消息 `query` 不是一回事）
  与 `dropped`。

### 性能：每步评分从 O(C²) 降到 O(C)

`idfCoverage` 对**每个候选**都重建一遍整个语料的词集合。真实 store（72 条）实测单步
`buildInjection` **113 ms → 9 ms**；只看覆盖率那段是 147.5 → 1.3 ms（109×），且逐字段一致
（已固化为回归用例）。评分在每个 pre-step 都跑，所以这是「每条模型消息」级别的开销。

### 修复：IDF 语料与检索语料不同源

`store.js` 的 `_rebuildIdf` 手抄了一份 `title×5 + keywords + summary`，而检索侧的
`weightedFieldText` 是 `title×5 + keywords + summary + **terms** + sourcePath`。于是只出现在
`terms` 里的词 `df=0` → 被当成极稀有词拿虚高 IDF（`terms` 正是为修「只有前 300 字符可检索」
加的主检索面）。改为直接调 `makeSearchText`，权重自动对齐。

### 观察：注入块抬头标注生产者

`[Memory Inject] auto-context` → `[Memory Inject] dsh-project-memory · auto-context`。
`source.kind` 只有宿主看得到（请求序列化只取 `role` / `content`，provider 对 `.source` 零引用），
抬头是模型与 GUI 用户唯一能看到生产者的地方。

### 工具描述修订

- `remember` 指向了一个**不存在**的工具（`search_experience`）→ 改为 `query_memory`。
- `remember` 与 `save_lesson` 职责相邻却都没说清怎么选 → 两处互相点名（`remember` 写独立的
  经验文件；新建内容优先 `save_lesson`，它带 scope / 合并 / 晋升）；`forget` 的参数说明同步。
- `watch_repo` 不再建议「重载插件」（模型做不到这件事）。

### 修复：`writeJsonAtomic` 的两份副本已漂移

同一个函数在 `store.js` 与 `insight-store.js` 各有一份。`f9a1389` 给前一份补了「失败即删自己的
`.tmp`」，v0.5.0 后加的那份没有，写成了「失败后重试同一个 rename」—— 瞬时失败下可能重试成功，
然后照样抛错。两份的父目录契约也不同（一份要求已存在，一份自建）。

后果落在 global insight 文件上：它写失败会永久留下 `<file>.<pid>.tmp`，因为
`cleanStaleTmp()` 只扫项目 store 目录，够不着 `~/.config/dsh-project-memory/`。

- 抽成 `src/util/fs.js` 的单一实现：先建父目录，失败时删掉自己的 `.tmp` 并原样抛出。
- 两份副本删除；`insight-store.js` 清掉随之无用的 import。
- `store.js` 两处 `mkdirSync(shards)` 已冗余，一并删除。分片写的 mkdir 次数不变（1 次，
  只是挪进函数内）。
- 测试：新增 `test/atomic-write.test.mjs`（6 项），含「`shards/` 被删后 store 仍写得进去」。

## 0.5.13 (2026-09-28)

适配 DSH 0.2.x。`npm test` **539 → 540 项 / 28 个文件**。

### 修复：0.2.x 上插件被整个停用

DSH 在 profile 组合阶段用运行版本核对插件的 `@deepseek-ai/dsh*` peer 范围，对不上就把该行
`disabled = true`。本插件三段范围的上限都是 `<0.2.0-0`，`0.2.0-rc.1` 落在范围外。后果不是
"某个功能失效"：`cordis.patch.yml` 插入层从未进入组合树，工具 / 命令 / 面板 / 自动注入全部
消失，插件管理器也拒绝安装或启用。

- `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-tools` 的 peer 范围追加 `|| >=0.2.0-rc.1 <0.3.0-0`。
- devDependencies 从 `0.1.5-rc.1` 升到 `0.2.0-rc.1`（`@deepseek-ai/cordis` → `^4.0.4`），
  类型检查与测试对齐运行版本。
- 验证：DSH 自身的 `evaluatePluginCompatibility()` 判定为兼容；隔离 `DSH_HOME` 下真实挂载，
  12/12 个工具注册进真实 ToolRuntime。

### 修复：`BlockAssembler.message(source)` 在 0.2.0 变为必填

签名由 `message(source?)` 收紧为 `message(source)`。`chatText()` 原先无参调用：运行时**不抛错**
（展开 `undefined` 合法），所以测试全绿、故障静默，但组装出的 assistant 消息丢掉了
`provider`/`model` 归属。改为传入已解析出的路由，并在 `test/llm-route.test.mjs` 补一项断言
（曾用无参调用复现为红灯）。

### 构建：client 产物不再每次构建都变

`tsdown.config.ts` 里 CSS 模块的类名映射直接遍历 lightningcss 的 `exports`，而它由 Rust
`HashMap` 支撑，hasher 每进程随机播种 —— 同一份 CSS 每次构建的键序都不同。类名与哈希本身稳定，
键序在运行时也只按键取值、不可观测，但 `client/client.js` 是提交进仓库的产物，后果是每次
`npm run build:client` 都产生纯键序 diff，真实改动淹没在噪音里。改为按键排序输出后，连续三次
构建产物逐字节一致（本版 `client/client.js` 因此有一次性的键序重排，无语义变化）。

### 其余宿主契约

逐包比对 0.1.5 / 0.1.7 → 0.2.0 的公共 API，插件用到的部分（`defineTool`、`ToolRunContext`、
`agent/pre-step`、`session/event`、`fs/observed`、`commands.register`、client 槽位与
`inputTriggers`、`sessions.list` 快照形状等）均为纯增量，无需改代码。本版唯一需要改源码的
破坏点就是上面那条 `BlockAssembler.message`。

## 0.5.12 (2026-09-26)

本版五个修复 + 一个新增，主题是记忆的驻留、索引归属，以及两处让 TS 增强层失效 / 失真的缺陷。`npm test` **476 → 539 项 / 26 → 28 个文件**。

### 修复：TS 增强队列的 TDZ 会打死宿主（`dsh: fatal load failure`）

```
dsh: fatal load failure: ReferenceError: Cannot access 'p' before initialization
    at enqueueEnhance (enhancer.js)  →  onFileChanged  →  WatchManager.pollRoot
```

`enqueueEnhance()` 先启动任务、后登记队列条目，并在 `finally` 里用
`enhanceQueue.findIndex(q => q.promise === p)` 反查自己。`deepParseWithTS()` 是同步的，文件
产不出增强符号时任务体走不到 `await`，`finally` 就在同步阶段执行——此时 `const p` 尚未完成
初始化。队列为空时 `findIndex` 回调不被调用，问题不显形；队列非空时读到 TDZ 的 `p`，抛
ReferenceError。watch 轮询对每个改动的 `.js` 都在同一个同步循环里调 `onFileChanged`，且丢弃了
返回的 promise，未处理的 rejection 被宿主当成致命错误。

- 队列条目改为先入队，`finally` 按对象身份摘除自己。
- 三个 fire-and-forget 入口各挂 catch。
- 顺带修掉同步完成的任务把一条已 resolve 的僵尸条目永久留在队列里的问题：同一路径同内容的
  后续调用会命中它，导致再也不增强。
- 测试：新增 `test/enhancer.test.mjs`（6 项），`src/enhancer.js` 此前无测试覆盖。

### 修复：TS 增强层对 `.js` 文件从未生效（不分平台）

`deepParseWithTS()` 调 `ts.createProgram([filePath], {}, host)`，`options` 是空的。
TypeScript 在**调用 host 之前**就有一道扩展名闸门：`getSourceFileFromReferenceWorker` 先比对
`getSupportedExtensions(options)`，`.js/.jsx/.mjs/.cjs` 不在其中就直接返回——host 根本不会被问。

而插件的 `isTypeScriptFile()` 明确把这四种扩展名列为可增强对象，watch / 懒索引 / `index_repo`
三条入口也照常喂进去。**结果是 TS 增强层（README 承诺的"推导返回类型、解析泛型、抽取接口"）
对绝大多数真实文件一直没有产出，且没有任何日志。**

- `createProgram` 改用 `{ allowJs: true, noLib: true }`。`.js` / `.jsx` / `.mjs` / `.cjs` 从 0 个符号
  恢复到正常产出（`isTypeScriptFile()` 认的 8 种扩展名逐一断言），`.ts` 行为不变。
- **顺带修掉 L2 对无注解 JS 的文本损伤。** `applyEnhancedSymbols()` 是**就地重写** L1 条目的
  `text`，而旧实现把参数一律渲染成 `${name}: ${type}`：本仓库 51 个 `.js/.mjs` 实测 334 条条目被
  重写，86% 的参数成了 `: any`，52 个带默认值的条目里 36 个把默认值丢了——

  ```
  chunkText(text, chunkChars = 3000, maxChunks = 40) — src/chunker.js:1          ← L1
  chunkText(text: any, chunkChars: any, maxChunks: any): any -- src/chunker.js:1  ← 旧 L2
  ```

  现在参数用**源码文本**（`= 默认值` / `?` / `...rest` / 解构模式都保住），推导出的返回类型只在
  有信息量时才追加（`any` / `unknown` / `{}` 不写）。改后同一份语料：默认值 0 丢失，被重写的条目
  里 51% 的文本与 L1 逐字相同（升级不再是损伤），其余 49% 多出一个真实返回类型（`: boolean` /
  `: void` / `: () => void` / 对象形状）。
- `.cjs` 的惯用写法 `module.exports.foo = function () {}` 此前产不出符号：它的父节点是
  `BinaryExpression`，不在函数表达式的名字白名单里——而 `isTypeScriptFile()` 明确把 `.cjs` 列为
  可增强对象。现在按 `module.exports.foo` / `exports.foo` / 字符串下标取名字。
- 增强条目的一行声明改用与 L1 `buildSymbol()` 相同的 ` — ` 分隔（旧为 ` -- `）：L2 重写的正是
  L1 的文本，两种分隔符会让同一个文件里的条目混排两种格式。
- **测试同步加固**：`test/enhancer.test.mjs` 原先的断言是 `existsSync(store.dir)`——store 目录
  只要有任何一次 commit 就会存在，前面几个用例已经把它建好，这条因此永远为真；它验的是
  "跑过了"而不是"处理了"。换成 `store.entries[rel].some(e => e.enhanced)`，并补 `.js` 与
  `.mjs` 的直接断言。固定 `setTimeout` 也改成轮询到条件成立，慢 CI 上不再靠运气。新增扩展名
  覆盖面、文本保真、CJS 断言与静默契约四组（共 13 项；前三组的 11 项在旧代码上为红，静默契约
  那 2 项锁的是"不加日志"这个决定，新旧都绿——它防的是将来有人把告警加回来）。

### 修复：TS 增强在 Windows 上因路径写法不同而整层失效

compiler host 用 `fileName === filePath` 严格相等来认自己的文件。TypeScript 内部一律走
`normalizePath`（反斜杠转正斜杠、消解 `.`/`..`、绝对化），而 `path.join` 给出的是平台原生形态。
Windows 上两边字符串不同 → `getSourceFile` 返回 undefined → `deepParseWithTS` 返回 `[]`。
POSIX 上路径本就是正斜杠，因此从不现形。

2026-09-26 的 Windows CI 就是这样暴露的（唯一失败断言是 enhancer 的「增强结果落进 store」）。

- 路径比较改用 `ts.normalizePath`（带 `typeof` 兜底：它在运行时导出但 `typescript.d.ts` 里
  没有声明，而 peer 范围覆盖 TS 5/6/7）。
- `useCaseSensitiveFileNames` 不再硬编码 `true`，改为跟随 `ts.sys`——TS 在 macOS 上是探测真实
  文件系统而非写死 `false`，跟随它才是正确语义。
- 预建唯一的 `SourceFile` 并按**对象身份**确认 TS 收下了它，不再用 `program.getSourceFile(filePath)`
  回查（那一步内部会把相对路径拼上 cwd，同样是脆弱点）。
- 回归断言改成**字符串形态**：反斜杠（Windows 形态）、裸 `./` 段、裸 `..` 段。原先那条用的是
  `path.join(dir, '.', 'shape.ts')`，而 `path.join` 自己就会消解 `.`——它与 `path.join(dir, 'shape.ts')`
  是同一个字符串，断言在旧代码上也是绿的，等于没测。TS 的 `normalizePath` 在**任何平台**都把 `\`
  归一成 `/`，所以这三条在 Linux 上就能判定，不必等 Windows CI。
- 两条"本该有结果却没有"的路径**保持静默**（host 没认出 root path、`readFileSync` 失败），
  但不再是无从分辨的黑盒：调用方契约（入队 resolve、返回 `[]`）由断言正面锁住，理由写在代码里。
  不做日志是代价与收益的权衡——watch 每 15s 一轮、每个不受支持的 root 都会撞上它，按文件去重
  也只是把"每轮一条"换成"每个文件一条"，而"这轮没增强"不会产出任何错误结果。2026-09-26 的
  教训是"静默"藏住了整层失效，但解法是补测试（见上一组断言），不是往终端打字。

### 已知限制（本版未做）：L2 不加载 TypeScript 的默认 lib

compiler host 里的 `getDefaultLibLocation: () => ts.getDefaultLibFilePath({})` 返回的是**文件**
路径而不是目录，于是默认 lib 从来没有被加载过——显式标注的类型正常，依赖全局类型（`Promise` /
`Array` / DOM）的一律塌成 `any` / `unknown`：

```
export function f() { return [1, 2, 3].map(n => n * 2) }   →   (): any       （载入 lib 后是 number[]）
export const g = async () => 1                             →   (): unknown   （载入 lib 后是 Promise<number>）
```

本版把它换成**显式**的 `noLib: true` 并在代码里写明理由：行为不变（实测两者产出的符号完全一致），
但"没生效"不再是一个没人写下来的意外。

修它不止一行：目录给对之后 host 还必须按需提供 `lib.d.ts` 及其引用的 6 个文件（`lib.es5` /
`lib.decorators` / `lib.decorators.legacy` / `lib.dom` / `lib.webworker.importscripts` /
`lib.scripthost`，共 ~2.1MB 文本）。实测代价：每个 program 重解析 **p50=102ms/文件**；把解析好的
`SourceFile` 缓存跨 program 复用（或走 `ts.DocumentRegistry`）则是一次性 ~100ms + 每文件 ~1ms。
这是"性能换质量"的产品选择，留到下一个版本单独做。

### 修复：storeCache 的驻留估算量错了对象

`estimateResidentBytes()` 用 `Math.max(_residentChars, entries * 2500)` 估算一个 store 的内存占用，
两个口径都不成立：

1. `_residentChars` 是 `loadJson` 读进来的 JSON 文本长度，其中包含 `load()` 随即被
   `stripPersistedDerived` 删掉的字节——老分片仍带 `searchText` / `linkedSymbols`。
   实测一个 store 的读盘文本是真实驻留的 **2.09 倍**。
2. 估算在 `load()` 内就被调用，而 `searchText` 要到 `allEntries()` 才物化，同一个 store
   在物化前后估出两个不同的数。

结果是高估：本可共存的 store 被过早逐出，下一次 `load()` 重读全部分片。在 Windows 上
（Defender 实时扫描放大每次文件读）尤其明显。

`deepseek-harness`（11698 文件 / 70119 条目）实测：

| 口径 | load() 后 | 物化 `searchText` 后 |
|---|---|---|
| 旧估算 | **167.2MB**（真实 63.5MB） | 167.2MB（真实 97.8MB） |
| 新估算 | 75.0MB（**+18.2%**） | 104.8MB（**+7.1%**） |

- 改为 `_estimateResidentBytes()` 统计内存中的对象图（形状开销 + `Buffer.byteLength()`，
  CJK 在 UTF-8 里 3 字节/字符，用 `String.length` 会再低估一半），按 `_entriesVersion` 与
  新增的 `_materializeVersion` 记忆化——`evictStoreCache` 每次要对整个缓存逐 store 求和。
  代价是版本变化后的一次全量遍历，冷加载 +8~11%。
- 删除 `_residentChars` 及 `loadJson` 的 `sizeSink` 参数。
- `keepKey` 豁免（刚加载的 store 即使超预算也保留）保留，但不再静默：单实例超预算时按 root
  告警一次。

行为变化：逐出变少，内存上限更接近 256MB 的本意；只有真正超预算时才像以前一样逐出。

测试：新增 `test/store-cache.test.mjs`（22 项），`storeCache` 此前无测试覆盖。

### 修复：watch 根不再钉住 store，也不在启动时急切读盘

`WatchManager` 长期持有每个 watch 根的 store 实例（`this.roots.get(root).store`），而
`removeRoot()` 的唯一调用方是 `watch_repo --watch false`。两个后果：

1. 逐出对 watch 根不省内存——`storeCache` 丢了 key，watcher 还持有那份；
2. 一旦被逐出，下一次 `load()` 会从盘上再建一份。同一个 root 出现两份互不可见的内存状态，
   各写各的脏分片，存在丢更新的窗口。

同一个字段还让 `restorePersisted()` 在启动时对整条 `watchlist` 急切读盘：watch 过多少个根，
启动就同步读多少个 store 的全部 shard。

- `addRoot()` 只登记 `{ snapshot, failures }`；新增 `storeFor(root)` 在 `pollRoot()` 需要时
  按需取，整个 `pollRoot` 期间共用一个实例。
- 每个 root 全进程只有一个活实例，内存上界回到 `STORE_CACHE_MAX_BYTES`。

### 修复：父根不再重复索引嵌套的项目根

一个没有项目标记（无 `.git`、无 `package.json`）的容器目录经由「标记缺失 → 回退到会话 cwd」
成为根后，`walkDir()` 会把整棵树索引一遍，而树里的每个子项目各自都有自己的 store。实测某个
父根的 store 里 **99.9% 的条目是子根的重复副本**，且是过期快照（部分源文件已从盘上删除）——
这份 store 没有独有价值，却占用内存，并在父根下 `query_memory` 时返回陈旧内容。

- `walkDir()` 新增 `nestedStoreName`：子目录自带 store 时不再往下走，跳过的目录放进返回值的
  `skipped` 字段。判据是子目录下存在 `<子目录>/<memoryDir>/format.json`——只有真正存过盘的
  store 才算数，误建的空目录不作数。与 `findProjectRoot()` 的解析规则一致。
- `index_repo` 与 watch 轮询都启用；`index_repo` 在结果里列出被跳过的子根。
- 存量重复自动收敛：被跳过的子树不在 `seen` 里，既有的 `commitFileUpdates(..., { unseen })`
  清理路径会将其移除。升级后首次 `index_repo` 或一次 watch 轮询即生效，不需要迁移脚本。

### 新增：父根未命中时列出独立子索引

上一节之后，父根不再保存子项目的内容，在父根下 `query_memory` 问子项目必然查不到。现在本根
记忆层（doc/symbol）无命中时，输出最前面会列出该根下自带 store 的子目录：

```
Note: this root keeps no copy of N nested project(s) — each has its own index.
Re-run query_memory with `root: <path>` for the one you want:
- <path>
```

- 触发条件只看记忆层：insight/experience 是全局层，与根无关，不应盖掉这条提示。
- 提示置于最前，因为 `truncate()` 截的是尾部，而 procedure 类条目单条可超 600 字符。
- 只影响 `query_memory` 的未命中路径，不涉及注入。

**验证**：`npm test` 518 项 / 28 个文件全绿；`npm run typecheck` 通过；`npm run eval:injection`
逐项不变（命中 14 / 假阳性 0 / 漏召 0，P = R = 1.00）。

## 0.5.11 (2026-09-25)

### 修复：doc↔symbol 链接不再物化进 entry（真实大仓库的内存与索引开销）

`linkedSymbols` 是**跨实体派生关系**（一个 doc chunk 链接到哪些符号，取决于符号表的当前状态），
旧实现却在索引时把它算好、写进 `entry` 并落盘。实测本仓库自己的 store（11698 文件 / 70119 条目）：

- 17174 个 chunk 共 **3,948,420** 个链接槽位，只对应 15,456 个符号，单 chunk 最多 2231 个；
- 唯一的消费者 `query_memory` 只读前 5 个——存了消费量的 **46 倍**；
- 加载这个 store 的堆占用 **443MB**，链接槽位是其中最大的一块；
- 每个索引提交点还要对整库做 O(chunks × symbols) 重扫，并靠 `markFile` 标脏追失效，
  否则"文档先索引、符号后到"会永久丢链接。

现在链接在**读取期**用每 store 的符号索引解算（`src/link.js` 的 `resolveLinkedSymbols`）：
纯 latin 符号名走倒排表按整词查，CJK/混合名保留原有边界语义的正则回退；成本 O(本 chunk 词数)，
与符号表规模无关。排序改为命中次数 → 名字长度 → id（旧实现交给消费者的前 5 个是符号表插入序，
即"任意 5 个"，这是本次一并修掉的行为）。

- **内存**：同一 store 的加载堆占用 **443MB → 129–196MB**，RSS **581MB → ~300MB**；
- `linkedSymbols` 在加载时从旧 shard 剥离、写入时不再产生；磁盘上的存量 shard 会在该文件
  下次重新索引时自然压实（不主动重写 11698 个 shard）；
- 删除 `linkEntries` 导出，以及 `commitFileUpdates` 的 `link` 参数（它只为"中间批次跳过、
  最后一批统一重建链接"而存在）；`enhancer` / `index-doc` 里的链接重建调用一并移除；
- `query_memory` 的 `references` 输出格式不变，`test/run-test.mjs` 的链接用例改为断言
  解析器行为，并新增"文档先索引、符号后到也能解出"与"limit / 排序"回归。

### 修复：其余派生/中间字段与两处无界缓存（体积、内存、轮询）

第一轮去掉了链接，这一轮把剩下的放大源和常驻开销一起收掉。同一个 store（11698 文件 /
70119 条目 / 索引源码 108.5MB）实测：**落盘 361MB → 93MB**（老 store 由下面的自动压实
收敛；再叠加 type-cache 自愈清理后是 **73MB**），加载 **1017ms → 279ms**，堆占用
**129–196MB → 101MB**，`recallItems` p50 **53ms → 47ms**。

- **`searchText` 不再落盘**（省 22.7MB）。它是 `weightedFieldText` 的纯派生结果，改成
  `allEntries()` 在内存里按需物化；写入时与 `linkedSymbols` 一起剥离（`PERSISTED_DERIVED`）。
  检索语义与输出不变；磁盘与加载解析变少，堆占用基本持平（物化改到首次查询时做）。
- **符号声明限长成一行**（`oneLineDeclaration`，≤200 字符）。TypeScript enricher 之前把
  interface 的**全部成员**拼进 `typeSig`、再整体落进 `text`/`typeSig`（实测符号条目平均
  1.25KB，其中 `text` 648B），而这两个字段没有任何读取方。现在 interface 只留前 6 个成员 +
  `… +N more`，`typeSig` 不再落盘。代码层 **31% → 19% 源码**，README 声称的"一行声明"
  由此第一次成立。
- **storeCache 按字节预算 + LRU**。原来只按个数（32），而单个大仓库 store 实测驻留
  130–200MB；现在同时限制条数与估算驻留量（256MB，约 2.5KB/entry），命中会把条目挪到
  队尾，热的不会先被逐出。
- **删除 type-cache（TS 增强结果缓存）**。它按内容哈希缓存增强结果，但三个增强入口
  （lazy 的 `fs/observed`、watch 轮询、`index_repo`）**都只在"文件已变更并重新索引"之后**
  才触发，此时内容哈希必然是新值——这个缓存永远命中不了。实测本仓库残留 9827 个文件
  （`du` 41MB，内容其实 9.2MB，约 31MB 是 4KB 块开销）。现在 `load()` 会自愈删除该目录；
  文件变更照常触发增强，进程内仍由 `enhanceQueue` 按 (relPath, 内容哈希) 去重。
- **watch 轮询空闲退避**。轮询是 O(树) 的 walkDir + 逐文件 stat（本仓库实测 58–87ms），
  原来固定一轮、不管有没有改动都在磨 I/O。现在改成递归 `setTimeout`：无变化时翻倍
  退避到最长 2 分钟，任何变化立即回到 `watchInterval`。基准间隔同时 **15s → 30s**
  （仍可配置）。
- **删除死代码** `rankEntries` / `rankEntriesMerged` / `store.searchEntries`：它们每次调用
  都 `buildBm25` 全库分词（70k 条目实测 p50 1.4s），生产路径没有调用方；相关测试改用线上
  真正跑的 `rankEntriesStreaming` / `rankEntriesMergedScored`。

**存量 store 的压实是自动且有界的**：加载时把带派生字段的老分片放进待压实队列，此后任意一次
`save()`（watch 轮询、索引、写入都会触发）最多补写 `COMPACT_BATCH = 200` 个分片，直到队列
清空。升级后不需要重新索引，也不会在首次启动时一次性重写整库；想让它立刻跑完，随便索引一次
即可。为了让压实不产生副作用，IDF 缓存的失效键也从"任何脏写"改成 entries 的变更计数
（`_entriesVersion`）——IDF 只依赖 entries，只写经验/insight 或只做压实都不该重建它。

### 文档

- README 的 `npm test` 断言与实测对齐：360 → **476**（核心 184 → 205、host-contract 9 → 10；
  补上此前漏记的 task-view 6 / root-guards 79 / store-gitignore 9）；
- 两份 README 的"交叉链接"机制描述由"索引后挂载到条目"改为"读取期按当前符号表解算"；
- `watchInterval` 文档补充空闲退避语义；"紧凑性"一节改用实测区间（符号稀疏项目 ~0.5%，
  符号密集的 TS monorepo ~19%），不再把 0.5% 当普遍值。

## 0.5.10 (2026-09-24)

### 修复：共享临时目录仍然是可用的记忆根（issue #5 现场复核的补充发现）

@jinchaofeiyang 在 issue #5 的补充材料里指出 `isUnsafeRoot('/tmp')` 在 macOS 上返回 `false`：
`os.tmpdir()` 在 macOS 上是 `/var/folders/…/T` 这个**每用户私有**目录，共享的 `/tmp`
（→ `/private/tmp`）是**另一个路径**，0.5.9 之前不在名单里——于是 `cd /tmp && dsh` 仍会把整个
/tmp 当项目根全量扫描，与家目录是同一类问题。Windows 同理：`C:\Windows` 被拒，但
`C:\Windows\Temp` 是精确匹配之外的漏网路径。

- 每用户临时目录与**共享/系统**临时目录合并成"临时目录"一组：POSIX `/tmp`、`/var/tmp`、
  `/private/tmp`、`/private/var/tmp`、`/var/folders`、`/dev/shm`；Windows `%TEMP%`、`%TMP%`、
  `%SystemRoot%\Temp`、`%windir%\Temp`。仍是精确匹配——`/tmp/myproj` 这类子目录照常可用
  （插件自己的测试夹具就依赖这一点）。
- 拒绝文案据此区分"shared temp directory"与笼统的"system directory"。

### 新增：反直觉输入的回归测试（现场复核要求的第 1 点）

`/opt/homebrew` 是被 `VCS_MARKERS` 的 `.git` **主动选中**的（ARM Mac 的 Homebrew 是 git clone），
不是兜底误判。所以"拒绝前缀"必须能压过"合法项目标记"。`findProjectRoot` 现在支持注入
`isUnsafe` 判定，于是这条输入可以在任意平台上用一个临时目录复现：

- 控制组证明：只有 `.git` 时该目录确实会当选（否则这条用例什么都没测）；
- 加前缀拒绝后必须为 `null`，且上溯在边界处停止；
- 边界之外的兄弟项目不受影响。
- 另外用 `path.win32` / `path.posix` 模拟两个平台，把各自的临时目录与系统前缀断言在
  **任意 runner** 上（macOS 的 `/tmp` 缺口正是靠这个才可能在 ubuntu CI 上被发现）。

### 新增：store 目录自我忽略（不再需要用户改 `.gitignore`）

让用户手动把 `.dsh-project-memory/` 写进自己的 `.gitignore` 是个设计缺陷：忘了就是一次误提交，
而插件也不该去改用户的文件。现在 store 在自己目录里写一条 `*` 规则（`<store>/.gitignore`）——
git 会读取工作区里任意目录下的 `.gitignore`，`*` 连这个文件自己一起命中，于是 `git status` /
`git add -A` 里整棵树都不出现，用户零配置。老版本留下的 store 在第一次 `load()` 时自动补上。

- 顺带：被忽略的文件不会被 `git clean -fd` 删除（未跟踪且未忽略的会被删）。
- 想跟着仓库提交记忆：`git add -f .dsh-project-memory`（已跟踪的文件不受忽略规则影响）。
- 回归用例 `test/store-gitignore.test.mjs` 用真 git 仓库验证：store 不进 `git status`、用户的
  `.gitignore` 逐字不变、`git clean -fd` 后 store 仍在、重复保存不重写该文件、历史 store 首次
  `load()` 即补上。

### 文档（现场复核要求的第 2 点）

- README 把根策略写成参考文档口径：根解析顺序、排除名单、扫描上限（20000 文件 / 12 层；
  截断会在结果里说明，且不删除没扫到的条目），以及 store 的自我忽略。

## 0.5.9 (2026-09-24)

### 修复：issue #5 —— 在家目录 / `/opt/homebrew` 自动建索引把 DSH 撑到 OOM

三个根因叠加，缺一条都复现不出报告者的现象：

- **`findProjectRoot` 会把任意目录升格成项目根。** 旧实现有两条路：`looksLikeProjectRoot`
  只要目录里有 `lib`+`include` 之类的"源码目录名"就认（`/opt/homebrew` 正好命中），以及找不到
  任何标记时兜底返回 `path.dirname(filePath)`（读到家目录下的散文件就把家目录当根）。另外
  ARM Mac 的 Homebrew 是 `git clone` 到 `/opt/homebrew` 的——**那里有 `.git`**，所以单靠
  "只认项目标记"仍然会把整个 Homebrew 判成项目根，危险前缀必须显式列名单。
- **`.dsh-project-memory` 自己算项目标记，形成自我固化环。** `shadowLog` 默认开、每步写盘前
  `mkdirSync`，所以只要在家目录里启动过一次 dsh，该目录就被建出来；此后读家目录下任意文件都会
  把根解析回家目录，家目录被**永久**锁成"项目"（并写进 `watch.json`）。
- **扫描/索引全链路没有上限。** `walkDir` 同步把整棵树攒成一个数组；`index_repo` 攒完全部
  updates 才 commit 一次（峰值 = 整棵树的条目）；`DEFAULT_IGNORE` 不含 `Library`/`Documents`/
  `Cellar`；watch 每 15 秒把这一切重跑一遍。

修复：

- 新增 `isUnsafeRoot` / `assertSafeRoot` / `resolveSafeIndexRoot`：文件系统根、家目录及其**所有
  祖先**、共享临时目录、系统与包管理器前缀一律拒绝，且**按平台分组**（POSIX：`/opt/homebrew`、
  `/opt`、`/usr`、`/usr/local`、`/home/linuxbrew`、`/nix` …；Windows：`%SystemRoot%`、
  `%ProgramFiles%`、`%ProgramData%` …）——`C:\opt`/`C:\usr` 是 Windows 上的正常用户目录，
  套用 POSIX 名单既误伤又自相矛盾。判定是
  **精确匹配**：只拒绝这些目录本身，子目录照常可用（`~/Library/Mobile Documents/…/proj` 仍是合法项目根）。
- 所有会写盘/扫描的入口统一过这道关：`index_repo`、`watch_repo`、`index_doc`、`remember`/
  `forget`/`lesson`/`query_memory`/`memory_stats`/任务工具、watch 管理器、`autoIndexOnFirstUse`。
- **项目根推导收敛成 `util/fs.js` 里的唯一策略**，懒索引 / 会话审计 / TaskBridge / 所有工具
  用同一套顺序：显式 `root` → 显式登记的根（`watch_repo`）→ 最近的 VCS/清单标记 →
  **会话工作目录本身（只要它是安全目录）** → `null`。旧实现是"标记优先，找不到就兜底到文件
  所在目录"，且审计/工具侧直接用原始 cwd、懒索引用标记根，同一个会话会分裂成两个 store。
  现在"有没有标记"不再决定"能不能用"——只决定"这个根是声明的还是推定的"。没有标记的散目录
  仍然**不会**被升格：只有会话 cwd（人明确选择的工作位置）才有这个资格。
- **推定根会通告模型**：根来自无标记的会话工作目录时，首次注入前追加一行"记忆根 = X
  （无项目标记，按会话工作目录推定）；若要改，给 index_repo / watch_repo / remember /
  query_memory 传 `root: <dir>`，或在项目目录里重启 dsh"。每个会话一次，与常驻任务卡同类
  （状态声明，不占条目额度），`autoContext.rootNotice: false` 可关。
- 危险根里**自动路径零副作用**：懒索引不索引、auto-inject 不读 store 也不写审计（不再把
  `.dsh-project-memory` `mkdirSync` 进家目录）、TaskBridge 不建档不记文件；即使被显式调用的工具
  也会收到可执行的拒绝说明，只有新配置 `allowUnsafeRoots: true` 才放行显式调用。
- 有界化：`walkDir` 返回 `{files, truncated}` 并支持 `maxScanFiles`（默认 20000）/`maxScanDepth`
  （默认 12）；`index_repo` 每 200 个文件分批提交；**截断时不执行"删除本轮未见到条目"的清理**
  （没扫到 ≠ 被删除，否则一份被上限截断的树每轮都会自我清空一半）；`DEFAULT_IGNORE` 补入
  `Library`/`Applications`/`Cellar`/`Caskroom`/`Frameworks`/`DerivedData`/`Pods` 等。
- 自愈：`WatchManager.restorePersisted()` 用新判据剔除历史遗留的污染 watch root（家目录、
  `/opt/homebrew` 等），用户不需要手删 `watch.json`。
- 无项目的会话不再静默：`/tasks` 等命令给出明确说明，auto-inject 在 stderr 提示一次。

验证：新增 `test/root-guards.test.mjs`（69 项：判定与例外、**用 `path.win32` 在任意平台上
模拟验证 Windows 分支**、每个入口的拒绝、历史污染自愈、安全无标记 cwd 照常可用、推定根通告、
审计与懒索引用同一个根、截断不误删、auto-inject 静默）；
`test/run-test.mjs` 里依赖旧语义（启发式、兜底、temp ceiling）的断言改为新契约；
`injection-audit` / `injection-budget` 的夹具根补上项目标记，避免根通告混进它们的计数。
全量测试与 `npm run typecheck` 通过。

### 开发工具：typecheck 从「一直不可用」修到可跑，并接入 CI

- 根 `tsconfig.json` 的 `include: ["src/**/*"]` 在纯 JS 源码且未开 `allowJs` 时**匹配不到任何输入**，
  `tsc` 只会报 `TS18003`；`tsconfig.client.json` 也从未通过过（`.ts/.tsx` 后缀导入 `TS5097` ×13、
  CSS Modules 无声明 `TS2307`、`session-id.js` 无类型 `TS7016`、`catch (err)` 取 `.message` `TS2339`）。
  现在：根项目开 `allowJs`（`checkJs: false`，只做解析级校验），客户端项目开
  `allowImportingTsExtensions` + `allowJs`，并补 `src/client/css-modules.d.ts`；新增 `npm run typecheck`，
  CI 在 `npm test` 之前执行。**没有**重建 `client/client.js`：那处收窄是纯类型改动，产物逐字不变。

### 重构：步骤读取收敛为单一纯函数模块（无行为变更，含两处刻意的语义对齐）

- **同一套读取逻辑原先抄了 8 份，并且已经漂移。** `commands/tasks.js`、`commands/task-actions.js`、
  `tools/query-memory.js`、`tools/task-tools.js`、`tools/lesson-tools.js`、`setup/taskbridge.js`、
  `auto-inject.js`、`reflection-pipeline.js` 各自实现「取步骤文本 / 归一状态 / 数完成度」：取文本分裂成
  `content ?? text` 与 `content || text` 两种，状态归一分裂成三种（无校验 / `Set` 白名单 / 数组白名单）；
  此外还有 `timeAgo` ×2、`sessionIdOf` ×2、`textOf` ×2、`done/total` 内联 ×2。现在统一到
  `src/util/task-view.js`（`stepContent` / `stepStatus` / `stepProgress` / `timeAgo` / `sessionIdOf`），
  消息文本抽取并入 `src/util/text.js` 的 `textOf`。
- 两处刻意的语义决定（**不是笔误**，由 `test/task-view.test.mjs` 钉住）：
  1. `content` 为空串时**不再**回退 `text` —— 显式清空的步骤不该顶出旧文本；
  2. `/tasks todos` 收到字符串步骤时不再被静默过滤成「0 条」而清空步骤，改为按 `pending` 接受。
  非法 `status` 一律归一为 `pending`（宿主 `todo/write` 只认那三个合法值）。
- 验证：真实 store（28 任务 / 150 步骤）的状态取值本就只有三个合法值，所以归一化对现存数据零影响；
  `git stash` 前后各跑一次真实 `/tasks` 快照，输出逐字相同；全量 182 项测试与 `typecheck` 均通过。

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

未修的低优先级发现见当期的发布笔记。

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
- **Every published number re-measured on 2026-09-14** (Node 24.19): 5k-file cold index 269 ms avg (p50 267), cold load 40 ms, cached query over 20k entries p50 2.6 / p95 5.4 ms, hot single-file re-index p50 2.4 ms, 10k-file cold index 551 ms avg, cold load 90 ms, IDF rebuild 106 ms at 40k entries (57 ms at 20k, 12 ms at 4k), symbol scan 12.9–19.2 µs/file. Table captions now name the environment and the reproduce command; the real-project example quotes the warm-cache run and states the cold-cache first run (787 ms vs 253 ms) instead of hiding it. `README.md`, `README.zh-CN.md` and the local notes were updated together so no two documents quote different numbers.

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

- **`query_memory` now searches insights.** `type: 'insight'` was added, and `type: 'all'` appends an `## Insights (lessons / decisions / procedures)` section. Before this, lessons/decisions/procedures had **no retrieval path at all**: `util/search.js` had no insight ranker and the tool's `type` enum had no insight value, so a lesson could only reach an agent through silent injection. Verified against this repository's own store: the "public face" lesson now returns at score 100 for a natural-language query.
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

- **Single-read indexing — cold index ~4× faster**: every indexing path read each file twice (`await sha256OfFile()` for the hash, then `readFileSync()` for the body) and paid a per-file `async readFile` thread-pool round-trip. New `readFileForIndex()` does one synchronous read and hands the same buffer to both `createHash('sha256')` and `toString('utf8')`; `index_repo`, `watch`, and lazy read-on-observe all use it. Unchanged files are still hashed without decoding. Synthetic 5,000-file corpus (Node 24): cold index 1,093 ms → 272 ms (4.0×); the `read+hash` phase drops from 70% to 11% of the pipeline. Tests green.

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
- Design rationale, deviations (non-destructive migration; reflection triggers subset; auto-inject host verification) and the live-verification checklist live in the internal design notes.
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