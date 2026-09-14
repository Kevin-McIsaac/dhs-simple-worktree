/**
 * dsh-worktree-session — node-half tests.
 *
 * The suite drives the exported core (createWorktree, cleanupWorktree,
 * listWorktrees, slug/exclude/base-ref helpers) against REAL temporary
 * repositories — bare origin + clone, actual `git worktree add` — plus the
 * route handlers through a captured webServer. No DSH, no network, no restart.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";

import {
	apply,
	makeDeps,
	stampSlug,
	uniqueSlug,
	ensureWtExcluded,
	baseRef,
	createWorktree,
	cleanupWorktree,
	listWorktrees,
	config,
} from "../lib/index.js";

// ---------- fixtures ----------

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A real repo with a real bare origin: commit on main, pushed. */
function mkRepo(t) {
	const root = mkdtempSync(join(tmpdir(), "dsh-wts-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const origin = join(root, "origin.git");
	const repo = join(root, "repo");
	git(root, "init", "--bare", "--initial-branch=main", origin);
	git(root, "clone", origin, repo);
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test");
	writeFileSync(join(repo, "readme.md"), "one\n");
	git(repo, "add", ".");
	git(repo, "commit", "-m", "init");
	git(repo, "push", "-u", "origin", "main");
	return { root, origin, repo };
}

/** Workspace registry double: same shape the plugin uses, nothing more. */
function fakeRegistry() {
	const byId = new Map();
	let n = 0;
	return {
		async create(path) {
			const entity = { id: `ws-${++n}`, path };
			byId.set(entity.id, entity);
			return entity;
		},
		get(id) {
			return byId.get(id);
		},
		async delete({ workspaceId }) {
			if (!byId.delete(workspaceId)) throw new Error(`unknown workspace ${workspaceId}`);
			return { deleted: true };
		},
		async resolveByPath(path) {
			for (const entity of byId.values()) if (entity.path === path) return entity;
			return void 0;
		},
		list: () => [...byId.values()],
	};
}

const FIXED_NOW = new Date(2026, 8, 14, 10, 30);

async function cutOne(registry, repo, overrides = {}) {
	return createWorktree(registry, repo, overrides.now ?? FIXED_NOW);
}

// ---------- slug naming ----------

test("stampSlug is wt-YYYYMMDD-HHMM in local time", () => {
	assert.equal(stampSlug(FIXED_NOW), "wt-20260914-1030");
});

test("uniqueSlug suffixes -2, -3 when the minute is taken", async (t) => {
	const { repo } = mkRepo(t);
	const first = await uniqueSlug(repo, FIXED_NOW);
	assert.equal(first, "wt-20260914-1030");
	git(repo, "worktree", "add", "-b", `wt/${first}`, join(".wt", first), "origin/main");
	const second = await uniqueSlug(repo, FIXED_NOW);
	assert.equal(second, "wt-20260914-1030-2");
});

test("ensureWtExcluded appends once and is idempotent", async (t) => {
	const { repo } = mkRepo(t);
	assert.equal(await ensureWtExcluded(repo), true);
	assert.equal(await ensureWtExcluded(repo), false);
	const text = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
	assert.equal(text.split("\n").filter((line) => line.trim() === ".wt/").length, 1);
});

// ---------- base ref ----------

test("baseRef prefers origin/HEAD and falls back to origin/main", async (t) => {
	const { repo } = mkRepo(t);
	assert.equal(await baseRef(repo), "origin/main");
});

test("baseRef throws when neither origin/HEAD nor origin/main resolves", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "dsh-wts-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const lonely = join(root, "lonely");
	git(root, "init", lonely);
	await assert.rejects(() => baseRef(lonely), /no origin\/HEAD/);
});

// ---------- create ----------

test("createWorktree cuts the tree, links .env, runs the bootstrap hook, registers the workspace", async (t) => {
	const { repo } = mkRepo(t);
	const registry = fakeRegistry();
	writeFileSync(join(repo, ".env"), "SECRET=1\n");
	writeFileSync(join(repo, ".worktree-bootstrap"), "#!/bin/sh\necho bootstrapped > bootstrapped.txt\n");
	chmodSync(join(repo, ".worktree-bootstrap"), 0o755);

	const result = await cutOne(registry, repo);

	assert.equal(result.branch, "wt/wt-20260914-1030");
	assert.equal(result.base, "origin/main");
	assert.equal(result.slug, "wt-20260914-1030");
	assert.deepEqual(result.warnings, []);
	assert.equal(result.envLinked, true);
	assert.deepEqual(result.bootstrap, { ran: true, ok: true });

	const tree = result.cwd;
	assert.ok(existsSync(join(tree, "readme.md")), "tree has tracked files");
	assert.ok(existsSync(join(tree, "bootstrapped.txt")), "bootstrap ran inside the tree");
	assert.equal(readFileSync(join(tree, ".env"), "utf8"), "SECRET=1\n");
	assert.equal(git(tree, "branch", "--show-current").trim(), result.branch);
	assert.equal(git(tree, "rev-parse", "HEAD").trim(), git(repo, "rev-parse", "origin/main").trim(), "branch tip == origin/main");

	const entity = registry.get(result.workspaceId);
	assert.ok(entity, "tree registered as a workspace (membership is required)");
	assert.equal(entity.path, tree);
	// .wt/ must be locally excluded, not tracked
	assert.ok(readFileSync(join(repo, ".git", "info", "exclude"), "utf8").includes(".wt/"));
});

test("createWorktree without .env or hook reports both as skipped", async (t) => {
	const { repo } = mkRepo(t);
	const registry = fakeRegistry();
	const result = await cutOne(registry, repo);
	assert.equal(result.envLinked, false);
	assert.deepEqual(result.bootstrap, { ran: false });
	assert.deepEqual(result.warnings, []);
});

test("createWorktree survives a failed fetch by branching from last-known refs", async (t) => {
	const { repo } = mkRepo(t);
	const registry = fakeRegistry();
	// origin/main is known locally; the remote itself is now unreachable.
	git(repo, "remote", "set-url", "origin", join(repo, "..", "gone.git"));
	const result = await cutOne(registry, repo);
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0], /git fetch origin failed/);
	assert.equal(git(result.cwd, "rev-parse", "HEAD").trim(), git(repo, "rev-parse", "origin/main").trim());
});

