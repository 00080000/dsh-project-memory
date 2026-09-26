# dsh-project-memory

> 如果这个插件帮你省下 1 小时 Debug 时间，请点个 Star。

[English](README.md) | [简体中文](README.zh-CN.md)

[![ci](https://github.com/00080000/dsh-project-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/00080000/dsh-project-memory/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![npm](https://img.shields.io/npm/v/@yolk_vat-y/dsh-project-memory)](https://www.npmjs.com/package/@yolk_vat-y/dsh-project-memory) [![npm downloads](https://img.shields.io/npm/dm/%40yolk_vat-y%2Fdsh-project-memory?style=flat-square&color=orange)](https://www.npmjs.com/package/@yolk_vat-y/dsh-project-memory) [![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/00080000/dsh-project-memory) [![Awesome](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)


A persistent **project development memory** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) agents. Built specifically for project development, natively integrated with dsh's task system: task lists and files read during a session are automatically persisted as cross-session task records, with tasks ↔ files linked — workflows can be switched and resumed, no need to re-scope the whole project, solving context loss. Documents (PDF/Markdown/txt) and code symbols are stored separately per workspace; documents are automatically cross-linked to the code symbols they mention. Experience notes (problem → solution) are automatically deduplicated, preventing repeated mistakes. All data is stored per project on disk, survives session compaction and handover; recalls include `path:line` citations for source verification. Only one dependency, no vector DB, no native builds.

> The plugin keeps a compact project **memory** on disk, with every entry pointing to a concrete file and line — the agent can reorient quickly instead of re-reading the whole project.

![Task panel: task list, step progress, and involved files](docs/images/image.png)

## Features

- **TaskBridge: cross-session development tasks** — the session's todo list and the files it touches are persisted as durable per-project task entities, so a workflow can be switched and resumed without re-scoping the project. Associated files are kept in recency-weighted order (a read never outranks a written file), so a resumed session sees where to look first. New sessions continue through `list_tasks` → `select_task`. Work delegated to subagents does not create tasks (see Known limits and boundaries). Auto-sync needs a dsh build with session events; on older hosts the task tools still work as a plain record list.
- **Task panel in dsh web (v0.4.2+)** — draggable cards show a task's steps and files, collapse to a mini-bar, or hide entirely. The panel stays hidden until summoned, syncs in the background on session switch, and does not reopen itself after a page refresh. Render errors are contained, so a panel failure cannot take down the host.
- **Panel editing and themes (v0.4.2+)** — bound cards allow inline editing of title and steps and status cycling; unbound cards are read-only. Four visual themes change material, geometry, typeface and density only; colours follow the host.
- **Bidirectional task-list sync (v0.4.2+)** — binding a task pushes its steps to the host task list, and panel edits write back through the same code path as model updates. Set `tasklist.syncHostOnAdopt` to false to opt out.
- **Document memory** — PDF, Markdown and plain text are chunked and summarized without a model call. Each entry keeps a short summary for injection, a bounded search-only term set built from the whole chunk so recall is not limited to the opening lines, and a citation back to the source.
- **Code symbol memory** — a dependency-free scanner extracts functions, classes, methods, interfaces and type aliases with full signatures across 8 languages, one line per declaration. Where `typescript` is installed, an optional second layer infers return types, resolves generics and extracts interfaces; it runs asynchronously, is cached by content hash, and never blocks indexing.
- **Automatic refresh** — a background poll detects new and changed files by content hash and re-memorizes only those.
- **Read-time memorization** — a file is memorized the moment the model reads it, so memory is a byproduct of normal work rather than a separate upfront scan. Files that are never read are never indexed.
- **Doc ↔ code cross-linking** — a document that mentions a symbol is surfaced when that symbol is queried.
- **BM25 recall** — ranked search over documents, symbols, experience notes and insights, with optional LLM query expansion. Tuned for CJK: phrase boost, a synonym table and CJK-aware boundaries for doc↔symbol linking.
- **Experience notes** — problems → solutions, deduplicated by overlap rather than repeated, bounded by project size, and returned only when a search matches.
- **Tiered insight memory (lessons / decisions / procedures, v0.5)** — one entity across task, project and global scope. Near-duplicates merge or reinforce; promotion moves an entry between scopes rather than copying it. Use is recorded, so decay and capacity rank by activity rather than by age alone. LLM reflection is off by default and writes task-level drafts only. The panel exposes a per-scope memory view for reviewing and editing entries.
- **Triggered injection** — an insight may carry an authored trigger: only `when` triggers, `guard` narrows it, and `prevents` records what breaks without the entry. Corpus text can never trigger an injection; the statistical channel is gated separately.
- **Streaming TF + IDF caching** — the query path caches term weights per store version (measured numbers under Performance). Only a real write drops the cache, so the watch poll never clears one a query just built.
- **Lock-free sync transactions** — all writes go through a synchronous transaction, so `remember` and `forget` never queue behind re-indexing. The lock is in-process: avoid pointing two dsh instances at the same store.
- **Minimal dependencies** — pure JavaScript; one runtime dependency for PDF text extraction, no native builds.
- **Negligible overhead** — memory work is in-process; the bottleneck is document extraction and disk I/O, not scoring.

## Installation

The plugin relies exclusively on stable public APIs (`defineTool`, `llm.stream`, `Schema`) declared via peerDependencies, ensuring compatibility with future rc/alpha releases without changes.

```bash
cd dsh-project-memory && dsh plugin --profile web add . -w
```

The `-w` (workspace-root) flag is required: the profile directory is a pnpm workspace root, and pnpm rejects `add` there without it. From any other directory, the path form works the same: `dsh plugin --profile web add /path/to/dsh-project-memory -w`.

The plugin is also published on npm as a scoped package:

```bash
dsh plugin --profile web add @yolk_vat-y/dsh-project-memory -w
```

A prebuilt tarball is published with each release, installable without a build step:

```bash
dsh plugin --profile web add /path/to/dsh-project-memory.tgz
```

Each indexed project has its own store at `<root>/.dsh-project-memory/`. Add it to `.gitignore` if it should not be committed.

## Usage

The tools below are **invoked by the agent**, not typed by the user. In the chat, just ask naturally — e.g. "index this project" or "what does the auth module do?" — or simply keep working, and the agent calls the matching tool automatically. By default (`lazyIndexing`) files are indexed the moment the model reads them, so memory fills in while you work. `watch_repo` keeps explicitly-watched roots fresh in the background; `index_repo` forces a full backfill of a project (unchanged files are skipped).

| Tool | Purpose |
|---|---|
| `index_doc file_path` | Index one document (PDF/MD/txt): chunk → deterministic `summary` + whole-chunk `terms` → store with `path:line`. Unchanged files are skipped. |
| `index_repo root` | Index a whole project: docs get deterministic summaries + whole-chunk terms, code files get a zero-token symbol table. Incremental, cleans up deleted files, cross-links docs to symbols. A root that does not exist — including a Windows-style path resolved on Linux/macOS — or one on the excluded list is rejected before anything is written. |
| `watch_repo root` | Enable automatic refresh: a background poll detects new/changed files (mtime + content hash) and re-indexes only those. Watched roots persist across plugin restarts; a non-existent or excluded root is refused, roots that disappear are dropped instead of being re-created, and entries that are no longer valid roots are dropped on startup. |
| `memory_stats root` | Show what the store contains: totals (files / entries / experience notes), last index time, and the per-file list sorted by recency. |
| `query_memory query` | BM25 search over docs + symbols + experience + insights (lessons / decisions / procedures), optionally query-expanded by the LLM. `type` selects a layer (`all` / `doc` / `symbol` / `experience` / `insight` / `task`). Returns ranked hits with relative scores, sources or insight ids, and doc→symbol references. |
| `list_tasks` | List task records for the project (archived marked). Call first in a new session before continuing work. |
| `select_task` | Bind the session to a task so its todo list and file reads sync into it. Exact `taskId`, or exact `title` (multiple matches return candidates; no match creates a new task). Pass `title` with `taskId` to rename. Auto-unarchives. |
| `archive_task` | Archive a task (hide from default views, exclude from capacity, stop syncing). `select_task` restores it. |
| `show_task_panel` | Show the task panel in the UI. Call when the user asks to see the task list or when you want to display the panel. |
| `/tasks` (typed by the user, not the model) | The only user command: shows the task stack (title, step progress, involved files, current session binding) and drives the workflow card. Every other action is a **sub-verb** invoked by card buttons, never typed: `/tasks switch` / `archive` / `unbind` / `rename` / `todos …` (task actions), `/tasks insight list` / `confirm` / `promote` / `demote` / `archive` / `restore` / `delete` / `save` / `edit …` (memory actions). |
| `remember problem solution` | Save an experience note. Similar problems supersede instead of duplicating. |
| `forget id_or_query` | Delete stale experience notes. |
| `save_lesson` (agent tool) | Save a lesson/decision/procedure at task/project/global scope (single insight entity). Near-duplicates merge (≥ 0.7 overlap) or reinforce (0.65–0.7); 2+ tasks hitting the same insight auto-promote task → project, 3+ → global. Params: `title`, `kind`, `scope`, `pattern`/`fix` or `choice`/`reason` or `steps`, `trigger` (`when` = `ops`/`writes`/`intents`, the only trigger surface; `guard` = `paths`/`not_paths`/`hosts`/`tags`, narrowing only; `prevents` = what breaks without it; legacy `keywords`/`symbols`/`actions`/`paths`/`scope` still accepted and auto-migrated), `task_id`, `files`, `symbols`, `confidence`, `root`. |

`/tasks` appears in the web `/` menu inside an icon-bearing **Workflow** group, offering three view
entries — Tasks / Project Memory / Global Memory (labelled in the UI language). A host command always
shows up in the built-in **Commands** section and a plugin cannot hide it (`commands.list()` and
`commands.execute()` read the same view, and `CommandDefinition` has no hidden flag), so the plugin
registers **only `/tasks`** and every other action rides it as a sub-verb driven by card buttons: the
menu duplication is one row. Typing `/tasks` + Enter still executes immediately; typing an argued line
such as `/tasks switch x` is no longer recognised as a command — use the card buttons.

## How it works

The design follows four principles:

- **Volatility** — context is ephemeral; it is lost when a session is compacted.
- **Persistence** — the **memory** is stored on disk and survives compaction and new sessions.
- **Compactness** — the code layer stores one bounded declaration line per symbol (≤200 chars) and the document layer keeps a ≤300-char `summary` plus a bounded `terms` set per chunk. **Derived data is never stored**: doc→symbol links and the BM25 `searchText` are computed at read time. How small the index ends up depends on symbol density and chunk length, so treat these as measurements of specific corpora (2026-09-25), not as guarantees: a code-only Vue app (289 files) lands at **325 bytes/entry ≈ 21% of source**, while a symbol-dense TypeScript monorepo (12,408 files / 106 MB of code + 14 MB of docs) measures **22% of source for the code layer (553 bytes/entry overall)** and **130% for the document layer**. Doc-heavy corpora are the largest per entry: a 274-document workspace (PDFs and Markdown) stores **1,506 bytes/entry**.
- **Verifiability** — **recalls** carry a `path:line` citation where applicable, so the agent can confirm details against the source.

Building the **memory** does not require an upfront scan: files are memorized as the model reads them, so the **memory** grows to cover exactly what has been worked with. Re-reading a file that has not changed is a no-op (content hash), so the **memory** stays fresh with minimal ongoing overhead.

The store is per-project and follows the codebase: changed files are re-extracted by content hash, deleted files are removed. Experience notes are retrieval-only, so accumulation does not affect context.

## Design

```
.dsh-project-memory/
  format.json      layout marker (v2, sharded)
  shards/          one self-describing JSON per indexed source file
                    ({ relPath, record, entries }) — writes touch only dirty shards
  experience.json  problem → solution notes (retrieval-only)
  watch.json       watched roots
  tasks.json       TaskBridge task entities (cross-session)
  binding.json     current session ↔ task binding
  insights.json    v0.5 project-scope insights (lessons/decisions/procedures); v0.4 experience notes imported once, non-destructively
  injection-audit.jsonl   one line per real injection (what / why / dropped / budget)
  admission-shadow.jsonl  one line **per step**, all scored candidates + features (offline replay, labels)
```

Stores created before v0.2.0 (single `entries.json` / `index.json`) migrate automatically and idempotently on first load. Within one dsh process, all tool calls share a single in-memory store per project, so hot-path indexing writes only the shard that changed.

- **Incremental** — content hash per file; only changed files are re-extracted.
- **Cross-linking** — when `query_memory` returns a doc chunk, it resolves the symbols that chunk mentions against the **current** symbol table and appends them as `references`. Links are computed at read time, so they cannot go stale and are not stored in the index (a doc indexed before its symbols still links correctly).
- **Query expansion** — when `llmQueryExpansion` is on, `query_memory` asks `ctx.llm` to rewrite the query into several variants (synonyms, EN/CN, identifier guesses) and merges BM25 scores across variants; when off, queries never touch the LLM. Indexing itself is model-free: keywords are rule-derived (title-weighted top terms), and doc↔symbol links surface English symbol names from Chinese hits.
- **Consistency** — the fact layer follows the codebase (hash re-extract / remove-on-delete); the experience layer is retrieval-only with supersede and `forget`. Store writes are serialized per memory directory; the lock is in-process, so avoid running multiple dsh instances against the same project store concurrently.

## Architecture (Task Panel)

```
TaskPanel (Container)
├── task-data-store  (server data, cross-tab sync via BroadcastChannel)
├── task-ui-store    (local UI state, localStorage)
├── task-hooks       (useTaskDrag, useTaskEdit)
└── TaskComponents   (MiniBar, TaskCard — presentational only)
```

The workflow panel is collapsible, automatically adapts to dsh and theme plugin styles, and offers four card style options to switch between.

![Four card styles](docs/images/image-4.png)

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `memoryDir` | `.dsh-project-memory` | store directory inside each indexed root |
| `chunkChars` | 3000 | max chars per document chunk |
| `maxChunksPerFile` | 40 | max chunks per document |
| `maxFileSizeMb` | 50 | skip documents (incl. PDF) and code files larger than this (MB) |
| `maxOutputChars` | 8000 | cap for `query_memory` result text (chars) |
| `tasklist.enabled` | true | enable TaskBridge auto-sync (task entities from the session todo list and file reads) |
| `tasklist.syncHostOnAdopt` | true | when `select_task`/`/task switch` binds a task, push its steps to host `todo/write` so dsh's task list mirrors the task |
| `maxPdfPages` | 1000 | PDF page cap when pages are not otherwise limited |
| `llmQueryExpansion` | false | expand queries via `ctx.llm` before BM25 (off by default to save tokens) |
| `expansionCount` | 6 | max expansion variants |
| `lazyIndexing` | true | index files the moment the model reads them (`fs/observed`) |
| `autoIndexOnFirstUse` | false | full scan of the current working directory on plugin load (opt-in) |
| `watch` | true | enable the background refresh |
| `watchInterval` | 30 | base poll interval (seconds); idle polls back off up to 2 minutes and reset to this value on any change |
| `maxScanFiles` | 20000 | hard cap on files per scan pass; a truncated pass is reported and does not remove the entries it did not reach. Set `0` to disable the cap |
| `maxScanDepth` | 12 | hard cap on directory depth per scan pass. Set `0` to disable |
| `allowUnsafeRoots` | false | allow **explicit** tool calls (`index_repo`/`watch_repo`/`remember` with a `root`) to target a directory on the excluded list. Automatic paths (lazy indexing, session audit, TaskBridge, `autoIndexOnFirstUse`) stay inert in these directories regardless |
| `tsPath` | (auto) | optional absolute path to a specific `typescript` install; if omitted, resolves from project cwd → plugin node_modules |
| `enableTypeScript` | true | set `false` to disable L2 TS enhancement entirely (L1 regex only) |

### Memory and injection knobs

| 键 | 默认值 | 含义 |
|---|---|---|
| `insight.*` | dedupOverlap `0.7` · reinforceBand `0.65` · maxProject `100` · maxGlobalProcedures `200` · promoteConfidence `0.7` · globalPromoteTasks `3` · decayDays `90` · `globalFile` (auto) | v0.5 insight dedupe / reinforce / promotion / capacity / archive settings |
| `reflection.enabled` | false | v0.5 LLM reflection, **draft-only at task level** (fires on task switch-away / archive). `cooldownMs` `1800000`, `maxLessonsPerReflect` `3`, `maxDecisionsPerReflect` `2` |
| `autoContext.enabled` | true | silent injection wrapper (resident task card + gated items). Inert (full passthrough) until the host exposes a resolvable session cwd; `maxTokens` `400`, `editedMax` `3` (how many recently-written "editing now" files the resident task card shows), `signalMinRatio` `0.5` (a hint must reach half of its layer's top score), `skipEchoSelfTodo` `true` (don't echo the task card back when the model itself maintains the task list with no newer human message; relevant insights still inject), `budgetLog` `off` (budget-drop audit on stderr: `off` silent / `once` at most one line per session / `all` one line per changed dropped set), `reinjectItemsAfter` `0` (cooldown, in pre-steps, before the same insight may be injected again), `rootNotice` `true` (when the memory root is inferred from a marker-less working directory, tell the model once where memory lives and how to change it) |
| `autoContext.gateCooldownSteps` | 2 | **admission knobs.** Minimum number of pre-steps between two *item* injections (the resident task card is exempt — it is a state snapshot and should update when it changes). This is the main "don't inject often" dial |
| `autoContext.maxItemsPerSession` | 12 | hard per-session cap on injected items; the budget is a ceiling, not a target — once exhausted the item channel stays silent |
| `autoContext.maxItemCharsPerSession` | 4000 | same, in characters |
| `autoContext.hintMinCoverage` | 0.45 | **absolute** floor for the statistical (hint) channel: IDF-weighted share of the query's information mass the entry covers. A ratio-only threshold cannot tell signal from "best of a bad lot" (`relative:1.00` on an unrelated entry). Raised from 0.30 in 0.5.8: on a real 43-entry store the control scenario injected 3 unrelated hints at cov 0.32–0.35, because a same-corpus store flattens IDF |
| `autoContext.hintMinMatched` | 2 | a hint must share at least this many terms with the query — one generic word ("plugin") is not evidence |
| `autoContext.hintMinSupport` | 0.15 | channel-level silence: if less than this share of the query's terms exist anywhere in the corpus, the hint channel says nothing this round — a long sentence that happens to share one word otherwise reports `cov:1.00` |
| `autoContext.legacyScope` | `filter` | how to treat a legacy `trigger.scope`: `filter` keeps the old semantics, `ignore` drops it. `npm run selfcheck:triggers` reports entries whose scope values cannot intersect the project tag space |
| `autoContext.auditLog` | true | append one JSONL line per **actual** injection to `<root>/.dsh-project-memory/injection-audit.jsonl` (what was injected, why it matched, what was dropped, session budget snapshot); rotates to `.1` past `auditMaxBytes` (`262144`). Silent on any I/O error — never affects the host request |
| `autoContext.shadowLog` | true | append one JSONL line **per step** (including steps that injected nothing) to `admission-shadow.jsonl`: every scored candidate with its judgement features (`rel` / `coverage` / `matched` / `support` / `terms` / `decision`) plus the step's `query` / `ops` / `writes`. This is what makes a threshold change answerable offline on real history (`decision` shows which gate rejected each candidate). Rotates past `shadowMaxBytes` (`2097152`). Disk only — never enters the prompt, costs no tokens |
| `autoContext.shadowMaxBytes` | 2097152 | rotation cap for `admission-shadow.jsonl` |

### Injection admission (why it stays quiet)

Automatic injection used to be a *retrieval* problem ("which entry is most related to this text?"), which is total — a ranking always returns something, so noise was structural. It is now an **admission** problem ("is this step about to cross a boundary I have been burned by?"), with silence as the default:

- **Only `when` triggers**, and it is a low-dimensional typed signal: normalized `ops`, the files this step is about to **write**, and intent words from the human message *after* stripping quoted/path references. Corpus text — raw tool arguments, file contents, filenames — can never trigger anything.
- **`guard` only narrows.** Extension/name globs (`*.pptx`, `README*`) are ignored outright: they can only lie, never narrow.
- **Ratio *plus* an absolute floor.** The hint channel needs the relative score *and* an IDF-weighted coverage floor *and* at least two shared terms — `relative:1.00` also happens on entries that share nothing with the step.
- **Frequency is bounded.** At most one item injection every `gateCooldownSteps`, capped per session by count and characters. The resident task card is exempt (it is a snapshot that should update); the budget is a ceiling, not a target.
- **Prefix-cache discipline.** Injections are appended as a user message at the tail of the history, so the cached prefix is never rewritten. What they add is resident *cache-read* tokens, not cache misses; nothing is ever edited in place.
- **It is auditable.** Every real injection appends one line to `injection-audit.jsonl` (reason, dropped candidates, session budget), and `admission-shadow.jsonl` adds one line **per step** — including the steps that correctly injected nothing — with every candidate's features and the gate that rejected it. That second file is what makes a threshold question answerable offline instead of by re-running the agent. `npm run eval:injection` scores 8 labelled scenarios on a **synthetic** pool — currently precision 1.00 / recall 1.00 with a clean control group. That pool is the CI baseline, not evidence about your data: point the same harness at your own store and the control group becomes a **hard gate** (`--store`, exits non-zero on violation). That is how the 0.45 floor was chosen, and how you can re-choose it (`--hint-cov <n>` replays at another floor).

### Toggling features

The two most relevant switches are `lazyIndexing` (index a file the moment the model reads it; default on) and `autoIndexOnFirstUse` (full scan of the current working directory on plugin load; default off). Lazily indexed project roots are automatically registered with the watcher, so changed files stay fresh without an explicit `watch_repo`.

**Root resolution.** In order: an explicit `root` argument; a registered root (`watch_repo`); the nearest ancestor with a VCS marker (`.git`/`.hg`/`.svn`) or a build/manifest marker (`package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, …); the session working directory, unless it is on the excluded list. A file that matches none of these is not indexed.

When the root comes from the working directory, the model gets one notice per session naming it and how to change it; mute with `autoContext.rootNotice: false`. Starting dsh in a container directory such as `~/workspace` therefore makes that directory the root, and memory spans everything beneath it up to the scan limit — start dsh inside the project for one store per project.

**Excluded directories.** Not used as a root, matched exactly (subdirectories are unaffected): the filesystem root, the home directory, temp directories — `os.tmpdir()` and the shared ones (`/tmp`, `/var/tmp`, `%TEMP%`, `%SystemRoot%\Temp`) — and system / package-manager prefixes (`/opt/homebrew` on POSIX; `%SystemRoot%`, `%ProgramFiles%`, `%ProgramData%` on Windows). A session in one of these runs without memory, with one line on stderr.

**Scan limits.** One pass covers at most `maxScanFiles` files (20000) and `maxScanDepth` directory levels (12). A truncated pass is reported in the `index_repo` result and logged once per root by the watcher, and it does not remove entries it did not reach. Raise both for a larger tree.

The store lives in the tree it indexes and **ignores itself**: it writes a `*` rule into its own `<store>/.gitignore`, which git honours for any directory, so nothing shows up in `git status` or `git add -A` and you have nothing to add to your own `.gitignore`. (It also means `git clean -fd` leaves the store alone.) To commit project memory deliberately, `git add -f .dsh-project-memory` — tracked files are not affected by ignore rules.

Settings live in the plugin's config object. To change them, add an override entry to your profile's `cordis.patch.yml` — for the web profile that is `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: project-memory
  config:
    lazyIndexing: true          # on: index files as the model reads them (default)
    autoIndexOnFirstUse: false  # off: no upfront full scan (default)
    llmQueryExpansion: false    # off: do not spend tokens on LLM query expansion (default)
    watch: true                 # on: background refresh for watched roots (default)
    watchInterval: 30           # base poll interval; idle polls back off to at most 2 min
    maxScanFiles: 20000         # per-scan file cap (truncation is reported, never deletes)
    maxScanDepth: 12            # per-scan directory-depth cap
    enableTypeScript: true      # on: L2 TS enhancement when TS is installed (default)
    # allowUnsafeRoots: false   # keep false unless you really want to index a home/system dir explicitly
    # budgetLog: once           # debugging: log budget drops to stderr (default off = silent)
    # reinjectItemsAfter: 20    # debugging: allow the same insight again after N steps (default 0 = once per session)
    # tsPath: /custom/path/to/typescript  # optional: force specific TS install
```

Only list the keys you want to change; the rest fall back to the plugin defaults. Verify the result with `dsh --profile web --dump-config`.

For a one-off run without editing the profile, pass the override as a CLI patch overlay:

```bash
dsh web --patch ./config.yml
```

where `config.yml` contains the same override block.

## Performance

### Measured on real projects (2026-09-25)

Four corpora, one machine (Node 24.19, 20 vCPU, Linux file system), each run twice with the **second, warm-cache run** quoted. "Cold index" is a full index pass (walk + sha256 + extract + commit); "query" runs the shipped scorer over 100 sampled queries; "re-index 1 file" is the watch/lazy hot path.

| Corpus | Files / entries | Cold index | Cold load | Query p50 / p95 | Re-index 1 file | Store content / on disk | Heap after load |
|--------|-----------------|-----------|-----------|-----------------|-----------------|------------------------|-----------------|
| Vue 3 + Vite app (code only) | 289 / 2,142 | 283 ms | 5.2 ms | 0.86 / 1.8 ms | 0.4 ms | 0.66 MB / 1.52 MB | 6.1 MB |
| Docs + PDFs workspace (274 docs) | 286 / 2,120 | 6.5 s | 12.4 ms | 4.6 / 13.9 ms | 0.4 ms | 3.05 MB / 3.63 MB | 9.0 MB |
| TypeScript monorepo, 3,000-file slice | 3,000 / 17,733 | 2.1 s | 59 ms | 10.2 / 21.4 ms | 1.8 ms | 11.0 MB / 19.0 MB | 22.6 MB |
| TypeScript monorepo, whole tree | 12,408 / 79,168 | 8.6 s | 239 ms | 45.8 / 89.3 ms | 7.4 ms | 41.7 MB / 74.7 MB | 73.9 MB |

**How it scales.** Re-indexing a changed file costs O(file), not O(corpus) — 0.4–7.4 ms across every corpus above. Cold load (≈19 µs/file), query (≈0.6 µs/entry) and resident heap (≈1.4 KB/entry once the first query materializes `searchText`) grow linearly with the index, which keeps small and mid-size projects in the single-digit-millisecond range.

> Two notes on method: `read+hash` depends on the OS page cache (2.5 s cold vs 0.3 s warm on the 12.4k-file tree), so the warm run is the one quoted; and this benchmark drifts by up to ~20% across days on the same machine, so compare numbers measured in the same session.

### Synthetic Benchmark (Node 24.19, 20 vCPU, Linux file system)

| Scenario | Scale | Measured |
|----------|-------|----------|
| Full cold index | 5,000 files / 20k entries | 373 ms avg (p50 374) |
| Cold load | 5,000 files | 56 ms |
| Hot lazy re-index (single file) | 5k files | p50 2.8 ms / max 3.5 ms |
| query_memory (cached) | 5k files / 20k entries | p50 3.3 ms / p95 6.9 ms |
| query_memory (cached) | 1k files / 4k entries | p50 0.7 ms / p95 1.5 ms |
| Full cold index | 10,000 files / 40k entries | 696 ms avg (p50 668) |
| Cold load | 10,000 files | 123 ms |
| Hot lazy re-index (single file) | 10k files | p50 5.9 ms / max 13.5 ms |

> Synthetic benchmark: generated code (~4–5 symbols/file), Node 24.19 on 20 vCPU / Linux file system, measured 2026-09-25. Reproduce with `npm run bench:synthetic -- 5000` (harness: `scripts/bench-synthetic.mjs`). Measures pure indexing overhead without LLM calls. query_memory uses the IDF cache + searchText materialized on first use; the first query after a write rebuilds IDF (**142 ms at 40k entries**, 67 ms at 20k, 14 ms at 4k), subsequent queries hit the cache.

### Reproduce it on your own project

Rather than asking you to trust the numbers above, the measurement itself ships with the repository **and with the published npm package** (`scripts/` is part of the tarball). It needs **no dsh instance, no network and no model calls**, and it never touches your project's own store — results go to a temp directory and are removed when it finishes:

```bash
npm run bench -- /path/to/your/project
# or, with options:
node scripts/bench.mjs /path/to/your/project [--json] [--samples 100] [--no-pdf] [--keep]
```

It reports the cold index split into read+hash / extract / commit, cold load, IDF rebuild, cold and hot query latency (p50/p95/max over 100 sampled queries through the shipped scorer), single-file hot re-index, store content vs on-disk size, resident heap (after load and after the first query), bytes per entry and RSS. Example — the Vue app row above:

```
cold index   283 ms   (read+hash 11 ms · extract 256 ms · commit 14 ms)   ← 2nd, warm-cache run
store        0.66 MB content · 1.52 MB on disk · 325 bytes/entry · cold load 5.2 ms
memory       heap 6.1 MB after load → 6.7 MB after the first query (RSS 62 MB)
hot query    p50 0.86 ms · p95 1.8 ms          (2,142 entries)
re-index 1 file  p50 0.4 ms
```

Pass `--queries your-queries.json` to run the labeled-set method (hit@5 / hit@10 / MRR) against your own project.

## Design tradeoffs

- **Synchronous lock-free transactions over async locks** — no async mutexes, file locks, or multi-process coordination: DSH runs on Cordis and single-process is an architectural given, so locking for a rare multi-process case would only slow the hot path (every `remember`/`forget`/`index_doc`); synchronous transactions keep that path at ~2 ms median with zero contention.
- **Watch: compute outside, commit inside** — no lock is held during parsing and `fs.watch` is not used: parsing and PDF extraction are slow, so a held lock would block queries, while polling with mtime + content hash behaves identically on network drives, Docker volumes, and WSL, with none of `fs.watch`'s duplicate-trigger/missed-event failure modes.
- **Corrupt shards are quarantined, not repaired** — a shard that fails to parse is renamed `*.corrupt` and only that file is re-indexed, leaving every other shard untouched; no WAL or embedded database: those add 500 KB+ of native dependencies, lock contention, and a new failure mode (a corrupt WAL) to avoid losing a single file's index.
- **No vector embeddings, no semantic search at query time** — no embedding model, vector index (HNSW/IVF), or reranker: lexical retrieval already answers the queries this plugin targets. On a real Vue project with 29 labelled queries, file-level hit@5 is **96.6%**; whole-chunk `terms` lift document term coverage from **27.3% to 100%** with MRR unchanged (**0.958** vs **0.955**). The marginal gain does not justify 10x the complexity, and the method ships with the code — `scripts/bench.mjs --queries your-queries.json` reproduces the same measurement on your own project.
- **Indexing is deterministic and model-free** — no model at index time and no translation at query time: the former makes two indexings of one document differ, the latter has a hard failure mode (a wrong translation means zero recall); rules plus symbol links already cover the common cases and work offline.
- **Model-facing memory: the agent writes, no human in the loop** — no human approval step: the consumer of this memory is the agent, and agents are usually headless, so memory that only promotes when someone clicks a card would never promote at all. `draft` is a provenance marker plus an evidence threshold, not an approval queue — the one inferring writer, `reflection` (off by default), writes task-level drafts only, and drafts never reach recall or injection.
- **Full entries returned directly** — no "minimal index first, fetch details in a second call": entries are already compact, so returning them whole is both more verifiable and one round-trip cheaper.
- **`forget` by query is aggressive; use IDs for precision** — no confirmation prompt, recycle bin, or exact-match-only mode: experience notes are low-risk, high-volume, and retrieval-only, so stale noise hurts more than an over-broad delete. For exact deletion use the ID shown by `query_memory`.
- **TypeScript enhancement is optional, lazy, and cached** — the L2 TS Compiler API runs asynchronously on a priority queue (P0 `fs/observed`, P1 `watch`, P2 `index_repo`) and caches results by content hash; TS is never required and enhancement never blocks: requiring it would make non-TS projects uninstallable, and blocking would stall `index_repo` on large projects. `npm i -D typescript@5|6` is the entire setup, and a missing TS falls back to the L1 regex scanner. The **default lib is not loaded** (`noLib`): inference that depends on global types (`Promise`/`Array`/DOM) degrades to `any`/`unknown`, while explicitly annotated types are unaffected.
- **Subagent sessions are out of scope for now**

## Development (for contributors)

These commands are for **maintaining the plugin code** — regular users do not need them. Installing the plugin only requires the command in [Installation](#installation).

```bash
npm install
npm test                    # 539 tests (214 core + 16 TaskBridge + 12 insight-store + 9 insight-actions + 8 doc-index + 7 auto-inject + 10 host-contract + 5 reflection + 4 llm-route + 2 client-hints + 10 recall + 14 readiness + 7 insight-derive + 7 readiness-eval + 6 ops + 11 injection-audit + 5 injection-budget + 6 injection-scenarios + 18 bugfix-0.5.7 + 3 client-icons + 10 client-slash + 5 workflow-command + 7 client-session-id + 6 task-view + 79 root-guards + 9 store-gitignore + 22 store-cache + 27 enhancer)
npm run eval:injection      # scenario P/R on the synthetic pool: 14/14 hits, 0 false positives, control group clean
npm run eval:injection -- --store .dsh-project-memory/insights.json   # replay on YOUR store; control group is a hard gate
npm run selfcheck:triggers  # which entries can still push, which declarations are dead (reads your local store)
npm run bench -- /path/to/project   # index/query performance on any project — no dsh needed
```

Release notes live in [`CHANGELOG.md`](CHANGELOG.md) and on [GitHub Releases](https://github.com/00080000/dsh-project-memory/releases).

## License

MIT — see [`LICENSE`](LICENSE).

Copyright (c) 2026 00080000 &lt;3388065969@qq.com&gt;