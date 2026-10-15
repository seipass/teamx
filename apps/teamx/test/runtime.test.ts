import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type JsonObject,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { initProject, loadTeams, type TeamFile } from "../src/config.ts";
import { runAgent } from "../src/runtime.ts";
import { TeamService } from "../src/service.ts";
import { Store } from "../src/store.ts";

let dir: string;
let store: Store;
let config: TeamFile;
let service: TeamService;
let oldConfig: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "teamx-runtime-"));
	oldConfig = process.env.TEAMX_CONFIG_DIR;
	process.env.TEAMX_CONFIG_DIR = join(dir, "global");
	initProject(dir);
	config = JSON.parse(readFileSync(join(dir, ".teamx", "config.json"), "utf8")) as TeamFile;
	for (const [id, agent] of Object.entries(config.teams.dev.agents)) agent.model = `teamx-test/${id}`;
	save();
	store = new Store(join(dir, ".teamx", "state", "teamx.db"));
	service = new TeamService(loadTeams(dir).get("dev")!, store, dir);
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
	if (oldConfig === undefined) delete process.env.TEAMX_CONFIG_DIR;
	else process.env.TEAMX_CONFIG_DIR = oldConfig;
});
function save() {
	writeFileSync(join(dir, ".teamx", "config.json"), JSON.stringify(config));
}

type Reply = { text: string } | { name: string; arguments: JsonObject };
async function fakeRuntime(reply: (actor: string, context: TranscriptContext) => Reply) {
	const runtime = await ModelRuntime.create({
		authPath: join(dir, "fake-auth.json"),
		modelsPath: null,
		modelsStorePath: join(dir, "fake-models.json"),
		refreshOnCreate: false,
	});
	runtime.registerProvider("teamx-test", {
		api: "openai-completions",
		baseUrl: "http://never-connect.invalid",
		apiKey: "test-only",
		models: ["lead", "builder", "reviewer"].map((id) => ({
			id,
			name: id,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		})),
		streamSimple: (model, context) => {
			const response = reply(model.id, context);
			const message: AssistantMessage = {
				role: "assistant",
				api: "openai-completions",
				provider: model.provider,
				model: model.id,
				content:
					"text" in response
						? [{ type: "text", text: response.text }]
						: [
								{
									type: "toolCall",
									id: `call-${Date.now()}-${Math.random()}`,
									name: response.name,
									arguments: response.arguments,
								},
							],
				stopReason: "text" in response ? "stop" : "toolUse",
				timestamp: Date.now(),
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
				stream.end(message);
			});
			return stream;
		},
	});
	await runtime.setRuntimeApiKey("teamx-test", "test-only");
	return runtime;
}

test("real pi sessions coordinate lead → builder → reviewer without external API calls", async () => {
	let taskId = "";
	const steps: Record<string, number> = { lead: 0, builder: 0, reviewer: 0 };
	const runtime = await fakeRuntime((actor): Reply => {
		const step = steps[actor]++;
		if (actor === "lead") {
			if (step === 0)
				return { name: "team_tasks", arguments: { action: "create", title: "Implement fixture", assignee: "builder" } };
			taskId = store.listTasks("dev")[0].id;
			if (step === 1)
				return {
					name: "team_messages",
					arguments: { action: "send", recipient: "builder", body: `Implement task ${taskId}` },
				};
		}
		if (actor === "builder") {
			if (step === 0) return { name: "team_tasks", arguments: { action: "claim", id: taskId } };
			if (step === 1)
				return { name: "team_tasks", arguments: { action: "submit", id: taskId, result: "Artifact ready" } };
			if (step === 2)
				return { name: "team_handoff", arguments: { id: taskId, recipient: "reviewer", body: "Please review" } };
		}
		if (actor === "reviewer" && step === 0)
			return { name: "team_tasks", arguments: { action: "review", id: taskId, approve: true, result: "Verified" } };
		return { text: `${actor} finished` };
	});
	store.message("dev", "user", "lead", "Build the fixture with the team");
	for (const actor of ["lead", "builder", "reviewer"])
		assert.ok(
			await runAgent(
				service,
				actor,
				undefined,
				() => {},
				async () => runtime,
			),
		);
	assert.equal(store.task("dev", taskId).status, "done");
	assert.equal(store.task("dev", taskId).reviewer, "reviewer");
	assert.equal(store.runs("dev").filter((run) => run.status === "done").length, 3);
	assert.equal(store.pending("dev", "builder").length, 0);
	assert.match(
		store
			.messages("dev")
			.map((message) => message.body)
			.join("\n"),
		/Artifact ready/,
	);
});

