/**
 * dsh-worktree-session — client half.
 *
 * No chrome of its own except one thing: a progress chip in the shipped
 * `conversation.input.left` seam that renders ONLY while a worktree is being
 * cut for the project it belongs to, then disappears. Everything else lives
 * behind window.__dshWorktreeSession for the hash-guarded sidebar patch:
 *
 *   - openForWorkspace(workspaceId, native): the sidebar project row's "+"
 *     button hands off here — subscribe to the SSE progress feed, cut a
 *     worktree via the node half, then birth the session in it through DSH's
 *     own `sessions.create({ workspaceId })` → `sessions.open(id)` (the
 *     workspace browser's openWorkspace flow; the tree is a registered
 *     workspace, so the session has membership and the composer works).
 *     Anything else falls back to the untouched native flow.
 *   - deleteWorktree(workspaceCwd): the session row's ⋯ menu "Delete worktree"
 *     item — confirm, POST cleanup { path }, and on refusal (dirty tree /
 *     unmerged branch) show the reason with an explicit force confirm.
 *
 * The create route returns as soon as the tree is cut; the repo's optional
 * `.worktree-bootstrap` hook keeps running host-side and its outcome streams
 * through the same feed.
 */
window.__ModuleLoader__.load({
	id: "dsh-worktree-session",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		const inject = ["slots", "sessions", "layout"];

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

		// ---------- progress store (module-level; the chip subscribes) ----------
		const progress = new Map(); // workspaceId -> latest event
		const listeners = new Set();
		function setProgress(key, event) {
			progress.set(key, event);
			for (const listener of listeners) listener();
		}
		function clearProgress(key) {
			progress.delete(key);
			for (const listener of listeners) listener();
		}
		const progressSnapshot = () => progress;
		function subscribeProgress(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}

		/** One line of human text per step — the whole chip vocabulary. */
		function stepText(event) {
			if (event.step === "cutting") return `⎇ cutting ${event.branch}…`;
			if (event.step === "ready") return "⎇ opening session…";
			if (event.step === "bootstrap") {
				if (event.state === "started") return "⎇ running .worktree-bootstrap…";
				if (event.state === "ok") return "⎇ bootstrap ok";
				if (event.state === "timeout") return "⎇ bootstrap timed out";
				return `⎇ bootstrap failed (${event.reason ?? "error"})`;
			}
			return "⎇ working…";
		}

		function makeChip() {
			const WorktreeProgressChip = () => {
				const snapshot = (0, react.useSyncExternalStore)(subscribeProgress, progressSnapshot, progressSnapshot);
				const entry = snapshot.entries().next();
				if (entry.done) return null;
				const [key, event] = entry.value;
				const settled = event.step === "bootstrap" && event.state !== "started";
				return (0, react_jsx_runtime.jsx)("span", {
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: 4,
						marginRight: 6,
						padding: "2px 8px",
						border: "0.5px solid var(--dsw-alias-border-l3)",
						borderRadius: 8,
						fontSize: 12,
						lineHeight: "18px",
						color: "var(--dsw-alias-label-primary)",
						background: "var(--dsw-alias-button-elevated-fill)",
						fontFamily: settled ? "inherit" : "var(--ds-font-family-code)",
						whiteSpace: "nowrap",
					},
					children: stepText(event),
				}, key);
			};
			return WorktreeProgressChip;
		}

		function apply(ctx) {
			const sessions = ctx.get("sessions");
			const layout = ctx.get("layout");

			// The progress chip: registered on the shipped input seam, renders null
			// unless a cut is in flight. Boot order relative to the input bar does
			// not matter — inject() re-evaluates when the seam appears.
			ctx.slots.inject("conversation.input.left", () =>
				ctx.slots.register(
					{ name: "conversation.input.left", id: "worktree-progress" },
					makeChip(),
				),
			);

			window.__dshWorktreeSession = {
				async openForWorkspace(workspaceId, native) {
					let source;
					try {
						// Subscribe first so no step is missed, then cut.
						source = new EventSource(`/api/worktree-session/progress?workspaceId=${encodeURIComponent(workspaceId)}`);
						source.onmessage = (message) => {
							try {
								const event = JSON.parse(message.data);
								setProgress(workspaceId, event);
								if (event.step === "bootstrap" && event.state !== "started") {
									setTimeout(() => {
										source?.close();
										clearProgress(workspaceId);
									}, 4000);
								}
							} catch {
								// a malformed frame never breaks the cut
							}
						};
						const result = await postJson("/api/worktree-session/create", { workspaceId });
						const newSessionId = await sessions.create({ workspaceId: result.workspaceId });
						sessions.open(newSessionId);
						layout.selectPanel(null);
						// The session is open; the stream stays only for the background
						// bootstrap outcome. Safety net: never linger past 3 minutes.
						setTimeout(() => {
							source?.close();
							clearProgress(workspaceId);
						}, 180000);
					} catch (error) {
						console.warn("[dsh-worktree-session] worktree create failed; falling back to native:", error);
						source?.close();
						clearProgress(workspaceId);
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
			console.info("[dsh-worktree-session] progress chip + workspace-button/delete-worktree hooks registered.");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
