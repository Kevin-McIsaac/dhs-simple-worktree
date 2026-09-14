# dsh-worktree-session

One-click git-worktree sessions for DeepSeek Harness. Click the chip, and the
next session is born inside a fresh git worktree — the one moment a session's
`cwd` is settable — so the conversation, its sidebar row and its git badge all
describe the tree, exactly, by construction.

## What the chip does

`⎇ worktree` lives in the conversation input bar (the shipped
`conversation.input.left` seam — no core patch, same slot the
`dsh-git-badge` chip uses). One click, no typing:

1. **fetch** — `git fetch origin` (failure degrades to a warning; the branch is
   cut from last-known refs, the git-worktree skill's own flow).
2. **cut** — `git worktree add -b wt/<slug> .wt/<slug> <base>` where `<slug>`
   is `wt-YYYYMMDD-HHMM` (auto-suffixed `-2`, `-3` on collision) and `<base>`
   is `origin/HEAD`, falling back to `origin/main`.
3. **exclude** — `.wt/` is appended to `.git/info/exclude` (local-only; never a
   tracked file).
4. **bootstrap** — the checkout's `.env` is symlinked into the tree when one
   exists; if the repo declares an executable `.worktree-bootstrap` at its
   root, it runs inside the tree. Failures are reported, never fatal.
5. **register** — the tree becomes a DSH workspace (`workspaceRegistry.create`,
   idempotent), so it appears in the sidebar with its own session rows.
6. **open** — the client then runs DSH's own native flow,
   `sessions.create({ workspaceId })` → `sessions.open(id)` — identical to the
   sidebar's "New session in {name}" button. `session.create` resolves
   `cwd = workspace.path`, and cwd is immutable thereafter.

The chevron (`▾`) beside the chip opens a remove popover listing the repo's
`.wt` trees with their safety facts (`*` dirty, `✓` merged). Removal runs the
cleanup route, which refuses — showing the reason, with an explicit **force**
button — when the tree is dirty or the branch holds commits no remote contains
and `gh` cannot confirm a merged PR. `gh`'s absence fails closed: squash-merged
branches are never ancestors of `main`, so ancestry alone must never be the
authority.

## Safety invariants

- Only trees under `<repo>/.wt/` with a `wt/…` branch are ever removed.
- The main checkout is never removable.
- Cleanup requires either remote containment, a MERGED PR, or `force: true`.

## Install

```bash
dsh plugin --profile web add link:/home/kmcisaac/Projects/dhs-simple-worktree
```

then add `"dsh-worktree-session"` to `dsh.profile.bundles` in
`~/.dsh/profiles/web/package.json`, and restart the web process.

## Testing

```bash
npm test
```

19 tests against real temporary repositories (bare origin + clone, real
`git worktree add`, real `.worktree-bootstrap` runs) plus the route handlers
through a captured webServer. No DSH, no network, no restart. The test-only
exports (`config`, `uniqueSlug`, `createWorktree`, `cleanupWorktree`,
`listWorktrees`, `makeDeps`) let the node half be driven without booting a
profile.
