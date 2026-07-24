# Python LSP Reconciliation Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Merge upstream pi-lens into the locally pinned branch while preserving all pinned behavior, prefer managed Pyright for Python LSP, retain managed Jedi fallback, report unavailable LSPs accurately, and roll the verified commit into the durable local Pi setup.

**Architecture:** Branch `fix/pi-lens/python-lsp-reconciliation` starts at the current pin and merges `master`, preserving both histories. Resolve only the two predicted content conflicts, use upstream Python server ordering and unavailable-diagnostics behavior, and preserve the pinned stale-context, Prettier, and managed-Jedi changes. After verification and publication, update the separate `pi-setup` package pin and use `pi install` to reconcile the active package checkout.

**Tech Stack:** TypeScript ESM, Vitest, Node 26, git worktrees, Pi git packages.

---

## Preconditions already completed

- Worktree: `/Users/quinnpaddock/worktrees/pi-lens/fix/pi-lens/python-lsp-reconciliation`
- Branch: `fix/pi-lens/python-lsp-reconciliation`
- `6e58a25` stabilizes immediate-exit tests under high parallel load; normal `npm test` passes with 963 passed and 5 skipped.
- `e5a3754` records the user-validated design in `docs/plans/2026-07-24-python-lsp-reconciliation-design.md`.
- Dry-run merge predicts content conflicts only in `index.ts` and `skills/lsp-navigation/SKILL.md`.

### Task 1: Add the Python server-priority regression test

**Files:**

- Modify: `tests/clients/lsp/server-policy.test.ts`

**Step 1: Write the failing test**

Add this test inside `describe("lsp server policy", ...)`:

```ts
it("prefers pyright before jedi for Python files", async () => {
  const { getServersForFile } = await import(
    "../../../clients/lsp/server.js"
  );

  const pythonServerIds = getServersForFile("example.py").map(
    (server) => server.id,
  );

  expect(pythonServerIds.slice(0, 2)).toEqual(["python", "python-jedi"]);
});
```

**Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run tests/clients/lsp/server-policy.test.ts -t "prefers pyright before jedi"
```

Expected: FAIL because the pinned registry returns only `python-jedi`.

**Step 3: Commit the regression test**

```bash
git add tests/clients/lsp/server-policy.test.ts
git commit -m "test: require pyright before jedi"
```

The failing commit is intentional: the upstream merge is the implementation under test.

### Task 2: Merge upstream and resolve the two conflicts

**Files:**

- Merge/modify: `index.ts`
- Merge/modify: `skills/lsp-navigation/SKILL.md`
- Auto-merged relevant files: `clients/installer/index.ts`, `clients/lsp/server.ts`, `clients/tool-policy.ts`, `tests/index-integration.test.ts`, `README.md`

**Step 1: Merge upstream**

```bash
git merge --no-ff master
```

Expected: merge pauses with content conflicts in only `index.ts` and `skills/lsp-navigation/SKILL.md`.

If the conflict set differs, stop and inspect the new paths before resolving them.

**Step 2: Resolve `index.ts` in favor of safe context snapshots**

For `agent_end`, retain:

```ts
const { ctxCwd, ctxUi } = snapshotEventContext("agent_end", ctx);
const getFlag = snapshotFlags(["no-autoformat", "no-read-guard", "no-lsp"]);
await handleAgentEnd({
  ctxCwd,
  getFlag,
  notify: (msg, level) => ctxUi?.notify?.(msg, level),
```

For `turn_end`, retain:

```ts
const { ctxCwd, ctxUi } = snapshotEventContext("turn_end", ctx);
const getFlag = snapshotFlags(["no-lsp", "no-tests"]);
// ...
await handleTurnEnd({
  ctxCwd,
  getFlag,
```

This preserves `24dd753` and rejects upstream accesses to stale `ctx`/live flags.

**Step 3: Resolve the navigation skill as a semantic union**

Keep the pinned mandatory trigger wording while incorporating upstream diagnostics guidance:

```yaml
description: Use when needing IDE-style code intelligence such as definitions, references, types, call hierarchy, symbols, diagnostics, signature help, implementations, or safe renames. Use as PRIMARY for code intelligence and proactive type/error checks.
```

Retain upstream's separate `When to Use Diagnostics` and `When to Use Navigation` tables, explicit batch guidance, tracked-snapshot caveat, and final golden rule. Remove every conflict marker.

**Step 4: Check the merged Python policy before staging**

Confirm in `clients/lsp/server.ts`:

```ts
PythonServer,
PythonJediServer,
```

Confirm `PythonServer` includes `pyright-langserver` and `basedpyright-langserver` candidates and initializes with `openFilesOnly: true`. Confirm `PythonJediServer` still uses managed tool ID `jedi-language-server`.

**Step 5: Stage resolutions and verify the index**

```bash
git add index.ts skills/lsp-navigation/SKILL.md
git diff --check
git diff --name-only --diff-filter=U
```

Expected: no whitespace errors and no unmerged paths.

**Step 6: Run the regression test and verify GREEN**

```bash
npx vitest run tests/clients/lsp/server-policy.test.ts -t "prefers pyright before jedi"
```

Expected: PASS.

**Step 7: Complete the merge commit**

```bash
git commit
```

Retain the generated merge subject and document the conflict policy in the body.

### Task 3: Verify behavior and ancestry

**Files:**

- No edits expected unless verification exposes a defect.

**Step 1: Verify history preservation**

```bash
for commit in 24dd753 9cd63a4 3a11ab2 3024432 1ef3dda master; do
  git merge-base --is-ancestor "$commit" HEAD
  echo "$commit preserved"
done
```

Expected: every check exits zero.

**Step 2: Run focused tests**

```bash
npx vitest run \
  tests/clients/lsp/server-policy.test.ts \
  tests/clients/lsp/integration.test.ts \
  tests/clients/lsp/lifecycle.test.ts \
  tests/clients/installer/managed-tool-ids.test.ts \
  tests/tools/lsp-diagnostics.test.ts \
  tests/tools/lsp-navigation.test.ts \
  tests/clients/formatters.test.ts \
  tests/clients/tool-policy.test.ts \
  tests/index-integration.test.ts
```

Expected: PASS, including upstream unavailable-LSP tests and pinned formatter/tool-policy tests.

**Step 3: Run proactive diagnostics**

Run `lsp_diagnostics` with severity `all` on:

- `clients/lsp/server.ts`
- `clients/installer/index.ts`
- `clients/tool-policy.ts`
- `index.ts`
- `tests/clients/lsp/server-policy.test.ts`
- `tests/index-integration.test.ts`

Expected: no errors.

**Step 4: Run repository verification**

```bash
npm run lint
npm run build
npm test
git diff --check
git status --short --branch
```

Expected: lint, build, and all tests pass; working tree is clean. If any test fails, use systematic debugging and do not bundle speculative corrections.

**Step 5: Exercise the managed Pyright server directly**

After the build, run a small Node script that imports `PythonServer`, calls `spawn()` with installation allowed, creates an LSP client for a temporary Python file, opens it, and performs a hover or diagnostics request. Always shut down the client/process in `finally`.

Expected: the launched process path resolves to the existing managed `~/.pi-lens/tools/node_modules/.bin/pyright-langserver`, and the request succeeds without attempting Jedi installation.

### Task 4: Publish the verified pi-lens branch

**Files:**

- No edits expected.

**Step 1: Record the reconciled commit**

```bash
PI_LENS_SHA=$(git rev-parse HEAD)
printf '%s\n' "$PI_LENS_SHA"
```

**Step 2: Request the branch-integration choice**

Use the finishing-a-development-branch skill. Publication is required before a clean machine can resolve a commit pin. Do not push until the user selects the push/PR option.

**Step 3: Publish the selected branch**

For the approved push option:

```bash
git push -u origin fix/pi-lens/python-lsp-reconciliation
```

Confirm the recorded SHA is reachable from `origin/fix/pi-lens/python-lsp-reconciliation`.

### Task 5: Update the durable pi-setup pin with TDD

**Files (separate repository/worktree):**

- Modify: `test/bootstrap.test.ts`
- Modify: `config/settings.json`
- Modify: `README.md`

**Step 1: Create an isolated pi-setup worktree**

Create branch `fix/pi-setup/python-lsp-pin` from `origin/main`. Do not carry the unrelated date-only change currently present in the main checkout's `extensions/llm-wiki/README.md`.

**Step 2: Update the bootstrap expectation first**

Replace the old pi-lens SHA in `test/bootstrap.test.ts` with `PI_LENS_SHA`.

**Step 3: Run the bootstrap test and verify RED**

```bash
node --test test/bootstrap.test.ts
```

Expected: FAIL because `config/settings.json` still contains `3a11ab24118396b3820f5e8ab143ac9dfae7aa0d`.

**Step 4: Update durable configuration and documentation**

Replace the old SHA with `PI_LENS_SHA` in:

- `config/settings.json`
- both package examples in `README.md`

Keep the explanation that pi-lens is pinned for local policy.

**Step 5: Run tests and verify GREEN**

```bash
node --test test/bootstrap.test.ts
npm test
```

Expected: PASS.

**Step 6: Commit explicit paths**

```bash
git add test/bootstrap.test.ts config/settings.json README.md
git commit -m "fix: pin reconciled Python LSP package"
```

Use the finishing-a-development-branch skill before pushing or integrating this second branch.

### Task 6: Reconcile the active Pi installation and verify runtime

**Files:**

- Modify through Pi CLI: `~/.pi/agent/settings.json`
- Reconciled package checkout: `~/.pi/agent/git/github.com/qpaddock-source/pi-lens`

**Step 1: Save the rollback ref**

```bash
OLD_PI_LENS_SHA=3a11ab24118396b3820f5e8ab143ac9dfae7aa0d
```

**Step 2: Install the published commit**

```bash
pi install "git:github.com/qpaddock-source/pi-lens@$PI_LENS_SHA"
```

Expected: settings update to the new pin, package checkout reconciliation, and successful dependency installation.

**Step 3: Reload Pi**

Run `/reload` in the active Pi session or restart Pi.

**Step 4: Verify a real Python file**

Run `lsp_diagnostics` and one navigation operation against a known Python file. Check `~/.pi-lens/sessionstart.log` for a successful `python`/Pyright spawn and confirm the footer reports at least one active LSP client. Confirm no `python-jedi` install attempt occurs while managed Pyright is available.

**Step 5: Roll back on failure**

```bash
pi install "git:github.com/qpaddock-source/pi-lens@$OLD_PI_LENS_SHA"
```

Reload Pi, then report the failed verification evidence. Do not install Jedi with unsafe pip flags.
