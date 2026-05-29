/**
 * GitHub integration via the `gh` CLI. The server shells out to the user's
 * already-authenticated `gh`, so there is no token handling or new runtime
 * dependency. Pure parsing/mapping helpers are separated from the (untested)
 * exec wrappers so the logic can be unit-tested without touching the network.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GithubIssueRef {
  owner: string;
  repo: string;
  number: number;
}

export type IssueState = "open" | "closed";

const SHORT_RE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)$/;
const URL_RE = /github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/(\d+)/;

/**
 * Parse an issue/PR reference. Accepts the short form "owner/repo#123" or a
 * full github.com issues/pull URL. Returns null if neither matches.
 */
export function parseIssueRef(input: string): GithubIssueRef | null {
  const s = input.trim();
  const m = SHORT_RE.exec(s) ?? URL_RE.exec(s);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/** Canonical short form "owner/repo#number". */
export function formatIssueRef(ref: GithubIssueRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/** A task `done` maps to a closed issue; anything else maps to open. */
export function taskStatusToIssueState(status: string): IssueState {
  return status === "done" ? "closed" : "open";
}

/**
 * Desired task status given an issue's state, in a `pull`. A closed issue means
 * the task is `done`. An open issue only forces a change if the task was `done`
 * (the issue was reopened) → back to `in_progress`; otherwise leave it as-is.
 */
export function issueStateToTaskStatus(state: IssueState, currentTaskStatus: string): string {
  if (state === "closed") return "done";
  return currentTaskStatus === "done" ? "in_progress" : currentTaskStatus;
}

// --- gh exec wrappers (thin; not unit-tested) --------------------------------

async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, { maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") {
      throw new Error(
        "gh CLI not found on PATH. Install it from https://cli.github.com and run `gh auth login`.",
      );
    }
    const detail = (err.stderr || err.message || "").trim();
    throw new Error(`gh ${args[0]} ${args[1] ?? ""} failed: ${detail}`);
  }
}

/** Create an issue and return its parsed reference (from the printed URL). */
export async function createIssue(opts: {
  repo?: string;
  title: string;
  body: string;
}): Promise<GithubIssueRef> {
  const args = ["issue", "create", "--title", opts.title, "--body", opts.body];
  if (opts.repo) args.push("--repo", opts.repo);
  const out = await gh(args); // prints the new issue URL
  const ref = parseIssueRef(out);
  if (!ref) throw new Error(`Issue created, but could not parse its URL: ${out}`);
  return ref;
}

/** Read an issue's current state. */
export async function getIssueState(ref: GithubIssueRef): Promise<IssueState> {
  const out = await gh([
    "issue",
    "view",
    String(ref.number),
    "--repo",
    `${ref.owner}/${ref.repo}`,
    "--json",
    "state",
    "-q",
    ".state",
  ]);
  return out.toLowerCase() === "closed" ? "closed" : "open";
}

/** Close or reopen an issue. */
export async function setIssueState(ref: GithubIssueRef, state: IssueState): Promise<void> {
  const verb = state === "closed" ? "close" : "reopen";
  await gh(["issue", verb, String(ref.number), "--repo", `${ref.owner}/${ref.repo}`]);
}
