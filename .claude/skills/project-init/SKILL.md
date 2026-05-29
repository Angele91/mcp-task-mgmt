---
name: project-init
description: Onboard an existing, already-built or already-running codebase into the mcp-task-mgmt server, capturing its current state as completed work so the tracker mirrors reality. Use when the user wants to register, import, init, or start tracking a project that already has code — e.g. "init this project into task mgmt", "track this repo", "onboard this codebase", "import my existing project", "set up tracking for what's already here".
---

# Project init (from existing codebase)

Register a codebase that **already exists** into the `mcp-task-mgmt` server so the tracker reflects what has *already been built*, not just future plans. The hierarchy is **Project → Milestone → Task → Spec**.

This is the retroactive counterpart to `task-breakdown`:

- **`task-breakdown`** — greenfield. Plan work that *doesn't exist yet* into `todo` tasks.
- **`project-init`** (this skill) — brownfield. Inspect a working codebase and record what's *already done* as `completed`/`done` items, so the tracker starts truthful.

## Prerequisite

The `mcp-task-mgmt` MCP server must be connected. If its tools (`create_project`, `create_milestone`, …) aren't available, tell the user to add it (`claude mcp add task-mgmt -- mcp-task-mgmt`, or `-- node <path>/dist/index.js`) and stop.

## Procedure

1. **Avoid duplicates.** Run `list_projects` first. If a project for this codebase already exists, surface it and ask whether to update it instead of creating a second one.

2. **Survey the codebase.** Build an honest picture of what's already built and how mature it is. Look at:
   - the README / docs (what the project claims to do),
   - the package manifest (`package.json`, `pyproject.toml`, `Cargo.toml`, …) for name, version, scripts, entry points,
   - the directory layout and main source files (the real subsystems),
   - tests (what's covered → what's actually done vs. scaffolded),
   - `git log` if it's a repo (recent work, in-flight threads).

   Derive the project's **name** and a one-paragraph **description** from this, citing real file paths.

3. **Recall prior context** (optional): `recall` with the project's keywords to surface relevant past decisions/lessons. See the `memory-recall` skill.

4. **Create the project.** `create_project { name, description, status: "active" }`. An already-running codebase is `active` (use `planning` only if it's a pre-code spike). Put the key facts — entry points, persistence, main modules — in the description so the record stands alone.

5. **Capture current state as a completed milestone.** Create one milestone named for the current version/state (e.g. `v0.1.0 — Core (built)`, status `completed`), then add one **`done`** task per major already-built subsystem or feature. Write each task's description with the real files and what it does. **Be honest:** a half-finished subsystem is an `in_progress` task under an `in_progress` milestone, not `done`.

6. **Optionally add forward work.** Decide scope with the user (a quick `AskUserQuestion` is fine):
   - *Current state only* — stop after step 5.
   - *Current state + next work* — add a `planned` milestone with `todo` tasks for likely next steps. Don't invent work; base it on real gaps (missing tests, TODOs, unbuilt README features). For genuinely forward planning, hand off to `task-breakdown`.

7. **Show the result.** Call `get_project_tree { id }` and present the tree for confirmation.

8. **Persist key facts** (optional): capture notable architectural decisions or constraints discovered during the survey with the `memory-capture` skill.

## Status values

- project: `planning` · `active` · `completed` · `archived`
- milestone: `planned` · `in_progress` · `completed`
- task: `todo` · `in_progress` · `done`
- spec: `draft` · `approved` · `implemented`

## Notes

- **Mirror reality, don't flatter it.** The point of this skill is a truthful baseline. Mark statuses by what the code actually shows (tests passing, features wired up), not by intent.
- **Size tasks to subsystems.** For an existing codebase, one `done` task per coherent module/feature (with file references) is the right granularity — not one per commit or per file.
- IDs are returned as `project-N`, `milestone-N`, `task-N`, `spec-N`. Capture each parent id from its create response before creating children.
- The server processes requests concurrently: **create a parent and wait for its id before creating its children.**
- After onboarding, `task-review` reports status and `work-session` ties planning, work, and memory into one loop.
