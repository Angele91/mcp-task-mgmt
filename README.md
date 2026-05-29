# mcp-task-mgmt

A [Model Context Protocol](https://modelcontextprotocol.io) server for task management, built with the official TypeScript SDK.

## Hierarchy

Work is organized in four nested levels. Deleting a parent cascades to its children.

```
Project ─< Milestone ─< Task ─< Spec
```

| Entity | ID form | Parent | Status values |
| --- | --- | --- | --- |
| Project | `project-N` | — | `planning`, `active`, `completed`, `archived` |
| Milestone | `milestone-N` | project | `planned`, `in_progress`, `completed` |
| Task | `task-N` | milestone | `todo`, `in_progress`, `done` |
| Spec | `spec-N` | task | `draft`, `approved`, `implemented` |

## Tools

Each entity has the standard five CRUD tools, plus a tree view — 21 in total.

| Tool | Description |
| --- | --- |
| `create_<entity>` | Create an entity (under its parent, where applicable) |
| `list_<entity>s` | List entities, optionally scoped to a parent and/or status |
| `get_<entity>` | Get a single entity by ID |
| `update_<entity>` | Update an entity's fields |
| `delete_<entity>` | Delete an entity by ID (cascades to children) |
| `get_project_tree` | Render the full nested tree for a project |

`<entity>` is one of `project`, `milestone`, `task`, `spec`.

- Milestones additionally accept an optional `dueDate` (ISO 8601).
- Specs use `title` + `content` (instead of `title` + `description`).

## Dependencies & planning

Beyond the parent/child hierarchy, tasks can declare **cross-cutting
dependencies** — a directed acyclic graph layered over the tree. This turns a
flat list into something that can tell you what to work on next.

| Tool | Description |
| --- | --- |
| `add_dependency` | Declare `taskId` waits for `dependsOnId` (must be done first). Same project only; self-edges and cycles are rejected. |
| `remove_dependency` | Detach a dependency edge. |
| `get_next_actions` | Tasks ready to work on now — not done, with every prerequisite done. Ordered by in-progress first, then by how much downstream work each unblocks. |
| `get_critical_path` | The longest chain of dependent tasks (prerequisite-first) — the sequence that gates how soon the project can finish. |

Dependencies are scoped to a single project and kept acyclic: `add_dependency`
rejects any edge that would close a loop. Deleting a task removes its edges.
`get_project_tree` annotates any task still waiting on an unfinished
prerequisite with `⛔ blocked by …`.

## Persistence

Tasks are persisted to a SQLite database (via `better-sqlite3`). By default the
database lives at `tasks.db` in the process's working directory. Override the
location with the `TASK_DB_PATH` environment variable, or set it to `:memory:`
for an ephemeral, non-persistent store:

```bash
TASK_DB_PATH=/var/lib/mcp/tasks.db pnpm start
TASK_DB_PATH=:memory: pnpm start
```

The schema is created automatically on first run.

## Global memory

Beyond per-project tasks, the server maintains a **global, cross-project memory**
modeled on Andrej Karpathy's *system-prompt-learning* / **LLM Wiki** pattern:
explicit, model-authored, natural-language memory that sits between the model's
weights and its context window. It is deliberately *not* RAG or vector
embeddings — memory is compiled into a human-readable document, not retrieved
opaquely.

The lifecycle:

| Stage | Tool(s) | What happens |
| --- | --- | --- |
| **Write** | `remember` | The model appends a raw note (a `lesson`, `fact`, `preference`, or `decision`) with optional tags, source, and salience (1–5). |
| **Recall** | `recall` | Keyword search (SQLite FTS5) returns the most relevant raw notes, ranked by bm25. Filterable by `kind` and `tags`. |
| **Consolidate** | `consolidate_memories` → `save_memory_wiki` | The model reviews all raw notes plus auto-detected duplicate candidates, then rewrites them into one de-duplicated markdown "wiki" and saves it. |
| **Load** | resource `memory://global` | The compiled wiki is exposed as an MCP resource (and via `get_memory_wiki`) for clients to auto-load into context at startup. |

Note management tools: `list_memories`, `get_memory`, `update_memory`, `delete_memory`.

Memory is stored in a **separate** SQLite database from the task data, so it is
shared across every project. By default it lives at `~/.mcp-task-mgmt/memory.db`;
override with `MEMORY_DB_PATH` (or `:memory:` for an ephemeral store):

```bash
MEMORY_DB_PATH=/var/lib/mcp/memory.db pnpm start
```

## Install

Pick whichever fits your client. All three end at the same stdio server.

**A. From source (recommended today).** A single install builds the server —
the `prepare` script runs `tsc` for you, so there's no separate build step:

```bash
git clone <repo-url> mcp-task-mgmt
cd mcp-task-mgmt
npm install            # installs deps AND builds dist/ (via prepare)
```

Optionally put it on your `PATH` so client configs don't need an absolute path:

```bash
npm link               # or: npm install -g .
mcp-task-mgmt          # now runnable as a bare command
```

(Works the same with `pnpm install` / `pnpm link --global` if you prefer pnpm.)

**B. Zero-clone via npx** — once the package is published to npm:

```bash
npx -y mcp-task-mgmt
```

See [Use with an MCP client](#use-with-an-mcp-client) for wiring it into Claude.

## Develop

```bash
pnpm watch        # recompile on change
pnpm typecheck    # type-check without emitting
pnpm test         # build + run the unit tests (node:test)
pnpm inspector    # run the MCP Inspector against the server
```

## Run

```bash
pnpm start        # node dist/index.js
```

The server speaks MCP over stdio.

## Use with an MCP client

### Claude Code (CLI)

If you put it on your `PATH` (`npm link`), no path is needed:

```bash
claude mcp add task-mgmt -- mcp-task-mgmt
```

Published to npm? Skip the install entirely:

```bash
claude mcp add task-mgmt -- npx -y mcp-task-mgmt
```

From a local clone without linking, point at the built entry — run it from the
repo root so `$(pwd)` resolves correctly:

```bash
claude mcp add task-mgmt -- node "$(pwd)/dist/index.js"
```

### Claude Desktop / other clients (JSON config)

Add one of these to the client's MCP config (e.g. Claude Desktop's
`claude_desktop_config.json`). Replace `/absolute/path/to/mcp-task-mgmt` with
your clone's location, or use the linked/npx form to avoid paths altogether:

```json
{
  "mcpServers": {
    "task-mgmt": {
      "command": "mcp-task-mgmt"
    }
  }
}
```

```json
{
  "mcpServers": {
    "task-mgmt": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-task-mgmt/dist/index.js"]
    }
  }
}
```

To persist tasks somewhere specific, add an `env` block with `TASK_DB_PATH`
(and `MEMORY_DB_PATH`) — see [Persistence](#persistence).

## Skills

The repo ships a set of [Agent Skills](https://docs.claude.com/en/docs/claude-code/skills)
in `.claude/skills/` that document the workflows for driving this server. When the
project is open in Claude Code they're auto-discovered (and invocable as
`/<name>`):

| Skill | What it does |
| --- | --- |
| `work-session` | **Orchestrator** — ties the others into one loop: prime → plan → work/track → capture → consolidate. |
| `task-breakdown` | Plan and scaffold a goal into the Project → Milestone → Task → Spec hierarchy. |
| `task-review` | Report status / what's next for a tracked project, and advance statuses. |
| `memory-capture` | **Write** a durable lesson/fact/preference/decision to global memory. |
| `memory-recall` | **Load** the compiled wiki + **recall** relevant notes before working. |
| `memory-consolidate` | **Compile** raw notes into the deduplicated memory wiki. |

`work-session` is the entry point for substantive work; the three `memory-*` skills
map to the write → recall → consolidate → load lifecycle.

## Project layout

```
src/
  index.ts   # server, generic CRUD tool registrar, tree view, memory tools + resource
  store.ts   # task SQLite schema + generic EntityStore (better-sqlite3)
  memory.ts  # global memory store: FTS5 search, compiled wiki, consolidation
test/
  store.test.js    # task Store / EntityStore unit tests (hierarchy + cascade)
  memory.test.js   # MemoryStore unit tests (FTS5, wiki, dedup)
.claude/skills/    # Agent Skills for using the server (see Skills above)
```
