#!/usr/bin/env bash
# Build patched-client.js from pristine-client.js.
#
# The patch is TWO ANCHORED EDITS to the workspace browser, both delegating all
# logic to the dsh-worktree-session plugin via window.__dshWorktreeSession, so
# with no plugin loaded every path behaves exactly as upstream:
#
#   1. The workspace row's "+" button (onCreate): when the plugin publishes
#      window.__dshWorktreeSession.openForWorkspace, the click cuts a worktree
#      and births the session in it; otherwise the native startSession runs.
#   2. groupByWorkspace: sessions whose cwd sits under <project>/.wt/ are
#      re-homed into that project's group (upstream would file them under
#      Ungrouped, because attachSession pins cwd to the workspace path and a
#      worktree session can never be a registry member).
#
# The sidebar's top "New session" button (startSession) is deliberately NOT
# touched: it remains the native in-checkout path.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
python3 - "$HERE/pristine-client.js" "$HERE/patched-client.js" <<'PY'
import sys

src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
count = 0

def rep(old, new):
    global text, count
    assert text.count(old) == 1, f"anchor not unique/found: {old[:80]!r} ({text.count(old)})"
    text = text.replace(old, new)
    count += 1

T = "\t"

# --- 1. The workspace row "+" button: worktree first, native as fallback ------
rep(
f"""\t\t\t\t\t\t\t\t\t\tonCreate: () => {{
{T*11}if (group.workspaceId !== void 0) {{
{T*12}setGroupExpanded(group.key, true);
{T*12}startSession(group.workspaceId);
{T*11}}}
{T*10}}},""",
f"""\t\t\t\t\t\t\t\t\t\tonCreate: () => {{
{T*11}if (group.workspaceId !== void 0) {{
{T*12}setGroupExpanded(group.key, true);
{T*12}const nativeCreate = () => startSession(group.workspaceId);
{T*12}/* dsh-worktree-session:patch — the plugin, when loaded, cuts a worktree and
{T*12} * births the session in it; anything else (plugin absent, route down, not a
{T*12} * git repo) falls through to the untouched native flow. */
{T*12}if (typeof window !== "undefined" && window.__dshWorktreeSession !== void 0 && window.__dshWorktreeSession.openForWorkspace !== void 0) window.__dshWorktreeSession.openForWorkspace(group.workspaceId, nativeCreate);
{T*12}else nativeCreate();
{T*11}}}
{T*10}}},""",
)

# --- 2. groupByWorkspace: absorb worktree workspace groups into their project --
rep(
f"""\t\tfunction groupByWorkspace(list, workspaces, archived, ungroupedOrder) {{
{T*3}const groups = [];
{T*3}const accounted = /* @__PURE__ */ new Set();
{T*3}for (const workspace of workspaces) {{
{T*4}const members = [];
{T*4}for (const id of workspace.sessionIds) {{
{T*5}const summary = list.byId[id];
{T*5}if (summary === void 0) continue;
{T*5}accounted.add(id);
{T*5}if (!sessionVisible(summary, list.current, archived)) continue;
{T*5}members.push(summary);
{T*4}}}
{T*4}groups.push(buildGroup(workspace.workspaceId, workspace.workspaceId, workspace.path, Date.parse(workspace.createdAt), workspace.title, members, "account"));
{T*3}}}
{T*3}const stray = list.ids.map((id) => list.byId[id]).filter((s) => s !== void 0 && !accounted.has(s.id) && sessionVisible(s, list.current, archived));
{T*3}if (stray.length > 0) groups.push(buildGroup("", void 0, void 0, void 0, "", ungroupedOrder === void 0 ? stray : orderedUngrouped(stray, ungroupedOrder), ungroupedOrder === void 0 ? "recency" : "account"));
{T*3}return groups;
{T*2}}}""",
f"""\t\tfunction groupByWorkspace(list, workspaces, archived, ungroupedOrder) {{
{T*3}const groups = [];
{T*3}const accounted = /* @__PURE__ */ new Set();
{T*3}for (const workspace of workspaces) {{
{T*4}const members = [];
{T*4}for (const id of workspace.sessionIds) {{
{T*5}const summary = list.byId[id];
{T*5}if (summary === void 0) continue;
{T*5}accounted.add(id);
{T*5}if (!sessionVisible(summary, list.current, archived)) continue;
{T*5}members.push(summary);
{T*4}}}
{T*4}groups.push(buildGroup(workspace.workspaceId, workspace.workspaceId, workspace.path, Date.parse(workspace.createdAt), workspace.title, members, "account"));
{T*3}}}
{T*3}const stray = list.ids.map((id) => list.byId[id]).filter((s) => s !== void 0 && !accounted.has(s.id) && sessionVisible(s, list.current, archived));
{T*3}if (stray.length > 0) groups.push(buildGroup("", void 0, void 0, void 0, "", ungroupedOrder === void 0 ? stray : orderedUngrouped(stray, ungroupedOrder), ungroupedOrder === void 0 ? "recency" : "account"));
{T*3}/* dsh-worktree-session:patch — worktree sessions live in their tree's own
{T*3} * registry workspace (attachSession pins cwd to the workspace path, and the
{T*3} * conversation hero disables the composer without membership), but those
{T*3} * worktree workspaces must not render as separate project rows: absorb each
{T*3} * one's sessions into its project's group. A worktree whose project is not
{T*3} * registered keeps its own row. The top "New session" button is untouched
{T*3} * and remains the native in-checkout path. */
{T*3}const merged = [];
{T*3}const absorbed = [];
{T*3}for (const g of groups) (g.cwd !== void 0 && String(g.cwd).includes("/.wt/") ? absorbed : merged).push(g);
{T*3}for (const wt of absorbed) {{
{T*4}const projectPath = String(wt.cwd).split("/.wt/")[0];
{T*4}const target = merged.find((g) => g.cwd !== void 0 && g.cwd === projectPath);
{T*4}if (target === void 0) merged.push(wt);
{T*4}else target.sessions.push(...wt.sessions);
{T*3}}}
{T*3}return merged;
{T*2}}}""",
)

