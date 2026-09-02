# dsh-project-memory

[English](README.md) | [简体中文](README.zh-CN.md)

[![ci](https://github.com/00080000/dsh-project-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/00080000/dsh-project-memory/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![npm](https://img.shields.io/npm/v/@yolk_vat-y/dsh-project-memory)](https://www.npmjs.com/package/@yolk_vat-y/dsh-project-memory) [![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/00080000/dsh-project-memory) [![Awesome](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

Persistent project memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh) agents. **Memorizes** documents (PDF / Markdown / txt) and code symbols into a per-workspace store, refreshes them automatically, and **recalls** them with source citations — documents are cross-linked to the code symbols they reference.

> The plugin keeps a compact project **memory** on disk, with every entry pointing to a concrete file and line — the agent can reorient quickly instead of re-reading the whole project.

## Features

- **Document memorization** — PDF, Markdown, and plain text files are chunked and summarized by the LLM; each entry carries a `path:line` citation back to the source.
- **Code symbol memory** — function, class, and method names with full type signatures (generics, parameters, return types, overloads) are extracted by a dependency-free source scanner (string/comment masking, multi-line signature joining, indentation-aware Python, class-method context), without LLM token usage.
- **L1 Enhanced Regex** — zero-dep regex scanner now extracts generics, parameter/return types, overloads, interfaces, and type aliases for all supported languages, producing one-line identity signatures `fn(a: A, b: B): R — file.ts:42`.
- **Optional TypeScript semantic enhancement (L2/L3)** — when `typescript` is installed in the user project (`npm i -D typescript`), the plugin automatically activates a second layer (L2) that uses the TS Compiler API to infer return types, resolve generics, extract interfaces and type aliases, and enrich arrow functions — all asynchronously in a priority queue (P0 on `fs/observed`, P1 on `watch`, P2 on `index_repo`). Results are cached on disk keyed by file content hash (L3) for instant cold-start reuse. Zero config: just install TS and restart dsh. Fully optional; if TS is absent or disabled via `enableTypeScript: false`, the plugin falls back to L1 regex-only extraction.
- **Automatic refresh** — a background poll (`watch_repo`) detects new or changed files by content hash and re-memorizes only those.
- **Read-time memorization** — files are memorized the moment the model actually reads them (`fs/observed`), so the memory is a byproduct of normal work, not a separate upfront scan. Files that are never read are never indexed. The project root is detected by markers (`.git`, `package.json`, …), a README plus source directories, or the file's own directory as a last resort.
- **Doc ↔ code cross-linking** — when a document mentions a symbol, the match is recorded as a `reference`; querying a symbol also surfaces the documents that describe it.
- **BM25 memory recall** — ranked search over documents, symbols, and experience notes, with optional LLM query expansion to handle vocabulary mismatch. **CJK-optimized**: precise phrase boost (3+ char phrases ×1.5 score on title/keywords match), synonym table (e.g. 数据库连接池 ↔ 连接池 ↔ DB pool), and CJK-aware word boundaries for doc↔symbol linking.
- **blindSpots-aware recall** — document summaries carry a `blindSpots` field (what the summary explicitly does NOT cover). When a query hits a blind spot, `query_memory` appends a warning pointing the model to read the source file, preventing hallucination from partial summaries.
- **Experience notes** — problems → solutions; similar problems supersede instead of duplicating, and notes are returned only when a search matches. The note store is bounded: capacity scales with project size (clamped to 100–2000), and the oldest notes are pruned when the limit is exceeded. **Supersede tightened to bidirectional 0.7 overlap** (was 0.6); **experience `problem` field now participates in CJK phrase boost** for long-tail query recall.
- **Streaming TF + IDF caching** — query path caches IDF (term inverse frequency) per store version; on cache hit, single-pass streaming scores 20k entries in ~8 ms (5k files) / ~1 ms (1k files) with zero intermediate objects; write path is O(1) version bump.
- **Lock-free sync transactions** — all writes (index / watch / remember / forget / watch_repo) go through synchronous transactions `store.commit(fn)`; fn succeeds then atomic write; JS single-threaded event loop guarantees no interleaving; `remember`/`forget` never blocked by watch re-indexing.
- **Minimal dependencies** — pure JavaScript; the only runtime dependency is `pdfjs-dist` (PDF text extraction), no native builds required.
- **Negligible overhead** — pure in-process operation; cold start <100 ms (5k files), typical project query median 2–3 ms (p99 < 7 ms); bottleneck is LLM summarization and PDF parsing, not the plugin.

## Performance

### Synthetic Benchmark (isolated environment, Node 24, Linux)

| Scenario | Scale | Measured |
|----------|-------|----------|
| Full cold index | 5,000 files / 20k entries | 353 ms |
| Cold load | 5,000 files | 82 ms |
| Hot lazy re-index (single file) | 5k files | median 2.3 ms / max 4.0 ms |
| query_memory (cached) | 5k files / 20k entries | median 9.3 ms / p95 12.6 ms |
| query_memory (cached) | 1k files / 4k entries | median 1.0 ms / p95 2.0 ms |
| Full cold index | 10,000 files / 40k entries | 637 ms |
| Cold load | 10,000 files | 144 ms |
| Hot lazy re-index (single file) | 10k files | median 4.5 ms / max 10.2 ms |

> Synthetic benchmark: generated code (~8 symbols/file), Node 24, Linux native FS, SSD. Measures pure indexing overhead without LLM calls. query_memory benchmark uses IDF cache + precomputed searchText; first query after write rebuilds IDF (~150 ms), subsequent queries hit cache.

### Real Project Storage

| Project | Files | Entries | Store Size | Per Entry |
|---------|-------|---------|------------|-----------|
| Java Spring Boot backend | 1,254 | 7,335 | 6.7 MB | ~0.9 KB |
| Vue 3 + Vite frontend | 289 | 2,141 | 1.0 MB | ~0.5 KB |

> Real projects (Java + Vue), tested on Linux file system (Node 24). Real project entries are smaller than synthetic benchmarks due to lower symbol density and shorter declarations.

## How it works

The design follows four principles:

- **Volatility** — context is ephemeral; it is lost when a session is compacted.
- **Persistence** — the **memory** is stored on disk and survives compaction and new sessions.
- **Compactness** — only summaries are stored; the **memory** runs around 0.5% the size of the source it covers (8.8 MB of source → 49 KB of index in the example project), so **recall** replaces re-reading the full file.
- **Verifiability** — **recalls** carry a `path:line` citation where applicable, so the agent can confirm details against the source.

Building the **memory** does not require an upfront scan: files are memorized as the model reads them, so the **memory** grows to cover exactly what has been worked with. Re-reading a file that has not changed is a no-op (content hash), so the **memory** stays fresh with minimal ongoing overhead.

The store is per-project and follows the codebase: changed files are re-extracted by content hash, deleted files are removed. Experience notes are retrieval-only, so accumulation does not affect context.

## Installation

Tested against dsh **0.1.0-rc.7 through 0.1.2-alpha.3**. The plugin relies exclusively on stable public APIs (`defineTool`, `llm.stream`, `Schema`) declared via peerDependencies, ensuring compatibility with future rc/alpha releases without changes.

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
| `index_doc file_path` | Index one document (PDF/MD/txt): chunk → LLM summary → store with `path:line`. Unchanged files are skipped. |
| `index_repo root` | Index a whole project: docs get LLM summaries, code files get a zero-token symbol table. Incremental, cleans up deleted files, cross-links docs to symbols. |
| `watch_repo root` | Enable automatic refresh: a background poll detects new/changed files (mtime + content hash) and re-indexes only those. Watched roots persist across plugin restarts. |
| `memory_stats root` | Show what the store contains: totals (files / entries / experience notes), last index time, and the per-file list sorted by recency. |
| `query_memory query` | BM25 search over docs + symbols + experience, optionally query-expanded by the LLM. Returns ranked hits with relative scores, sources, and doc→symbol references. |
| `remember problem solution` | Save an experience note. Similar problems supersede instead of duplicating. |
| `forget id_or_query` | Delete stale experience notes. |

## Design

```
.dsh-project-memory/
  format.json      layout marker (v2, sharded)
  shards/          one self-describing JSON per indexed source file
                   ({ relPath, record, entries }) — writes touch only dirty shards
  experience.json  problem → solution notes (retrieval-only)
  watch.json       watched roots
```

Stores created before v0.2.0 (single `entries.json` / `index.json`) migrate automatically and idempotently on first load. Within one dsh process, all tool calls share a single in-memory store per project, so hot-path indexing writes only the shard that changed.

- **Incremental** — content hash per file; only changed files are re-extracted.
- **Cross-linking** — after indexing, doc summaries are matched against symbol names; matches are attached to the doc entry as `references` and surfaced by `query_memory`.
- **Query expansion** — when `llmQueryExpansion` is on, `query_memory` asks `ctx.llm` to rewrite the query into several variants (synonyms, EN/CN, identifier guesses) and merges BM25 scores across variants; when off, queries never touch the LLM. Cross-language recall (a Chinese question hitting English content) comes from index time instead: doc keywords are required to cover the document's own language AND English, and doc↔symbol links surface English symbol names from Chinese hits.
- **Consistency** — the fact layer follows the codebase (hash re-extract / remove-on-delete); the experience layer is retrieval-only with supersede and `forget`. Store writes are serialized per memory directory; the lock is in-process, so avoid running multiple dsh instances against the same project store concurrently.

## Design tradeoffs

These are deliberate scope choices.

### 1. Synchronous lock-free transactions over async locks

**We do:** All writes go through `store.commit(fn)` — a synchronous in-process transaction. The callback `fn` performs all validation and mutations; only on success is the result atomically written to disk. The JS event loop guarantees no interleaving. CAS (`applyFileUpdate`) makes concurrent writes idempotent.

**We don't:** Async mutexes, file locks, or multi-process coordination.

**Why:** DSH runs on Cordis, which is single-process by design. Adding locks would complicate the hot path (every `remember`/`forget`/`index_doc` call) for a scenario (multi-process DSH) that would require a breaking ecosystem change. Synchronous transactions keep the hot path at ~2 ms median with zero contention overhead in practice.

### 2. Watch: compute outside, commit inside

**We do:** Heavy work (mtime/hash/scan/LLM summary) runs outside the transaction; a single `commit` applies all changes atomically. On failure, the snapshot rolls back so the next poll retries automatically.

**We don't:** Hold a lock during LLM calls, or use `fs.watch` events.

**Why:** LLM summarization takes seconds — holding a lock would block `remember`/`forget`/`query_memory`. Polling with mtime+content-hash is platform-agnostic (works on network drives, Docker volumes, WSL) and avoids the "double fire / missed events" nightmare of `fs.watch`.

### 3. Corrupt files are quarantined, not auto-repaired

**We do:** On JSON parse failure, the bad file is renamed to `*.corrupt`, an error is logged, and that file's store starts fresh. The rest of the store remains intact.

**We don't:** Write-ahead logs, embedded databases (SQLite/LMDB), or automatic partial recovery.

**Why:** A corrupted shard means *one source file* has a bad index — quarantining it costs near zero. A WAL or embedded DB adds a heavy dependency, increases binary size, and introduces new failure modes (lock contention, corruption of the WAL itself). The tradeoff: lose one file's index vs. add 500 KB+ of native code.

### 4. No vector embeddings, no semantic search at query time

**We do:** BM25 with CJK phrase boost (3+ chars ×1.5 on title/keywords), synonym expansion (bidirectional table), field weighting (title ×5), and experience-layer phrase boost. All at query time, zero LLM calls.

**We don't:** Vector embeddings, dense retrieval, rerankers, or hybrid search.

**Why:** Vectors require an embedding model (local = heavy, remote = latency + cost + privacy), a vector index (HNSW/IVF = memory + build time), and reranking (another LLM call). For code + docs + experience notes, lexical BM25 with our enhancements already achieves >90% recall on real queries. The marginal gain from semantic search doesn't justify the 10x complexity/cost increase.

### 5. Cross-language recall at index time, not query time

**We do:** Doc keywords *must* cover both the document's language AND English. Doc↔symbol links surface English symbol names from Chinese queries. With `llmQueryExpansion: false`, queries never touch the LLM.

**We don't:** Translate queries at search time, or use multilingual embeddings.

**Why:** Query-time translation adds latency, token cost, and failure modes (bad translation = zero recall). Index-time bilingual keywords are a one-time cost per document; the LLM already summarizes the doc, so extracting English keywords is free. This also works offline and deterministically.

### 6. Explicit `remember` over implicit learning

**We do:** Users (or the agent) explicitly call `remember(problem, solution)`. Supersede uses bidirectional token overlap ≥0.7 to deduplicate.

**We don't:** Automatically extract "lessons" from user corrections, or infer rules from conversation history.

**Why:** Implicit learning is unpredictable — it hallucinates, captures noise, and pollutes the memory with unverifiable entries. Explicit `remember` creates an auditable, user-controlled knowledge base. The cost (one tool call) is negligible; the benefit (trust, verifiability, no silent corruption) is decisive.

### 7. Full entries returned directly

**We do:** `query_memory` returns complete entries with `path:line` citations. Every hit can be verified against source.

**We don't:** Return a minimal index first, then require a second tool call for details.

**Why:** Returning full entries preserves **verifiability** — the agent sees the exact source line for every claim. It also avoids a round-trip per useful hit. Our entries are already compact (~300 chars summary + citation); the token cost is lower than a second tool call + context switch.

### 8. Symbol extraction focused on what developers search for

**We do:** Regex-based symbol extraction (functions, classes, methods, interfaces, type aliases) with string/comment masking, multi-line signatures, and cross-file linking by symbol name. For TypeScript/JavaScript projects, an optional L2 enhancement layer uses the TS Compiler API to infer return types, resolve generics, and extract interfaces — all cached by content hash for instant reuse.

**We don't:** Tree-sitter AST parsing, import graphs, call graphs, or full-program type resolution across files.

**Why:** Our regex scanner handles 8 languages with zero dependencies, runs in <1 ms/file, and captures the declarations developers actually search for (names, signatures, generics). The optional TS layer adds semantic depth for TS/JS without native deps. Cross-file linking by name covers the most common "find related code" use case. Full-program analysis would add native binaries, 10x install size, and version fragility — for marginal gain on the remaining 5% of edge cases.

### 9. `forget` by query is aggressive; prefer ID deletion

**We do:** `forget query` deletes all experience notes with ≥0.5 token overlap.

**We don't:** Interactive confirmation, soft-delete/trash, or exact-match-only.

**Why:** Experience notes are low-stakes, high-volume, and retrieval-only. Aggressive deletion prevents stale noise from polluting search. For precision, delete by ID (shown in `query_memory` output).

### 11. TypeScript enhancement is optional, lazy, and cached

**We do:** L2 TS Compiler API enhancement runs async in a priority queue (P0 on `fs/observed`, P1 on `watch`, P2 on `index_repo`), results cached by content hash in `type-cache/`. Zero config — just `npm i -D typescript`. Falls back to L1 regex if TS absent or disabled.

**We don't:** Mandatory TS, blocking enhancement, or full-program type checking.

**Why:** Mandatory TS would break installs for non-TS projects. Blocking enhancement would stall `index_repo` on large codebases. Full-program checking is 10x slower and memory-heavy. Our design: enhance what's read, cache it, never block the hot path.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `memoryDir` | `.dsh-project-memory` | store directory inside each indexed root |
| `chunkChars` | 3000 | max chars per document chunk |
| `maxChunksPerFile` | 40 | max chunks per document |
| `maxFileSizeMb` | 50 | skip documents (incl. PDF) and code files larger than this (MB) |
| `maxOutputChars` | 8000 | cap for `query_memory` result text (chars) |
| `maxPdfPages` | 1000 | PDF page cap when pages are not otherwise limited |
| `llmQueryExpansion` | false | expand queries via `ctx.llm` before BM25 (off by default to save tokens) |
| `expansionCount` | 6 | max expansion variants |
| `lazyIndexing` | true | index files the moment the model reads them (`fs/observed`) |
| `autoIndexOnFirstUse` | false | full scan of the current working directory on plugin load (opt-in) |
| `watch` | true | enable the background refresh |
| `watchInterval` | 15 | poll interval (seconds) |
| `tsPath` | (auto) | optional absolute path to a specific `typescript` install; if omitted, resolves from project cwd → plugin node_modules |
| `enableTypeScript` | true | set `false` to disable L2 TS enhancement entirely (L1 regex only) |

### Toggling features

The two most relevant switches are `lazyIndexing` (index a file the moment the model reads it; default on) and `autoIndexOnFirstUse` (full scan of the current working directory on plugin load; default off). Lazily indexed project roots are automatically registered with the watcher, so changed files stay fresh without an explicit `watch_repo`.

Settings live in the plugin's config object. To change them, add an override entry to your profile's `cordis.patch.yml` — for the web profile that is `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: project-memory
  config:
    lazyIndexing: true          # on: index files as the model reads them (default)
    autoIndexOnFirstUse: false  # off: no upfront full scan (default)
    llmQueryExpansion: false    # off: do not spend tokens on LLM query expansion (default)
    watch: true                 # on: background refresh for watched roots (default)
    watchInterval: 15           # poll interval in seconds
    enableTypeScript: true      # on: L2 TS enhancement when TS is installed (default)
    # tsPath: /custom/path/to/typescript  # optional: force specific TS install
```

Only list the keys you want to change; the rest fall back to the plugin defaults. Verify the result with `dsh --profile web --dump-config`.

For a one-off run without editing the profile, pass the override as a CLI patch overlay:

```bash
dsh web --patch ./config.yml
```

where `config.yml` contains the same override block.

## Development (for contributors)

These commands are for **maintaining the plugin code** — regular users do not need them. Installing the plugin only requires the command in [Installation](#installation).

```bash
npm install
npm test          # 157 tests (v0.3.3): chunker / symbols / store / tools / BM25 / links / watch / lazy / config / dump / concurrency / restore / size limit
```

## License

MIT