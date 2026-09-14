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

		/** Minimal imperative picker: branch + state per row; click-away closes. */
		function openPicker(trees) {
			const overlay = document.createElement("div");
			overlay.style.cssText = "position:fixed;inset:0;z-index:1000;";
			const panel = document.createElement("div");
			panel.style.cssText = "position:fixed;top:40px;right:40px;z-index:1001;min-width:280px;background:var(--dsw-alias-bg-layer-1, #fff);border:0.5px solid var(--dsw-alias-border-l3);border-radius:10px;padding:8px;box-shadow:0 8px 24px rgba(0,0,0,.25);font-size:12px;";
			const title = document.createElement("div");
			title.textContent = "Delete a worktree";
			title.style.cssText = "font-weight:600;margin-bottom:4px;";
			panel.append(title);
			const close = () => overlay.remove();

			for (const tree of trees) {
				const row = document.createElement("div");
				row.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 2px;";
				const label = document.createElement("span");
				label.textContent = tree.branch + (tree.dirty ? " *" : "") + (tree.merged ? " ✓" : "");
				label.title = `${tree.branch} — ${tree.path}`;
				label.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code);";
				const button = document.createElement("button");
				button.textContent = "remove";
				button.style.cssText = "cursor:pointer;border:0.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);border-radius:8px;padding:1px 8px;font:inherit;font-size:11px;flex:none;";
				button.onclick = async () => {
					button.disabled = true;
					await window.__dshWorktreeSession.deleteWorktree(tree.path);
					button.disabled = false;
				};
				row.append(label, button);
				panel.append(row);
			}
			overlay.onclick = close;
			panel.onclick = (event) => event.stopPropagation();
			overlay.append(panel);
			document.body.append(overlay);
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

				async openWorktreePicker(workspaceId) {
					let trees = [];
					try {
						const response = await fetch(`/api/worktree-session/list?workspaceId=${encodeURIComponent(workspaceId)}`);
						const data = await response.json().catch(() => ({}));
						if (!response.ok) return;
						trees = data.worktrees ?? [];
					} catch {
						return;
					}
					if (trees.length === 0) return;
					if (trees.length === 1) return this.deleteWorktree(trees[0].path);
					openPicker(trees);
				},
			};
			console.info("[dsh-worktree-session] workspace-button + delete-worktree hooks registered.");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
