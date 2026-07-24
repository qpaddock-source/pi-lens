# Python LSP Reconciliation Design

Date: 2026-07-24
Status: validated with user; revised after technical review

## Goal

Reconcile the locally pinned pi-lens branch with upstream `master` without dropping its three divergent commits, restore Pyright/BasedPyright as the preferred Python language server, retain managed Jedi as fallback, and report LSP unavailability accurately.

## Context

The local Pi configuration pins pi-lens at `3a11ab24118396b3820f5e8ab143ac9dfae7aa0d`. That line diverged from `master` after release `v3.8.44` and contains:

- `24dd753` — snapshot stale hook context
- `9cd63a4` — default web formatting to Prettier
- `3a11ab2` — manage Jedi language server

At the pin, `PythonJediServer` is the only registered Python LSP. The machine has a managed Pyright installation but no `jedi-language-server`; Jedi auto-install also fails under the externally managed Python environment. Standalone Pyright diagnostics therefore run while the live LSP client count remains zero.

Upstream `master` contains the two relevant corrections:

- `3024432` — register Pyright/BasedPyright first with `openFilesOnly: true`, retaining Jedi as fallback
- `1ef3dda` — distinguish LSP unavailability from a clean diagnostic result

## Chosen approach

Create `fix/pi-lens/python-lsp-reconciliation` from the current pin and merge upstream `master` into it. A merge preserves the original divergent commit identities and incorporates all upstream changes. It avoids rewriting the history currently referenced by local configuration.

A rebase or cherry-pick sequence was rejected because it would rewrite the divergent commits and create more opportunities to omit or alter pinned behavior.

## Conflict policy

Resolve conflicts according to these rules:

1. Preserve the behavior introduced by all three pinned commits.
2. Use upstream Python server ordering: `PythonServer` before `PythonJediServer`.
3. Preserve managed Jedi installation and use Jedi only when Pyright/BasedPyright cannot launch.
4. Add an explicit service-level fallback policy; registry ordering alone is insufficient because aggregate diagnostics request all matching servers.
5. Preserve Pyright initialization with `openFilesOnly: true`.
6. Preserve upstream unavailable-LSP reporting instead of returning a false clean result.
7. Do not introduce `pip --break-system-packages`, install system Python packages, or otherwise bypass PEP 668.
8. Avoid unrelated cleanup while resolving merge conflicts.

## Fallback and aggregation policy

Add optional `fallbackFor?: string` metadata to `LSPServerInfo` and set `PythonJediServer.fallbackFor` to `"python"`. This declares that Jedi is an exclusive fallback for the Pyright server ID rather than a complementary diagnostics provider.

`LSPService.getClientsForFile()` must preserve concurrent aggregation for independent, complementary servers while treating declared fallbacks differently:

1. Resolve roots and attempt all non-fallback servers concurrently.
2. Track successfully started server IDs.
3. Process fallback servers in registry order.
4. Skip a fallback when its target server is already ready.
5. If the target failed or was not applicable, attempt fallbacks until one succeeds, then mark that target as satisfied.
6. Count only servers actually attempted in diagnostics health; skipped fallbacks must not inflate `serverCountAttempted`.

`getClientForFile()` already attempts servers sequentially and retains its current primary-then-fallback behavior. The explicit metadata closes the aggregate-diagnostics path that would otherwise start and install both Python servers.

## Runtime flow

For a Python file, pi-lens first selects `PythonServer`. It searches project-local, managed, and system candidates for `pyright-langserver` and `basedpyright-langserver`. A successful server starts over stdio and initializes with `openFilesOnly: true`, preventing workspace-wide cold-start analysis.

Navigation uses the first successful client. Aggregate diagnostics start Pyright plus any independent complementary providers, but skip Jedi when Pyright is ready. Only when Pyright cannot launch does service selection attempt `PythonJediServer`, whose existing managed-tool policy may discover or install `jedi-language-server`. If neither implementation is available, the LSP tool reports unavailability. The footer continues to derive status from live client count, while the standalone Pyright CLI remains an independent diagnostics runner.

## Error handling

Candidate launch failure remains recoverable so the next registered Python server can be attempted. Failure details should identify unavailable clients rather than claiming there are no diagnostics. Existing per-session circuit-breaker behavior remains intact.

The local Python environment will not be modified as part of reconciliation. Pyright is already available under `~/.pi-lens/tools/node_modules/.bin/` and should satisfy the preferred path after rollout.

## Testing

- Confirm the three divergent commits, baseline/design commits, regression-test commit, and upstream fixes are ancestors of the reconciled tip using fail-fast ancestry checks.
- Verify `PythonServer` precedes `PythonJediServer`, Pyright initialization includes `openFilesOnly: true`, and Jedi declares `fallbackFor: "python"`.
- Add service-level tests proving: Pyright success skips Jedi; Pyright failure attempts Jedi; independent complementary servers still aggregate; skipped fallbacks do not count as attempts.
- Add tool-level tests proving: zero ready clients report LSP unavailable rather than `No diagnostics found`; stale diagnostics remain visibly stale; healthy empty results remain distinct; structured health details are returned.
- Run focused server-policy, service, installer, LSP diagnostics, formatter, tool-policy, and integration tests.
- Run TypeScript diagnostics, `npm run lint`, `npm run build`, and the complete `npm test` suite.
- Run a concrete `LSPService` smoke script against a real Python file, with assertions and unconditional process/temp-file cleanup.

The baseline immediate-exit integration tests were stabilized for high parallel load without changing the production startup window.

## Rollout and rollback

After repository verification, publish the pi-lens branch so its commit is resolvable as a git package pin. Reconcile the active package with `pi install`, reload or restart Pi, and verify fresh logs, diagnostics health, navigation, live client count, and the absence of Jedi installation attempts while Pyright is available.

Only after active runtime verification succeeds may the durable pin in `pi-setup` be updated and committed. If runtime verification fails, restore the prior active pin `3a11ab24118396b3820f5e8ab143ac9dfae7aa0d`, reload Pi, and leave or abandon the durable `pi-setup` pin change. Do not fall back to unsafe Python package installation flags.
