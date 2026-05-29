import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, ftsQuery, MEMORY_KINDS } from "../dist/memory.js";

// Each test gets a fresh in-memory store for full isolation.
let m;
beforeEach(() => {
  m = new MemoryStore(":memory:");
});
afterEach(() => {
  m.close();
});

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("ftsQuery", () => {
  it("tokenizes, quotes, and OR-joins words", () => {
    assert.equal(ftsQuery("build before commit"), '"build" OR "before" OR "commit"');
  });

  it("strips punctuation and FTS operators that would otherwise throw", () => {
    assert.equal(ftsQuery("foo: bar(baz)* AND -qux"), '"foo" OR "bar" OR "baz" OR "AND" OR "qux"');
  });

  it("returns a match-nothing query for empty/whitespace input", () => {
    assert.equal(ftsQuery(""), '""');
    assert.equal(ftsQuery("   "), '""');
    assert.equal(ftsQuery("!!! ??? ..."), '""');
  });
});

describe("remember", () => {
  it("creates a note with a prefixed id and ISO timestamps", () => {
    const note = m.remember({ content: "hello world" });
    assert.equal(note.id, "memory-1");
    assert.equal(note.content, "hello world");
    assert.match(note.createdAt, ISO_RE);
    assert.match(note.updatedAt, ISO_RE);
    assert.equal(note.createdAt, note.updatedAt);
  });

  it("applies defaults: kind=lesson, salience=3, empty tags, null source", () => {
    const note = m.remember({ content: "x" });
    assert.equal(note.kind, "lesson");
    assert.equal(note.salience, 3);
    assert.deepEqual(note.tags, []);
    assert.equal(note.source, null);
  });

  it("auto-increments ids", () => {
    assert.equal(m.remember({ content: "a" }).id, "memory-1");
    assert.equal(m.remember({ content: "b" }).id, "memory-2");
    assert.equal(m.remember({ content: "c" }).id, "memory-3");
  });

  it("persists all kinds", () => {
    for (const kind of MEMORY_KINDS) {
      const note = m.remember({ content: `a ${kind}`, kind });
      assert.equal(note.kind, kind);
    }
  });

  it("clamps salience into [1,5] and rounds", () => {
    assert.equal(m.remember({ content: "a", salience: 0 }).salience, 1);
    assert.equal(m.remember({ content: "b", salience: 9 }).salience, 5);
    assert.equal(m.remember({ content: "c", salience: 3.7 }).salience, 4);
  });

  it("normalizes tags: trims, drops empties, strips embedded commas", () => {
    const note = m.remember({ content: "x", tags: ["  build ", "", "a,b", "ci"] });
    // "a,b" -> comma replaced with space so the round-trip split is not corrupted
    assert.deepEqual(note.tags, ["build", "a b", "ci"]);
  });

  it("stores an explicit source", () => {
    assert.equal(m.remember({ content: "x", source: "conv-42" }).source, "conv-42");
  });
});

describe("get", () => {
  it("returns a stored note", () => {
    const created = m.remember({ content: "findme" });
    assert.deepEqual(m.get(created.id), created);
  });

  it("returns undefined for a nonexistent id", () => {
    assert.equal(m.get("memory-999"), undefined);
  });

  it("returns undefined for a malformed id", () => {
    assert.equal(m.get("not-an-id"), undefined);
    assert.equal(m.get("project-1"), undefined);
  });
});

describe("list", () => {
  it("returns newest first", () => {
    m.remember({ content: "first" });
    m.remember({ content: "second" });
    m.remember({ content: "third" });
    assert.deepEqual(
      m.list().map((n) => n.id),
      ["memory-3", "memory-2", "memory-1"],
    );
  });

  it("filters by kind", () => {
    m.remember({ content: "a lesson", kind: "lesson" });
    m.remember({ content: "a fact", kind: "fact" });
    m.remember({ content: "another fact", kind: "fact" });
    const facts = m.list({ kind: "fact" });
    assert.equal(facts.length, 2);
    assert.ok(facts.every((n) => n.kind === "fact"));
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) m.remember({ content: `n${i}` });
    assert.equal(m.list({ limit: 2 }).length, 2);
  });

  it("returns an empty array when there are no notes", () => {
    assert.deepEqual(m.list(), []);
  });
});

describe("update", () => {
  it("updates only the provided fields and preserves createdAt", () => {
    const note = m.remember({ content: "old", kind: "lesson", tags: ["a"] });
    const updated = m.update(note.id, { content: "new", tags: ["b", "c"] });
    assert.equal(updated.content, "new");
    assert.deepEqual(updated.tags, ["b", "c"]);
    assert.equal(updated.kind, "lesson"); // untouched
    assert.equal(updated.createdAt, note.createdAt);
  });

  it("clamps salience on update", () => {
    const note = m.remember({ content: "x" });
    assert.equal(m.update(note.id, { salience: 42 }).salience, 5);
  });

  it("returns undefined for a nonexistent or malformed id", () => {
    assert.equal(m.update("memory-999", { content: "x" }), undefined);
    assert.equal(m.update("bogus", { content: "x" }), undefined);
  });
});

