# dsh-worktree-session

Git worktree based sessions for DeepSeek Harness. The the project row's
**"+" button** (new session)  creates a the new session rooted in a new worktree.

## Why

When working with an agentic coding tool it is common to
run multiple tasks in parallel on different branches. DSH supports this with sessions —
but every session on a project shares the same Git checkout, so parallel
sessions can clobber each other: one session's `git checkout` or `git reset`
yanks the branch out from under another mid-task.

The simple Git answer is worktrees: one checkout per task, each isolated. This
plugin changes the default behavior so that **adding a session (the + button)
first creates a worktree, then creates the session inside it**. The session's
`cwd` is set once, at creation, and immutable afterwards — so birthing it in
the tree is the only moment isolation can be guaranteed.

## What the "+" button does

One click on a project row's +:

1. **Worktree** — `git worktree add -b wt/<slug> .wt/<slug> <base>` from the
   last-known refs (no network). `<slug>` is `wt-YYYYMMDD-HHMM` (auto-suffixed
   `-2`, `-3` on collision); `<base>` is `origin/HEAD`, falling back to
   `origin/main`. `.wt/` is excluded via `.git/info/exclude` — local-only,
   never a tracked file.
2. **Bootstrap** — the checkout's `.env` is symlinked into the tree, and a
   repo-declared executable `.worktree-bootstrap` runs inside it, in the
   background: the session never waits on it.
3. **Open** — the session is created in the tree and opens with a working
   composer; its sidebar row renders under the project.

Anything else — plugin absent, route down, not a git repo — falls back to the
native flow, so non-git workspaces behave exactly as upstream. The sidebar's
top **"New session" button is untouched** and remains the native in-checkout
path.

## Deleting a worktree

The session row's **⋯ menu** gains a "Delete worktree" item for sessions
living under `<project>/.wt/`. Confirm, and the cleanup route removes tree,
branch, and workspace registration together. The route refuses — the dialog
then shows the reason, with an explicit force confirm — when the tree is dirty
or the branch holds commits no remote contains and `gh` cannot confirm a
merged PR. `gh`'s absence fails closed: squash-merged branches are never
ancestors of `main`, so ancestry alone must never be the authority.

## Why the apply script

The three sidebar behaviors — the + handoff, the group absorption, and the ⋯
menu item — live inside DSH's compiled workspace-browser bundle
(`@deepseek-ai/dsh-client-ui-workspace/lib/client.js`). DSH's plugin system
exposes declared slot seams (input-bar chips, session-row badges) but no seam
covers those points, and a plugin cannot change how the browser groups rows,
what its + button does, or what its session menu contains. So the patch edits
the installed bundle file directly, and `seam/apply.sh` makes that safe:

- **hash-guard** — refuses to touch an unrecognized upstream build; a DSH
  update is never clobbered, only skipped
- **marker detection** — the patch carries a comment marker, so a stale patch
  of ours can be upgraded in place while a genuine upstream change is left alone
- **revert** — restores the baseline (badge seam included) at any time
- **status** — run this first after a DSH update; it reports drift without
  touching anything

Because the patch lives in `node_modules`, a DSH reinstall or update reverts
to pristine — re-run `apply.sh apply` afterwards. It composes with the
`dsh-git-badge` seam patch (disjoint regions; the baseline is the
badge-patched build). If upstream ever ships these seams, `apply` becomes a
no-op and the plugin keeps working unchanged.

## Install

```bash
dsh plugin --profile web add link:/home/kmcisaac/Projects/dhs-simple-worktree
```

then add `"dsh-worktree-session"` to `dsh.profile.bundles` in
`~/.dsh/profiles/web/package.json`, apply the sidebar patch, and restart the
web process:

```bash
seam/apply.sh apply
```

## Testing

```bash
npm test
```

Tests against real temporary repositories (bare origin + clone, real
`git worktree add`, real `.worktree-bootstrap` runs) plus the route handlers
through a captured webServer. No DSH, no network, no restart. The test-only
exports (`config`, `uniqueSlug`, `createWorktree`, `cleanupWorktree`, …) let
the node half be driven without booting a profile.
