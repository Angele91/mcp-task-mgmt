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

/**
 * Seed a project with `n` tasks under a single milestone. Returns the project id
 * and the array of task ids (task-1 … task-n).
 */
function seedTasks(n) {
  const project = store.projects.create(null, { name: "P" });
  const milestone = store.milestones.create(project.id, { name: "M" });
  const tasks = [];
  for (let i = 0; i < n; i++) {
    tasks.push(store.tasks.create(milestone.id, { title: `T${i + 1}` }).id);
  }
  return { projectId: project.id, tasks };
}

describe("addDependency", () => {
  it("records an edge and reflects it in both directions", () => {
    const { tasks } = seedTasks(2);
    store.addDependency(tasks[1], tasks[0]); // task-2 depends on task-1
    assert.deepEqual(store.dependencyIds(tasks[1]), [tasks[0]]);
    assert.deepEqual(store.dependentIds(tasks[0]), [tasks[1]]);
  });

  it("is idempotent", () => {
    const { tasks } = seedTasks(2);
    store.addDependency(tasks[1], tasks[0]);
    store.addDependency(tasks[1], tasks[0]);
    assert.equal(store.dependencyIds(tasks[1]).length, 1);
  });

  it("rejects a self-dependency", () => {
    const { tasks } = seedTasks(1);
    assert.throws(() => store.addDependency(tasks[0], tasks[0]), /cannot depend on itself/);
  });

  it("rejects a direct cycle", () => {
    const { tasks } = seedTasks(2);
    store.addDependency(tasks[1], tasks[0]);
    assert.throws(() => store.addDependency(tasks[0], tasks[1]), /cycle/);
  });

  it("rejects a transitive cycle", () => {
    const { tasks } = seedTasks(3);
    store.addDependency(tasks[1], tasks[0]); // 2 → 1
    store.addDependency(tasks[2], tasks[1]); // 3 → 2
    assert.throws(() => store.addDependency(tasks[0], tasks[2]), /cycle/); // 1 → 3 closes the loop
  });

  it("rejects dependencies across different projects", () => {
    const a = seedTasks(1);
    const b = seedTasks(1);
    assert.throws(() => store.addDependency(a.tasks[0], b.tasks[0]), /same project/);
  });

  it("rejects unknown or malformed task ids", () => {
    const { tasks } = seedTasks(1);
    assert.throws(() => store.addDependency(tasks[0], "task-999"), /No task found/);
    assert.throws(() => store.addDependency("bogus", tasks[0]), /Invalid task id/);
  });
});

describe("removeDependency", () => {
  it("removes an edge and reports success", () => {
    const { tasks } = seedTasks(2);
    store.addDependency(tasks[1], tasks[0]);
    assert.equal(store.removeDependency(tasks[1], tasks[0]), true);
    assert.deepEqual(store.dependencyIds(tasks[1]), []);
  });

  it("returns false when no such edge exists", () => {
    const { tasks } = seedTasks(2);
    assert.equal(store.removeDependency(tasks[1], tasks[0]), false);
  });
});

describe("cascade", () => {
  it("drops edges when a task is deleted", () => {
    const { tasks } = seedTasks(2);
    store.addDependency(tasks[1], tasks[0]);
    store.tasks.delete(tasks[0]);
    assert.deepEqual(store.dependencyIds(tasks[1]), []);
  });
});

describe("nextActions", () => {
  it("returns root tasks (no prerequisites) when nothing is done", () => {
    const { projectId, tasks } = seedTasks(3);
    store.addDependency(tasks[1], tasks[0]); // 2 → 1
    store.addDependency(tasks[2], tasks[0]); // 3 → 1
    const ready = store.nextActions(projectId).map((t) => t.id);
    assert.deepEqual(ready, [tasks[0]]); // only task-1 is unblocked
  });

  it("unblocks dependents once a prerequisite is done", () => {
    const { projectId, tasks } = seedTasks(3);
    store.addDependency(tasks[1], tasks[0]);
    store.addDependency(tasks[2], tasks[0]);
    store.tasks.update(tasks[0], { status: "done" });
    const ready = store.nextActions(projectId).map((t) => t.id).sort();
    assert.deepEqual(ready, [tasks[1], tasks[2]].sort());
  });

  it("excludes done tasks", () => {
    const { projectId, tasks } = seedTasks(2);
    store.tasks.update(tasks[0], { status: "done" });
    const ready = store.nextActions(projectId).map((t) => t.id);
    assert.deepEqual(ready, [tasks[1]]);
  });

  it("orders in-progress before todo", () => {
    const { projectId, tasks } = seedTasks(2);
    store.tasks.update(tasks[1], { status: "in_progress" });
    const ready = store.nextActions(projectId).map((t) => t.id);
    assert.deepEqual(ready, [tasks[1], tasks[0]]); // in_progress first
  });

  it("orders by how much downstream work each unblocks", () => {
    const { projectId, tasks } = seedTasks(4);
    // task-1 unblocks 2 and 3 (then 4 via 3); task-2 unblocks nothing.
    store.addDependency(tasks[2], tasks[0]); // 3 → 1
    store.addDependency(tasks[3], tasks[2]); // 4 → 3
    const ready = store.nextActions(projectId).map((t) => t.id);
    // task-1 (impact 2: tasks 3,4) and task-2 (impact 0) are both ready; task-1 first.
    assert.equal(ready[0], tasks[0]);
    assert.ok(ready.includes(tasks[1]));
    assert.ok(ready.indexOf(tasks[0]) < ready.indexOf(tasks[1]));
  });
});

