#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape } from "zod";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  Store,
  type EntityStore,
  type Project,
  type Milestone,
  type Task,
  type Spec,
  type ProjectTree,
  type TaskActivity,
} from "./store.js";
import { MemoryStore, MEMORY_KINDS, type Memory } from "./memory.js";

// Persist to TASK_DB_PATH if set, otherwise tasks.db in the current directory.
// Use ":memory:" for an ephemeral, non-persistent store.
const dbPath = process.env.TASK_DB_PATH ?? path.join(process.cwd(), "tasks.db");
if (dbPath !== ":memory:") {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}
const store = new Store(dbPath);

// Global memory lives in the user's home dir, shared across every project.
// Override with MEMORY_DB_PATH; ":memory:" for an ephemeral store.
const memoryDbPath =
  process.env.MEMORY_DB_PATH ?? path.join(os.homedir(), ".mcp-task-mgmt", "memory.db");
if (memoryDbPath !== ":memory:") {
  fs.mkdirSync(path.dirname(memoryDbPath), { recursive: true });
}
const memory = new MemoryStore(memoryDbPath);

const server = new McpServer({ name: "mcp-task-mgmt", version: "0.1.0" });

type TextResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(text: string): TextResult {
  return { content: [{ type: "text", text }] };
}
function err(text: string): TextResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Register the standard create/list/get/update/delete tools for one entity.
 */
function registerCrud<T extends { id: string }>(opts: {
  store: EntityStore<T>;
  singular: string; // e.g. "project"
  plural: string; // e.g. "projects"
  parent?: { idParam: string; label: string }; // e.g. { idParam: "projectId", label: "project" }
  createFields: ZodRawShape; // settable fields on create
  updateFields: ZodRawShape; // settable fields on update (all optional)
  statusValues: readonly [string, ...string[]];
  format: (entity: T) => string;
}) {
  const { store, singular, plural, parent, createFields, updateFields, statusValues, format } =
    opts;

  const parentArg = parent
    ? { [parent.idParam]: z.string().describe(`ID of the parent ${parent.label}`) }
    : {};

  // CREATE
  server.registerTool(
    `create_${singular}`,
    {
      title: `Create ${singular}`,
      description: `Create a new ${singular}${parent ? ` under a ${parent.label}` : ""}.`,
      inputSchema: { ...parentArg, ...createFields },
    },
    async (args: Record<string, unknown>) => {
      const parentId = parent ? (args[parent.idParam] as string) : null;
      const values = { ...args };
      if (parent) delete values[parent.idParam];
      try {
        const entity = store.create(parentId, values);
        return ok(`Created ${singular}:\n${format(entity)}`);
      } catch (e) {
        return err(`Could not create ${singular}: ${(e as Error).message}`);
      }
    },
  );

  // LIST
  server.registerTool(
    `list_${plural}`,
    {
      title: `List ${plural}`,
      description: `List ${plural}${parent ? `, optionally scoped to a ${parent.label}` : ""}, optionally filtered by status.`,
      inputSchema: {
        ...(parent
          ? { [parent.idParam]: z.string().optional().describe(`Filter by parent ${parent.label}`) }
          : {}),
        status: z.enum(statusValues).optional().describe("Filter by status"),
      },
    },
    async (args: Record<string, unknown>) => {
      const parentId = parent ? (args[parent.idParam] as string | undefined) : undefined;
      const status = args.status as string | undefined;
      try {
        const entities = store.list(parentId, status ? { status } : undefined);
        if (entities.length === 0) return ok(`No ${plural} found.`);
        return ok(entities.map(format).join("\n\n"));
      } catch (e) {
        return err(`Could not list ${plural}: ${(e as Error).message}`);
      }
    },
  );

  // GET
  server.registerTool(
    `get_${singular}`,
    {
      title: `Get ${singular}`,
      description: `Get a single ${singular} by ID.`,
      inputSchema: { id: z.string().describe(`The ${singular} ID, e.g. ${singular}-1`) },
    },
    async ({ id }: { id: string }) => {
      const entity = store.get(id);
      return entity ? ok(format(entity)) : err(`No ${singular} found with id ${id}.`);
    },
  );

  // UPDATE
  server.registerTool(
    `update_${singular}`,
    {
      title: `Update ${singular}`,
      description: `Update fields of a ${singular}.`,
      inputSchema: { id: z.string().describe(`The ${singular} ID to update`), ...updateFields },
    },
    async (args: Record<string, unknown>) => {
      const { id, ...values } = args as { id: string } & Record<string, unknown>;
      try {
        const entity = store.update(id, values);
        return entity
          ? ok(`Updated ${singular}:\n${format(entity)}`)
          : err(`No ${singular} found with id ${id}.`);
      } catch (e) {
        return err(`Could not update ${singular}: ${(e as Error).message}`);
      }
    },
  );

  // DELETE
  server.registerTool(
    `delete_${singular}`,
    {
      title: `Delete ${singular}`,
      description: `Delete a ${singular} by ID. Child records are deleted too (cascade).`,
      inputSchema: { id: z.string().describe(`The ${singular} ID to delete`) },
    },
    async ({ id }: { id: string }) => {
      const deleted = store.delete(id);
      return deleted ? ok(`Deleted ${singular} ${id} (and any children).`) : err(`No ${singular} found with id ${id}.`);
    },
  );
}

