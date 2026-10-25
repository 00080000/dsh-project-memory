---
name: project-memory
description: Recall and maintain this project's long-term memory — indexed docs and code symbols, lessons, decisions, procedures, and cross-session tasks. Use it before re-deriving project context or repeating a past mistake.
---

# Project memory

This repository keeps a memory store at `.dsh-project-memory/` (path configurable). It holds three
kinds of things:

1. **Indexed corpus** — documents (Markdown / PDF / text) and code symbols, with `path:line`
   citations.
2. **Insights** — lessons (`problem → fix`), decisions (`choice + reason`), procedures (steps), and
   experience notes. These are written by agents, across sessions.
3. **Tasks** — cross-session work records with steps and hot files. A session can be bound to one.

Query it before re-deriving; write to it only after something has been verified.

## When to query

- Before asking the human to re-explain the project, a past decision, or "what were we doing".
- Before changing a subsystem: there may be a lesson about its failure modes.
- Before an irreversible action (commit / publish / release / push / deploy / migrate): the store may
  know a prerequisite you would otherwise miss.
- When resuming: call `list_tasks`, then `select_task` if one matches the current work.

## Workflow

1. **Locate context**
   - `query_memory` with `query` = what you actually need ("how are shards written", "why store
     scope", "where is X implemented").
   - `type`: `all` (default) / `doc` / `symbol` / `experience` / `insight` / `task`.
   - Results carry ids and citations. Treat them as evidence: read the cited file when the answer
     matters.
2. **Refresh the index if it looks empty or stale**
   - `index_repo root:"<project>"` — incremental; unchanged files are skipped.
   - `index_doc file_path:"…"` — one document, even outside the corpus.
   - `memory_stats` — counts, last index time, per-file list.
3. **Write back what will still be true next session**
   - `save_lesson` — one insight. Give `kind` (`lesson` / `decision` / `procedure`), a one-line
     `title`, and the body: `pattern` + `fix`, or `choice` + `reason`, or `steps`.
   - `remember problem solution` — shorthand for `kind: experience`.
   - `files`: project-relative paths the conclusion is about.
   - `trigger.when`: when this should be recalled. `ops` (action), `writes` (file about to change),
     `intents` (words the human would use). `guard` only narrows; `prevents` records what breaks
     without it. Do **not** write a trigger you have not seen fire.
   - `scope`: `task` (needs a bound task), `project` (default), `global` (rarely).
4. **Correct or delete**
   - Same `id` + new fields = in-place update (old value kept in `prev`).
   - `forget id_or_query` is a real delete, no undo. Prefer ids; keyword deletes refuse when too many
     entries match.

## Rules

- Memory is evidence, not authority. Re-check the file before acting on a citation.
- Do not save: progress narration, temporary state, secrets/credentials, anything derivable from the
  code in one read.
- One durable entry beats five observations. Merge by updating the existing id.
- Write in the same language the project uses; keep titles short and searchable.
- The store self-ignores in git; do not commit it unless the human explicitly wants memory in the repo.

## Diagnostics

Run from a shell (no dsh required):

```bash
node <this-skill-dir>/scripts/pm-digest.mjs <project-root>
node <this-skill-dir>/scripts/pm-digest.mjs <project-root> --json
```

It prints store size, insight/task counts, trigger coverage, and staleness. Use it when memory looks
empty, suspiciously large, or when you need to explain what is stored.
