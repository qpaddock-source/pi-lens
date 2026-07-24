# Python LSP Reconciliation Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Merge upstream pi-lens into the locally pinned branch while preserving all pinned behavior, prefer managed Pyright for Python LSP, use managed Jedi only as a true fallback, report unavailable LSPs accurately, validate the installed package, and only then update the durable local Pi setup pin.

**Architecture:** Branch `fix/pi-lens/python-lsp-reconciliation` starts at the current pin and merges `master`, preserving both histories. The merge provides upstream Pyright and health behavior; a small `fallbackFor` policy prevents aggregate diagnostics from starting Jedi when Pyright is ready while preserving concurrent complementary servers. Publication and active runtime validation happen before the separate `pi-setup` pin update.

**Tech Stack:** TypeScript ESM, Vitest, Node 26, git worktrees, Pi git packages.

---

## Preconditions already completed

- Worktree: `/Users/quinnpaddock/worktrees/pi-lens/fix/pi-lens/python-lsp-reconciliation`
- Branch: `fix/pi-lens/python-lsp-reconciliation`
- `6e58a25` stabilizes immediate-exit tests under high parallel load; normal `npm test` passes with 963 passed and 5 skipped.
- `e5a3754` records the user-validated design.
- `37408be` records the original implementation plan.
- A dry-run merge predicts content conflicts only in `index.ts` and `skills/lsp-navigation/SKILL.md`; recompute after Task 1 and stop if the conflict set changes unexpectedly.

### Task 1: Add pre-merge Python policy regressions

**Files:**

- Modify: `tests/clients/lsp/server-policy.test.ts`

**Step 1: Add the server-order test**

Add inside `describe("lsp server policy", ...)`:

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

**Step 2: Assert lazy Pyright initialization**

In the existing `launches pyright-langserver from managed pyright install` test, add:

```ts
expect(spawned?.initialization).toMatchObject({
  openFilesOnly: true,
});
```

**Step 3: Run both tests and verify RED**

```bash
npx vitest run tests/clients/lsp/server-policy.test.ts \
  -t "prefers pyright before jedi|launches pyright-langserver from managed"
```

Expected: FAIL because the pin registers only Jedi and does not initialize Pyright with `openFilesOnly: true`.

**Step 4: Commit the intentional RED tests**

```bash
git add tests/clients/lsp/server-policy.test.ts
git commit -m "test: require preferred lazy pyright LSP"
```

Record the resulting Task 1 commit in the execution notes. The failing commit is intentional: the upstream merge is the implementation under test.

### Task 2: Merge upstream and resolve conflicts

**Files:**

- Merge/modify: `index.ts`
- Merge/modify: `skills/lsp-navigation/SKILL.md`
- Auto-merged relevant files: `clients/installer/index.ts`, `clients/lsp/server.ts`, `clients/lsp/index.ts`, `clients/tool-policy.ts`, `tools/lsp-diagnostics.ts`, `tests/index-integration.test.ts`, `README.md`

**Step 1: Merge upstream**

```bash
git merge --no-ff master
```

Expected: merge pauses with content conflicts in `index.ts` and `skills/lsp-navigation/SKILL.md`. If the conflict set differs, stop and inspect every additional path before resolving it.

**Step 2: Preserve safe event-context snapshots in `index.ts`**

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

This preserves `24dd753` and rejects upstream access to stale `ctx` or live flags.

**Step 3: Resolve the navigation skill as a semantic union**

Use this frontmatter description:

```yaml
description: Use when needing IDE-style code intelligence such as definitions, references, types, call hierarchy, symbols, diagnostics, signature help, implementations, or safe renames. Use as PRIMARY for code intelligence and proactive type/error checks.
```

Retain upstream's separate diagnostics and navigation tables, bounded batch guidance, tracked-snapshot caveat, and final golden rule. Remove every conflict marker.

**Step 4: Inspect the auto-merged Python behavior**

Confirm `clients/lsp/server.ts` contains, in this order:

```ts
PythonServer,
PythonJediServer,
```

Confirm Pyright/BasedPyright candidates and `openFilesOnly: true` are present. Confirm Jedi still uses managed tool ID `jedi-language-server`.

**Step 5: Stage and validate the merge resolution**

```bash
git add index.ts skills/lsp-navigation/SKILL.md
git diff --check
git diff --cached --check
test -z "$(git diff --name-only --diff-filter=U)"
```

