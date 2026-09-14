/**
 * dsh-worktree-session — client half.
 *
 * No UI of its own. Everything lives behind window.__dshWorktreeSession for
 * the hash-guarded sidebar patch to call:
 *
 *   - openForWorkspace(workspaceId, native): the sidebar project row's "+"
 *     button hands off here — cut a worktree via the node half, then birth the
 *     session in it through DSH's own `sessions.create({ workspaceId })` →
 *     `sessions.open(id)` (the workspace browser's openWorkspace flow; the
 *     tree is a registered workspace, so the session has membership and the
 *     composer works). Anything else falls back to the untouched native flow.
 *   - deleteWorktree(workspaceCwd): the session row's ⋯ menu "Delete worktree"
 *     item — confirm, POST cleanup { path }, and on refusal (dirty tree /
 *     unmerged branch) show the reason with an explicit force confirm.
 *
 * The create route returns as soon as the tree is cut; the repo's optional
 * `.worktree-bootstrap` hook keeps running host-side and logs its outcome.
 */
window.__ModuleLoader__.load({
	id: "dsh-worktree-session",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const inject = ["sessions", "layout"];

		async function postJson(path, body) {
			const response = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(data.error ?? `${response.status} ${response.statusText}`);
			return data;
		}

		function apply(ctx) {
			const sessions = ctx.get("sessions");
			const layout = ctx.get("layout");

			window.__dshWorktreeSession = {
				async openForWorkspace(workspaceId, native) {
					try {
						const result = await postJson("/api/worktree-session/create", { workspaceId });
						const newSessionId = await sessions.create({ workspaceId: result.workspaceId });
						sessions.open(newSessionId);
						layout.selectPanel(null);
					} catch (error) {
						console.warn("[dsh-worktree-session] worktree create failed; falling back to native:", error);
						native();
					}
				},

				async deleteWorktree(workspaceCwd) {
					if (workspaceCwd === void 0 || !String(workspaceCwd).includes("/.wt/")) return;
					if (!window.confirm(`Delete worktree ${workspaceCwd}?\n\nIts branch and workspace registration are removed with it. If this session is still open, its directory disappears from under it — archive the session first if you want it tidy.`)) return;
					try {
						await postJson("/api/worktree-session/cleanup", { path: workspaceCwd });
					} catch (error) {
						// Refused (dirty tree / unmerged branch): show the reason, offer force.
						const reason = String(error?.message ?? error);
						if (window.confirm(`${reason}\n\nForce delete anyway?`)) {
							try {
								await postJson("/api/worktree-session/cleanup", { path: workspaceCwd, force: true });
							} catch (forceError) {
								window.alert(`Force delete failed: ${String(forceError?.message ?? forceError)}`);
							}
						}
					}
				},
			};
			console.info("[dsh-worktree-session] workspace-button + delete-worktree hooks registered.");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
