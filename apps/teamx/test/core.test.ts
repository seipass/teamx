import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	configPaths,
	initProject,
	loadTeams,
	resolveSelection,
	type TeamFile,
	toolAllowed,
	validateConfig,
} from "../src/config.ts";
import { TeamService } from "../src/service.ts";
import { Store } from "../src/store.ts";

let dir: string;
let store: Store;
let oldConfig: string | undefined;
function fixture() {
	initProject(dir);
	return JSON.parse(readFileSync(join(dir, ".teamx", "config.json"), "utf8")) as TeamFile;
}
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "teamx-test-"));
	oldConfig = process.env.TEAMX_CONFIG_DIR;
	process.env.TEAMX_CONFIG_DIR = join(dir, "global");
	store = new Store(join(dir, "state", "teamx.db"));
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
	if (oldConfig === undefined) delete process.env.TEAMX_CONFIG_DIR;
	else process.env.TEAMX_CONFIG_DIR = oldConfig;
});

test("team defaults inherit, explicit empty lists disable, and capabilities cannot exceed the team", () => {
	const team = fixture().teams.dev;
	assert.deepEqual(resolveSelection(team).tools, ["read", "team_tasks", "team_messages", "team_handoff"]);
	assert.deepEqual(resolveSelection(team, { tools: [], skills: [], mcp: {} }), { tools: [], skills: [], mcp: {} });
	assert.throws(() => resolveSelection(team, { tools: ["delete_everything"] }), /exceeds/);
	assert.throws(() => resolveSelection(team, { skills: ["secret"] }), /exceeds/);
	assert.throws(() => resolveSelection(team, { mcp: { unknown: ["read"] } }), /exceeds/);
});
test("MCP per-tool selection is constrained by team and uses exact namespace matching", () => {
	const team = fixture().teams.dev;
	team.mcp.github = { config: { url: "https://example.invalid/mcp" }, tools: ["get_issue"] };
	const selected = resolveSelection(team, { mcp: { github: ["get_issue"] } });
	assert.ok(toolAllowed(selected, "mcp__github__get_issue"));
	assert.ok(!toolAllowed(selected, "mcp__github__delete_issue"));
	assert.ok(!toolAllowed(selected, "mcp__github_other__get_issue"));
	assert.ok(!toolAllowed(selected, "read_mcp_resource"));
	assert.throws(() => resolveSelection(team, { mcp: { github: ["*"] } }), /exceeds/);
	assert.throws(() => resolveSelection(team, { mcp: { constructor: [] } }), /exceeds/);
});
test("invalid agent overrides and unknown config fields fail validation", () => {
	const config = fixture();
	config.teams.dev.agents.builder.capabilities = { tools: ["bad"] };
	assert.throws(() => validateConfig(config), /exceeds/);
	config.teams.dev.agents.builder.capabilities = { tools: [] };
	Object.assign(config.teams.dev.agents.builder.capabilities, { skill: [] });
	assert.throws(() => validateConfig(config), /Unknown/);
});
test("project team replaces the global team; pi and omp settings are ignored", () => {
	const config = fixture();
	const global = configPaths(dir).global;
	mkdirSync(global, { recursive: true });
	const other = structuredClone(config.teams.dev);
	other.name = "Global";
	writeFileSync(join(global, "config.json"), JSON.stringify({ version: 1, teams: { dev: other, research: other } }));
	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi", "settings.json"), "invalid json");
	assert.equal(loadTeams(dir).get("dev")?.team.name, "Development");
	assert.equal(loadTeams(dir).get("research")?.team.name, "Global");
	assert.equal(configPaths(dir).auth, join(global, "agent", "auth.json"));
	assert.throws(() => initProject(dir), /EEXIST/);
});
test("task claim is atomic across two database connections", () => {
	const task = store.createTask("dev", "Implement", null);
	const second = new Store(join(dir, "state", "teamx.db"));
	try {
		assert.equal(store.claim("dev", task.id, "builder").status, "in_progress");
		assert.throws(() => second.claim("dev", task.id, "reviewer"), /unavailable/);
		assert.equal(second.task("dev", task.id).assignee, "builder");
	} finally {
		second.close();
	}
});
test("dependencies require reviewed completion and authors cannot approve their own work", () => {
	const first = store.createTask("dev", "First", "builder");
	const second = store.createTask("dev", "Second", null, [first.id]);
	assert.throws(() => store.claim("dev", second.id, "builder"), /dependencies/);
	store.claim("dev", first.id, "builder");
	assert.throws(() => store.submit("dev", first.id, "other", "done"), /owner/);
	store.submit("dev", first.id, "builder", "Implemented");
	assert.throws(() => store.review("dev", first.id, "builder", true, "ok"), /different reviewer/);
	assert.throws(() => store.claim("dev", second.id, "builder"), /dependencies/);
	store.review("dev", first.id, "reviewer", true, "Verified");
	assert.equal(store.claim("dev", second.id, "builder").status, "in_progress");
});
test("team scope applies to task lookup, dependencies, claims and message history", () => {
	const task = store.createTask("private", "Secret", null);
	assert.throws(() => store.task("dev", task.id), /not found/);
	assert.throws(() => store.createTask("dev", "Dependent", null, [task.id]), /not found/);
	assert.throws(() => store.claim("dev", task.id, "builder"), /unavailable/);
	store.message("private", "lead", null, "secret");
	assert.equal(store.messages("dev").length, 0);
});
test("messages distinguish direct recipients from shared channel and persist delivery", () => {
	const direct = store.message("dev", "lead", "builder", "Implement");
	store.message("dev", "lead", null, "Shared");
	store.message("dev", "reviewer", "lead", "Private");
	assert.equal(store.messages("dev", "builder").length, 2);
	assert.deepEqual(
		store.pending("dev", "builder").map((m) => m.id),
		[direct.id],
	);
	store.delivered("other", [direct.id]);
	assert.equal(store.pending("dev", "builder").length, 1);
	store.delivered("dev", [direct.id]);
	assert.equal(store.pending("dev", "builder").length, 0);
});
test("handoff requires submission and a teammate; sender identity comes from service", () => {
	fixture();
	const service = new TeamService(loadTeams(dir).get("dev")!, store, dir);
	const task = store.createTask("dev", "Build", "builder");
	store.claim("dev", task.id, "builder");
	assert.throws(
		() => service.dispatch("builder", "team_handoff", { id: task.id, recipient: "reviewer", body: "Review" }),
		/Submit/,
	);
	store.submit("dev", task.id, "builder", "Artifact: output.md");
	service.dispatch("builder", "team_handoff", { id: task.id, recipient: "reviewer", body: "Review" });
	assert.equal(store.pending("dev", "reviewer")[0].sender, "builder");
	assert.match(store.pending("dev", "reviewer")[0].body, /output.md/);
	assert.throws(
		() => service.dispatch("builder", "team_messages", { action: "send", recipient: "outsider", body: "hi" }),
		/not found/,
	);
	assert.throws(() => service.agent("constructor"), /not found/);
});
test("only one run per agent, stale leases block tasks, and recovery preserves snapshots", () => {
	const task = store.createTask("dev", "Build", "builder");
	store.claim("dev", task.id, "builder");
	const run = store.startRun("dev", "builder", { tools: ["read"] });
	assert.throws(() => store.startRun("dev", "builder", {}), /UNIQUE/);
	assert.equal(store.recover("other", Date.now() + 1), 0);
	assert.equal(store.recover("dev", Date.now() + 1), 1);
	assert.equal(store.task("dev", task.id).status, "blocked");
	assert.equal(store.runs("dev")[0].snapshot, run.snapshot);
	assert.equal(store.resumeTask("dev", task.id).status, "ready");
	store.startRun("dev", "builder", {});
});
test("failed or cancelled runs block owned active tasks", () => {
	const task = store.createTask("dev", "Build", "builder");
	store.claim("dev", task.id, "builder");
	const run = store.startRun("dev", "builder", {});
	store.finishRun(run.id, "cancelled", "Interrupted");
	assert.equal(store.task("dev", task.id).status, "blocked");
	assert.equal(store.runs("dev")[0].status, "cancelled");
});
test("configuration revocations are visible to the next tool call", () => {
	const config = fixture();
	const service = new TeamService(loadTeams(dir).get("dev")!, store, dir);
	assert.ok(service.currentSelection("builder").tools.includes("bash"));
	config.teams.dev.agents.builder.capabilities = { tools: [] };
	writeFileSync(join(dir, ".teamx", "config.json"), JSON.stringify(config));
	assert.equal(toolAllowed(service.currentSelection("builder"), "bash"), false);
});

test("assignment, change requests and completed dependencies notify the responsible agent", () => {
	const first = store.createTask("dev", "First", "builder");
	const dependent = store.createTask("dev", "Dependent", "reviewer", [first.id]);
	assert.match(store.pending("dev", "builder")[0].body, /Task assigned/);
	store.claim("dev", first.id, "builder");
	store.submit("dev", first.id, "builder", "Draft");
	store.review("dev", first.id, "reviewer", false, "Add evidence");
	assert.match(store.pending("dev", "builder").at(-1)!.body, /Changes requested/);
	store.claim("dev", first.id, "builder");
	store.submit("dev", first.id, "builder", "Evidence added");
	store.review("dev", first.id, "reviewer", true, "Verified");
	assert.match(store.pending("dev", "reviewer").at(-1)!.body, /Dependencies completed/);
	assert.equal(store.claim("dev", dependent.id, "reviewer").status, "in_progress");
});
