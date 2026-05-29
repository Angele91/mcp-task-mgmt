/**
 * SQLite-backed store (via better-sqlite3) for the four-level hierarchy:
 *
 *   Project ─< Milestone ─< Task ─< Spec
 *
 * Each level is exposed as a generic {@link EntityStore} with uniform CRUD.
 * Deletes cascade down the tree via SQLite foreign keys. IDs are exposed in a
 * readable "<prefix>-<n>" form (e.g. "project-1", "task-7") and parsed back to
 * numeric rowids internally.
 */
import Database from "better-sqlite3";

export type ProjectStatus = "planning" | "active" | "completed" | "archived";
export type MilestoneStatus = "planned" | "in_progress" | "completed";
export type TaskStatus = "todo" | "in_progress" | "done";
export type SpecStatus = "draft" | "approved" | "implemented";

export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Milestone {
  id: string;
  projectId: string;
  name: string;
  description: string;
  status: MilestoneStatus;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  milestoneId: string;
  title: string;
  description: string;
  status: TaskStatus;
  /** Linked GitHub issue/PR, as "owner/repo#number", or null. */
  githubIssue: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Spec {
  id: string;
  taskId: string;
  title: string;
  content: string;
  status: SpecStatus;
  createdAt: string;
  updatedAt: string;
}

/** A single acceptance criterion under a spec, with verification + test signals. */
export interface AcceptanceCriterion {
  id: string;
  specId: string;
  text: string;
  /** Confirmed to pass. */
  verified: boolean;
  /** Optional reference to the test that exercises it (file::name, CI job, …). */
  test: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Coverage stats for a spec's acceptance criteria. */
export interface Coverage {
  specId: string;
  total: number;
  verified: number;
  /** Criteria with a linked test (the Nyquist "sample"). */
  tested: number;
  /** Criteria with no linked test. */
  nyquistGaps: number;
  unverified: number;
  /** total > 0 and every criterion is both verified and tested. */
  fullyCovered: boolean;
}

export type ActivityKind = "status" | "note";

/** One append-only entry in a task's activity log (status change or note). */
export interface TaskActivity {
  id: string;
  taskId: string;
  kind: ActivityKind;
  /** Free-text note (for `note`); blank or an auto-summary for `status`. */
  message: string;
  /** Prior status, for `status` entries (null on creation / for notes). */
  fromStatus: string | null;
  /** New status, for `status` entries (null for notes). */
  toStatus: string | null;
  createdAt: string;
}

/** A task enriched with its prerequisite edges, as it appears in a tree. */
export interface TaskNode extends Task {
  specs: Spec[];
  /** IDs of tasks this one depends on (must be `done` first). */
  dependsOn: string[];
  /** Most recent activity entries, newest first (empty if not requested). */
  recentActivity: TaskActivity[];
}

/** A node in the rendered project tree. */
export interface ProjectTree extends Project {
  milestones: (Milestone & {
    tasks: TaskNode[];
  })[];
}

interface ParentRef {
  /** Column in this table that references the parent (e.g. "projectId"). */
  column: string;
  /** ID prefix of the parent entity (e.g. "project"). */
  prefix: string;
}

interface EntityConfig<T = unknown> {
  table: string;
  /** ID prefix for this entity (e.g. "milestone"). */
  prefix: string;
  /** Mutable, settable columns (excludes id / parent / timestamps). */
  fields: string[];
  parent?: ParentRef;
  /** Optional side-effects fired after a successful create/update. */
  hooks?: {
    onCreate?(entity: T): void;
    onUpdate?(before: T, after: T): void;
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function formatId(prefix: string, rowid: number | bigint): string {
  return `${prefix}-${rowid}`;
}

export function parseId(prefix: string, id: string): number | undefined {
  const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
  return match ? Number(match[1]) : undefined;
}

/**
 * Generic CRUD over a single table. Returned objects use prefixed string IDs
 * for both the row's own id and its parent reference.
 */
export class EntityStore<T> {
  constructor(
    private readonly db: Database.Database,
    private readonly cfg: EntityConfig<T>,
  ) {}

  private mapRow(row: Record<string, unknown>): T {
    const out: Record<string, unknown> = { ...row };
    out.id = formatId(this.cfg.prefix, row.id as number);
    if (this.cfg.parent) {
      const { column, prefix } = this.cfg.parent;
      out[column] = formatId(prefix, row[column] as number);
    }
    return out as T;
  }

  /**
   * @param parentId Prefixed parent ID, or null for a root entity (project).
   * @param values   Mutable field values (only defined keys are written; the
   *                  rest fall back to column defaults).
   */
  create(parentId: string | null, values: Record<string, unknown>): T {
    const cols: string[] = [];
    const params: Record<string, unknown> = {};

    for (const field of this.cfg.fields) {
      if (values[field] !== undefined) {
        cols.push(field);
        params[field] = values[field];
      }
    }

    if (this.cfg.parent) {
      const numeric = parentId === null ? undefined : parseId(this.cfg.parent.prefix, parentId);
      if (numeric === undefined) {
        throw new Error(
          `Invalid ${this.cfg.parent.prefix} id: ${parentId ?? "(missing)"}`,
        );
      }
      cols.push(this.cfg.parent.column);
      params[this.cfg.parent.column] = numeric;
    }

    const ts = nowIso();
    cols.push("createdAt", "updatedAt");
    params.createdAt = ts;
    params.updatedAt = ts;

    const placeholders = cols.map((c) => `@${c}`).join(", ");
    const info = this.db
      .prepare(`INSERT INTO ${this.cfg.table} (${cols.join(", ")}) VALUES (${placeholders})`)
      .run(params);

    const entity = this.get(formatId(this.cfg.prefix, info.lastInsertRowid))!;
    this.cfg.hooks?.onCreate?.(entity);
    return entity;
  }

  get(id: string): T | undefined {
    const numeric = parseId(this.cfg.prefix, id);
    if (numeric === undefined) return undefined;
    const row = this.db
      .prepare(`SELECT * FROM ${this.cfg.table} WHERE id = ?`)
      .get(numeric) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  list(parentId?: string, filter?: { status?: string }): T[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (this.cfg.parent && parentId !== undefined) {
      const numeric = parseId(this.cfg.parent.prefix, parentId);
      if (numeric === undefined) {
        throw new Error(`Invalid ${this.cfg.parent.prefix} id: ${parentId}`);
      }
      where.push(`${this.cfg.parent.column} = @parentId`);
      params.parentId = numeric;
    }
    if (filter?.status) {
      where.push(`status = @status`);
      params.status = filter.status;
    }

    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM ${this.cfg.table} ${clause} ORDER BY id`)
      .all(params) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  update(id: string, values: Record<string, unknown>): T | undefined {
    const numeric = parseId(this.cfg.prefix, id);
    if (numeric === undefined) return undefined;
    const before = this.get(id);
    if (!before) return undefined;

    const sets: string[] = [];
    const params: Record<string, unknown> = { id: numeric };
    for (const field of this.cfg.fields) {
      if (values[field] !== undefined) {
        sets.push(`${field} = @${field}`);
        params[field] = values[field];
      }
    }
    sets.push(`updatedAt = @updatedAt`);
    params.updatedAt = nowIso();

    this.db
      .prepare(`UPDATE ${this.cfg.table} SET ${sets.join(", ")} WHERE id = @id`)
      .run(params);
    const after = this.get(id)!;
    this.cfg.hooks?.onUpdate?.(before, after);
    return after;
  }

  delete(id: string): boolean {
    const numeric = parseId(this.cfg.prefix, id);
    if (numeric === undefined) return false;
    const info = this.db.prepare(`DELETE FROM ${this.cfg.table} WHERE id = ?`).run(numeric);
    return info.changes > 0;
  }
}

export class Store {
  private db: Database.Database;

  readonly projects: EntityStore<Project>;
  readonly milestones: EntityStore<Milestone>;
  readonly tasks: EntityStore<Task>;
  readonly specs: EntityStore<Spec>;

  /**
   * @param path SQLite file path, or ":memory:" for an ephemeral database.
   */
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();

    this.projects = new EntityStore<Project>(this.db, {
      table: "projects",
      prefix: "project",
      fields: ["name", "description", "status"],
    });
    this.milestones = new EntityStore<Milestone>(this.db, {
      table: "milestones",
      prefix: "milestone",
      fields: ["name", "description", "status", "dueDate"],
      parent: { column: "projectId", prefix: "project" },
    });
    this.tasks = new EntityStore<Task>(this.db, {
      table: "tasks",
      prefix: "task",
      fields: ["title", "description", "status"],
      parent: { column: "milestoneId", prefix: "milestone" },
      hooks: {
        onCreate: (t) => this.recordActivity(t.id, "status", "", null, t.status),
        onUpdate: (before, after) => {
          if (before.status !== after.status) {
            this.recordActivity(after.id, "status", "", before.status, after.status);
          }
        },
      },
    });
    this.specs = new EntityStore<Spec>(this.db, {
      table: "specs",
      prefix: "spec",
      fields: ["title", "content", "status"],
      parent: { column: "taskId", prefix: "task" },
    });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('planning','active','completed','archived')),
        createdAt   TEXT NOT NULL,
        updatedAt   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS milestones (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        projectId   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'planned'
                      CHECK (status IN ('planned','in_progress','completed')),
        dueDate     TEXT,
        createdAt   TEXT NOT NULL,
        updatedAt   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        milestoneId INTEGER NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'todo'
                      CHECK (status IN ('todo','in_progress','done')),
        githubIssue TEXT,
        createdAt   TEXT NOT NULL,
        updatedAt   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS specs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        taskId      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        content     TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','approved','implemented')),
        createdAt   TEXT NOT NULL,
        updatedAt   TEXT NOT NULL
      );

      -- Cross-cutting dependency edges between tasks. A row (taskId, dependsOnId)
      -- means taskId must not start until dependsOnId is done. Both endpoints are
      -- tasks; deleting either side removes the edge (cascade).
      CREATE TABLE IF NOT EXISTS task_dependencies (
        taskId      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        dependsOnId INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        PRIMARY KEY (taskId, dependsOnId)
      );

      -- Append-only activity log per task: status transitions (auto-recorded on
      -- create/update) and free-form notes (logged explicitly). Ordered by id.
      CREATE TABLE IF NOT EXISTS task_activity (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        taskId      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL CHECK (kind IN ('status','note')),
        message     TEXT NOT NULL DEFAULT '',
        fromStatus  TEXT,
        toStatus    TEXT,
        createdAt   TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_milestones_projectId ON milestones(projectId);
      CREATE INDEX IF NOT EXISTS idx_tasks_milestoneId    ON tasks(milestoneId);
      CREATE INDEX IF NOT EXISTS idx_specs_taskId         ON specs(taskId);
      CREATE INDEX IF NOT EXISTS idx_deps_dependsOnId     ON task_dependencies(dependsOnId);
      -- Acceptance criteria under a spec (spec ─< criterion). Each carries a
      -- verified flag and an optional test reference; deleting a spec cascades.
      CREATE TABLE IF NOT EXISTS acceptance_criteria (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        specId      INTEGER NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
        text        TEXT NOT NULL,
        verified    INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
        test        TEXT,
        createdAt   TEXT NOT NULL,
        updatedAt   TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_activity_taskId      ON task_activity(taskId);
      CREATE INDEX IF NOT EXISTS idx_criteria_specId      ON acceptance_criteria(specId);
    `);

    // Columns added after the initial release: add them to pre-existing tables.
    const taskCols = this.db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
    if (!taskCols.some((c) => c.name === "githubIssue")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN githubIssue TEXT`);
    }
  }

  /**
   * Build the full nested tree for a project, or undefined if not found.
   *
   * @param activityLimit How many recent activity entries to attach per task
   *   (newest first). 0 attaches none. Defaults to 1.
   */
  projectTree(projectId: string, activityLimit = 1): ProjectTree | undefined {
    const project = this.projects.get(projectId);
    if (!project) return undefined;
    const milestones = this.milestones.list(projectId).map((milestone) => {
      const tasks = this.tasks.list(milestone.id).map((task) => ({
        ...task,
        specs: this.specs.list(task.id),
        dependsOn: this.dependencyIds(task.id),
        recentActivity: activityLimit > 0 ? this.recentActivity(task.id, activityLimit) : [],
      }));
      return { ...milestone, tasks };
    });
    return { ...project, milestones };
  }

  // --- Dependency graph -------------------------------------------------------
  //
  // Edges live in task_dependencies as (taskId → dependsOnId): "taskId waits for
  // dependsOnId". The graph is kept acyclic by addDependency's cycle guard, so
  // the longest-path / topological routines below always terminate.

  /** Numeric project rowid that owns a task rowid, or undefined if not found. */
  private taskProjectRowid(rowid: number): number | undefined {
    const row = this.db
      .prepare(
        `SELECT m.projectId AS pid FROM tasks t
           JOIN milestones m ON t.milestoneId = m.id
          WHERE t.id = ?`,
      )
      .get(rowid) as { pid: number } | undefined;
    return row?.pid;
  }

  /** All edges as numeric rowid pairs. */
  private edges(): { taskId: number; dependsOnId: number }[] {
    return this.db
      .prepare(`SELECT taskId, dependsOnId FROM task_dependencies`)
      .all() as { taskId: number; dependsOnId: number }[];
  }

  /** taskId → [dependsOnId, …] (prerequisites). */
  private adjacency(): Map<number, number[]> {
    const adj = new Map<number, number[]>();
    for (const { taskId, dependsOnId } of this.edges()) {
      const arr = adj.get(taskId);
      if (arr) arr.push(dependsOnId);
      else adj.set(taskId, [dependsOnId]);
    }
    return adj;
  }

  /** Does `start` transitively depend on `target` (following dependsOn edges)? */
  private dependsOnTransitively(start: number, target: number): boolean {
    const adj = this.adjacency();
    const seen = new Set<number>();
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const next of adj.get(cur) ?? []) {
        if (next === target) return true;
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  }

  /** Task rows (id + status) for a project, ordered by id. */
  private projectTaskRows(projectId: string): { id: number; status: string }[] {
    const pid = parseId("project", projectId);
    if (pid === undefined) throw new Error(`Invalid project id: ${projectId}`);
    return this.db
      .prepare(
        `SELECT t.id AS id, t.status AS status FROM tasks t
           JOIN milestones m ON t.milestoneId = m.id
          WHERE m.projectId = ? ORDER BY t.id`,
      )
      .all(pid) as { id: number; status: string }[];
  }

  /**
   * Add a dependency: `taskId` waits for `dependsOnId`. Both tasks must exist and
   * belong to the same project; self-edges and cycles are rejected. Idempotent.
   */
  addDependency(taskId: string, dependsOnId: string): void {
    const a = parseId("task", taskId);
    const b = parseId("task", dependsOnId);
    if (a === undefined) throw new Error(`Invalid task id: ${taskId}`);
    if (b === undefined) throw new Error(`Invalid task id: ${dependsOnId}`);
    if (a === b) throw new Error("A task cannot depend on itself");
    if (!this.tasks.get(taskId)) throw new Error(`No task found with id ${taskId}`);
    if (!this.tasks.get(dependsOnId)) throw new Error(`No task found with id ${dependsOnId}`);
    if (this.taskProjectRowid(a) !== this.taskProjectRowid(b)) {
      throw new Error("Dependencies must be between tasks in the same project");
    }
    // Adding a→b cycles iff b already (transitively) depends on a.
    if (this.dependsOnTransitively(b, a)) {
      throw new Error(`Adding this dependency would create a cycle (${dependsOnId} already depends on ${taskId})`);
    }
    this.db
      .prepare(`INSERT OR IGNORE INTO task_dependencies (taskId, dependsOnId) VALUES (?, ?)`)
      .run(a, b);
  }

  /** Remove a dependency edge. Returns true if an edge was removed. */
  removeDependency(taskId: string, dependsOnId: string): boolean {
    const a = parseId("task", taskId);
    const b = parseId("task", dependsOnId);
    if (a === undefined || b === undefined) return false;
    const info = this.db
      .prepare(`DELETE FROM task_dependencies WHERE taskId = ? AND dependsOnId = ?`)
      .run(a, b);
    return info.changes > 0;
  }

  /** Prefixed IDs of the tasks a task depends on (its prerequisites). */
  dependencyIds(taskId: string): string[] {
    const a = parseId("task", taskId);
    if (a === undefined) return [];
    const rows = this.db
      .prepare(`SELECT dependsOnId FROM task_dependencies WHERE taskId = ? ORDER BY dependsOnId`)
      .all(a) as { dependsOnId: number }[];
    return rows.map((r) => formatId("task", r.dependsOnId));
  }

  /** Prefixed IDs of the tasks that depend on a task (its dependents). */
  dependentIds(taskId: string): string[] {
    const a = parseId("task", taskId);
    if (a === undefined) return [];
    const rows = this.db
      .prepare(`SELECT taskId FROM task_dependencies WHERE dependsOnId = ? ORDER BY taskId`)
      .all(a) as { taskId: number }[];
    return rows.map((r) => formatId("task", r.taskId));
  }

  /** Transitive-dependent count per task rowid (how much work each unblocks). */
  private transitiveDependentCounts(ids: number[]): Map<number, number> {
    const rev = new Map<number, number[]>(); // dependsOnId → [tasks depending on it]
    for (const { taskId, dependsOnId } of this.edges()) {
      const arr = rev.get(dependsOnId);
      if (arr) arr.push(taskId);
      else rev.set(dependsOnId, [taskId]);
    }
    const counts = new Map<number, number>();
    for (const id of ids) {
      const seen = new Set<number>();
      const stack = [...(rev.get(id) ?? [])];
      while (stack.length) {
        const cur = stack.pop()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const next of rev.get(cur) ?? []) stack.push(next);
      }
      counts.set(id, seen.size);
    }
    return counts;
  }

  /**
   * Tasks in a project that are ready to work on: not `done`, with every
   * prerequisite `done`. Ordered by in-progress first, then by how much
   * downstream work each unblocks (descending), then by id.
   */
  nextActions(projectId: string): Task[] {
    const rows = this.projectTaskRows(projectId);
    const statusById = new Map(rows.map((r) => [r.id, r.status]));
    const adj = this.adjacency();
    const ready = rows.filter(
      (r) =>
        r.status !== "done" &&
        (adj.get(r.id) ?? []).every((dep) => statusById.get(dep) === "done"),
    );
    const impact = this.transitiveDependentCounts(ready.map((r) => r.id));
    ready.sort((x, y) => {
      const sx = x.status === "in_progress" ? 0 : 1;
      const sy = y.status === "in_progress" ? 0 : 1;
      if (sx !== sy) return sx - sy;
      const ix = impact.get(x.id) ?? 0;
      const iy = impact.get(y.id) ?? 0;
      if (ix !== iy) return iy - ix;
      return x.id - y.id;
    });
    return ready.map((r) => this.tasks.get(formatId("task", r.id))!);
  }

  /**
   * The critical path: the longest chain of dependent tasks in a project, in
   * prerequisite-first order. Length is measured in task count (no durations).
   * Ties are broken toward the lowest task id for determinism.
   */
  criticalPath(projectId: string): Task[] {
    const rows = this.projectTaskRows(projectId);
    const inProject = new Set(rows.map((r) => r.id));
    const adj = this.adjacency();
    const len = new Map<number, number>();
    const prev = new Map<number, number | null>();

    const longestEndingAt = (id: number): number => {
      const cached = len.get(id);
      if (cached !== undefined) return cached;
      let best = 1;
      let bestPrev: number | null = null;
      for (const dep of adj.get(id) ?? []) {
        if (!inProject.has(dep)) continue;
        const candidate = 1 + longestEndingAt(dep);
        if (candidate > best || (candidate === best && (bestPrev === null || dep < bestPrev))) {
          best = candidate;
          bestPrev = dep;
        }
      }
      len.set(id, best);
      prev.set(id, bestPrev);
      return best;
    };

    let endNode: number | null = null;
    let max = 0;
    for (const r of rows) {
      const l = longestEndingAt(r.id);
      if (l > max || (l === max && endNode !== null && r.id < endNode)) {
        max = l;
        endNode = r.id;
      }
    }
    if (endNode === null) return [];

    const chain: number[] = [];
    let cur: number | null = endNode;
    while (cur !== null) {
      chain.push(cur);
      cur = prev.get(cur) ?? null;
    }
    chain.reverse(); // prerequisite-first
    return chain.map((id) => this.tasks.get(formatId("task", id))!);
  }

  // --- Task activity log ------------------------------------------------------
  //
  // An append-only history per task. Status transitions are recorded
  // automatically by the tasks store hooks above; notes are added via logTask.

  private mapActivityRow(row: Record<string, unknown>): TaskActivity {
    return {
      id: formatId("activity", row.id as number),
      taskId: formatId("task", row.taskId as number),
      kind: row.kind as ActivityKind,
      message: row.message as string,
      fromStatus: (row.fromStatus as string | null) ?? null,
      toStatus: (row.toStatus as string | null) ?? null,
      createdAt: row.createdAt as string,
    };
  }

  /** Insert one activity row and return it. Assumes a valid task id. */
  private recordActivity(
    taskId: string,
    kind: ActivityKind,
    message: string,
    fromStatus: string | null,
    toStatus: string | null,
  ): TaskActivity {
    const tid = parseId("task", taskId);
    if (tid === undefined) throw new Error(`Invalid task id: ${taskId}`);
    const info = this.db
      .prepare(
        `INSERT INTO task_activity (taskId, kind, message, fromStatus, toStatus, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(tid, kind, message, fromStatus, toStatus, nowIso());
    const row = this.db
      .prepare(`SELECT * FROM task_activity WHERE id = ?`)
      .get(info.lastInsertRowid) as Record<string, unknown>;
    return this.mapActivityRow(row);
  }

  /** Append a free-form note to a task's activity log. */
  logTask(taskId: string, message: string): TaskActivity {
    if (!this.tasks.get(taskId)) throw new Error(`No task found with id ${taskId}`);
    return this.recordActivity(taskId, "note", message, null, null);
  }

  /**
   * Set or clear a task's linked GitHub issue (`ref` as "owner/repo#number",
   * or null to unlink). Records an activity note. Returns the updated task.
   */
  setTaskGithubIssue(taskId: string, ref: string | null): Task | undefined {
    const numeric = parseId("task", taskId);
    if (numeric === undefined) return undefined;
    if (!this.tasks.get(taskId)) return undefined;
    this.db
      .prepare(`UPDATE tasks SET githubIssue = ?, updatedAt = ? WHERE id = ?`)
      .run(ref, nowIso(), numeric);
    this.recordActivity(
      taskId,
      "note",
      ref ? `Linked GitHub issue ${ref}` : "Unlinked GitHub issue",
      null,
      null,
    );
    return this.tasks.get(taskId);
  }

  /** The full activity log for a task, oldest first. */
  taskActivity(taskId: string): TaskActivity[] {
    const tid = parseId("task", taskId);
    if (tid === undefined) throw new Error(`Invalid task id: ${taskId}`);
    const rows = this.db
      .prepare(`SELECT * FROM task_activity WHERE taskId = ? ORDER BY id`)
      .all(tid) as Record<string, unknown>[];
    return rows.map((r) => this.mapActivityRow(r));
  }

  /** The most recent activity entries for a task, newest first. */
  recentActivity(taskId: string, limit = 1): TaskActivity[] {
    const tid = parseId("task", taskId);
    if (tid === undefined) return [];
    const rows = this.db
      .prepare(`SELECT * FROM task_activity WHERE taskId = ? ORDER BY id DESC LIMIT ?`)
      .all(tid, limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapActivityRow(r));
  }

  // --- Acceptance criteria & coverage -----------------------------------------
  //
  // Criteria hang off specs (spec ─< criterion). Each has a `verified` flag and
  // an optional `test` reference. Coverage combines both: "tested" means a test
  // is linked (the Nyquist sample); "fully covered" means verified AND tested.

  private mapCriterionRow(row: Record<string, unknown>): AcceptanceCriterion {
    return {
      id: formatId("ac", row.id as number),
      specId: formatId("spec", row.specId as number),
      text: row.text as string,
      verified: Boolean(row.verified),
      test: (row.test as string | null) ?? null,
      createdAt: row.createdAt as string,
      updatedAt: row.updatedAt as string,
    };
  }

  /** Add an acceptance criterion to a spec. */
  createCriterion(specId: string, text: string, test: string | null = null): AcceptanceCriterion {
    const sid = parseId("spec", specId);
    if (sid === undefined) throw new Error(`Invalid spec id: ${specId}`);
    if (!this.specs.get(specId)) throw new Error(`No spec found with id ${specId}`);
    const ts = nowIso();
    const info = this.db
      .prepare(
        `INSERT INTO acceptance_criteria (specId, text, verified, test, createdAt, updatedAt)
         VALUES (?, ?, 0, ?, ?, ?)`,
      )
      .run(sid, text, test, ts, ts);
    return this.getCriterion(formatId("ac", info.lastInsertRowid))!;
  }

  getCriterion(id: string): AcceptanceCriterion | undefined {
    const numeric = parseId("ac", id);
    if (numeric === undefined) return undefined;
    const row = this.db
      .prepare(`SELECT * FROM acceptance_criteria WHERE id = ?`)
      .get(numeric) as Record<string, unknown> | undefined;
    return row ? this.mapCriterionRow(row) : undefined;
  }

  /** Criteria for a spec, oldest first. */
  listCriteria(specId: string): AcceptanceCriterion[] {
    const sid = parseId("spec", specId);
    if (sid === undefined) throw new Error(`Invalid spec id: ${specId}`);
    const rows = this.db
      .prepare(`SELECT * FROM acceptance_criteria WHERE specId = ? ORDER BY id`)
      .all(sid) as Record<string, unknown>[];
    return rows.map((r) => this.mapCriterionRow(r));
  }

  /**
   * Update a criterion. `test: ""` clears the link; `test: null` leaves it as-is
   * (so callers can update only what they pass).
   */
  updateCriterion(
    id: string,
    values: { text?: string; verified?: boolean; test?: string | null },
  ): AcceptanceCriterion | undefined {
    const numeric = parseId("ac", id);
    if (numeric === undefined) return undefined;
    if (!this.getCriterion(id)) return undefined;

    const sets: string[] = [];
    const params: Record<string, unknown> = { id: numeric };
    if (values.text !== undefined) {
      sets.push(`text = @text`);
      params.text = values.text;
    }
    if (values.verified !== undefined) {
      sets.push(`verified = @verified`);
      params.verified = values.verified ? 1 : 0;
    }
    if (values.test !== undefined) {
      sets.push(`test = @test`);
      params.test = values.test === "" ? null : values.test;
    }
    sets.push(`updatedAt = @updatedAt`);
    params.updatedAt = nowIso();

    this.db
      .prepare(`UPDATE acceptance_criteria SET ${sets.join(", ")} WHERE id = @id`)
      .run(params);
    return this.getCriterion(id);
  }

  deleteCriterion(id: string): boolean {
    const numeric = parseId("ac", id);
    if (numeric === undefined) return false;
    const info = this.db.prepare(`DELETE FROM acceptance_criteria WHERE id = ?`).run(numeric);
    return info.changes > 0;
  }

  /** Coverage stats for a single spec's criteria. */
  coverageForSpec(specId: string): Coverage {
    const criteria = this.listCriteria(specId);
    const total = criteria.length;
    const verified = criteria.filter((c) => c.verified).length;
    const tested = criteria.filter((c) => c.test).length;
    return {
      specId,
      total,
      verified,
      tested,
      nyquistGaps: total - tested,
      unverified: total - verified,
      fullyCovered: total > 0 && verified === total && tested === total,
    };
  }

  /** Prefixed spec IDs belonging to a project, in id order. */
  private specIdsForProject(projectId: string): string[] {
    const pid = parseId("project", projectId);
    if (pid === undefined) throw new Error(`Invalid project id: ${projectId}`);
    const rows = this.db
      .prepare(
        `SELECT s.id AS id FROM specs s
           JOIN tasks t      ON s.taskId = t.id
           JOIN milestones m ON t.milestoneId = m.id
          WHERE m.projectId = ? ORDER BY s.id`,
      )
      .all(pid) as { id: number }[];
    return rows.map((r) => formatId("spec", r.id));
  }

  /** Coverage for every spec in a project (Nyquist audit). */
  coverageForProject(projectId: string): Coverage[] {
    return this.specIdsForProject(projectId).map((id) => this.coverageForSpec(id));
  }

  close(): void {
    this.db.close();
  }
}
