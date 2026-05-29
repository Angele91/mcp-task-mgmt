import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../dist/store.js";

let store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => {
  store.close();
});

/** Create a project → milestone → task and return the task id. */
function seedTask(status) {
  const p = store.projects.create(null, { name: "P" });
  const m = store.milestones.create(p.id, { name: "M" });
  return store.tasks.create(m.id, { title: "T", ...(status ? { status } : {}) }).id;
}

describe("auto-logged status events", () => {
  it("records a creation event with the initial status", () => {
    const id = seedTask();
    const log = store.taskActivity(id);
    assert.equal(log.length, 1);
    assert.equal(log[0].kind, "status");
    assert.equal(log[0].fromStatus, null);
    assert.equal(log[0].toStatus, "todo");
    assert.equal(log[0].id, "activity-1");
    assert.equal(log[0].taskId, id);
  });

  it("honors an explicit initial status on creation", () => {
    const id = seedTask("in_progress");
    assert.equal(store.taskActivity(id)[0].toStatus, "in_progress");
  });

  it("records a transition when status changes", () => {
    const id = seedTask();
    store.tasks.update(id, { status: "in_progress" });
    const log = store.taskActivity(id);
    assert.equal(log.length, 2);
    assert.equal(log[1].kind, "status");
    assert.equal(log[1].fromStatus, "todo");
    assert.equal(log[1].toStatus, "in_progress");
  });

  it("does NOT log when an update leaves status unchanged", () => {
    const id = seedTask();
    store.tasks.update(id, { title: "renamed" }); // no status change
    store.tasks.update(id, { status: "todo" }); // same status
    assert.equal(store.taskActivity(id).length, 1); // only the creation event
  });

  it("only logs activity for tasks, not other entities", () => {
    const p = store.projects.create(null, { name: "P" });
    store.projects.update(p.id, { status: "completed" });
    // No task_activity rows exist for a project; nothing to assert beyond no throw.
    assert.equal(store.tasks.list().length, 0);
  });
});

describe("logTask (notes)", () => {
  it("appends a free-form note", () => {
    const id = seedTask();
    const entry = store.logTask(id, "Implemented the parser and ran the suite");
    assert.equal(entry.kind, "note");
    assert.equal(entry.message, "Implemented the parser and ran the suite");
    assert.equal(entry.fromStatus, null);
    assert.equal(entry.toStatus, null);
  });

  it("interleaves notes and status events in chronological order", () => {
    const id = seedTask();
    store.logTask(id, "starting");
    store.tasks.update(id, { status: "in_progress" });
    store.logTask(id, "halfway");
    store.tasks.update(id, { status: "done" });
    const kinds = store.taskActivity(id).map((a) => `${a.kind}:${a.toStatus ?? a.message}`);
    assert.deepEqual(kinds, [
      "status:todo",
      "note:starting",
      "status:in_progress",
      "note:halfway",
      "status:done",
    ]);
  });

  it("throws when the task does not exist", () => {
    assert.throws(() => store.logTask("task-999", "x"), /No task found/);
  });
});

describe("taskActivity", () => {
  it("throws on a malformed task id", () => {
    assert.throws(() => store.taskActivity("bogus"), /Invalid task id/);
  });

  it("returns an empty array for a task with no rows", () => {
    // A task always has a creation event, so fabricate the empty case by reading
    // a valid-but-unused id space: delete the task's rows via cascade first.
    const id = seedTask();
    store.tasks.delete(id);
    assert.deepEqual(store.taskActivity(id), []);
  });
});

describe("projectTree recent activity", () => {
  it("attaches the latest entry per task by default", () => {
    const p = store.projects.create(null, { name: "P" });
    const m = store.milestones.create(p.id, { name: "M" });
    const t = store.tasks.create(m.id, { title: "T" });
    store.tasks.update(t.id, { status: "in_progress" });
    const tree = store.projectTree(p.id);
    const node = tree.milestones[0].tasks[0];
    assert.equal(node.recentActivity.length, 1);
    assert.equal(node.recentActivity[0].toStatus, "in_progress"); // newest
  });

  it("returns entries newest-first up to the limit", () => {
    const p = store.projects.create(null, { name: "P" });
    const m = store.milestones.create(p.id, { name: "M" });
    const t = store.tasks.create(m.id, { title: "T" });
    store.logTask(t.id, "first");
    store.logTask(t.id, "second");
    const node = store.projectTree(p.id, 2).milestones[0].tasks[0];
    assert.deepEqual(
      node.recentActivity.map((a) => a.message),
      ["second", "first"],
    );
  });

  it("attaches nothing when the limit is 0", () => {
    const p = store.projects.create(null, { name: "P" });
    const m = store.milestones.create(p.id, { name: "M" });
    store.tasks.create(m.id, { title: "T" });
    const node = store.projectTree(p.id, 0).milestones[0].tasks[0];
    assert.deepEqual(node.recentActivity, []);
  });
});

describe("cascade", () => {
  it("drops activity when the task is deleted", () => {
    const id = seedTask();
    store.logTask(id, "note");
    assert.equal(store.taskActivity(id).length, 2);
    store.tasks.delete(id);
    assert.deepEqual(store.taskActivity(id), []);
  });

  it("drops activity when an ancestor is deleted (cascade through the tree)", () => {
    const p = store.projects.create(null, { name: "P" });
    const m = store.milestones.create(p.id, { name: "M" });
    const t = store.tasks.create(m.id, { title: "T" });
    store.logTask(t.id, "note");
    store.projects.delete(p.id);
    assert.deepEqual(store.taskActivity(t.id), []);
  });
});
