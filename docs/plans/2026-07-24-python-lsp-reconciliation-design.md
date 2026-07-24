# Python LSP Reconciliation Design

Date: 2026-07-24
Status: validated with user

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
4. Preserve Pyright initialization with `openFilesOnly: true`.
5. Preserve upstream unavailable-LSP reporting instead of returning a false clean result.
6. Do not introduce `pip --break-system-packages`, install system Python packages, or otherwise bypass PEP 668.
7. Avoid unrelated cleanup while resolving merge conflicts.

## Runtime flow

For a Python file, pi-lens first selects `PythonServer`. It searches project-local, managed, and system candidates for `pyright-langserver` and `basedpyright-langserver`. A successful server starts over stdio and initializes with `openFilesOnly: true`, preventing workspace-wide cold-start analysis.

If no Pyright-compatible server launches, service selection advances to `PythonJediServer`. Existing managed-tool policy may install or discover `jedi-language-server`. If neither implementation is available, the LSP tool reports unavailability. The footer continues to derive status from live client count, while the standalone Pyright CLI remains an independent diagnostics runner.

## Error handling

Candidate launch failure remains recoverable so the next registered Python server can be attempted. Failure details should identify unavailable clients rather than claiming there are no diagnostics. Existing per-session circuit-breaker behavior remains intact.

The local Python environment will not be modified as part of reconciliation. Pyright is already available under `~/.pi-lens/tools/node_modules/.bin/` and should satisfy the preferred path after rollout.

## Testing

- Confirm the three divergent commits and upstream `master` are ancestors of the reconciled tip.
- Run focused server-policy, installer, LSP diagnostics, formatter, tool-policy, and integration tests.
- Run TypeScript diagnostics, `npm run lint`, `npm run build`, and the complete `npm test` suite.
- Verify `PythonServer` precedes `PythonJediServer` in the final registry.
- Verify a real Python file starts the managed Pyright language server and changes the footer to an active state.
- Verify unavailable LSP diagnostics are distinguishable from a clean result.

The baseline immediate-exit integration tests were stabilized for high parallel load without changing the production startup window.

## Rollout and rollback

Only after repository verification succeeds, update the pi-lens package pin in `~/.pi/agent/settings.json` to the reconciled commit and reload or restart Pi. Verify fresh session logs and Python LSP navigation.

If runtime verification fails, restore the prior pin `3a11ab24118396b3820f5e8ab143ac9dfae7aa0d` and reload Pi. Do not fall back to unsafe Python package installation flags.
