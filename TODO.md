# 待办 / 已知瓶颈

Done items → CHANGELOG.

## Near-term (v0.2.x)

- [x] **C1: CJK Retrieval Enhancement** — phrase boost, synonyms, link boundaries
- [x] **C2: doc↔symbol CJK Precision** — with C1
- [x] **B2: Supersede Threshold** — bidirectional 0.7 overlap
- [x] **B3: Long-tail Query Recall** — experience `problem` phrase boost
- [x] **D-1: pdfjs-dist Lazy Load** — module-level lazy init

## Mid-term (Trigger-based)

- **A3: Lock Scope Reduction** — move LLM summarization out of lock
- **Async I/O / Cold Start** — if hot path >5ms or cold start >100ms

## On Hold (Await User Feedback)

- tree-sitter AST parsing
- Multi-line signatures for remaining languages
- Symbol scanner edge cases

## Candidates (v0.3.0+)

- Dictionary max-match (50KB vocab)
- Experience SimHash dedup
- Symbol link kind weights