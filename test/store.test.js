import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../dist/store.js";

// Each test gets a fresh in-memory store for full isolation.
let store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => {
  store.close();
});

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Build a full one-of-each tree; returns the created entities. */
function seedTree() {
  const project = store.projects.create(null, { name: "Apollo" });
  const milestone = store.milestones.create(project.id, { name: "Launch" });
  const task = store.tasks.create(milestone.id, { title: "Build rocket" });
  const spec = store.specs.create(task.id, { title: "Engine spec" });
  return { project, milestone, task, spec };
}

describe("projects (root entity)", () => {
  it("creates with a prefixed id, defaults, and ISO timestamps", () => {
    const p = store.projects.create(null, { name: "Apollo" });
    assert.equal(p.id, "project-1");
    assert.equal(p.name, "Apollo");
    assert.equal(p.description, "");
    assert.equal(p.status, "active");
    assert.match(p.createdAt, ISO_RE);
    assert.equal(p.createdAt, p.updatedAt);
  });

  it("honors explicit description and status", () => {
    const p = store.projects.create(null, {
      name: "X",
      description: "desc",
      status: "planning",
    });
    assert.equal(p.description, "desc");
    assert.equal(p.status, "planning");
  });

  it("auto-increments ids", () => {
    assert.equal(store.projects.create(null, { name: "a" }).id, "project-1");
    assert.equal(store.projects.create(null, { name: "b" }).id, "project-2");
  });

  it("rejects an invalid status via the DB CHECK constraint", () => {
    assert.throws(() => store.projects.create(null, { name: "x", status: "bogus" }), /CHECK constraint/);
  });
});

describe("child entities and parent references", () => {
  it("returns the parent id in prefixed form", () => {
    const p = store.projects.create(null, { name: "P" });
    const m = store.milestones.create(p.id, { name: "M" });
    assert.equal(m.id, "milestone-1");
    assert.equal(m.projectId, "project-1");
  });

  it("defaults milestone status to planned and dueDate to null", () => {
    const p = store.projects.create(null, { name: "P" });
    const m = store.milestones.create(p.id, { name: "M" });
    assert.equal(m.status, "planned");
    assert.equal(m.dueDate, null);
  });

  it("stores a milestone dueDate when provided", () => {
    const p = store.projects.create(null, { name: "P" });
    const m = store.milestones.create(p.id, { name: "M", dueDate: "2026-07-01" });
    assert.equal(m.dueDate, "2026-07-01");
  });

  it("defaults task status to todo and spec status to draft", () => {
    const { task, spec } = seedTree();
    assert.equal(task.status, "todo");
    assert.equal(spec.status, "draft");
  });

  it("specs use a content field", () => {
    const { task } = seedTree();
    const s = store.specs.create(task.id, { title: "S", content: "the body" });
    assert.equal(s.content, "the body");
  });

  it("rejects a nonexistent parent via the foreign key constraint", () => {
    assert.throws(() => store.milestones.create("project-999", { name: "orphan" }), /FOREIGN KEY constraint/);
  });

  it("rejects a malformed parent id before touching the DB", () => {
    assert.throws(() => store.milestones.create("bogus", { name: "orphan" }), /Invalid project id/);
  });
});

describe("get", () => {
  it("returns a stored entity", () => {
    const p = store.projects.create(null, { name: "P" });
    assert.deepEqual(store.projects.get(p.id), p);
  });

  it("returns undefined for nonexistent or malformed ids", () => {
    assert.equal(store.projects.get("project-999"), undefined);
    assert.equal(store.projects.get("not-an-id"), undefined);
    assert.equal(store.projects.get("milestone-1"), undefined); // wrong prefix
  });
});

describe("list", () => {
  it("returns all entities ordered by id ascending", () => {
    store.projects.create(null, { name: "a" });
    store.projects.create(null, { name: "b" });
    store.projects.create(null, { name: "c" });
    assert.deepEqual(
      store.projects.list().map((p) => p.id),
      ["project-1", "project-2", "project-3"],
    );
  });

  it("scopes children to a parent", () => {
    const p1 = store.projects.create(null, { name: "P1" });
    const p2 = store.projects.create(null, { name: "P2" });
    store.milestones.create(p1.id, { name: "M1a" });
    store.milestones.create(p1.id, { name: "M1b" });
    store.milestones.create(p2.id, { name: "M2a" });

    assert.equal(store.milestones.list(p1.id).length, 2);
    assert.equal(store.milestones.list(p2.id).length, 1);
    assert.equal(store.milestones.list().length, 3); // no scope = all
  });

  it("filters by status", () => {
    store.projects.create(null, { name: "a", status: "active" });
    store.projects.create(null, { name: "b", status: "archived" });
    store.projects.create(null, { name: "c", status: "archived" });
    assert.equal(store.projects.list(undefined, { status: "archived" }).length, 2);
  });

  it("combines parent scope and status filter", () => {
    const p = store.projects.create(null, { name: "P" });
    store.milestones.create(p.id, { name: "done", status: "completed" });
    store.milestones.create(p.id, { name: "pending", status: "planned" });
    const completed = store.milestones.list(p.id, { status: "completed" });
    assert.equal(completed.length, 1);
    assert.equal(completed[0].name, "done");
  });

  it("rejects a malformed parent id", () => {
    assert.throws(() => store.milestones.list("bogus"), /Invalid project id/);
  });
});

