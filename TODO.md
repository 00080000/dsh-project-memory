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

## Mid-term (Trigger-based)

- **Async I/O / Cold Start** — if hot path >5ms or cold start >100ms

## On Hold (Await User Feedback)

- tree-sitter AST parsing (optional plugin)
- Multi-line signatures for remaining languages
- Symbol scanner edge cases

## Candidates (v0.4.0+)

- Dictionary max-match (50KB vocab)
- Experience SimHash dedup
- Symbol link kind weights