test("createWorktree reports a failing bootstrap hook instead of failing the session", async (t) => {
	const { repo } = mkRepo(t);
	const registry = fakeRegistry();
	writeFileSync(join(repo, ".worktree-bootstrap"), "#!/bin/sh\necho boom >&2\nexit 3\n");
	chmodSync(join(repo, ".worktree-bootstrap"), 0o755);
	const result = await cutOne(registry, repo);
	assert.equal(result.bootstrap.ok, false);
	assert.match(result.bootstrap.reason, /exit 3/);
	assert.ok(result.warnings.some((w) => w.includes(".worktree-bootstrap failed")));
	assert.ok(existsSync(result.cwd), "tree still exists");
});

test("createWorktree refuses to treat a non-executable hook as runnable", async (t) => {
	const { repo } = mkRepo(t);
	const registry = fakeRegistry();
	writeFileSync(join(repo, ".worktree-bootstrap"), "#!/bin/sh\ntrue\n");
	const result = await cutOne(registry, repo);
	assert.equal(result.bootstrap.ok, false);
	assert.match(result.bootstrap.reason, /not executable/);
});

// ---------- cleanup ----------

test("cleanupWorktree refuses an unmerged branch, removes it with force", async (t) => {
	const { repo } = mkRepo(t);
	const registry = fakeRegistry();
	const created = await cutOne(registry, repo);

	writeFileSync(join(created.cwd, "work.txt"), "precious\n");
	git(created.cwd, "add", ".");
	git(created.cwd, "commit", "-m", "precious work");

	const refused = await cleanupWorktree(registry, created.cwd);
	assert.equal(refused.ok, false);
	assert.equal(refused.status, 409);
	assert.match(refused.error, /no remote contains|merged PR/);
	assert.ok(existsSync(created.cwd), "tree untouched on refusal");

	const forced = await cleanupWorktree(registry, created.cwd, true);
	assert.equal(forced.ok, true);
	assert.ok(!existsSync(created.cwd), "tree removed");
	assert.throws(() => git(repo, "rev-parse", "--verify", created.branch), "branch deleted");
	assert.ok(created.workspaceId !== void 0, "tree was registered");
});

test("cleanupWorktree allows a branch whose content reached origin (simulated merge)", async (t) => {
	const { repo } = mkRepo(t);
	const registry = fakeRegistry();
	const created = await cutOne(registry, repo);

	writeFileSync(join(created.cwd, "work.txt"), "landed\n");
	git(created.cwd, "add", ".");
	git(created.cwd, "commit", "-m", "landed");
	git(created.cwd, "push", "origin", `${created.branch}:main`); // squash-equivalent: content on origin
	git(repo, "fetch", "origin", "--quiet");

	const result = await cleanupWorktree(registry, created.cwd);
	assert.equal(result.ok, true, `expected success, got: ${JSON.stringify(result.error ?? result)}`);
	assert.ok(!existsSync(created.cwd));
});

