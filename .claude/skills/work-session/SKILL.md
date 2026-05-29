---
name: work-session
description: Orchestrate a full working session against the mcp-task-mgmt server — prime context from memory, plan/track the work, then capture learnings and consolidate. Use at the start of a substantive piece of work, when the user says "let's work on X", "start a session on Y", "pick up where we left off", or wants memory and task tracking wired into the work end-to-end.
---

# Work session (orchestration)

Ties the task and memory skills into one loop so a session starts warm and ends with its learnings persisted. Each phase below delegates to a focused skill — invoke or follow them rather than reimplementing their steps.

## Prerequisite

The `mcp-task-mgmt` MCP server must be connected. If its tools aren't available, tell the user how to add it and stop.

## The loop

```
   ┌─────────────────────────────────────────────────────────┐
   │  PRIME → PLAN → WORK ⇄ TRACK → CAPTURE → CONSOLIDATE      │
   └─────────────────────────────────────────────────────────┘
```

### 1. PRIME — load what's already known
Use **`memory-recall`**: read the `memory://global` wiki for the big picture, then `recall` the key terms of the task. Apply any `preference`, `decision`, and high-`salience` notes before deciding anything. This prevents repeating past mistakes and re-litigating settled choices.

### 2. PLAN — make sure the work is tracked
- If this is new work, use **`task-breakdown`** to scaffold the Project → Milestone → Task → Spec hierarchy.
- If resuming, use **`task-review`** (`get_project_tree`) to see where things stand and pick the next item.
Mark the item you're starting `in_progress` (`update_task`), and its milestone too if it was `planned`.

### 3. WORK ⇄ TRACK — do the work, keep status honest
As you complete units of work, advance statuses with the narrowest scope (`update_task … done`, `update_spec … approved/implemented`). When all tasks under a milestone are done, set the milestone `completed`. Keep tracking continuous, not a big update at the end.

### 4. CAPTURE — record what's worth keeping
Whenever a durable lesson, fact, preference, or decision surfaces during the work, use **`memory-capture`** to `remember` it (dedup-check with `recall` first). Don't batch this to the end — capture at the moment of insight so nothing is lost.

### 5. CONSOLIDATE — compound the memory
At a natural boundary (finishing a milestone, end of session, or when raw notes have piled up), use **`memory-consolidate`**: compile the raw notes into the deduplicated `memory://global` wiki and prune captured notes. The wiki — not the raw buffer — is what primes the *next* session, so this is what makes memory compound over time.

## Judgment

- **Scale to the work.** A quick task may only need PRIME → one TRACK update → CAPTURE. A multi-day effort uses the whole loop repeatedly. Don't force ceremony on small jobs.
- **PRIME and CAPTURE are the highest-leverage phases** — they're what a stateless session normally skips. Never skip PRIME at the start; never skip CAPTURE when something is learned.
- **CONSOLIDATE is periodic, not every session.** Run it when the raw buffer is noisy or at milestone boundaries, not after every note.
- Honor recalled memories, but **verify any stale-able detail** (a file, flag, or version a memory names) before relying on it.

## Related skills

`memory-recall` · `task-breakdown` · `task-review` · `memory-capture` · `memory-consolidate`