describe("criticalPath", () => {
  it("returns the longest dependent chain in prerequisite-first order", () => {
    const { projectId, tasks } = seedTasks(4);
    store.addDependency(tasks[1], tasks[0]); // 2 → 1
    store.addDependency(tasks[2], tasks[1]); // 3 → 2  (chain 1→2→3, length 3)
    // task-4 stands alone (length 1)
    const path = store.criticalPath(projectId).map((t) => t.id);
    assert.deepEqual(path, [tasks[0], tasks[1], tasks[2]]);
  });

  it("picks the longer of two branches", () => {
    const { projectId, tasks } = seedTasks(4);
    store.addDependency(tasks[1], tasks[0]); // 2 → 1   (length 2)
    store.addDependency(tasks[3], tasks[2]); // 4 → 3   (length 2)
    store.addDependency(tasks[2], tasks[1]); // 3 → 2   → chain 1→2→3→4 length 4
    const path = store.criticalPath(projectId).map((t) => t.id);
    assert.deepEqual(path, [tasks[0], tasks[1], tasks[2], tasks[3]]);
  });

  it("returns a single task when there are no edges", () => {
    const { projectId, tasks } = seedTasks(2);
    const path = store.criticalPath(projectId).map((t) => t.id);
    assert.equal(path.length, 1);
    assert.equal(path[0], tasks[0]); // lowest id wins the tie
  });

  it("returns empty for a project with no tasks", () => {
    const project = store.projects.create(null, { name: "Empty" });
    assert.deepEqual(store.criticalPath(project.id), []);
  });
});

describe("projectTree dependsOn", () => {
  it("includes each task's prerequisite ids", () => {
    const { projectId, tasks } = seedTasks(2);
    store.addDependency(tasks[1], tasks[0]);
    const tree = store.projectTree(projectId);
    const all = tree.milestones.flatMap((m) => m.tasks);
    const t2 = all.find((t) => t.id === tasks[1]);
    assert.deepEqual(t2.dependsOn, [tasks[0]]);
  });
});

// Corner cases surfaced by the generate-acceptance-criteria skill (spec-1).
describe("corner cases", () => {
  it("removeDependency returns false for a malformed or unknown task id", () => {
    const { tasks } = seedTasks(1);
    assert.equal(store.removeDependency("bogus", tasks[0]), false);
    assert.equal(store.removeDependency(tasks[0], "also-bogus"), false);
  });

  it("dependencyIds and dependentIds return [] for a malformed id", () => {
    assert.deepEqual(store.dependencyIds("bogus"), []);
    assert.deepEqual(store.dependentIds("nope-1"), []);
  });

  it("nextActions returns [] for a project with no tasks", () => {
    const project = store.projects.create(null, { name: "Empty" });
    assert.deepEqual(store.nextActions(project.id), []);
  });

  it("criticalPath breaks equal-length ties by lowest prerequisite id", () => {
    const { projectId, tasks } = seedTasks(3);
    // task-3 depends on both task-2 and task-1 (equal-length prerequisites);
    // adding 3→2 before 3→1 forces the dep < bestPrev tie-break branch.
    store.addDependency(tasks[2], tasks[1]); // 3 → 2
    store.addDependency(tasks[2], tasks[0]); // 3 → 1
    const path = store.criticalPath(projectId).map((t) => t.id);
    assert.deepEqual(path, [tasks[0], tasks[2]]); // lowest-id prerequisite wins
  });
});
