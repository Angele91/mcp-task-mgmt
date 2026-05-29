import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseIssueRef,
  formatIssueRef,
  taskStatusToIssueState,
  issueStateToTaskStatus,
  createIssue,
  getIssueState,
  setIssueState,
  __setRunner,
  __resetRunner,
} from "../dist/github.js";
import { Store } from "../dist/store.js";

describe("parseIssueRef", () => {
  it("parses the short form owner/repo#123", () => {
    assert.deepEqual(parseIssueRef("octocat/hello-world#42"), {
      owner: "octocat",
      repo: "hello-world",
      number: 42,
    });
  });

  it("parses a full issues URL", () => {
    assert.deepEqual(parseIssueRef("https://github.com/octocat/hello-world/issues/7"), {
      owner: "octocat",
      repo: "hello-world",
      number: 7,
    });
  });

  it("parses a pull-request URL", () => {
    assert.deepEqual(parseIssueRef("https://github.com/o/r/pull/99"), {
      owner: "o",
      repo: "r",
      number: 99,
    });
  });

  it("trims surrounding whitespace", () => {
    assert.equal(parseIssueRef("  o/r#1  ")?.number, 1);
  });

  it("returns null for garbage", () => {
    assert.equal(parseIssueRef("not a ref"), null);
    assert.equal(parseIssueRef("owner/repo"), null); // no number
    assert.equal(parseIssueRef("owner#5"), null); // no repo
  });
});

describe("formatIssueRef", () => {
  it("renders the canonical short form", () => {
    assert.equal(formatIssueRef({ owner: "o", repo: "r", number: 3 }), "o/r#3");
  });

  it("round-trips with parseIssueRef", () => {
    const ref = parseIssueRef("https://github.com/a/b/issues/12");
    assert.equal(formatIssueRef(ref), "a/b#12");
  });
});

describe("taskStatusToIssueState", () => {
  it("maps done → closed", () => {
    assert.equal(taskStatusToIssueState("done"), "closed");
  });

  it("maps everything else → open", () => {
    assert.equal(taskStatusToIssueState("todo"), "open");
    assert.equal(taskStatusToIssueState("in_progress"), "open");
  });
});

describe("issueStateToTaskStatus", () => {
  it("closed issue → done", () => {
    assert.equal(issueStateToTaskStatus("closed", "todo"), "done");
    assert.equal(issueStateToTaskStatus("closed", "in_progress"), "done");
  });

  it("open issue reverts a done task to in_progress (it was reopened)", () => {
    assert.equal(issueStateToTaskStatus("open", "done"), "in_progress");
  });

  it("open issue leaves a non-done task unchanged", () => {
    assert.equal(issueStateToTaskStatus("open", "todo"), "todo");
    assert.equal(issueStateToTaskStatus("open", "in_progress"), "in_progress");
  });
});

