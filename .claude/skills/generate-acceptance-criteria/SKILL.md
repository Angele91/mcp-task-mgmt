---
name: generate-acceptance-criteria
description: Generate acceptance criteria and Nyquist coverage for a spec — rigorously. Whenever you create or fill in acceptance criteria for a change, this skill makes you also enumerate corner/edge cases AND inspect the code the change actually touched for untested paths, turning each gap into a criterion plus a test. Use when asked to write/generate acceptance criteria, define a spec's AC, fill Nyquist coverage gaps, or "make sure the tests cover the edge cases / the code this change touched".
---

# Generate acceptance criteria (with corner cases + affected-code coverage)

Produce acceptance criteria for a spec and drive its Nyquist coverage to zero gaps — using the `mcp-task-mgmt` criteria tools. Generation is **not done** until two things are true:

1. **Corner cases are covered**, not just the happy path.
2. **The code this change touched has no untested paths** — every affected branch is either exercised by a test or captured as an explicit, accepted gap.

Skipping either is the most common way a "passing" change ships a regression. This skill exists to force both checks every time.

## Prerequisite

The `mcp-task-mgmt` server must be connected (`add_acceptance_criterion`, `get_spec_coverage`, `get_coverage_report`, …). If its tools aren't available, tell the user to add it and stop.

## The two mandates

### A. Corner cases — work the checklist, don't freestyle

For the behavior the spec describes, walk this checklist and add a criterion for every category that *could* apply. Omit a category only after deciding it genuinely doesn't (say so):

- **Empty / null / zero** — empty string/list/map, null/undefined, zero count.
- **Boundaries** — min, max, first, last, off-by-one, exactly-at-limit, one-over.
- **Invalid / malformed input** — wrong type, bad format, out-of-range; the error path and message.
- **Duplicates / idempotency** — repeated calls, double-submit, re-running the same op.
- **Ordering / concurrency** — out-of-order events, interleaving, races, partial state.
- **Scale** — large input, many rows, deep nesting, long strings.
- **Encoding** — unicode, emoji, whitespace, case-sensitivity, locale.
- **Auth / permission** — unauthorized, wrong owner, missing scope (where relevant).
- **Failure / rollback** — a mid-operation failure leaves no half-written state; cascade/cleanup happens.
- **Time** — timezones, DST, ordering by timestamp, "now" boundaries.

Each corner case becomes one criterion: a single, checkable statement.

### B. Uncovered code affected by the change — measure, don't guess

1. **Find what the change touched.** `git diff` (or `git diff <base>...HEAD`) → the changed files, functions, and branches. If there's no diff yet, scope to the files the spec's work will modify.
2. **Measure coverage of that code.** Use the project's coverage runner if present:
   - Node: `node --test --experimental-test-coverage` (or `c8 -- node --test …`).
   - Other stacks: `pytest --cov`, `go test -cover`, `cargo llvm-cov`, etc.
   Intersect the coverage report with the changed lines/branches. If no runner exists, reason explicitly from the diff vs. existing tests — and flag that it's an estimate.
3. **Every uncovered affected path → a criterion.** For each untested branch/function the change introduced or modified, add a criterion describing the behavior, and add (or note the need for) the test that exercises it. New uncovered code is a release blocker, not a nice-to-have.

## Procedure

1. **Identify the spec.** Use the given `spec-N`, or create one (`create_spec`) for the change first. `list_acceptance_criteria { specId }` to see what already exists.
2. **Establish change context** (mandate B.1) — capture the diff / affected surface.
3. **Draft criteria** — happy path, then the corner-case checklist (A), then one per uncovered affected path (B).
4. **Record them** — `add_acceptance_criterion { specId, text, test? }` per criterion. Attach a `test` reference when the test already exists.
5. **Make them real** — write the missing tests, run them, then `update_acceptance_criterion { id, verified: true, test: "<ref>" }`. **Only mark `verified` once a test exists and passes** — never on intent.
6. **Verify coverage** — `get_spec_coverage { specId }` (and `get_coverage_report { projectId }` for the rollup). Resolve every **Nyquist gap** (criterion with no linked test). If a gap is deliberately accepted, leave a one-line reason in the task's activity log (`log_task`) — don't silently leave it.
7. **Done = no gaps.** A spec is complete only when `get_spec_coverage` shows every criterion verified *and* tested, or each remaining gap is explicitly accepted with a logged rationale.

## Notes

- **Coverage = tested (has a sample), not just verified.** A criterion someone eyeballed but wrote no test for is still a Nyquist gap. The whole point is that the requirement is demonstrably exercised.
- **Honesty over green.** Don't pad with vague criteria to inflate the count, and don't mark `verified` without a passing test — a truthful "2 gaps remain" beats a fake "fully covered".
- The corner-case checklist is a floor, not a ceiling — add domain-specific cases the checklist doesn't name.
- Related: `task-breakdown` plans new work; this skill hardens the spec/AC layer of that work. After generating, `task-review` and `get_coverage_report` track whether gaps get closed.
