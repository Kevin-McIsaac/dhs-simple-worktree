/**
 * dsh-worktree-session — client half.
 *
 * One surface: a chip in the shipped `conversation.input.left` seam (the same
 * slot dsh-git-badge's input chip uses — present on every install, no seam
 * patch). Click = create: the node half cuts and registers the worktree, then
 * this half births the session EXACTLY the way the sidebar's own
 * "New session in {name}" flow does — `sessions.create({ workspaceId })` then
 * `sessions.open(id)` — because session.create resolves cwd = workspace.path
 * and cwd is immutable afterwards. Birthing it here is the whole feature.
 *
 * The chip's chevron opens a remove popover listing the repo's .wt trees with
 * their safety facts; removal goes through the node half's cleanup route,
 * which refuses anything dangerous unless explicitly forced.
 *
 * No session-creation logic of our own, no workspace lookups: the node half
 * resolves the workspace from the conversation's session id, and the client
 * reuses the two upstream service calls the workspace browser itself uses.
 */
window.__ModuleLoader__.load({
	id: "dsh-worktree-session",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

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

		const chipRow = {
			display: "flex",
			alignItems: "center",
			gap: 2,
			marginRight: 6,
			position: "relative",
		};
		const buttonStyle = {
			cursor: "pointer",
			border: "0.5px solid var(--dsw-alias-border-l3)",
			background: "var(--dsw-alias-button-elevated-fill)",
			color: "var(--dsw-alias-label-primary)",
			borderRadius: 8,
			padding: "2px 8px",
			font: "inherit",
			fontSize: 12,
			lineHeight: "18px",
			display: "inline-flex",
			alignItems: "center",
			gap: 4,
		};
		const chevronStyle = { ...buttonStyle, padding: "2px 5px" };
		const popoverStyle = {
			position: "absolute",
			top: "calc(100% + 6px)",
			left: 0,
			zIndex: 50,
			minWidth: 260,
			maxWidth: 380,
			background: "var(--dsw-alias-button-elevated-fill)",
			border: "0.5px solid var(--dsw-alias-border-l3)",
			borderRadius: 10,
			padding: 8,
			boxShadow: "0 8px 24px rgba(0,0,0,.25)",
			fontSize: 12,
		};
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			padding: "4px 2px",
		};
		const branchStyle = {
			fontFamily: "var(--ds-font-family-code)",
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			flex: 1,
		};
		const tinyButton = {
			...buttonStyle,
			fontSize: 11,
			padding: "1px 6px",
			flex: "none",
		};
		const errorStyle = { color: "var(--dsw-alias-label-critical, #d33)", padding: "4px 2px", wordBreak: "break-word" };

		/**
		 * The chip. `sessionId` arrives through the seam's inject share (same
		 * mechanism the badge chip uses); everything else is resolved by the
		 * node half, so this component never learns a filesystem path.
		 */
		function makeChip(ctx) {
			const sessions = ctx.get("sessions");
			const layout = ctx.get("layout");

			function WorktreeChip({ sessionId }) {
				const [busy, setBusy] = react.useState(false);
				const [note, setNote] = react.useState(void 0);
				const [open, setOpen] = react.useState(false);
				const [trees, setTrees] = react.useState([]);
				const [listError, setListError] = react.useState(void 0);
				const [confirming, setConfirming] = react.useState(() => new Map());

				const loadTrees = react.useCallback(async () => {
					setListError(void 0);
					try {
						const response = await fetch(`/api/worktree-session/list?session=${encodeURIComponent(sessionId)}`);
						const data = await response.json().catch(() => ({}));
						if (!response.ok) throw new Error(data.error ?? `${response.status}`);
						setTrees(data.worktrees ?? []);
					} catch (error) {
						setListError(String(error?.message ?? error));
					}
				}, [sessionId]);

				// Open the session in the tree through DSH's own flow — the exact
				// two calls (plus panel reset) the workspace browser's openWorkspace
				// makes; session.create then sets cwd = the tree, immutably.
				// Raw cwd, NOT workspaceId: the tree is never a registry workspace,
				// and the sidebar patch re-homes the session under the project row.
				const create = async () => {
					if (busy) return;
					setBusy(true);
					setNote(void 0);
					try {
						const result = await postJson("/api/worktree-session/create", { sessionId });
						const newSessionId = await sessions.create({ cwd: result.cwd });
						sessions.open(newSessionId);
						layout.selectPanel(null);
						setNote(`created ${result.branch}`);
					} catch (error) {
						setNote(String(error?.message ?? error));
					} finally {
						setBusy(false);
					}
				};

				const remove = async (tree, force) => {
					try {
						await postJson("/api/worktree-session/cleanup", { path: tree.path, force });
						setConfirming((prev) => {
							const next = new Map(prev);
							next.delete(tree.path);
							return next;
						});
						await loadTrees();
					} catch (error) {
						// The node half refused (dirty tree / unmerged branch): surface the
						// reason and arm a force button for that row — a second, deliberate click.
						setConfirming((prev) => new Map(prev).set(tree.path, String(error?.message ?? error)));
					}
				};

				if (sessionId === void 0) return null;
				return react_jsx_runtime.jsxs("span", {
					style: chipRow,
					children: [
						react_jsx_runtime.jsx("button", {
							style: buttonStyle,
							title: "Create a git worktree and open the next session in it",
							onClick: create,
							disabled: busy,
							children: busy ? "creating…" : "⎇ worktree",
						}),
						react_jsx_runtime.jsx("button", {
							style: chevronStyle,
							title: "Remove a finished worktree",
							onClick: () => {
								const next = !open;
								setOpen(next);
								if (next) loadTrees();
							},
							children: "▾",
						}),
						note !== void 0
							? react_jsx_runtime.jsx("span", { style: { fontSize: 11, marginLeft: 6, opacity: 0.8 }, children: note })
							: null,
						open
							? react_jsx_runtime.jsxs("div", {
									style: popoverStyle,
									children: [
										react_jsx_runtime.jsx("div", { style: { fontWeight: 600, marginBottom: 4 }, children: "Worktrees of this repo" }),
										listError !== void 0 ? react_jsx_runtime.jsx("div", { style: errorStyle, children: listError }) : null,
										trees.length === 0 && listError === void 0
											? react_jsx_runtime.jsx("div", { style: { opacity: 0.7 }, children: "none yet — click ⎇ worktree to cut one" })
											: null,
										trees.map((tree) =>
											react_jsx_runtime.jsxs("div", {
												style: rowStyle,
												children: [
													react_jsx_runtime.jsx("span", {
														style: branchStyle,
														title: `${tree.branch} — ${tree.path}`,
														children: tree.branch + (tree.dirty ? " *" : "") + (tree.merged ? " ✓" : ""),
													}),
													confirming.get(tree.path) === void 0
														? react_jsx_runtime.jsx("button", { style: tinyButton, onClick: () => remove(tree, false), children: "remove" })
														: react_jsx_runtime.jsxs(react.Fragment, {
																children: [
																	react_jsx_runtime.jsx("button", { style: tinyButton, onClick: () => remove(tree, true), children: "force" }),
																	react_jsx_runtime.jsx("button", { style: tinyButton, onClick: () => loadTrees().then(() => setConfirming(new Map())), children: "×" }),
																],
															}),
												],
											}, tree.path),
										),
										trees.map((tree) =>
											confirming.get(tree.path) !== void 0
												? react_jsx_runtime.jsx("div", { style: errorStyle, children: confirming.get(tree.path) }, `why-${tree.path}`)
												: null,
										),
									],
								})
							: null,
					],
				});
			}
			return WorktreeChip;
		}

		function apply(ctx) {
			ctx.slots.inject("conversation.input.left", () =>
				ctx.slots.register(
					{
						name: "conversation.input.left",
						id: "worktree-chip",
						inject: (sessionId) => ({ sessionId }),
					},
					makeChip(ctx),
				),
			);
			// The sidebar patch (seam/apply.sh) hands the workspace browser's "+"
			// button to this hook when it exists, and falls back to the native flow
			// when it does not — with no plugin loaded the button behaves exactly
			// as upstream. The hook does what the chip does, keyed by workspaceId
			// instead of sessionId; `native` is the untouched upstream onCreate body.
			const sessions = ctx.get("sessions");
			const layout = ctx.get("layout");
			window.__dshWorktreeSession = {
				async openForWorkspace(workspaceId, native) {
					try {
						const result = await postJson("/api/worktree-session/create", { workspaceId });
						const newSessionId = await sessions.create({ cwd: result.cwd });
						sessions.open(newSessionId);
						layout.selectPanel(null);
					} catch (error) {
						console.warn("[dsh-worktree-session] worktree create failed; falling back to native:", error);
						native();
					}
				},
			};
			console.info("[dsh-worktree-session] input chip + workspace-button hook registered.");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
