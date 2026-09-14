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

# --- 2. groupByWorkspace: re-home .wt sessions under their project row --------
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
{T*3}/* dsh-worktree-session:patch — sessions born in a worktree under
{T*3} * <project>/.wt/ are never registry members (attachSession pins cwd to the
{T*3} * workspace path), so upstream files them under "Ungrouped". Re-home them
{T*3} * into their project's group by cwd convention; manual `git worktree add`
{T*3} * trees re-home the same way. The top "New session" button is untouched and
{T*3} * remains the native in-checkout path. */
{T*3}const memberIds = /* @__PURE__ */ new Set();
{T*3}for (const workspace of workspaces) for (const id of workspace.sessionIds) memberIds.add(id);
{T*3}const stray = list.ids.map((id) => list.byId[id]).filter((s) => s !== void 0 && !memberIds.has(s.id) && sessionVisible(s, list.current, archived));
{T*3}const unclaimed = new Set(stray);
{T*3}for (const workspace of workspaces) {{
{T*4}const members = [];
{T*4}for (const id of workspace.sessionIds) {{
{T*5}const summary = list.byId[id];
{T*5}if (summary === void 0) continue;
{T*5}if (!sessionVisible(summary, list.current, archived)) continue;
{T*5}members.push(summary);
{T*4}}}
{T*4}if (workspace.path !== void 0) {{
{T*5}const prefix = workspace.path.replace(/\\/+$/, "") + "/.wt/";
{T*5}for (const s of stray) {{
{T*6}if (s.cwd !== void 0 && s.cwd.startsWith(prefix)) {{
{T*7}members.push(s);
{T*7}unclaimed.delete(s);
{T*6}}}
{T*5}}}
{T*4}}}
{T*4}groups.push(buildGroup(workspace.workspaceId, workspace.workspaceId, workspace.path, Date.parse(workspace.createdAt), workspace.title, members, "account"));
{T*3}}}
{T*3}const rest = [...unclaimed];
{T*3}if (rest.length > 0) groups.push(buildGroup("", void 0, void 0, void 0, "", ungroupedOrder === void 0 ? rest : orderedUngrouped(rest, ungroupedOrder), ungroupedOrder === void 0 ? "recency" : "account"));
{T*3}return groups;
{T*2}}}""",
)

open(dst, "w", encoding="utf-8").write(text)
print(f"patched: {count} anchored edits -> {dst}")
PY
