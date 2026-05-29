---
name: memory-recall
description: Prime context with relevant cross-project memory from the mcp-task-mgmt server before starting work. Use at the start of a task or session, when picking up unfamiliar work, or when the user asks "what do you remember about X", "have we decided how to Y", "what are my preferences for Z".
---

# Memory recall (LOAD + RECALL)

The **load** and **recall** steps of the memory loop. Pull relevant learned context before working so past lessons, decisions, and preferences are honored.

## Prerequisite

The `mcp-task-mgmt` MCP server must be connected.

## Procedure

1. **Load the compiled wiki** — the curated, consolidated memory:
   - Read the resource `memory://global`, or call `get_memory_wiki`.
   - This is the high-signal, deduplicated summary. Skim it first.
2. **Recall specifics** for the task at hand:
   - `recall { query, kind?, tags?, limit? }` with the key terms of what you're about to do.
   - `query` is keyword-based (full-text search); pass the salient nouns/verbs. Punctuation is safe to include.
   - Narrow with `kind` (e.g. `preference`) or `tags` when you want a specific slice. Tag filters require **all** listed tags to match.
3. **Apply what you find.** Honor `preference` and high-`salience` notes. Follow prior `decision`s for consistency unless the user overrides. Let `lesson`s steer you away from known pitfalls.
4. If a recalled memory references a file, flag, or choice, **verify it still holds** before relying on it — memories reflect what was true when written.

## When recall comes up empty

If nothing relevant is stored, proceed normally — and capture new lessons/decisions as you go (see `memory-capture`) so the next session starts warmer.

## Notes

- Prefer the wiki for the "big picture" and `recall` for targeted lookups.
- `list_memories { kind?, limit? }` browses raw notes newest-first when you want to scan rather than search.