# --- 3. Session row ⋯ menu: "Delete worktree" for sessions living in a tree ---
# Three anchored sub-edits: the component signature (thread workspaceCwd), the
# menu items (conditional append), the onSelect dispatch, and the tree call
# site that supplies the prop. Flat/search lists never receive it.
rep(
f"""\t\tfunction SessionNodeItem({{ node, currentId, now, onOpen, onRename, onFork, onArchive, onReveal, drag, flat = false, t, renderSlot, workspaceId }}) {{""",
f"""\t\tfunction SessionNodeItem({{ node, currentId, now, onOpen, onRename, onFork, onArchive, onReveal, drag, flat = false, t, renderSlot, workspaceId, workspaceCwd }}) {{""",
)

rep(
f"""\t\t\t\t{{
{T*5}id: "archive",
{T*5}label: t("menu.archiveSession"),
{T*5}icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, {{ size: 16 }})
{T*4}}}
{T*3}];""",
f"""\t\t\t\t{{
{T*5}id: "archive",
{T*5}label: t("menu.archiveSession"),
{T*5}icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, {{ size: 16 }})
{T*4}}},
{T*4}/* dsh-worktree-session:patch — only the tree supplies workspaceCwd, so the
{T*4} * item appears on worktree sessions in the browser tree and nowhere else. */
{T*4}...(workspaceCwd !== void 0 && String(workspaceCwd).includes("/.wt/") ? [{{
{T*5}id: "deleteWorktree",
{T*5}label: "Delete worktree",
{T*5}icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {{}})
{T*4}}}] : [])
{T*3}];""",
)

rep(
f"""\t\t\t\t\t\t\t\tonSelect: (id) => {{
{T*9}setMenuOpen(false);
{T*9}if (id === "rename") onRename(node.id, row.title);
{T*9}if (id === "fork") onFork(node.id);
{T*9}if (id === "archive") onArchive(node.id);
{T*8}}},""",
f"""\t\t\t\t\t\t\t\tonSelect: (id) => {{
{T*9}setMenuOpen(false);
{T*9}if (id === "rename") onRename(node.id, row.title);
{T*9}if (id === "fork") onFork(node.id);
{T*9}if (id === "archive") onArchive(node.id);
{T*9}/* dsh-worktree-session:patch — the plugin owns the confirmation and the
{T*9} * safety refusals; with no plugin loaded the item simply does nothing. */
{T*9}if (id === "deleteWorktree" && typeof window !== "undefined" && window.__dshWorktreeSession !== void 0 && window.__dshWorktreeSession.deleteWorktree !== void 0) window.__dshWorktreeSession.deleteWorktree(workspaceCwd);
{T*8}}},""",
)

rep(
f"""\t\t\t\t\t\t\t\t\t\t// only the tree knows which workspace a row belongs to; the
{T*11}// flat and search lists pass neither prop, so they stay bare
{T*11}workspaceId: group.workspaceId,""",
f"""\t\t\t\t\t\t\t\t\t\t// only the tree knows which workspace a row belongs to; the
{T*11}// flat and search lists pass neither prop, so they stay bare
{T*11}workspaceId: group.workspaceId,
{T*11}/* dsh-worktree-session:patch — the session menu's Delete-worktree item
{T*11} * gates on this path. */
{T*11}workspaceCwd: group.cwd,""",
)

open(dst, "w", encoding="utf-8").write(text)
print(f"patched: {count} anchored edits -> {dst}")
PY