Expected: no whitespace errors and no unmerged paths.

**Step 6: Run the Task 1 tests and verify GREEN**

```bash
npx vitest run tests/clients/lsp/server-policy.test.ts \
  -t "prefers pyright before jedi|launches pyright-langserver from managed"
```

Expected: PASS.

**Step 7: Complete the merge commit**

```bash
git commit
```

Retain the generated merge subject and describe the safe-context conflict resolution in the body.

### Task 3: Implement true service-level fallback with TDD

**Files:**

- Modify: `clients/lsp/server.ts`
- Modify: `clients/lsp/index.ts`
- Create: `tests/clients/lsp/service-fallback.test.ts`

**Step 1: Write the service-level test fixture**

Create `tests/clients/lsp/service-fallback.test.ts` using the existing service test mock pattern:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
  getServersForFileWithConfig,
}));
vi.mock("../../../clients/lsp/client.js", () => ({
  createLSPClient,
}));

const FILE = "/repo/example.py";

function fakeClient() {
  return {
    isAlive: () => true,
    shutdown: vi.fn(async () => {}),
    getWorkspaceDiagnosticsSupport: () => ({
      advertised: false,
      mode: "push-only" as const,
      diagnosticProviderKind: "none" as const,
    }),
    getOperationSupport: () => ({}),
  };
}

function server(
  id: string,
  options: { fallbackFor?: string; available?: boolean } = {},
) {
  return {
    id,
    name: id,
    extensions: [".py"],
    fallbackFor: options.fallbackFor,
    root: vi.fn(async () => "/repo"),
    spawn: vi.fn(async () =>
      options.available === false
        ? undefined
        : {
            process: {
              process: { killed: false },
              stdin: {},
              stdout: {},
              stderr: {},
              pid: 1234,
            },
          },
    ),
  };
}

beforeEach(() => {
  getServersForFileWithConfig.mockReset();
  createLSPClient.mockReset();
  createLSPClient.mockImplementation(async () => fakeClient());
});
```

Adjust only the fake process shape if the merged `createLSPClient` contract requires it; do not weaken behavioral assertions.

**Step 2: Add the primary-success test**

```ts
it("skips a declared fallback when its primary server is ready", async () => {
  const { LSPService } = await import("../../../clients/lsp/index.js");
  const primary = server("python");
  const jedi = server("python-jedi", { fallbackFor: "python" });
  getServersForFileWithConfig.mockReturnValue([primary, jedi]);

  const result = await new LSPService().getClientsForFile(FILE);

  expect(primary.spawn).toHaveBeenCalledTimes(1);
  expect(jedi.spawn).not.toHaveBeenCalled();
  expect(result.clients.map((entry) => entry.info.id)).toEqual(["python"]);
  expect(result.serverCountAttempted).toBe(1);
});
```

**Step 3: Add the primary-failure test**

```ts
it("starts a declared fallback when its primary server is unavailable", async () => {
  const { LSPService } = await import("../../../clients/lsp/index.js");
  const primary = server("python", { available: false });
  const jedi = server("python-jedi", { fallbackFor: "python" });
  getServersForFileWithConfig.mockReturnValue([primary, jedi]);

  const result = await new LSPService().getClientsForFile(FILE);

  expect(primary.spawn).toHaveBeenCalledTimes(1);
  expect(jedi.spawn).toHaveBeenCalledTimes(1);
  expect(result.clients.map((entry) => entry.info.id)).toEqual([
    "python-jedi",
  ]);
  expect(result.serverCountAttempted).toBe(2);
});
```

**Step 4: Add the complementary-server test**

```ts
it("keeps complementary servers while skipping a satisfied fallback", async () => {
  const { LSPService } = await import("../../../clients/lsp/index.js");
  const primary = server("python");
  const complementary = server("python-analysis");
  const jedi = server("python-jedi", { fallbackFor: "python" });
  getServersForFileWithConfig.mockReturnValue([
    primary,
    complementary,
    jedi,
  ]);

  const result = await new LSPService().getClientsForFile(FILE);

  expect(complementary.spawn).toHaveBeenCalledTimes(1);
  expect(jedi.spawn).not.toHaveBeenCalled();
  expect(result.clients.map((entry) => entry.info.id).sort()).toEqual([
    "python",
    "python-analysis",
  ]);
  expect(result.serverCountAttempted).toBe(2);
});
```

**Step 5: Run the new tests and verify RED**

```bash
npx vitest run tests/clients/lsp/service-fallback.test.ts
```

Expected: FAIL because aggregate selection currently attempts every matching server.

**Step 6: Add fallback metadata**

Add to `LSPServerInfo` in `clients/lsp/server.ts`:

```ts
/** Server ID that must be unavailable before this fallback is attempted. */
fallbackFor?: string;
```

Add to `PythonJediServer`:

```ts
fallbackFor: "python",
```

**Step 7: Replace aggregate selection with primary-then-fallback selection**

Replace the body of `getClientsForFile()` after the empty-server check with logic equivalent to:

```ts
const roots = await Promise.all(servers.map((server) => server.root(filePath)));
const rootedServers = servers.filter((_server, index) => Boolean(roots[index]));
const primaryServers = rootedServers.filter((server) => !server.fallbackFor);
const fallbackServers = rootedServers.filter((server) => server.fallbackFor);

