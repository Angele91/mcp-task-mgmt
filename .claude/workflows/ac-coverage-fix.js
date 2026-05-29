export const meta = {
  name: 'ac-coverage-fix',
  description:
    'Close real test-coverage gaps file-by-file: a fix agent per gap writes tests (and the smallest testability seam if needed), then a verify agent builds and drives the full suite green.',
  phases: [
    { title: 'Fix', detail: 'one agent per gap file — write tests / minimal refactor' },
    { title: 'Verify', detail: 'build + full suite + coverage, fix any failures' },
  ],
}

// Each gap: { file, test, uncovered, guidance }. Override by passing `args`.
const GAPS =
  Array.isArray(args) && args.length
    ? args
    : [
        {
          file: 'src/github.ts',
          test: 'test/github.test.js',
          uncovered:
            'the gh exec wrappers — gh(), createIssue, getIssueState, setIssueState (~lines 42-86 of dist/github.js)',
          guidance:
            'These shell out via execFile("gh", ...) so they are not unit-testable as written. Add the SMALLEST seam: an injectable command runner (e.g. a module-level `let runner = <real execFile wrapper>` plus an exported test hook like `__setRunner(fn)` / `__resetRunner()`), and have gh() call it. Do NOT change the public signatures of createIssue / getIssueState / setIssueState / parseIssueRef / formatIssueRef (index.ts imports them). Then add tests that stub the runner to cover: createIssue parses the printed issue URL into a ref and throws on an unparseable one; getIssueState maps CLOSED/OPEN; setIssueState runs close/reopen; and gh() maps an ENOENT error to the friendly "gh CLI not found" message and other failures to "gh <cmd> failed".',
        },
        {
          file: 'src/memory.ts',
          test: 'test/memory.test.js',
          uncovered:
            'the updateMemory `kind` and `source` partial-update branches (~lines 196-198 and 204-206 of dist/memory.js)',
          guidance:
            'No source change needed. Add a test that updates a memory note\'s kind and source fields and asserts they persist, exercising those branches. Match the existing memory.test.js style.',
        },
      ]

const FIX = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'sourceChanged', 'testsAdded', 'summary'],
  properties: {
    file: { type: 'string' },
    sourceChanged: { type: 'boolean', description: 'true if the source file was modified (vs test-only)' },
    testsAdded: { type: 'integer' },
    summary: { type: 'string', description: 'concisely, what was changed and which tests were added' },
  },
}

const VERIFY = {
  type: 'object',
  additionalProperties: false,
  required: ['passed', 'suiteLine', 'notes'],
  properties: {
    passed: { type: 'boolean', description: 'true if the full suite passes' },
    suiteLine: { type: 'string', description: 'the "# tests N / # pass N / # fail N" summary' },
    coverage: { type: 'string', description: 'line/branch % for github.js, memory.js, store.js, and all files' },
    fixesApplied: { type: 'string', description: 'any compile/test failures fixed during verify' },
    notes: { type: 'string' },
  },
}

phase('Fix')
const fixes = (
  await parallel(
    GAPS.map((g) => () =>
      agent(
        `You are working in the mcp-task-mgmt repo (a TypeScript MCP server: build with \`pnpm build\`, test with \`pnpm test\`; tests use node:test + node:assert/strict and import compiled code from ../dist/...).\n\n` +
          `Close the test-coverage gap in ${g.file}: ${g.uncovered}.\n\n` +
          `Guidance: ${g.guidance}\n\n` +
          `STRICT RULES:\n` +
          `- Edit ONLY ${g.file} and ${g.test}. Touch no other file.\n` +
          `- Keep all existing public exports and behavior identical.\n` +
          `- Do NOT run \`pnpm build\` or \`pnpm test\` — a separate verify step builds once to avoid clobbering the shared dist/. You may read existing source/tests to match style.\n` +
          `- Write real, meaningful tests for the uncovered code — no placeholders, no padding.\n\n` +
          `Return what you changed.`,
        { label: `fix:${g.file}`, phase: 'Fix', schema: FIX },
      ),
    ),
  )
).filter(Boolean)

phase('Verify')
const verify = await agent(
  `You are in the mcp-task-mgmt repo. Fix agents just edited source/tests for: ${GAPS.map((g) => g.file).join(', ')} (plus their test files) WITHOUT building.\n\n` +
    `Do this in order:\n` +
    `1. \`pnpm build\` — if it fails, fix the compile errors minimally (preserve behavior) and rebuild.\n` +
    `2. \`pnpm test\` — the FULL suite must pass. If a test fails, decide whether the TEST is wrong or the CODE has a real bug the new test exposed, and fix the right one (fix the code for a genuine bug; never bend a test to match buggy behavior). Re-run until green.\n` +
    `3. \`node --test --experimental-test-coverage test/*.test.js\` — read off the line/branch % for github.js, memory.js, store.js, and "all files".\n\n` +
    `Return the final suite summary, the coverage numbers, and anything you had to fix.`,
  { label: 'verify: build + suite + coverage', phase: 'Verify', schema: VERIFY },
)

return { fixes, verify }