describe("delete", () => {
  it("removes a note and reports success", () => {
    const note = m.remember({ content: "x" });
    assert.equal(m.delete(note.id), true);
    assert.equal(m.get(note.id), undefined);
  });

  it("returns false for a nonexistent or malformed id", () => {
    assert.equal(m.delete("memory-999"), false);
    assert.equal(m.delete("bogus"), false);
  });
});

describe("recall (FTS5)", () => {
  beforeEach(() => {
    m.remember({ content: "Always run pnpm build before committing", kind: "lesson", tags: ["build", "ci"] });
    m.remember({ content: "User prefers TypeScript over Python", kind: "preference", tags: ["lang"] });
    m.remember({ content: "Chose better-sqlite3 for its synchronous API", kind: "decision", tags: ["db"] });
  });

  it("finds notes by keyword", () => {
    const ids = m.recall("typescript").map((n) => n.id);
    assert.deepEqual(ids, ["memory-2"]);
  });

  it("matches any token (OR semantics)", () => {
    const ids = m.recall("python synchronous").map((n) => n.id).sort();
    assert.deepEqual(ids, ["memory-2", "memory-3"]);
  });

  it("returns a rank for each result", () => {
    const [hit] = m.recall("typescript");
    assert.equal(typeof hit.rank, "number");
  });

  it("filters by kind", () => {
    assert.deepEqual(m.recall("build run python", { kind: "lesson" }).map((n) => n.id), ["memory-1"]);
  });

  it("filters by tags (all must match)", () => {
    assert.deepEqual(m.recall("build", { tags: ["build"] }).map((n) => n.id), ["memory-1"]);
    assert.deepEqual(m.recall("build", { tags: ["build", "ci"] }).map((n) => n.id), ["memory-1"]);
    assert.deepEqual(m.recall("build", { tags: ["build", "nope"] }).map((n) => n.id), []);
  });

  it("respects limit", () => {
    assert.equal(m.recall("build python sqlite", { limit: 1 }).length, 1);
  });

  it("returns [] for a query that matches nothing", () => {
    assert.deepEqual(m.recall("kubernetes"), []);
  });

  it("does not throw on punctuation / FTS operator characters", () => {
    assert.deepEqual(m.recall("foo: bar(baz)* AND -qux"), []);
    assert.doesNotThrow(() => m.recall('"quoted" NEAR(x)'));
  });

  it("reflects updates (FTS update trigger fires)", () => {
    m.update("memory-2", { content: "User now prefers Rust" });
    assert.deepEqual(m.recall("typescript").map((n) => n.id), []);
    assert.deepEqual(m.recall("rust").map((n) => n.id), ["memory-2"]);
  });

  it("reflects deletes (FTS delete trigger fires)", () => {
    m.delete("memory-1");
    assert.deepEqual(m.recall("build committing"), []);
  });
});

describe("wiki", () => {
  it("returns null before anything is saved", () => {
    assert.equal(m.getWiki(), null);
  });

  it("saves and reads back the compiled wiki", () => {
    const saved = m.saveWiki("# Memory\n\n- a lesson");
    assert.equal(saved.content, "# Memory\n\n- a lesson");
    assert.match(saved.updatedAt, ISO_RE);
    assert.equal(m.getWiki().content, "# Memory\n\n- a lesson");
  });

  it("upserts (overwrites) on repeat save", () => {
    m.saveWiki("first");
    m.saveWiki("second");
    assert.equal(m.getWiki().content, "second");
  });
});

describe("duplicateCandidates", () => {
  it("flags near-duplicate notes", () => {
    m.remember({ content: "Always run pnpm build before committing" });
    m.remember({ content: "Remember to run pnpm build prior to commits" });
    m.remember({ content: "User prefers TypeScript over Python" });

    const dups = m.duplicateCandidates();
    assert.equal(dups.length, 1);
    assert.deepEqual([dups[0].a, dups[0].b].sort(), ["memory-1", "memory-2"]);
    assert.ok(dups[0].score >= 0.3, `score ${dups[0].score} should clear the threshold`);
  });

  it("does not flag unrelated notes", () => {
    m.remember({ content: "The sky is blue today" });
    m.remember({ content: "Deploy the service on Fridays" });
    assert.deepEqual(m.duplicateCandidates(), []);
  });

  it("returns each pair once (no reciprocal duplicates)", () => {
    m.remember({ content: "run pnpm build before committing changes now" });
    m.remember({ content: "run pnpm build before committing changes today" });
    const dups = m.duplicateCandidates();
    assert.equal(dups.length, 1);
  });

  it("returns [] for an empty store", () => {
    assert.deepEqual(m.duplicateCandidates(), []);
  });
});

describe("isolation", () => {
  it("two stores do not share state", () => {
    const a = new MemoryStore(":memory:");
    const b = new MemoryStore(":memory:");
    a.remember({ content: "only in a" });
    assert.equal(a.list().length, 1);
    assert.equal(b.list().length, 0);
    a.close();
    b.close();
  });
});