let serverCountAttempted = primaryServers.length;
const primaryResults = await Promise.all(
  primaryServers.map((server) => this.ensureClientForServer(filePath, server)),
);
const clients = primaryResults.filter(
  (entry): entry is SpawnedServer => Boolean(entry),
);
const satisfiedServerIds = new Set(clients.map((entry) => entry.info.id));

for (const fallback of fallbackServers) {
  const target = fallback.fallbackFor;
  if (target && satisfiedServerIds.has(target)) continue;

  serverCountAttempted += 1;
  const spawned = await this.ensureClientForServer(filePath, fallback);
  if (!spawned) continue;

  clients.push(spawned);
  if (target) satisfiedServerIds.add(target);
}

return { clients, serverCountAttempted };
```

This must not serialize or suppress independent primary/complementary servers.

**Step 8: Run the tests and verify GREEN**

```bash
npx vitest run \
  tests/clients/lsp/service-fallback.test.ts \
  tests/clients/lsp/service-mode-grace.test.ts \
  tests/clients/lsp/service-early-unblock.test.ts \
  tests/clients/lsp/service-touch-collect.test.ts \
  tests/clients/lsp/server-policy.test.ts
```

Expected: PASS.

**Step 9: Commit**

```bash
git add clients/lsp/server.ts clients/lsp/index.ts \
  tests/clients/lsp/service-fallback.test.ts
git commit -m "fix: make Jedi an exclusive Python LSP fallback"
```

### Task 4: Add unavailable-LSP regression coverage

**Files:**

- Modify: `tests/tools/lsp-diagnostics.test.ts`

**Step 1: Add a small file-execution helper**

Inside the test file, add a helper that creates a temporary `.ts` file, executes `createLspDiagnosticsTool()` in file mode, returns the result, and removes the directory in `finally`. Keep the existing hoisted service mock.

**Step 2: Test zero ready clients**

Configure:

```ts
mocked.service.getDiagnostics.mockResolvedValue([]);
mocked.service.getDiagnosticsHealth.mockReturnValue({
  health: "no_clients",
  failureKind: "no_clients",
  serverCountAttempted: 1,
  serverCountReady: 0,
  candidateServerIds: ["typescript"],
  mergedCount: 0,
  dedupDroppedCount: 0,
  checkedAt: new Date().toISOString(),
});
```

Assert the content contains `LSP unavailable`, does not contain `No diagnostics found.`, and:

```ts
expect(result.details?.lspHealth).toMatchObject({
  health: "no_clients",
  serverCountAttempted: 1,
  serverCountReady: 0,
});
```

**Step 3: Test stale diagnostics**

Return one diagnostic and health:

```ts
{
  health: "no_clients_stale",
  failureKind: "no_clients_stale",
  serverCountAttempted: 1,
  serverCountReady: 0,
  candidateServerIds: ["typescript"],
  mergedCount: 1,
  dedupDroppedCount: 0,
  checkedAt: new Date().toISOString(),
}
```

Assert content contains `LSP unavailable`, `stale last-known diagnostics`, and the diagnostic message; assert `details.lspHealth.health === "no_clients_stale"`.

**Step 4: Test a healthy empty result**

Return `[]` and health with `health: "ok_empty"`, `serverCountAttempted: 1`, and `serverCountReady: 1`. Assert the content is `No diagnostics found.`, contains no unavailable warning, and exposes the healthy structured details.

**Step 5: Run the tests**

```bash
npx vitest run tests/tools/lsp-diagnostics.test.ts
```

Expected: PASS against the merged upstream behavior. If any assertion fails, use systematic debugging before modifying production behavior.

**Step 6: Commit**

```bash
git add tests/tools/lsp-diagnostics.test.ts
git commit -m "test: cover unavailable LSP diagnostic health"
```

### Task 5: Verify behavior, history, and the real managed server

**Files:**

- No edits expected unless verification exposes a defect.

**Step 1: Verify ancestry fail-fast**

Run in one shell invocation:

```bash
set -euo pipefail
task1_sha=$(git log -1 --format=%H --grep='^test: require preferred lazy pyright LSP$')
test -n "$task1_sha"
for commit in \
  24dd753 \
  9cd63a4 \
  3a11ab2 \
  6e58a25 \
  e5a3754 \
  37408be \
  "$task1_sha" \
  3024432 \
  1ef3dda \
  master
