---
name: task-review
description: Review progress on work tracked in the mcp-task-mgmt server and report status, what's in flight, and what's next. Use when the user asks "where are we on X", "what's the status of the project", "what's left to do", "show me the plan", or wants a standup-style summary or to advance task statuses.
---

# Task review

Report on and advance work tracked in the `mcp-task-mgmt` server (Project → Milestone → Task → Spec).

## Prerequisite

The `mcp-task-mgmt` MCP server must be connected.

## Procedure

1. **Find the project**: if the user named one, `list_projects` and match; otherwise `list_projects` and ask which (or summarize all active ones).
2. **Pull the tree**: `get_project_tree { id }` for the full nested view in one call. Prefer this over many `list_*` calls.
3. **Summarize**, don't dump. Report:
   - Project status and overall progress (e.g. "2 of 5 milestones completed").
   - **In flight**: milestones `in_progress` and tasks `in_progress`.
   - **Next up**: the earliest `planned`/`todo` items, especially under the active milestone.
   - **Attention**: milestones with a past `dueDate` not yet `completed`; tasks `done` whose specs are still `draft`.
4. **Offer next actions**: advancing a status, adding a task, or breaking down the next milestone.

## Advancing status

When the user reports progress, update with the narrowest scope:

- Start work: `update_task { id, status: "in_progress" }` (and the parent milestone if it was `planned`).
- Finish a task: `update_task { id, status: "done" }`. If all tasks under a milestone are `done`, suggest setting the milestone `completed`.
- Approve/implement a spec: `update_spec { id, status: "approved" | "implemented" }`.

## Status reference

- project: `planning` · `active` · `completed` · `archived`
- milestone: `planned` · `in_progress` · `completed`
- task: `todo` · `in_progress` · `done`
- spec: `draft` · `approved` · `implemented`

## Notes

- Use `list_milestones { projectId, status }`, `list_tasks { milestoneId, status }`, etc. for filtered slices when the tree is large.
- When a milestone wraps up, capture any lessons learned with the `memory-capture` skill.