test("live revocation blocks an originally declared tool inside a real pi session", async () => {
	let step = 0;
	let result = "";
	const runtime = await fakeRuntime((_actor, context) => {
		if (step++ === 0) {
			config.teams.dev.agents.lead.capabilities = { tools: [] };
			save();
			return { name: "read", arguments: { path: join(dir, ".teamx", "config.json") } };
		}
		const toolResult = context.messages.findLast((message) => message.role === "toolResult");
		result = JSON.stringify(toolResult);
		return { text: "Access denied as expected" };
	});
	store.message("dev", "user", "lead", "Read config");
	await runAgent(
		service,
		"lead",
		undefined,
		() => {},
		async () => runtime,
	);
	assert.match(result, /not permitted/);
});

test("selected Skills load while project pi resources are excluded", async () => {
	mkdirSync(join(dir, ".teamx", "skills"));
	writeFileSync(
		join(dir, ".teamx", "skills", "SKILL.md"),
		"---\nname: teamx-fixture\ndescription: Selected fixture instructions.\n---\nFixture body\n",
	);
	config.teams.dev.skills.fixture = "skills/SKILL.md";
	config.teams.dev.agents.lead.capabilities = { skills: ["fixture"] };
	save();
	service = new TeamService(loadTeams(dir).get("dev")!, store, dir);
	mkdirSync(join(dir, ".pi", "skills", "unselected"), { recursive: true });
	writeFileSync(
		join(dir, ".pi", "skills", "unselected", "SKILL.md"),
		"---\nname: unselected-fixture\ndescription: Should not load.\n---\nNo\n",
	);
	let prompt = "";
	const runtime = await fakeRuntime((_actor, context) => {
		prompt = JSON.stringify(context.messages.filter((message) => message.role === "system"));
		return { text: "Skills checked" };
	});
	store.message("dev", "user", "lead", "Check skills");
	await runAgent(
		service,
		"lead",
		undefined,
		() => {},
		async () => runtime,
	);
	assert.match(prompt, /teamx-fixture/);
	assert.doesNotMatch(prompt, /unselected-fixture/);
});

test("failed startup leaves messages pending and records a failed run", async () => {
	store.message("dev", "user", "lead", "Work");
	await assert.rejects(
		runAgent(
			service,
			"lead",
			undefined,
			() => {},
			async () => {
				throw new Error("Fixture unavailable");
			},
		),
		/Fixture unavailable/,
	);
	assert.equal(store.pending("dev", "lead").length, 1);
	assert.equal(store.runs("dev")[0].status, "failed");
});

test("assigned MCP stdio tools execute through pi while unassigned servers stay disconnected", async () => {
	config.teams.dev.mcp.fixture = {
		config: {
			command: process.execPath,
			args: [fileURLToPath(new URL("../../../packages/mcp/test/fixtures/stdio-server.mjs", import.meta.url))],
		},
		tools: ["echo"],
	};
	config.teams.dev.mcp.unassigned = { config: { command: "/must-not-start" }, tools: ["*"] };
	config.teams.dev.agents.lead.capabilities = { mcp: { fixture: ["echo"] } };
	save();
	service = new TeamService(loadTeams(dir).get("dev")!, store, dir);
	let step = 0;
	let response = "";
	const runtime = await fakeRuntime((_actor, context): Reply => {
		if (step++ === 0) return { name: "mcp__fixture__echo", arguments: { text: "teamx-mcp-ok" } };
		response = JSON.stringify(context.messages.findLast((message) => message.role === "toolResult"));
		return { text: "MCP checked" };
	});
	store.message("dev", "user", "lead", "Call the assigned MCP tool");
	await runAgent(
		service,
		"lead",
		undefined,
		() => {},
		async () => runtime,
	);
	assert.match(response, /teamx-mcp-ok/);
	assert.doesNotMatch(response, /isError":true/);
});