do
  git merge-base --is-ancestor "$commit" HEAD && printf '%s preserved\n' "$commit"
done
```

Expected: any failed ancestor check terminates the command nonzero.

**Step 2: Run focused tests**

```bash
npx vitest run \
  tests/clients/lsp/server-policy.test.ts \
  tests/clients/lsp/service-fallback.test.ts \
  tests/clients/lsp/service-mode-grace.test.ts \
  tests/clients/lsp/service-early-unblock.test.ts \
  tests/clients/lsp/service-touch-collect.test.ts \
  tests/clients/lsp/integration.test.ts \
  tests/clients/lsp/lifecycle.test.ts \
  tests/clients/installer/managed-tool-ids.test.ts \
  tests/tools/lsp-diagnostics.test.ts \
  tests/tools/lsp-navigation.test.ts \
  tests/clients/formatters.test.ts \
  tests/clients/tool-policy.test.ts \
  tests/index-integration.test.ts
```

Expected: PASS.

**Step 3: Run proactive diagnostics**

Run `lsp_diagnostics` with severity `all` on:

- `clients/lsp/server.ts`
- `clients/lsp/index.ts`
- `clients/installer/index.ts`
- `clients/tool-policy.ts`
- `tools/lsp-diagnostics.ts`
- `index.ts`
- `tests/clients/lsp/server-policy.test.ts`
- `tests/clients/lsp/service-fallback.test.ts`
- `tests/tools/lsp-diagnostics.test.ts`
- `tests/index-integration.test.ts`

Expected: no errors.

**Step 4: Run repository verification**

```bash
npm run lint
npm run build
npm test
git diff --check
git diff --cached --check
git status --short --branch
```

Expected: lint, build, and all tests pass; the working tree is clean.

**Step 5: Exercise the real selection path through `LSPService`**

After `npm run build`, run from the pi-lens worktree:

```bash
node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { LSPService } from "./clients/lsp/index.js";

const root = await mkdtemp(path.join(os.tmpdir(), "pi-lens-python-smoke-"));
const file = path.join(root, "smoke.py");
const content = 'value: int = "not-an-int"\n';
const service = new LSPService();

