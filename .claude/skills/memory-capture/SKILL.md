---
name: memory-capture
description: Record a durable, cross-project memory (a lesson, fact, preference, or decision) in the mcp-task-mgmt global memory. Use when something worth remembering surfaces — the user states a preference or correction, a non-obvious lesson is learned, a decision is made with rationale, or the user says "remember that…", "note for next time", "from now on".
---

# Memory capture (WRITE)

The **write** step of the memory loop (Karpathy's system-prompt-learning / LLM Wiki pattern). Append a raw note to the global, cross-project memory so it can be recalled and later compiled into the memory wiki.

## Prerequisite

The `mcp-task-mgmt` MCP server must be connected. Memory is global (stored in `~/.mcp-task-mgmt/memory.db`), shared across all projects — independent of any task project.

## What is worth capturing

Capture durable, reusable knowledge — not transient task state (that belongs in tasks).

- **lesson** — something learned, often from a mistake or surprise. "Running the build before commit catches type errors early."
- **fact** — stable knowledge about the user, domain, or environment. "The prod database is Postgres 15 in us-east-1."
- **preference** — how the user wants things done. "Prefers TypeScript over Python; avoids default exports."
- **decision** — a choice and its rationale, for future consistency. "Chose better-sqlite3 for its synchronous API over node:sqlite."

If it would help a future session and isn't derivable from the code/repo, capture it. If it's only relevant to the current task, don't.

## Procedure

1. **Check for duplicates**: `recall { query: <key terms> }` first. If a near-identical note exists, `update_memory` it instead of adding a new one.
2. **Write it**: `remember { content, kind, tags?, source?, salience? }`.
   - `content` — one self-contained sentence or two. Write it so it makes sense with no surrounding context.
   - `kind` — one of `lesson` | `fact` | `preference` | `decision`.
   - `tags` — lowercase topic tags for later filtering (e.g. `["build", "ci"]`).
   - `source` — optional provenance (project name, file, conversation).
   - `salience` — importance 1–5 (default 3). Reserve 5 for things that should almost always be honored.
3. **Confirm** briefly what was stored.

## Guidance

- One fact per note — keep notes atomic so consolidation and recall stay clean.
- Phrase preferences and lessons as durable rules, not as one-off observations.
- Don't capture secrets/credentials.
- Periodically the raw notes should be compiled into the wiki — see the `memory-consolidate` skill.
