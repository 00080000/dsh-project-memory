# 待办 / 已知瓶颈

Done items → CHANGELOG.

## Near-term (v0.3.x)

- [x] **C1: CJK Retrieval Enhancement** — phrase boost, synonyms, link boundaries
- [x] **C2: doc↔symbol CJK Precision** — with C1
- [x] **B2: Supersede Threshold** — bidirectional 0.7 overlap
- [x] **B3: Long-tail Query Recall** — experience `problem` phrase boost
- [x] **D-1: pdfjs-dist Lazy Load** — module-level lazy init
- [x] **L1 Enhanced Regex** — generics, params, return types, overloads, interface/type alias (v0.3.3)
- [x] **L2 TS Compiler API** — inference, generics instantiation, implicit returns (v0.3.2)
- [x] **L3 Disk Cache** — type-cache/ keyed by content hash (v0.3.2)
- [x] **Symbol Layer Refactor** — one-line identity `fn(a:A,b:B):R — file.ts:42`, no `summary`/`sig` (v0.3.3)
- [x] **Doc Layer Refactor** — blindSpots, hash, answer-level summary (v0.3.3)
- [x] **Doc retrieval: blindSpots-aware logic in query_memory** (v0.3.3)

## Completed v0.4.x (TaskBridge + TaskPanel)

- [x] **TaskBridge** — cross-session task entity via `session/event` subscription (todo/write + tool/call), tools list_tasks/select_task/archive_task, `/tasks` command (v0.4.0)
- [x] **TaskPanel rewrite** — real dsh web contract (cordis inject + shell.overlay), floating drag-expand-collapse, mini-bar, hide-on-startup (v0.4.2)
- [x] **Bidirectional task list sync** — select_task → host todo/write, panel edits ↔ host todo_write, `/task` switch/archive/unbind/rename/todos (v0.4.2)
- [x] **Task store refactor** — data/UI separation, BroadcastChannel cross-tab sync, explicit open via `/tasks` or tool (v0.4.4)

## Completed v0.5.x (Tiered Insight Memory + Silent Injection)

- [x] **Tiered Insight Memory** — task/project/global scopes, single entity, bidirectional token-overlap dedupe (≥0.7 merge, 0.65~0.7 reinforce), auto-promotion (2 tasks→project, 3+→global), soft archive + decay + overflow prune, secret filter, non-destructive migration from experience.json (v0.5.0)
- [x] **Reflection Pipeline** — optional LLM reflection on task switch-away/archive, cooldown + content-digest gating, silent failure, writes task-level drafts only (v0.5.0)
- [x] **Silent Injection Engine** — agent/pre-step seam, relevance-gated, project-profile tags, scope-tags filter for global procedures, fingerprint dedupe (60s), inert on error (v0.5.0)
- [x] **TaskPanel Memory Views** — Task/Project/Global tabs, inline insights on task cards, `/insight` command with actions (confirm/promote/demote/archive/restore/delete/edit/create) (v0.5.0)
- [x] **Silent Injection crash fixes** — agent/pre-step signature fix, message source.kind fix, both paths inert on error (v0.5.1)
- [x] **TaskPanel editing UX** — click vs double-click discrimination (~250ms), auto-growing textareas, pre-wrap step rendering (v0.5.1)

## Mid-term (Trigger-based)

- **Async I/O / Cold Start** — if hot path >5ms or cold start >100ms

## On Hold (Await User Feedback)

- tree-sitter AST parsing (optional plugin)
- Multi-line signatures for remaining languages
- Symbol scanner edge cases

## Candidates (v0.6.0+)

- Dictionary max-match (50KB vocab)
- Experience SimHash dedup
- Symbol link kind weights