---
name: task-breakdown
description: Plan and scaffold a body of work into the Project → Milestone → Task → Spec hierarchy using the mcp-task-mgmt server. Use when the user wants to break down a goal, project, or feature into structured, trackable work — e.g. "plan out X", "set up a project for Y", "break this into tasks", "create milestones for Z".
---

# Task breakdown

Turn a goal into a structured plan in the `mcp-task-mgmt` server. The hierarchy is **Project → Milestone → Task → Spec**. Deleting a parent cascades to its children.

## Prerequisite

The `mcp-task-mgmt` MCP server must be connected. If its tools (`create_project`, `create_milestone`, …) aren't available, tell the user to add it (`claude mcp add task-mgmt -- node <path>/dist/index.js`) and stop.

## When to create each level

- **Project** — the overall initiative. One per distinct effort.
- **Milestone** — a meaningful, demoable chunk of the project (a phase, release, or deliverable). Optional `dueDate` (ISO 8601).
- **Task** — a concrete unit of work a person picks up and finishes.
- **Spec** — the detailed contract/notes for a task: acceptance criteria, design, API shape. Use `content` for the body.

Don't over-nest. If a "task" needs no detailed contract, skip the spec. If a project is tiny, one milestone is fine.

## Procedure

1. **Clarify scope** if the goal is vague. Ask 1–3 questions only when genuinely blocked (e.g. unknown deadline, unclear deliverables). Otherwise proceed with sensible structure.
2. **Recall prior context** (optional but recommended): run `recall` with the goal's keywords to surface relevant past decisions/lessons before planning. See the `memory-recall` skill.
3. **Create the project**: `create_project { name, description, status }`. Default status `planning` while scoping, `active` once work starts.
4. **Create milestones** under the project id: `create_milestone { projectId, name, description, dueDate? }`. Order them by sequence.
5. **Create tasks** under each milestone: `create_task { milestoneId, title, description }`.
6. **Create specs** for tasks that need a contract: `create_spec { taskId, title, content }`. Put acceptance criteria in `content`.
7. **Show the result**: call `get_project_tree { id }` and present the tree to the user for confirmation.

## Status values

- project: `planning` · `active` · `completed` · `archived`
- milestone: `planned` · `in_progress` · `completed`
- task: `todo` · `in_progress` · `done`
- spec: `draft` · `approved` · `implemented`

## Notes

- IDs are returned as `project-N`, `milestone-N`, `task-N`, `spec-N`. Capture the parent id from each create response before creating its children.
- The server processes requests concurrently: **create a parent and wait for its id before creating its children**.
- After scaffolding, consider capturing the key planning decisions with the `memory-capture` skill so they persist across sessions.
