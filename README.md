# dsh-worktree-session

One-click git-worktree sessions for DeepSeek Harness. The sidebar project row's
**"+" button** cuts a fresh git worktree and the new session is born inside it —
the one moment a session's `cwd` is settable — and the session renders **under
the existing project row**, not under a separate workspace.

## What the "+" button does

One click, no typing, on any project row whose workspace is a git repo:

1. **cut** — the plugin route fetches `origin`, then
   `git worktree add -b wt/<slug> .wt/<slug> <base>` where `<slug>` is
   `wt-YYYYMMDD-HHMM` (auto-suffixed `-2`, `-3` on collision) and `<base>` is
   `origin/HEAD`, falling back to `origin/main`. A failed fetch degrades to a
   warning; the branch is cut from last-known refs.
2. **bootstrap** — the checkout's `.env` is symlinked into the tree when one
   exists; if the repo declares an executable `.worktree-bootstrap` at its
   root, it runs inside the tree. Failures are reported, never fatal.
3. **open** — the client births the session with DSH's own
   `sessions.create({ cwd })` → `sessions.open(id)`. `session.create` sets
   `cwd = the tree`, and cwd is immutable thereafter.

Anything else — plugin absent, route down, not a git repo — falls back to the
native flow, so non-git workspaces behave exactly as upstream.

## Why the session shows under the project

The tree IS registered as a workspace — membership is mandatory, because
`attachSession` pins cwd to the workspace path and the conversation hero
disables the composer ("Choose a workspace to start") for sessions with no
workspace. But the worktree's group must not render as a separate project:
a small hash-guarded patch to the workspace browser absorbs every
`<project>/.wt/…` workspace group into its project's row, and re-homes
cwd-stray sessions the same way (so manual `git worktree add` trees merge
too). The sidebar's top **"New session" button is untouched** — it remains
the native in-checkout path.

## Deleting a worktree

The session row's **⋯ menu** gains a "Delete worktree" item for sessions
living under `<project>/.wt/` (patched in; flat/search lists never show it).
Confirm, and the cleanup route removes tree, branch, and workspace
registration. The route refuses — the dialog then shows the reason with an
explicit force confirm — when the tree is dirty or the branch holds commits
no remote contains and `gh` cannot confirm a merged PR. `gh`'s absence fails
closed: squash-merged branches are never ancestors of `main`, so ancestry
alone must never be the authority. There is no input-bar chip any more: the
+ button owns creation and the ⋯ menu owns deletion.

## Safety invariants

- Only trees under `<repo>/.wt/` with a `wt/…` branch are ever removed.
- The main checkout is never removable.
- Cleanup requires either remote containment, a MERGED PR, or `force: true`.
- `.wt/` is excluded via `.git/info/exclude` (local-only; never a tracked file).

## Install

```bash
dsh plugin --profile web add link:/home/kmcisaac/Projects/dhs-simple-worktree
```

then add `"dsh-worktree-session"` to `dsh.profile.bundles` in
`~/.dsh/profiles/web/package.json`, apply the sidebar patch, and restart the
web process:

```bash
seam/apply.sh apply      # hash-guarded; refuses unknown upstream builds
seam/apply.sh revert     # restore the baseline (badge seam included) at any time
seam/apply.sh status     # run this first after a DSH update
```

The patch composes with the `dsh-git-badge` seam patch (disjoint regions); its
pristine baseline is the badge-patched build.

## Testing

```bash
npm test
```

20 tests against real temporary repositories (bare origin + clone, real
`git worktree add`, real `.worktree-bootstrap` runs) plus the route handlers
through a captured webServer. No DSH, no network, no restart. The test-only
exports (`config`, `uniqueSlug`, `createWorktree`, `cleanupWorktree`,
`listWorktrees`, `makeDeps`) let the node half be driven without booting a
profile.