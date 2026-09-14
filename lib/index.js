/**
 * dsh-worktree-session — node half.
 *
 * One job: when a conversation asks for a worktree, cut it, register it, and
 * hand back a workspace id — the CLIENT then births the session in the tree
 * through DSH's own `sessions.create({ workspaceId })` flow, which is the one
 * moment a session's cwd is settable. This half never creates sessions.
 *
 * Routes (registered on the host webServer, same idiom as dsh-git-badge):
 *   POST /api/worktree-session/create   body { sessionId }
 *       fetch origin, cut `git worktree add -b wt/<slug> .wt/<slug> <base>`,
 *       symlink the checkout's .env into the tree, run an optional
 *       `.worktree-bootstrap` script inside the tree, register the tree as a
 *       workspace (idempotent), return { workspaceId, path, branch, ... }.
 *   GET  /api/worktree-session/list?sessionId=…
 *       the repo's .wt trees with their safety facts (dirty, unmerged) for the
 *       client's remove popover.
 *   POST /api/worktree-session/cleanup  body { workspaceId, force? }
 *       remove tree + branch + workspace registration. Refuses anything the
 *       git-worktree skill calls dangerous unless force is set: a dirty tree,
 *       or a branch with commits no remote contains and no merged PR.
 *
 * Safety invariants:
 *   - only trees under `<repo>/.wt/` are ever removed, never a main checkout;
 *   - only branches named `wt/…` are ever deleted;
 *   - gh (if present) is the merge authority; absence fails CLOSED (force needed).
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, statSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const inject = ["webServer", "workspaceRegistry"];
const name = "dsh-worktree-session";

/**
 * Runtime tunables. Production code never writes these; the test suite mutates
 * them to collapse the timeouts deterministically. One exported object rather
 * than scattered consts so tests have a single documented seam.
 */
const config = {
	/** budget for every git invocation; an expired call is killed */
	gitTimeoutMs: 15000,
	/** network fetch budget; the create path's worst-case latency */
	fetchTimeoutMs: 30000,
	/** budget for the repo's .worktree-bootstrap script, if it declares one */
	bootstrapTimeoutMs: 180000,
	/** how many -N suffixes uniqueSlug tries before giving up */
	maxSlugCollisions: 99,
};

