---
name: memory-consolidate
description: Compile the raw memory notes in the mcp-task-mgmt server into a single, de-duplicated memory wiki. Use periodically or when raw notes have accumulated, when recall returns redundant/overlapping notes, or when the user says "clean up memory", "consolidate what you've learned", "compile the memory wiki".
---

# Memory consolidate (COMPILE)

The **consolidate/compile** step of the memory loop — the heart of Karpathy's method. Review the accumulated raw notes and rewrite them into one coherent, deduplicated markdown wiki that gets loaded into context going forward.

## Prerequisite

The `mcp-task-mgmt` MCP server must be connected.

## Procedure

1. **Gather material**: call `consolidate_memories { kind? }`. It returns, in one block:
   - the current compiled wiki (or "(none yet)"),
   - all raw notes,
   - likely duplicate pairs (advisory — based on token overlap),
   - instructions.
   This tool is read-only; it changes nothing on its own.
2. **Compile the wiki.** Rewrite the raw notes into a single markdown document:
   - Group by `kind` or by topic (e.g. `## Preferences`, `## Decisions`, `## Lessons`).
   - **Merge duplicates and near-duplicates** into one clear statement (use the duplicate pairs as hints, but judge for yourself).
   - **Resolve contradictions** — prefer newer/higher-salience notes; if genuinely unsure, ask the user.
   - **Generalize** specific observations into reusable rules where appropriate.
   - Keep it concise and high-signal — this is loaded into context, so every line should earn its place.
   - Preserve durable knowledge already in the existing wiki that isn't represented in raw notes.
3. **Save it**: `save_memory_wiki { content: <full markdown> }`. This replaces the wiki served at `memory://global`.
4. **Prune captured raw notes** (optional but recommended): `delete_memory { id }` for notes now fully represented in the wiki, so the raw buffer stays small and future consolidations are cheap. Keep notes you're unsure about.
5. **Confirm** what changed (sections written, duplicates merged, notes pruned).

## Cadence

Consolidate when the raw buffer grows (e.g. dozens of notes), when recall feels noisy, or at natural boundaries like finishing a milestone. The compiled wiki — not the raw notes — is what primes future sessions, so keeping it current is what makes the memory compound.

## Cautions

- Never drop information silently — if you remove a note, its content must live on in the wiki (or be intentionally discarded with the user's awareness).
- Don't delete raw notes you haven't captured into the wiki yet.