// --- Formatters ---------------------------------------------------------------

function formatProject(p: Project): string {
  return [
    `${p.id} [${p.status}] ${p.name}`,
    p.description ? `  ${p.description}` : null,
    `  created: ${p.createdAt}  updated: ${p.updatedAt}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatMilestone(m: Milestone): string {
  return [
    `${m.id} [${m.status}] ${m.name}  (project: ${m.projectId})`,
    m.description ? `  ${m.description}` : null,
    m.dueDate ? `  due: ${m.dueDate}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatTask(t: Task): string {
  return [
    `${t.id} [${t.status}] ${t.title}  (milestone: ${t.milestoneId})`,
    t.description ? `  ${t.description}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatSpec(s: Spec): string {
  return [
    `${s.id} [${s.status}] ${s.title}  (task: ${s.taskId})`,
    s.content ? `  ${s.content}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// --- Status enums -------------------------------------------------------------

const projectStatus = ["planning", "active", "completed", "archived"] as const;
const milestoneStatus = ["planned", "in_progress", "completed"] as const;
const taskStatus = ["todo", "in_progress", "done"] as const;
const specStatus = ["draft", "approved", "implemented"] as const;

// --- Register entity tools ----------------------------------------------------

registerCrud<Project>({
  store: store.projects,
  singular: "project",
  plural: "projects",
  statusValues: projectStatus,
  createFields: {
    name: z.string().min(1).describe("Project name"),
    description: z.string().optional().describe("Optional description"),
    status: z.enum(projectStatus).optional().describe("Initial status (default: active)"),
  },
  updateFields: {
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    status: z.enum(projectStatus).optional(),
  },
  format: formatProject,
});

registerCrud<Milestone>({
  store: store.milestones,
  singular: "milestone",
  plural: "milestones",
  parent: { idParam: "projectId", label: "project" },
  statusValues: milestoneStatus,
  createFields: {
    name: z.string().min(1).describe("Milestone name"),
    description: z.string().optional().describe("Optional description"),
    status: z.enum(milestoneStatus).optional().describe("Initial status (default: planned)"),
    dueDate: z.string().optional().describe("Optional due date (ISO 8601)"),
  },
  updateFields: {
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    status: z.enum(milestoneStatus).optional(),
    dueDate: z.string().optional(),
  },
  format: formatMilestone,
});

registerCrud<Task>({
  store: store.tasks,
  singular: "task",
  plural: "tasks",
  parent: { idParam: "milestoneId", label: "milestone" },
  statusValues: taskStatus,
  createFields: {
    title: z.string().min(1).describe("Task title"),
    description: z.string().optional().describe("Optional description"),
    status: z.enum(taskStatus).optional().describe("Initial status (default: todo)"),
  },
  updateFields: {
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    status: z.enum(taskStatus).optional(),
  },
  format: formatTask,
});

registerCrud<Spec>({
  store: store.specs,
  singular: "spec",
  plural: "specs",
  parent: { idParam: "taskId", label: "task" },
  statusValues: specStatus,
  createFields: {
    title: z.string().min(1).describe("Spec title"),
    content: z.string().optional().describe("Spec content / body"),
    status: z.enum(specStatus).optional().describe("Initial status (default: draft)"),
  },
  updateFields: {
    title: z.string().min(1).optional(),
    content: z.string().optional(),
    status: z.enum(specStatus).optional(),
  },
  format: formatSpec,
});

// --- Tree view ----------------------------------------------------------------

/** A compact one-line rendering of an activity entry for the tree. */
function activityLine(a: TaskActivity): string {
  const when = a.createdAt.slice(0, 10); // YYYY-MM-DD
  if (a.kind === "status") {
    const change = a.fromStatus ? `${a.fromStatus} → ${a.toStatus}` : `created (${a.toStatus})`;
    return `↳ ${change}  · ${when}`;
  }
  const msg = a.message.length > 64 ? `${a.message.slice(0, 63)}…` : a.message;
  return `↳ “${msg}”  · ${when}`;
}

function renderTree(tree: ProjectTree): string {
  // A task is blocked when any prerequisite isn't done yet. Build a status map
  // across the whole project so we can name the unmet prerequisites.
  const statusById = new Map<string, string>();
  for (const m of tree.milestones) for (const t of m.tasks) statusById.set(t.id, t.status);

  const lines: string[] = [`${tree.id} [${tree.status}] ${tree.name}`];
  for (const m of tree.milestones) {
    lines.push(`  └─ ${m.id} [${m.status}] ${m.name}`);
    for (const t of m.tasks) {
      const unmet = t.dependsOn.filter((dep) => statusById.get(dep) !== "done");
      const tag =
        t.status !== "done" && unmet.length ? `  ⛔ blocked by ${unmet.join(", ")}` : "";
      lines.push(`      └─ ${t.id} [${t.status}] ${t.title}${tag}`);
      for (const a of t.recentActivity) {
        lines.push(`          ${activityLine(a)}`);
      }
      for (const s of t.specs) {
        lines.push(`          └─ ${s.id} [${s.status}] ${s.title}`);
      }
    }
  }
  return lines.join("\n");
}

server.registerTool(
  "get_project_tree",
  {
    title: "Get project tree",
    description:
      "Get the full nested hierarchy (milestones → tasks → specs) for a project. Each task shows its most recent activity; pass `activity` to widen or hide it.",
    inputSchema: {
      id: z.string().describe("The project ID, e.g. project-1"),
      activity: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Recent activity entries to show per task (default 1, 0 to hide)"),
    },
  },
  async ({ id, activity }: { id: string; activity?: number }) => {
    const tree = store.projectTree(id, activity ?? 1);
    return tree ? ok(renderTree(tree)) : err(`No project found with id ${id}.`);
  },
);

// --- Dependency planning ------------------------------------------------------

server.registerTool(
  "add_dependency",
  {
    title: "Add task dependency",
    description:
      "Declare that one task waits for another: taskId cannot start until dependsOnId is done. Both tasks must be in the same project; self-edges and cycles are rejected.",
    inputSchema: {
      taskId: z.string().describe("The dependent task, e.g. task-2"),
      dependsOnId: z.string().describe("The prerequisite task that must be done first, e.g. task-1"),
    },
  },
  async ({ taskId, dependsOnId }: { taskId: string; dependsOnId: string }) => {
    try {
      store.addDependency(taskId, dependsOnId);
      return ok(`${taskId} now depends on ${dependsOnId}.`);
    } catch (e) {
      return err(`Could not add dependency: ${(e as Error).message}`);
    }
  },
);

server.registerTool(
  "remove_dependency",
  {
    title: "Remove task dependency",
    description: "Remove a dependency edge between two tasks.",
    inputSchema: {
      taskId: z.string().describe("The dependent task"),
      dependsOnId: z.string().describe("The prerequisite task to detach"),
    },
  },
  async ({ taskId, dependsOnId }: { taskId: string; dependsOnId: string }) => {
    const removed = store.removeDependency(taskId, dependsOnId);
    return removed
      ? ok(`Removed dependency: ${taskId} no longer depends on ${dependsOnId}.`)
      : err(`No dependency from ${taskId} to ${dependsOnId}.`);
  },
);

server.registerTool(
  "get_next_actions",
  {
    title: "Get next actions",
    description:
      "List the tasks in a project that are ready to work on now — not done, with every prerequisite done. Ordered by in-progress first, then by how much downstream work each unblocks.",
    inputSchema: { projectId: z.string().describe("The project ID, e.g. project-1") },
  },
  async ({ projectId }: { projectId: string }) => {
    try {
      if (!store.projects.get(projectId)) return err(`No project found with id ${projectId}.`);
      const ready = store.nextActions(projectId);
      if (ready.length === 0) {
        return ok("No ready tasks — everything is done, blocked, or the project has no tasks.");
      }
      return ok(ready.map(formatTask).join("\n\n"));
    } catch (e) {
      return err(`Could not compute next actions: ${(e as Error).message}`);
    }
  },
);

server.registerTool(
  "get_critical_path",
  {
    title: "Get critical path",
    description:
      "Show the longest chain of dependent tasks in a project, in prerequisite-first order — the sequence that determines how soon the project can finish.",
    inputSchema: { projectId: z.string().describe("The project ID, e.g. project-1") },
  },
  async ({ projectId }: { projectId: string }) => {
    try {
      if (!store.projects.get(projectId)) return err(`No project found with id ${projectId}.`);
      const path = store.criticalPath(projectId);
      if (path.length === 0) return ok("No tasks in this project yet.");
      const chain = path.map((t) => `${t.id} [${t.status}] ${t.title}`).join("\n  ↓\n");
      return ok(`Critical path (${path.length} task${path.length === 1 ? "" : "s"}):\n\n${chain}`);
    } catch (e) {
      return err(`Could not compute critical path: ${(e as Error).message}`);
    }
  },
);

// --- Task activity & history --------------------------------------------------

function formatActivity(a: TaskActivity): string {
  if (a.kind === "status") {
    const transition = a.fromStatus ? `${a.fromStatus} → ${a.toStatus}` : `created (${a.toStatus})`;
    return `${a.id} [status] ${a.createdAt}  ${transition}`;
  }
  return `${a.id} [note]   ${a.createdAt}  ${a.message}`;
}

server.registerTool(
  "log_task",
  {
    title: "Log task activity",
    description:
      "Append a free-form note to a task's activity log — a record of what was done, decided, or attempted. Status changes are logged automatically; use this for everything else.",
    inputSchema: {
      taskId: z.string().describe("The task ID, e.g. task-1"),
      message: z.string().min(1).describe("What happened — progress, a decision, a blocker, a result"),
    },
  },
  async ({ taskId, message }: { taskId: string; message: string }) => {
    try {
      const entry = store.logTask(taskId, message);
      return ok(`Logged to ${taskId}:\n${formatActivity(entry)}`);
    } catch (e) {
      return err(`Could not log activity: ${(e as Error).message}`);
    }
  },
);

server.registerTool(
  "get_task_activity",
  {
    title: "Get task activity",
    description:
      "Return a task's full activity history, oldest first — status transitions (auto-recorded) interleaved with logged notes.",
    inputSchema: { id: z.string().describe("The task ID, e.g. task-1") },
  },
  async ({ id }: { id: string }) => {
    try {
      if (!store.tasks.get(id)) return err(`No task found with id ${id}.`);
      const log = store.taskActivity(id);
      if (log.length === 0) return ok(`No activity recorded for ${id} yet.`);
      const task = store.tasks.get(id)!;
      return ok(`History for ${id} [${task.status}] ${task.title}:\n\n${log.map(formatActivity).join("\n")}`);
    } catch (e) {
      return err(`Could not read activity: ${(e as Error).message}`);
    }
  },
);

// --- Global memory (Karpathy's system-prompt-learning / LLM Wiki) -------------

const memoryKind = MEMORY_KINDS;

function formatMemory(m: Memory): string {
  return [
    `${m.id} [${m.kind}] (salience ${m.salience})${m.tags.length ? "  #" + m.tags.join(" #") : ""}`,
    `  ${m.content}`,
    m.source ? `  source: ${m.source}` : null,
    `  created: ${m.createdAt}  updated: ${m.updatedAt}`,
  ]
    .filter(Boolean)
    .join("\n");
}

server.registerTool(
  "remember",
  {
    title: "Remember",
    description:
      "Write a memory note (lesson, fact, preference, or decision) to the global, cross-project memory.",
    inputSchema: {
      content: z.string().min(1).describe("The memory note text"),
      kind: z.enum(memoryKind).optional().describe("lesson | fact | preference | decision (default: lesson)"),
      tags: z.array(z.string()).optional().describe("Topic tags for filtering and recall"),
      source: z.string().optional().describe("Optional provenance (project, file, conversation)"),
      salience: z.number().int().min(1).max(5).optional().describe("Importance 1-5 (default 3)"),
    },
  },
  async (args) => {
    try {
      const m = memory.remember(args);
      return ok(`Remembered:\n${formatMemory(m)}`);
    } catch (e) {
      return err(`Could not remember: ${(e as Error).message}`);
    }
  },
);

server.registerTool(
  "recall",
  {
    title: "Recall",
    description: "Keyword-search the global memory and return the most relevant notes.",
    inputSchema: {
      query: z.string().min(1).describe("Keyword search query"),
      kind: z.enum(memoryKind).optional().describe("Filter by kind"),
      tags: z.array(z.string()).optional().describe("Filter by tags (all must match)"),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
    },
  },
  async ({ query, kind, tags, limit }) => {
    try {
      const results = memory.recall(query, { kind, tags, limit });
      if (results.length === 0) return ok("No matching memories.");
      return ok(results.map(formatMemory).join("\n\n"));
    } catch (e) {
      return err(`Could not recall: ${(e as Error).message}`);
    }
  },
);

server.registerTool(
  "list_memories",
  {
    title: "List memories",
    description: "List raw memory notes, newest first, optionally filtered by kind.",
    inputSchema: {
      kind: z.enum(memoryKind).optional().describe("Filter by kind"),
      limit: z.number().int().min(1).max(500).optional().describe("Max results (default 100)"),
    },
  },
  async ({ kind, limit }) => {
    const results = memory.list({ kind, limit });
    if (results.length === 0) return ok("No memories found.");
    return ok(results.map(formatMemory).join("\n\n"));
  },
);

server.registerTool(
  "get_memory",
  {
    title: "Get memory",
    description: "Get a single memory note by ID.",
    inputSchema: { id: z.string().describe("The memory ID, e.g. memory-1") },
  },
  async ({ id }) => {
    const m = memory.get(id);
    return m ? ok(formatMemory(m)) : err(`No memory found with id ${id}.`);
  },
);

server.registerTool(
  "update_memory",
  {
    title: "Update memory",
    description: "Update fields of a memory note.",
    inputSchema: {
      id: z.string().describe("The memory ID to update"),
      content: z.string().min(1).optional(),
      kind: z.enum(memoryKind).optional(),
      tags: z.array(z.string()).optional(),
      source: z.string().optional(),
      salience: z.number().int().min(1).max(5).optional(),
    },
  },
  async (args) => {
    const { id, ...values } = args as { id: string } & Record<string, unknown>;
    try {
      const m = memory.update(id, values);
      return m ? ok(`Updated memory:\n${formatMemory(m)}`) : err(`No memory found with id ${id}.`);
    } catch (e) {
      return err(`Could not update memory: ${(e as Error).message}`);
    }
  },
);

server.registerTool(
  "delete_memory",
  {
    title: "Delete memory",
    description: "Delete a memory note by ID.",
    inputSchema: { id: z.string().describe("The memory ID to delete") },
  },
  async ({ id }) => {
    const deleted = memory.delete(id);
    return deleted ? ok(`Deleted memory ${id}.`) : err(`No memory found with id ${id}.`);
  },
);

server.registerTool(
  "consolidate_memories",
  {
    title: "Consolidate memories",
    description:
      "Compile step: returns the current wiki, all raw notes, and likely duplicate pairs, with instructions to rewrite a single de-duplicated memory wiki. Read-only — does not modify anything.",
    inputSchema: {
      kind: z.enum(memoryKind).optional().describe("Scope the raw notes to one kind"),
    },
  },
  async ({ kind }) => {
    const wiki = memory.getWiki();
    const notes = memory.list({ kind, limit: 500 });
    const dups = memory.duplicateCandidates();

    const sections: string[] = [];
    sections.push("# CURRENT COMPILED WIKI\n\n" + (wiki ? wiki.content : "(none yet)"));
    sections.push(
      "# RAW NOTES (" + notes.length + ")\n\n" +
        (notes.length ? notes.map(formatMemory).join("\n\n") : "(no notes)"),
    );
    sections.push(
      "# LIKELY DUPLICATE PAIRS\n\n" +
        (dups.length
          ? dups.map((d) => `- ${d.a} ~ ${d.b} (score ${d.score.toFixed(2)})`).join("\n")
          : "(none detected)"),
    );
    sections.push(
      "# INSTRUCTIONS\n\n" +
        "Review the raw notes and duplicate candidates above. Rewrite them into a single, " +
        "de-duplicated, well-organized markdown wiki grouped by kind/topic, resolving any " +
        "contradictions and generalizing where useful. Then call `save_memory_wiki` with the " +
        "full markdown. Optionally call `delete_memory` on raw notes now fully captured in the wiki.",
    );
    return ok(sections.join("\n\n---\n\n"));
  },
);

server.registerTool(
  "save_memory_wiki",
  {
    title: "Save memory wiki",
    description:
      "Persist the model-authored compiled memory wiki (markdown). This is what the memory://global resource serves.",
    inputSchema: { content: z.string().min(1).describe("The full compiled markdown wiki") },
  },
  async ({ content }) => {
    const saved = memory.saveWiki(content);
    return ok(`Saved memory wiki (${saved.content.length} chars) at ${saved.updatedAt}.`);
  },
);

server.registerTool(
  "get_memory_wiki",
  {
    title: "Get memory wiki",
    description: "Read the compiled memory wiki (same content as the memory://global resource).",
    inputSchema: {},
  },
  async () => {
    const wiki = memory.getWiki();
    return wiki
      ? ok(wiki.content)
      : ok(
          "No memory wiki has been compiled yet. Use `consolidate_memories`, then `save_memory_wiki`.",
        );
  },
);

const EMPTY_WIKI =
  "# Global Memory\n\n_No memories have been consolidated yet._\n\n" +
  "Use the `remember` tool to capture notes, then `consolidate_memories` + `save_memory_wiki` to compile this wiki.";

server.registerResource(
  "global-memory",
  "memory://global",
  {
    title: "Global Memory (compiled wiki)",
    description:
      "Cross-project learned lessons, facts, preferences, and decisions. Auto-loaded into context.",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: memory.getWiki()?.content ?? EMPTY_WIKI,
      },
    ],
  }),
);

// --- Lifecycle ----------------------------------------------------------------

function shutdown() {
  store.close();
  memory.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr — stdout is reserved for the MCP protocol.
  console.error(
    `mcp-task-mgmt server running on stdio (tasks: ${dbPath}, memory: ${memoryDbPath})`,
  );
}

main().catch((e) => {
  console.error("Fatal error starting server:", e);
  process.exit(1);
});