test("cleanupWorktree refuses a dirty tree without force", async (t) => {
	const { repo } = mkRepo(t);
	const registry = fakeRegistry();
	const created = await cutOne(registry, repo);
	writeFileSync(join(created.cwd, "mess.txt"), "uncommitted\n");

	const refused = await cleanupWorktree(registry, created.cwd);
	assert.equal(refused.ok, false);
	assert.match(refused.error, /uncommitted changes/);

	const forced = await cleanupWorktree(registry, created.cwd, true);
	assert.equal(forced.ok, true);
});

test("cleanupWorktree never removes the main checkout", async (t) => {
	const { repo } = mkRepo(t);
	const registry = fakeRegistry();
	// The registry entry is irrelevant now — cleanup addresses the tree by path.
	await assert.rejects(
		() => cleanupWorktree(registry, repo),
		/main checkout|not a wt\/ branch/,
	);
	assert.ok(existsSync(repo));
});

test("cleanupWorktree refuses a workspace whose branch is not wt/", async (t) => {
	const { repo } = mkRepo(t);
	const registry = fakeRegistry();
	// A linked worktree on a non-wt branch, cut out-of-band without the plugin.
	git(repo, "worktree", "add", "-b", "feature/x", join(".wt", "feature-x"), "origin/main");
	await assert.rejects(
		() => cleanupWorktree(registry, join(repo, ".wt", "feature-x")),
		/not a wt\/ branch/,
	);
});

// ---------- list ----------

test("listWorktrees reports the repo's .wt trees with safety facts", async (t) => {
	const { repo } = mkRepo(t);
	const registry = fakeRegistry();
	const first = await cutOne(registry, repo);
	const second = await createWorktree(registry, repo, new Date(2026, 8, 14, 10, 31));

	writeFileSync(join(second.cwd, "scratch.txt"), "dirty\n");

	const trees = await listWorktrees(registry, repo);
	assert.equal(trees.length, 2);
	const byBranch = new Map(trees.map((tree) => [tree.branch, tree]));
	const firstTree = byBranch.get(first.branch);
	const secondTree = byBranch.get(second.branch);
	assert.equal(firstTree.dirty, false);
	assert.equal(firstTree.merged, true, "fresh tree == origin/main, so remotes contain it");
	assert.equal(secondTree.dirty, true);
	assert.ok(firstTree.path !== void 0 && firstTree.path.includes("/.wt/"));
});

// ---------- routes ----------

/** Minimal req/res doubles matching the webServer handler contract. */
function fakeRes() {
	const res = { status: void 0, body: "" };
	res.writeHead = (status) => (res.status = status);
	res.end = (body) => (res.body = body ?? "");
	return res;
}
function fakeReq(body, url = "/api/worktree-session") {
	const req = new EventEmitter();
	req.url = url;
	process.nextTick(() => {
		if (body !== void 0) req.emit("data", body);
		req.emit("end");
	});
	return req;
}

/** Boot the plugin's apply() against a captured webServer + registry + sessions. */
function boot({ repo: sessionCwd, registry }) {
	const routes = new Map();
	const ctx = {
		webServer: { register: (route) => routes.set(route.path, route.handler) },
		// run registrations immediately — the real effect() defers to service mount
		effect: (fn) => fn(),
		workspaceRegistry: registry,
		get: (service) =>
			service === "sessions"
				? { get: (sessionId) => (sessionId === "s1" ? { header: { cwd: sessionCwd } } : void 0) }
				: void 0,
	};
	// In production the conversation's workspace is always already registered;
	// seed the double the same way so resolveSessionWorkspace can find it.
	registry.create(sessionCwd);
	apply(ctx);
	return routes;
}

async function callRoute(routes, path, req) {
	const res = fakeRes();
	// the webServer matches the exact path and hands the full URL on req
	req.url = path;
	await routes.get(path.split("?")[0])(req, res);
	return { status: res.status, body: JSON.parse(res.body) };
}