describe("update", () => {
  it("updates only provided fields and preserves createdAt", () => {
    const p = store.projects.create(null, { name: "old", description: "d" });
    const updated = store.projects.update(p.id, { name: "new", status: "completed" });
    assert.equal(updated.name, "new");
    assert.equal(updated.status, "completed");
    assert.equal(updated.description, "d"); // untouched
    assert.equal(updated.createdAt, p.createdAt);
  });

  it("does not change the parent reference", () => {
    const { milestone } = seedTree();
    const updated = store.milestones.update(milestone.id, { name: "renamed" });
    assert.equal(updated.projectId, "project-1");
  });

  it("returns undefined for nonexistent or malformed ids", () => {
    assert.equal(store.projects.update("project-999", { name: "x" }), undefined);
    assert.equal(store.projects.update("bogus", { name: "x" }), undefined);
  });
});

describe("delete and cascade", () => {
  it("deletes an entity and reports success", () => {
    const p = store.projects.create(null, { name: "P" });
    assert.equal(store.projects.delete(p.id), true);
    assert.equal(store.projects.get(p.id), undefined);
  });

  it("returns false for nonexistent or malformed ids", () => {
    assert.equal(store.projects.delete("project-999"), false);
    assert.equal(store.projects.delete("bogus"), false);
  });

  it("cascades from project down to specs", () => {
    const { project, milestone, task, spec } = seedTree();
    store.projects.delete(project.id);
    assert.equal(store.milestones.get(milestone.id), undefined);
    assert.equal(store.tasks.get(task.id), undefined);
    assert.equal(store.specs.get(spec.id), undefined);
  });

  it("cascades from a milestone but leaves the project and siblings intact", () => {
    const { project, milestone, task, spec } = seedTree();
    const sibling = store.milestones.create(project.id, { name: "Sibling" });

    store.milestones.delete(milestone.id);
    assert.equal(store.tasks.get(task.id), undefined);
    assert.equal(store.specs.get(spec.id), undefined);
    assert.ok(store.projects.get(project.id)); // project survives
    assert.ok(store.milestones.get(sibling.id)); // sibling survives
  });
});

describe("projectTree", () => {
  it("builds the full nested hierarchy", () => {
    const { project } = seedTree();
    const tree = store.projectTree(project.id);
    assert.equal(tree.id, "project-1");
    assert.equal(tree.milestones.length, 1);
    assert.equal(tree.milestones[0].tasks.length, 1);
    assert.equal(tree.milestones[0].tasks[0].specs.length, 1);
    assert.equal(tree.milestones[0].tasks[0].specs[0].title, "Engine spec");
  });

  it("returns a project with empty children when there are none", () => {
    const p = store.projects.create(null, { name: "Empty" });
    const tree = store.projectTree(p.id);
    assert.deepEqual(tree.milestones, []);
  });

  it("returns undefined for a nonexistent project", () => {
    assert.equal(store.projectTree("project-999"), undefined);
  });
});

describe("isolation", () => {
  it("two stores do not share state", () => {
    const a = new Store(":memory:");
    const b = new Store(":memory:");
    a.projects.create(null, { name: "only in a" });
    assert.equal(a.projects.list().length, 1);
    assert.equal(b.projects.list().length, 0);
    a.close();
    b.close();
  });
});

describe("migration: githubIssue column", () => {
  // In-memory stores always CREATE tasks with githubIssue, so the ALTER-TABLE
  // branch only fires for databases that predate v0.5.0. Simulate one on disk.
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mig-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write a pre-v0.5.0 tasks table (no githubIssue column) to dbPath. */
  function seedOldDb(dbPath) {
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE tasks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        milestoneId INTEGER NOT NULL,
        title       TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'todo',
        createdAt   TEXT NOT NULL,
        updatedAt   TEXT NOT NULL
      );
    `);
    const cols = raw.prepare(`PRAGMA table_info(tasks)`).all().map((c) => c.name);
    raw.close();
    return cols;
  }

  it("adds the githubIssue column when opening a pre-existing tasks table", () => {
    const dbPath = path.join(dir, "old.db");
    const before = seedOldDb(dbPath);
    assert.ok(!before.includes("githubIssue")); // gap exists before migration

    const store = new Store(dbPath); // constructor runs migrate() → ALTER
    try {
      // Behavior check: a freshly created task exposes githubIssue defaulting to null,
      // and the link can be set — both impossible if the column were missing.
      const p = store.projects.create(null, { name: "P" });
      const m = store.milestones.create(p.id, { name: "M" });
      const t = store.tasks.create(m.id, { title: "T" });
      assert.equal(t.githubIssue, null);
      assert.equal(store.setTaskGithubIssue(t.id, "o/r#1").githubIssue, "o/r#1");
    } finally {
      store.close();
    }
  });

  it("is idempotent — opening an already-migrated db twice is fine", () => {
    const dbPath = path.join(dir, "twice.db");
    seedOldDb(dbPath);
    new Store(dbPath).close(); // first open migrates
    const store = new Store(dbPath); // second open: column already present, no-op
    try {
      const p = store.projects.create(null, { name: "P" });
      const m = store.milestones.create(p.id, { name: "M" });
      assert.equal(store.tasks.create(m.id, { title: "T" }).githubIssue, null);
    } finally {
      store.close();
    }
  });
});