try {
  await writeFile(file, content, "utf8");
  const selection = await service.getClientsForFile(file);
  assert.deepEqual(
    selection.clients.map((entry) => entry.info.id),
    ["python"],
  );
  assert.equal(selection.serverCountAttempted, 1);

  await service.openFile(file, content);
  await service.getDiagnostics(file, "document");
  const health = service.getDiagnosticsHealth(file);
  assert.ok(health);
  assert.equal(health.serverCountReady, 1);
  assert.equal(health.serverCountAttempted, 1);
  assert.ok(health.candidateServerIds.includes("python"));
  assert.ok(health.candidateServerIds.includes("python-jedi"));
  console.log(JSON.stringify({ selected: ["python"], health }, null, 2));
} finally {
  await service.shutdown();
  await rm(root, { recursive: true, force: true });
}
NODE
```

Expected: selected client is `python`, attempted count is one, health is ready, cleanup always runs, and no Jedi installation is attempted. The automated fallback test remains the authoritative assertion that `PythonJediServer.spawn()` was not called.

### Task 6: Publish the verified pi-lens branch

**Files:**

- No edits expected.

**Step 1: Request the branch-integration choice**

Use the finishing-a-development-branch skill. Publication is required before a clean machine can resolve the commit pin. Do not push until the user selects the push/PR option.

**Step 2: Publish and verify in one shell invocation**

For an approved push:

```bash
set -euo pipefail
branch=fix/pi-lens/python-lsp-reconciliation
sha=$(git rev-parse HEAD)
git push -u origin "$branch"
git fetch origin "$branch"
git merge-base --is-ancestor "$sha" "origin/$branch"
printf 'published pi-lens SHA: %s\n' "$sha"
```

Record the literal printed SHA in the execution summary; do not rely on a shell variable in later tool calls.

### Task 7: Reconcile and validate the active Pi installation

**Files:**

- Modify through Pi CLI: `~/.pi/agent/settings.json`
- Reconciled checkout: `~/.pi/agent/git/github.com/qpaddock-source/pi-lens`

**Step 1: Install the published commit with a same-shell SHA lookup**

```bash
set -euo pipefail
worktree=/Users/quinnpaddock/worktrees/pi-lens/fix/pi-lens/python-lsp-reconciliation
sha=$(git -C "$worktree" rev-parse HEAD)
pi install "git:github.com/qpaddock-source/pi-lens@$sha"
printf 'installed pi-lens SHA: %s\n' "$sha"
```

Expected: active settings contain the printed literal SHA, checkout reconciliation succeeds, and dependencies install.

**Step 2: Reload Pi**

Run `/reload` in the active Pi session or restart Pi.

**Step 3: Verify a real Python file**

Run `lsp_diagnostics` and one navigation operation against a known Python file. Check fresh `~/.pi-lens/sessionstart.log` entries and assert:

- `python`/Pyright spawns successfully;
- no `python-jedi` spawn or install attempt occurs for the same file/root;
- diagnostics health reports at least one ready client;
- the footer reports at least one active LSP client.

**Step 4: Roll back and stop on failure**

Use the literal old pin, not a cross-command variable:

```bash
pi install "git:github.com/qpaddock-source/pi-lens@3a11ab24118396b3820f5e8ab143ac9dfae7aa0d"
```

Reload Pi, report the evidence, and do not begin Task 8. Do not install Jedi with unsafe pip flags.

### Task 8: Update the durable pi-setup pin only after runtime success

**Files (separate repository/worktree):**

- Modify: `test/bootstrap.test.ts`
- Modify: `config/settings.json`
- Modify: `README.md`

**Step 1: Create an isolated pi-setup worktree**

Create branch `fix/pi-setup/python-lsp-pin` from `origin/main`. Do not carry the unrelated date-only modification currently present in the main checkout's `extensions/llm-wiki/README.md`.

**Step 2: Record the literal verified SHA**

In one shell invocation:

```bash
set -euo pipefail
worktree=/Users/quinnpaddock/worktrees/pi-lens/fix/pi-lens/python-lsp-reconciliation
sha=$(git -C "$worktree" rev-parse HEAD)
git -C "$worktree" merge-base --is-ancestor "$sha" \
  origin/fix/pi-lens/python-lsp-reconciliation
printf '%s\n' "$sha"
```

Use the printed literal SHA in all three files below; do not refer to `PI_LENS_SHA` in later shell calls.

**Step 3: Update the bootstrap expectation first**

Replace the old pi-lens SHA in `test/bootstrap.test.ts` with the printed verified SHA.

**Step 4: Run the bootstrap test and verify RED**

```bash
node --test test/bootstrap.test.ts
```

Expected: FAIL because `config/settings.json` still contains `3a11ab24118396b3820f5e8ab143ac9dfae7aa0d`.

**Step 5: Update durable configuration and documentation**

Replace the old SHA with the same literal verified SHA in:

- `config/settings.json`
- both package examples in `README.md`

Keep the explanation that pi-lens is pinned for local policy.

**Step 6: Run tests and verify GREEN**

```bash
node --test test/bootstrap.test.ts
npm test
```

Expected: PASS.

**Step 7: Commit explicit paths**

```bash
git add test/bootstrap.test.ts config/settings.json README.md
git diff --cached --check
git commit -m "fix: pin reconciled Python LSP package"
```

Use the finishing-a-development-branch skill before pushing or integrating this second branch. If a later check invalidates the pi-lens commit, abandon or revert this pin commit rather than leaving a known-failed durable configuration.