test("routes: create end-to-end from a session id OR a workspace id", async (t) => {
	const { repo } = mkRepo(t);
	const registry = fakeRegistry();
	const routes = boot({ repo, registry });

	const fromSession = await callRoute(routes, "/api/worktree-session/create", fakeReq(JSON.stringify({ sessionId: "s1" })));
	assert.equal(fromSession.status, 200);
	// the route creates with the real clock, so assert the shape, not the stamp
	assert.match(fromSession.body.branch, /^wt\/wt-\d{8}-\d{4}$/);
	assert.equal(fromSession.body.branch, `wt/${fromSession.body.slug}`);
	assert.ok(fromSession.body.cwd.startsWith(join(repo, ".wt")), "response carries the tree cwd");
	assert.ok(fromSession.body.workspaceId !== void 0, "tree registered (membership required)");
	assert.equal(registry.list().length, 2, "project + tree workspaces");

	// the sidebar "+" flow knows the workspace before any session exists
	const ws = registry.list()[0];
	const fromWorkspace = await callRoute(routes, "/api/worktree-session/create", fakeReq(JSON.stringify({ workspaceId: ws.id })));
	assert.equal(fromWorkspace.status, 200);
	assert.ok(fromWorkspace.body.cwd.startsWith(join(repo, ".wt")), "workspace-id flow cuts the tree too");
	assert.ok(fromWorkspace.body.workspaceId !== void 0);

	const badSession = await callRoute(routes, "/api/worktree-session/create", fakeReq(JSON.stringify({ sessionId: "nope" })));
	assert.equal(badSession.status, 400);
	assert.match(badSession.body.error, /unknown session/);

	const badBody = await callRoute(routes, "/api/worktree-session/create", fakeReq(JSON.stringify({})));
	assert.equal(badBody.status, 400);
	assert.match(badBody.body.error, /workspaceId.*sessionId/);

	const badJson = await callRoute(routes, "/api/worktree-session/create", fakeReq("{not json"));
	assert.equal(badJson.status, 400);
	assert.match(badJson.body.error, /not valid JSON/);
});

test("routes: list and cleanup end-to-end", async (t) => {
	const { repo } = mkRepo(t);
	const registry = fakeRegistry();
	const routes = boot({ repo, registry });

	const created = await callRoute(routes, "/api/worktree-session/create", fakeReq(JSON.stringify({ sessionId: "s1" })));
	assert.equal(created.status, 200);

	const listed = await callRoute(routes, `/api/worktree-session/list?session=s1`, fakeReq());
	assert.equal(listed.status, 200);
	assert.equal(listed.body.worktrees.length, 1);
	assert.equal(listed.body.worktrees[0].branch, created.body.branch);

	// unmerged → 409 → force → gone (the tree must actually hold unmerged work)
	writeFileSync(join(created.body.cwd, "work.txt"), "precious\n");
	git(created.body.cwd, "add", ".");
	git(created.body.cwd, "commit", "-m", "precious work");
	const refused = await callRoute(routes, "/api/worktree-session/cleanup", fakeReq(JSON.stringify({ path: created.body.cwd })));
	assert.equal(refused.status, 409);
	const forced = await callRoute(routes, "/api/worktree-session/cleanup", fakeReq(JSON.stringify({ path: created.body.cwd, force: true })));
	assert.equal(forced.status, 200);
	assert.ok(!existsSync(created.body.cwd));

	const unknown = await callRoute(routes, "/api/worktree-session/cleanup", fakeReq(JSON.stringify({ path: "/nonexistent/.wt/nope" })));
	assert.equal(unknown.status, 400);
	assert.match(unknown.body.error, /not inside a git repository/);
});

test("cleanup retires the tree's workspace registration", async (t) => {
	const { repo } = mkRepo(t);
	const registry = fakeRegistry();
	const created = await createWorktree(registry, repo, FIXED_NOW);
	const result = await cleanupWorktree(registry, created.cwd);
	assert.equal(result.ok, true);
	assert.ok(!existsSync(created.cwd));
	assert.equal(registry.get(created.workspaceId), void 0, "workspace registration retired with the tree");
});

test("makeDeps resolves the session cwd through the sessions service", (t) => {
	const { repo } = mkRepo(t);
	const registry = fakeRegistry();
	const ctx = {
		workspaceRegistry: registry,
		get: (service) => (service === "sessions" ? { get: (id) => (id === "s1" ? { header: { cwd: repo } } : void 0) } : void 0),
	};
	const deps = makeDeps(ctx);
	assert.equal(deps.resolveSessionCwd("s1"), repo);
	assert.equal(deps.resolveSessionCwd("s2"), void 0);
	assert.equal(deps.workspaceRegistry, registry);
});
