# dsh-project-memory

[English](README.md) | [简体中文](README.zh-CN.md)

[![ci](https://github.com/00080000/dsh-project-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/00080000/dsh-project-memory/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![npm](https://img.shields.io/npm/v/@yolk_vat-y/dsh-project-memory)](https://www.npmjs.com/package/@yolk_vat-y/dsh-project-memory) [![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/00080000/dsh-project-memory)

Persistent project memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh) agents. Indexes documents (PDF / Markdown / txt) and code symbols into a per-workspace store, refreshes them automatically, and recalls them with source citations — documents are cross-linked to the code symbols they reference.

> The plugin keeps a compact project index on disk, with every entry pointing to a concrete file and line — the agent can reorient quickly instead of re-reading the whole project.

## Features

- **Document indexing** — PDF, Markdown, and plain text files are chunked and summarized by the LLM; each entry carries a `path:line` citation back to the source.
- **Code symbol table** — function, class, and method names are extracted by a dependency-free source scanner (string/comment masking, multi-line signature joining, indentation-aware Python, class-method context), without LLM token usage.
- **Automatic refresh** — a background poll (`watch_repo`) detects new or changed files by content hash and re-indexes only those.
- **Read-time indexing** — files are indexed the moment the model actually reads them (`fs/observed`), so the index is a byproduct of normal work, not a separate upfront scan. Files that are never read are never indexed. The project root is detected by markers (`.git`, `package.json`, …), a README plus source directories, or the file's own directory as a last resort.
- **Doc ↔ code cross-linking** — when a document mentions a symbol, the match is recorded as a `reference`; querying a symbol also surfaces the documents that describe it.
- **BM25 retrieval** — ranked search over documents, symbols, and experience notes, with optional LLM query expansion to handle vocabulary mismatch. **CJK-optimized**: precise phrase boost (3+ char phrases ×1.5 score on title/keywords match), synonym table (e.g. 数据库连接池 ↔ 连接池 ↔ DB pool), and CJK-aware word boundaries for doc↔symbol linking.
- **Experience notes** — problems → solutions; similar problems supersede instead of duplicating, and notes are returned only when a search matches. The note store is bounded: capacity scales with project size (clamped to 100–2000), and the oldest notes are pruned when the limit is exceeded. **Supersede tightened to bidirectional 0.7 overlap** (was 0.6); **experience `problem` field now participates in CJK phrase boost** for long-tail query recall.
- **Minimal dependencies** — pure JavaScript; the only runtime dependency is `pdfjs-dist` (PDF text extraction), no native builds required.

## How it works

The design follows four principles:

- **Volatility** — context is ephemeral; it is lost when a session is compacted.
- **Persistence** — the index is stored on disk and survives compaction and new sessions.
- **Compactness** — only summaries are stored; the index runs around 0.5% the size of the source it covers (8.8 MB of source → 49 KB of index in the example project), so retrieval replaces re-reading the full file.
- **Verifiability** — hits carry a `path:line` citation where applicable, so the agent can confirm details against the source.

Building the index does not require an upfront scan: files are indexed as the model reads them, so the index grows to cover exactly what has been worked with. Re-reading a file that has not changed is a no-op (content hash), so the index stays fresh with minimal ongoing overhead.

The store is per-project and follows the codebase: changed files are re-extracted by content hash, deleted files are removed. Experience notes are retrieval-only, so accumulation does not affect context.

## Installation

Tested against dsh **0.1.0-rc.7 through 0.1.2-alpha.1**. The plugin relies exclusively on stable public APIs (`defineTool`, `llm.stream`, `Schema`) declared via peerDependencies, ensuring compatibility with future rc releases without changes.

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
dsh plugin --profile web add /path/to/dsh-project-memory-0.2.0.tgz
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

- **In-process locking** — store writes are serialized per memory directory within one dsh process; two dsh instances sharing a project store is last-writer-wins. A cross-process lock would need a resident daemon, which conflicts with the pure-JS, no-background-service positioning, so multi-instance writes are explicitly unsupported.
- **Watch poll holds the lock** — while the watcher re-indexes changed docs (LLM summarization), `remember`/`forget` queue behind it. Polling (mtime + content hash) instead of `fs.watch` events keeps behavior consistent across platforms; overlapping polls serialize on the same lock: safe, but they can pile up on very large diffs. Tune via `watchInterval`.
- **Corrupt files are quarantined** — a store JSON that fails to parse falls back to empty for that file and is rebuilt on the next write; the broken file is renamed to `*.corrupt` with an error logged, but its data cannot be recovered. Auto-repairing partial writes would need a write-ahead journal or an embedded database — out of proportion when quarantining one bad file costs nothing.
- **Absolute source paths** — entries cite absolute paths; moving a project invalidates citations until the next re-index.
- **`forget` by query is eager** — keyword deletion matches at ≥0.5 token overlap and may remove several notes at once; prefer deleting by id for precision.
- **Cross-language recall depends on index time** — with `llmQueryExpansion` off, a Chinese-only query reaches English content through bilingual keywords captured when docs are indexed, plus doc↔symbol links; queries stay LLM-free. Stores indexed before v0.1.1 gain bilingual keywords as files change, or immediately via `index_repo` with `reindex: true`.
- **CJK retrieval** — phrase boost and synonym expansion are purely query-side; they do not increase index size or LLM usage. Link boundaries use CJK-aware regex only; English symbols keep the original word-boundary behavior. The experience supersede threshold (0.7 bidirectional) is a conservative default; adjust via config if false positives/negatives appear in practice.

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
npm test          # chunker / symbols / store / tools / BM25 / links / watch / lazy / config / dump / concurrency / restore / size limit
```

## License

MIT