describe("gh exec wrappers (stubbed runner)", () => {
  afterEach(() => {
    __resetRunner();
  });

  it("createIssue parses the printed issue URL into a ref", async () => {
    let captured;
    __setRunner(async (args) => {
      captured = args;
      return "https://github.com/octocat/hello-world/issues/42\n";
    });
    const ref = await createIssue({ title: "T", body: "B", repo: "octocat/hello-world" });
    assert.deepEqual(ref, { owner: "octocat", repo: "hello-world", number: 42 });
    assert.deepEqual(captured, [
      "issue",
      "create",
      "--title",
      "T",
      "--body",
      "B",
      "--repo",
      "octocat/hello-world",
    ]);
  });

  it("createIssue omits --repo when none is given", async () => {
    let captured;
    __setRunner(async (args) => {
      captured = args;
      return "https://github.com/o/r/issues/1";
    });
    await createIssue({ title: "T", body: "B" });
    assert.equal(captured.includes("--repo"), false);
  });

  it("createIssue throws when the printed output is not a parseable URL", async () => {
    __setRunner(async () => "something went sideways");
    await assert.rejects(createIssue({ title: "T", body: "B" }), /could not parse its URL: something went sideways/);
  });

  it("getIssueState maps CLOSED → closed", async () => {
    let captured;
    __setRunner(async (args) => {
      captured = args;
      return "CLOSED\n";
    });
    const state = await getIssueState({ owner: "o", repo: "r", number: 5 });
    assert.equal(state, "closed");
    assert.deepEqual(captured, [
      "issue",
      "view",
      "5",
      "--repo",
      "o/r",
      "--json",
      "state",
      "-q",
      ".state",
    ]);
  });

  it("getIssueState maps OPEN → open", async () => {
    __setRunner(async () => "OPEN");
    assert.equal(await getIssueState({ owner: "o", repo: "r", number: 5 }), "open");
  });

  it("getIssueState treats any non-CLOSED value as open", async () => {
    __setRunner(async () => "weird");
    assert.equal(await getIssueState({ owner: "o", repo: "r", number: 5 }), "open");
  });

  it("setIssueState runs `issue close` for closed", async () => {
    let captured;
    __setRunner(async (args) => {
      captured = args;
      return "";
    });
    await setIssueState({ owner: "o", repo: "r", number: 8 }, "closed");
    assert.deepEqual(captured, ["issue", "close", "8", "--repo", "o/r"]);
  });

  it("setIssueState runs `issue reopen` for open", async () => {
    let captured;
    __setRunner(async (args) => {
      captured = args;
      return "";
    });
    await setIssueState({ owner: "o", repo: "r", number: 8 }, "open");
    assert.deepEqual(captured, ["issue", "reopen", "8", "--repo", "o/r"]);
  });

  it("gh() maps an ENOENT error to the friendly `gh CLI not found` message", async () => {
    __setRunner(async () => {
      const err = new Error("spawn gh ENOENT");
      err.code = "ENOENT";
      throw err;
    });
    await assert.rejects(getIssueState({ owner: "o", repo: "r", number: 1 }), /gh CLI not found on PATH/);
  });

  it("gh() maps other failures to `gh <cmd> failed`, preferring stderr", async () => {
    __setRunner(async () => {
      const err = new Error("exit 1");
      err.stderr = "could not resolve to a Repository";
      throw err;
    });
    await assert.rejects(
      getIssueState({ owner: "o", repo: "r", number: 1 }),
      /gh issue view failed: could not resolve to a Repository/,
    );
  });

  it("gh() falls back to the error message when stderr is absent", async () => {
    __setRunner(async () => {
      throw new Error("boom");
    });
    await assert.rejects(setIssueState({ owner: "o", repo: "r", number: 1 }, "open"), /gh issue reopen failed: boom/);
  });
});

describe("Store github link", () => {
  let store;
  beforeEach(() => {
    store = new Store(":memory:");
  });
  afterEach(() => {
    store.close();
  });

  function seedTask() {
    const p = store.projects.create(null, { name: "P" });
    const m = store.milestones.create(p.id, { name: "M" });
    return store.tasks.create(m.id, { title: "T" }).id;
  }

  it("defaults githubIssue to null on a new task", () => {
    const id = seedTask();
    assert.equal(store.tasks.get(id).githubIssue, null);
  });

  it("sets and clears the link", () => {
    const id = seedTask();
    assert.equal(store.setTaskGithubIssue(id, "o/r#5").githubIssue, "o/r#5");
    assert.equal(store.setTaskGithubIssue(id, null).githubIssue, null);
  });

  it("records an activity note when linking and unlinking", () => {
    const id = seedTask();
    store.setTaskGithubIssue(id, "o/r#5");
    store.setTaskGithubIssue(id, null);
    const notes = store.taskActivity(id).filter((a) => a.kind === "note").map((a) => a.message);
    assert.deepEqual(notes, ["Linked GitHub issue o/r#5", "Unlinked GitHub issue"]);
  });

  it("surfaces the link on the project tree task node", () => {
    const id = seedTask();
    store.setTaskGithubIssue(id, "o/r#5");
    const p = store.tasks.get(id).milestoneId; // milestone id
    const projectId = store.milestones.get(p).projectId;
    const node = store.projectTree(projectId).milestones[0].tasks[0];
    assert.equal(node.githubIssue, "o/r#5");
  });

  it("returns undefined for an unknown or malformed task id", () => {
    assert.equal(store.setTaskGithubIssue("task-999", "o/r#5"), undefined);
    assert.equal(store.setTaskGithubIssue("bogus", "o/r#5"), undefined);
  });
});