/** Run one git command; resolve { ok, stdout, stderr } — git failures are data, not throws. */
function runGit(cwd, args, timeoutMs = config.gitTimeoutMs) {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
			resolve({ ok: error === void 0 || error === null, code: error?.code, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

/** Run one arbitrary executable (the bootstrap hook); same shape as runGit. */
function runProgram(cwd, file, args, timeoutMs) {
	return new Promise((resolve) => {
		execFile(file, args, { cwd, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
			resolve({ ok: error === void 0 || error === null, code: error?.code, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

/** `wt-YYYYMMDD-HHMM` in LOCAL time — sortable, unique to the minute, no typing. */
export function stampSlug(now = new Date()) {
	const p = (n, w = 2) => String(n).padStart(w, "0");
	return `wt-${p(now.getFullYear(), 4)}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/**
 * Pick a slug whose branch and tree path are both free. Two worktrees cut in
 * the same minute get -2, -3, … so nothing is ever silently reused.
 */
export async function uniqueSlug(repoPath, now = new Date()) {
	const worktrees = await worktreePaths(repoPath);
	const branches = await runGit(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
	const taken = new Set([...worktrees.map((p) => p.toLowerCase()), ...branches.stdout.split("\n")]);
	const base = stampSlug(now);
	for (let n = 1; n <= config.maxSlugCollisions; n++) {
		const slug = n === 1 ? base : `${base}-${n}`;
		const branch = `wt/${slug}`;
		if (!taken.has(branch.toLowerCase()) && !taken.has(join(repoPath, ".wt", slug).toLowerCase())) return slug;
	}
	throw new Error(`no free worktree slug under ${base} (${config.maxSlugCollisions} suffixes tried)`);
}

/** Paths of every linked worktree of the repo (excludes the main checkout). */
export async function worktreePaths(repoPath) {
	const list = await runGit(repoPath, ["worktree", "list", "--porcelain"]);
	if (!list.ok) return [];
	const paths = [];
	for (const line of list.stdout.split("\n")) {
		if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length));
	}
	// `git worktree list` puts the main worktree first; everything after is linked.
	return paths.slice(1);
}

/** Ensure `.wt/` is locally excluded. Edits `.git/info/exclude` — never a tracked file. */
export async function ensureWtExcluded(repoPath) {
	const excludePath = join(repoPath, ".git", "info", "exclude");
	let current = "";
	try {
		current = readFileSync(excludePath, "utf8");
	} catch {
		// no exclude file yet — fall through and create it
	}
	if (current.split("\n").some((line) => line.trim() === ".wt/")) return false;
	appendFileSync(excludePath, (current.endsWith("\n") || current === "" ? "" : "\n") + ".wt/\n");
	return true;
}

/**
 * The ref new worktrees branch from: origin's HEAD if it declares one, else
 * origin/main, else fail. Callers fetch first, so this reads the last-known
 * remote state — the git-worktree skill's own flow.
 */
export async function baseRef(repoPath) {
	const head = await runGit(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	const candidate = head.ok ? head.stdout.trim() : "origin/main";
	if (candidate !== "") {
		const verify = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", candidate]);
		if (verify.ok) return candidate;
	}
	const fallback = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", "origin/main"]);
	if (fallback.ok) return "origin/main";
	throw new Error("no origin/HEAD and no origin/main — fetch first or cut the branch by hand");
}

/**
 * Which session directory are we working for? The session's cwd is immutable
 * creation metadata, so it names the checkout the conversation lives in. The
 * registry maps that path to the workspace id the client already knows.
 */
export async function resolveSessionWorkspace(workspaceRegistry, resolveSessionCwd, sessionId) {
	const cwd = resolveSessionCwd(sessionId);
	if (cwd === void 0 || cwd === null) throw new Error(`unknown session "${sessionId}" — is the conversation still open?`);
	const entity = await workspaceRegistry.resolveByPath(cwd).catch(() => void 0);
	if (entity === void 0 || entity === null) throw new Error(`the session's directory "${cwd}" is not a registered workspace`);
	return entity;
}

/**
 * Merge authority for cleanup, per the git-worktree skill: squash-merged
 * branches are never ancestors of main, so ancestry lies. `gh` is the truth;
 * a remote that contains the branch is just as good; gh's ABSENCE fails closed.
 * Returns { merged: boolean, reason: string }.
 */
export async function branchMerged(repoPath, branch) {
	const contained = await runGit(repoPath, ["branch", "-r", "--contains", branch]);
	if (contained.ok && contained.stdout.trim() !== "") {
		return { merged: true, reason: `remote refs contain ${branch}` };
	}
	const gh = await new Promise((resolve) => {
		execFile("gh", ["pr", "view", branch.replace(/^wt\//, ""), "--json", "state"], { cwd: repoPath, timeout: config.gitTimeoutMs, windowsHide: true }, (error, stdout) => {
			resolve({ ok: error === void 0 || error === null, stdout: String(stdout) });
		});
	});
	if (!gh.ok) return { merged: false, reason: `${branch} has commits no remote contains and gh could not confirm a merged PR` };
	try {
		const state = JSON.parse(gh.stdout).state;
		if (state === "MERGED") return { merged: true, reason: `PR for ${branch} is MERGED` };
		return { merged: false, reason: `PR for ${branch} is ${state}, not MERGED` };
	} catch {
		return { merged: false, reason: `could not read gh's PR state for ${branch}` };
	}
}

// ---------- create ----------

/**
 * Cut the worktree for one session's repo. Steps are individually reported so
 * the chip can show exactly what happened; only fatal steps (repo/git/base/
 * slug/worktree) throw. Fetch, .env and bootstrap problems degrade to warnings.
 */
export async function createWorktree(workspaceRegistry, repoPath, now = new Date()) {
	const toplevel = await runGit(repoPath, ["rev-parse", "--show-toplevel"]);
	if (!toplevel.ok) throw new Error(`"${repoPath}" is not inside a git repository`);
	const repo = toplevel.stdout.trim();

	const warnings = [];
	const fetch = await runGit(repo, ["fetch", "origin", "--quiet"], config.fetchTimeoutMs);
	if (!fetch.ok) warnings.push(`git fetch origin failed (${(fetch.stderr || "unknown").trim().split("\n")[0]}); branching from last-known refs`);

	const base = await baseRef(repo);
	const slug = await uniqueSlug(repo, now);
	const branch = `wt/${slug}`;
	await ensureWtExcluded(repo);

	const added = await runGit(repo, ["worktree", "add", "-b", branch, join(".wt", slug), base]);
	if (!added.ok) throw new Error(`git worktree add failed: ${(added.stderr || added.stdout).trim().split("\n")[0]}`);
	const treePath = join(repo, ".wt", slug);

	// A fresh worktree has no gitignored files. The dangerous silent one is the
	// env file: everything builds and runs but integrations are unconfigured.
	// Link the checkout's .env when it exists — cheap, visible, removable.
	let envLinked = false;
	if (existsSync(join(repo, ".env")) && !existsSync(join(treePath, ".env"))) {
		try {
			symlinkSync(join(repo, ".env"), join(treePath, ".env"));
			envLinked = true;
		} catch (error) {
			warnings.push(`could not link .env into the tree: ${String(error)}`);
		}
	}

	// The repo's own bootstrap hook, if it declares one: an executable
	// .worktree-bootstrap at the repo root, run INSIDE the tree. Its failure
	// never fails the session — the response says what happened instead.
	const bootstrapPath = join(repo, ".worktree-bootstrap");
	let bootstrap = { ran: false };
	if (existsSync(bootstrapPath)) {
		let executable = false;
		try {
			executable = statSync(bootstrapPath).isFile() && (statSync(bootstrapPath).mode & 0o111) !== 0;
		} catch {
			executable = false;
		}
		if (!executable) {
			bootstrap = { ran: true, ok: false, reason: ".worktree-bootstrap exists but is not executable" };
			warnings.push(bootstrap.reason);
		} else {
			const run = await runProgram(treePath, bootstrapPath, [], config.bootstrapTimeoutMs);
			bootstrap = run.ok
				? { ran: true, ok: true }
				: { ran: true, ok: false, reason: run.code === void 0 ? "timed out" : `exit ${run.code}`, stderr: run.stderr.slice(-2000) };
			if (!run.ok) warnings.push(`.worktree-bootstrap failed: ${bootstrap.reason}`);
		}
	}

	const workspace = await workspaceRegistry.create(treePath);
	return { workspaceId: workspace.id, path: treePath, branch, base, slug, envLinked, bootstrap, warnings };
}

// ---------- cleanup ----------

/** Facts cleanup needs about one tree: dirty flag and merge state. */
export async function treeSafety(repoPath, treePath, branch) {
	const status = await runGit(treePath, ["status", "--porcelain"]);
	const dirty = status.ok && status.stdout.trim() !== "";
	const merged = await branchMerged(repoPath, branch);
	return { dirty, merged: merged.merged, mergeReason: merged.reason };
}

/**
 * Remove one worktree tree + its wt/ branch + its workspace registration.
 * Refuses (status 409-shaped result) unless force, when:
 *   - the tree is dirty;
 *   - the branch has commits no remote contains and gh confirms no merged PR
 *     (or gh is missing — fail closed, per the git-worktree skill).
 * Only trees under `<repo>/.wt/` with a `wt/…` branch are ever touched.
 */
export async function cleanupWorktree(workspaceRegistry, workspaceId, force = false) {
	const entity = workspaceRegistry.get(workspaceId);
	if (entity === void 0) throw new Error(`workspace "${workspaceId}" not found`);
	const treePath = entity.path;

	const toplevel = await runGit(treePath, ["rev-parse", "--show-toplevel"]);
	if (!toplevel.ok) throw new Error(`"${treePath}" is not inside a git repository`);
	const tree = toplevel.stdout.trim();

	const branchOut = await runGit(tree, ["branch", "--show-current"]);
	const branch = branchOut.stdout.trim();
	if (!branch.startsWith("wt/")) throw new Error(`refusing to remove "${tree}": its branch "${branch || "(detached)"}" is not a wt/ branch`);
	if (!tree.includes("/.wt/")) throw new Error(`refusing to remove "${tree}": it is not under a .wt/ directory`);

	// The MAIN checkout of the repo this tree belongs to — never removable.
	const list = await runGit(tree, ["worktree", "list", "--porcelain"]);
	const mainPath = list.stdout.split("\n").find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
	if (mainPath !== void 0 && mainPath === tree) throw new Error(`refusing to remove "${tree}": it is the main checkout`);

	const repo = tree.split("/.wt/")[0];
	const safety = await treeSafety(repo, tree, branch);
	if (safety.dirty && force !== true) return { ok: false, status: 409, error: `"${tree}" has uncommitted changes; remove or commit them first, or pass force`, safety };
	if (!safety.merged && force !== true) return { ok: false, status: 409, error: safety.mergeReason + "; merge the work (or pass force to discard it)", safety };

	const removed = await runGit(repo, ["worktree", "remove", tree, ...(safety.dirty && force === true ? ["--force"] : [])]);
	if (!removed.ok) throw new Error(`git worktree remove failed: ${(removed.stderr || removed.stdout).trim().split("\n")[0]}`);

	const warnings = [];
	const deleted = await runGit(repo, ["branch", "-D", branch]);
	if (!deleted.ok) warnings.push(`branch ${branch} not deleted: ${(deleted.stderr || deleted.stdout).trim().split("\n")[0]}`);

	try {
		await workspaceRegistry.delete({ workspaceId });
	} catch (error) {
		warnings.push(`workspace "${workspaceId}" could not be unregistered: ${String(error)}`);
	}
	return { ok: true, status: 200, removed: tree, branch, warnings, safety };
}

/** The repo's .wt trees, with the facts the client's remove popover shows. */
export async function listWorktrees(workspaceRegistry, repoPath) {
	const paths = await worktreePaths(repoPath);
	const trees = [];
	for (const treePath of paths) {
		if (!treePath.includes("/.wt/")) continue;
		const entity = await workspaceRegistry.resolveByPath(treePath).catch(() => void 0);
		const branchOut = await runGit(treePath, ["branch", "--show-current"]);
		const branch = branchOut.stdout.trim();
		if (!branch.startsWith("wt/")) continue;
		const repo = treePath.split("/.wt/")[0];
		const safety = await treeSafety(repo, treePath, branch);
		trees.push({ workspaceId: entity?.id, path: treePath, branch, dirty: safety.dirty, merged: safety.merged, mergeReason: safety.mergeReason });
	}
	return trees;
}

// ---------- route wiring ----------

/** Read one request body as a UTF-8 string (the webServer hands raw streams). */
function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => (data += chunk));
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

/** Parse a JSON POST body; {} when empty, RemoteError-style 400 when malformed. */
async function readJsonBody(req) {
	const raw = await readBody(req);
	if (raw.trim() === "") return {};
	try {
		return JSON.parse(raw);
	} catch {
		return void 0;
	}
}

/**
 * Host plugin body — register the three routes. Same effect() + webServer
 * registration idiom as dsh-git-badge; the deps are extracted so the test
 * suite can drive createWorktree/cleanupWorktree without booting DSH.
 */
export function makeDeps(ctx) {
	return {
		workspaceRegistry: ctx.workspaceRegistry,
		// Same host-side session read dsh-git-badge uses: cwd is session header
		// metadata, readable without activating a cold agent.
		resolveSessionCwd: (sessionId) => ctx.get("sessions")?.get?.(sessionId)?.header?.cwd,
	};
}

function apply(ctx) {
	const deps = makeDeps(ctx);

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/worktree-session/create",
		handler: async (req, res) => {
			try {
				const body = await readJsonBody(req);
				if (body === void 0) return sendJson(res, 400, { error: "request body is not valid JSON" });
				if (typeof body.sessionId !== "string" || body.sessionId === "") return sendJson(res, 400, { error: "body must be { sessionId }" });
				const workspace = await resolveSessionWorkspace(ctx.workspaceRegistry, deps.resolveSessionCwd, body.sessionId);
				const result = await createWorktree(ctx.workspaceRegistry, workspace.path);
				sendJson(res, 200, result);
			} catch (error) {
				sendJson(res, 400, { error: String(error?.message ?? error) });
			}
		},
	}), "worktree-session: create route");

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/worktree-session/list",
		handler: async (req, res) => {
			try {
				const url = new URL(req.url, "http://localhost");
				const sessionId = url.searchParams.get("session");
				if (sessionId === null || sessionId === "") return sendJson(res, 400, { error: "query must be ?session=<sessionId>" });
				const workspace = await resolveSessionWorkspace(ctx.workspaceRegistry, deps.resolveSessionCwd, sessionId);
				sendJson(res, 200, { worktrees: await listWorktrees(ctx.workspaceRegistry, workspace.path) });
			} catch (error) {
				sendJson(res, 400, { error: String(error?.message ?? error) });
			}
		},
	}), "worktree-session: list route");

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/worktree-session/cleanup",
		handler: async (req, res) => {
			try {
				const body = await readJsonBody(req);
				if (body === void 0) return sendJson(res, 400, { error: "request body is not valid JSON" });
				if (typeof body.workspaceId !== "string" || body.workspaceId === "") return sendJson(res, 400, { error: "body must be { workspaceId, force? }" });
				const result = await cleanupWorktree(ctx.workspaceRegistry, body.workspaceId, body.force === true);
				if (result.ok) sendJson(res, result.status, result);
				else sendJson(res, result.status, { error: result.error, safety: result.safety });
			} catch (error) {
				sendJson(res, 400, { error: String(error?.message ?? error) });
			}
		},
	}), "worktree-session: cleanup route");
}

export { apply, inject, name, config };
