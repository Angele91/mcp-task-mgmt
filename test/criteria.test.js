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

/** Create project → milestone → task → spec; return the spec id. */
function seedSpec() {
  const p = store.projects.create(null, { name: "P" });
  const m = store.milestones.create(p.id, { name: "M" });
  const t = store.tasks.create(m.id, { title: "T" });
  return store.specs.create(t.id, { title: "S" }).id;
}

describe("createCriterion", () => {
  it("creates an unverified, untested criterion with a prefixed id", () => {
    const specId = seedSpec();
    const c = store.createCriterion(specId, "Handles empty input");
    assert.equal(c.id, "ac-1");
    assert.equal(c.specId, specId);
    assert.equal(c.text, "Handles empty input");
    assert.equal(c.verified, false);
    assert.equal(c.test, null);
  });

  it("accepts an up-front test reference", () => {
    const specId = seedSpec();
    const c = store.createCriterion(specId, "x", "test/x.test.js::empty");
    assert.equal(c.test, "test/x.test.js::empty");
  });

  it("rejects an unknown or malformed spec id", () => {
    assert.throws(() => store.createCriterion("spec-999", "x"), /No spec found/);
    assert.throws(() => store.createCriterion("bogus", "x"), /Invalid spec id/);
  });
});

describe("updateCriterion", () => {
  it("marks verified and coerces the stored 0/1 back to a boolean", () => {
    const c = store.createCriterion(seedSpec(), "x");
    const u = store.updateCriterion(c.id, { verified: true });
    assert.equal(u.verified, true);
    assert.equal(store.getCriterion(c.id).verified, true); // survives a re-read
  });

  it("sets and clears the test link ('' clears, undefined leaves alone)", () => {
    const c = store.createCriterion(seedSpec(), "x", "t1");
    assert.equal(store.updateCriterion(c.id, { verified: true }).test, "t1"); // untouched
    assert.equal(store.updateCriterion(c.id, { test: "t2" }).test, "t2");
    assert.equal(store.updateCriterion(c.id, { test: "" }).test, null); // cleared
  });

  it("edits the text", () => {
    const c = store.createCriterion(seedSpec(), "old");
    assert.equal(store.updateCriterion(c.id, { text: "new" }).text, "new");
  });

  it("returns undefined for unknown or malformed ids", () => {
    assert.equal(store.updateCriterion("ac-999", { verified: true }), undefined);
    assert.equal(store.updateCriterion("bogus", { verified: true }), undefined);
  });
});

describe("listCriteria / deleteCriterion", () => {
  it("lists criteria for a spec in id order", () => {
    const specId = seedSpec();
    store.createCriterion(specId, "a");
    store.createCriterion(specId, "b");
    assert.deepEqual(store.listCriteria(specId).map((c) => c.text), ["a", "b"]);
  });

  it("deletes a criterion", () => {
    const c = store.createCriterion(seedSpec(), "a");
    assert.equal(store.deleteCriterion(c.id), true);
    assert.equal(store.getCriterion(c.id), undefined);
    assert.equal(store.deleteCriterion("ac-999"), false);
  });
});

describe("cascade", () => {
  it("drops criteria when the parent spec is deleted", () => {
    const specId = seedSpec();
    store.createCriterion(specId, "a");
    store.specs.delete(specId);
    assert.deepEqual(store.listCriteria(specId), []);
  });

  it("drops criteria when an ancestor task is deleted", () => {
    const specId = seedSpec();
    const taskId = store.specs.get(specId).taskId;
    store.createCriterion(specId, "a");
    store.tasks.delete(taskId);
    assert.deepEqual(store.listCriteria(specId), []);
  });
});

describe("coverageForSpec", () => {
  it("reports zero coverage for an empty spec", () => {
    const cov = store.coverageForSpec(seedSpec());
    assert.deepEqual(
      { total: cov.total, fullyCovered: cov.fullyCovered, gaps: cov.nyquistGaps },
      { total: 0, fullyCovered: false, gaps: 0 },
    );
  });

  it("counts verified, tested, gaps and full coverage", () => {
    const specId = seedSpec();
    const a = store.createCriterion(specId, "a", "t-a");
    const b = store.createCriterion(specId, "b"); // no test → Nyquist gap
    store.createCriterion(specId, "c", "t-c");
    store.updateCriterion(a.id, { verified: true });
    store.updateCriterion(b.id, { verified: true });

    const cov = store.coverageForSpec(specId);
    assert.equal(cov.total, 3);
    assert.equal(cov.verified, 2); // a, b
    assert.equal(cov.tested, 2); // a, c
    assert.equal(cov.nyquistGaps, 1); // b
    assert.equal(cov.unverified, 1); // c
    assert.equal(cov.fullyCovered, false);
  });

  it("is fully covered only when every criterion is verified AND tested", () => {
    const specId = seedSpec();
    const a = store.createCriterion(specId, "a", "t-a");
    store.updateCriterion(a.id, { verified: true });
    assert.equal(store.coverageForSpec(specId).fullyCovered, true);
  });
});

describe("coverageForProject", () => {
  it("returns coverage for every spec in the project", () => {
    const p = store.projects.create(null, { name: "P" });
    const m = store.milestones.create(p.id, { name: "M" });
    const t = store.tasks.create(m.id, { title: "T" });
    const s1 = store.specs.create(t.id, { title: "S1" });
    const s2 = store.specs.create(t.id, { title: "S2" });
    const c = store.createCriterion(s1.id, "x", "t");
    store.updateCriterion(c.id, { verified: true });
    store.createCriterion(s2.id, "y"); // gap

    const covs = store.coverageForProject(p.id);
    assert.deepEqual(covs.map((c) => c.specId), [s1.id, s2.id]);
    assert.equal(covs.find((c) => c.specId === s1.id).fullyCovered, true);
    assert.equal(covs.find((c) => c.specId === s2.id).nyquistGaps, 1);
  });

  it("rejects a malformed project id", () => {
    assert.throws(() => store.coverageForProject("bogus"), /Invalid project id/);
  });
});
