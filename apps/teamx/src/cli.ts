import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { configPaths, initProject, loadTeams, resolveSelection, validId } from "./config.ts";
import { modelRuntime, runAgent, workTeam } from "./runtime.ts";
import { TeamService } from "./service.ts";
import { Store, type TaskStatus } from "./store.ts";

const HELP = `teamx — pi agent teams

  teamx init                              Create .teamx/config.json
  teamx config path                       Show isolated configuration paths
  teamx config validate                   Validate team and agent capabilities
  teamx teams                             List teams
  teamx agents <team>                      Show roles and effective capabilities
  teamx login <provider> [oauth|api_key]   Provider login, stored only in ~/.teamx
  teamx logout <provider>                  Remove a teamx provider login
  teamx models                            List available provider/model IDs
  teamx board <team>                       Show the shared task board
  teamx task add <team> <title> [agent]     Create and optionally assign a task
  teamx task claim <team> <id> <agent>      Claim a ready task
  teamx task submit <team> <id> <agent> <result>
  teamx task review <team> <id> <approve|reject> <note>
  teamx task resume <team> <id>            Requeue a blocked task after inspection
  teamx send <team> <agent|all> <message>   Queue a direct message or post to channel
  teamx messages <team>                    Read team conversations
  teamx run <team> <agent> [request]        Run an agent's pending messages
  teamx work <team> [max-runs]              Process team handoffs (default: 10 runs)
  teamx chat <team> <agent>                Interactive conversation; /exit to quit
  teamx runs <team>                        Show recent runs
  teamx recover <team>                     Recover workers with expired leases

Quote multiword titles, results and messages. Ctrl-C cancels current work.
TEAMX_CONFIG_DIR overrides ~/.teamx. Project teams replace same-named global teams.
`;

function required(value: string | undefined, label: string): string {
	if (!value) throw new Error(`Missing ${label}. Run teamx --help.`);
	return value;
}
function board(service: TeamService) {
	const tasks = service.store.listTasks(service.loaded.id);
	const labels: TaskStatus[] = ["ready", "in_progress", "review", "done", "blocked", "cancelled"];
	console.log(`\n${service.loaded.team.name} — shared task board`);
	for (const status of labels) {
		const column = tasks.filter((task) => task.status === status);
		console.log(`\n${status.toUpperCase()} (${column.length})`);
		for (const task of column)
			console.log(
				`  ${task.id}  ${task.title}  [${task.assignee ?? "unassigned"}]${task.result ? `\n    ${task.result.replaceAll("\n", "\n    ")}` : ""}`,
			);
	}
}

async function login(provider: string, type: string | undefined, cwd: string) {
	const runtime = await modelRuntime(cwd);
	const auth = runtime.getProvider(provider)?.auth;
	if (!auth) throw new Error(`Provider not found: ${provider}`);
	const method = type ?? (auth.oauth ? "oauth" : "api_key");
	if (method !== "oauth" && method !== "api_key") throw new Error("Login type must be oauth or api_key");
	let hidden = false;
	const output = new Writable({
		write(chunk, _encoding, next) {
			if (!hidden) process.stdout.write(chunk);
			next();
		},
	});
	const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
	try {
		await runtime.login(provider, method, {
			prompt: async (prompt) => {
				if (prompt.type === "select") for (const option of prompt.options) console.log(`${option.id}: ${option.label}`);
				if (prompt.type === "secret") {
					if (!process.stdin.isTTY) throw new Error("Secret entry requires an interactive terminal");
					process.stdout.write(`${prompt.message}: `);
					hidden = true;
				}
				try {
					return await rl.question(hidden ? "" : `${prompt.message}: `, { signal: prompt.signal });
				} finally {
					if (hidden) {
						hidden = false;
						process.stdout.write("\n");
					}
				}
			},
			notify: (event) => {
				if (event.type === "auth_url") console.log(event.url, event.instructions ?? "");
				else if (event.type === "device_code") console.log(event.verificationUri, event.userCode);
				else console.log(event.message);
			},
		});
		if (existsSync(configPaths(cwd).auth)) chmodSync(configPaths(cwd).auth, 0o600);
		console.log(`Logged in to ${provider}. Credentials saved in the teamx auth store.`);
	} finally {
		rl.close();
	}
}

export async function main(args = process.argv.slice(2), cwd = process.cwd()) {
	const [command, ...rest] = args;
	if (!command || command === "--help" || command === "help") {
		console.log(HELP);
		return;
	}
	if (command === "init") {
		console.log(initProject(cwd));
		return;
	}
	if (command === "config") {
		if (rest[0] === "path") console.log(JSON.stringify(configPaths(cwd), null, 2));
		else if (rest[0] === "validate") {
			const teams = loadTeams(cwd);
			if (!teams.size) throw new Error("No teams configured. Run teamx init.");
			console.log(`Valid: ${teams.size} team(s)`);
		} else throw new Error("Use config path or config validate");
		return;
	}
	if (command === "login") {
		await login(required(rest[0], "provider"), rest[1], cwd);
		return;
	}
	if (command === "logout") {
		await (await modelRuntime(cwd)).logout(required(rest[0], "provider"));
		console.log("Logged out");
		return;
	}
	if (command === "models") {
		for (const model of await (await modelRuntime(cwd)).getAvailable()) console.log(`${model.provider}/${model.id}`);
		return;
	}
	const teams = loadTeams(cwd);
	if (command === "teams") {
		for (const [id, loaded] of teams)
			console.log(`${id}\t${loaded.team.name}\t${Object.keys(loaded.team.agents).length} agents\t${loaded.file}`);
		return;
	}
	const teamId = validId(required(command === "task" ? rest[1] : rest[0], "team"));
	const loaded = teams.get(teamId);
	if (!loaded) throw new Error(`Team not found: ${teamId}. Run teamx init or edit .teamx/config.json.`);
	if (command === "agents") {
		for (const [id, agent] of Object.entries(loaded.team.agents))
			console.log(
				JSON.stringify({ id, ...agent, effective: resolveSelection(loaded.team, agent.capabilities) }, null, 2),
			);
		return;
	}
	const state = join(configPaths(cwd).project, "state");
	mkdirSync(state, { recursive: true, mode: 0o700 });
	const store = new Store(join(state, "teamx.db"));
	const service = new TeamService(loaded, store, cwd);
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		switch (command) {
			case "board":
				board(service);
				break;
			case "task": {
				const [action, , id, actor, result] = rest;
				if (action === "add") {
					if (actor) service.agent(actor);
					console.log(store.createTask(teamId, required(id, "title"), actor ?? null));
				} else if (action === "claim") {
					service.agent(required(actor, "agent"));
					console.log(store.claim(teamId, required(id, "task id"), actor!));
				} else if (action === "submit") {
					service.agent(required(actor, "agent"));
					console.log(store.submit(teamId, required(id, "task id"), actor!, required(result, "result")));
				} else if (action === "review") {
					if (actor !== "approve" && actor !== "reject") throw new Error("Review must be approve or reject");
					console.log(
						store.review(teamId, required(id, "task id"), "user", actor === "approve", required(result, "review note")),
					);
				} else if (action === "resume") console.log(store.resumeTask(teamId, required(id, "task id")));
				else throw new Error("Unknown task action");
				break;
			}
			case "send": {
				const target = required(rest[1], "recipient");
				if (target !== "all") service.agent(target);
				console.log(store.message(teamId, "user", target === "all" ? null : target, required(rest[2], "message")).id);
				break;
			}
			case "messages":
				for (const message of store.messages(teamId))
					console.log(`[${message.sender} → ${message.recipient ?? "#team"}] ${message.body}`);
				break;
			case "run": {
				const actor = required(rest[1], "agent");
				service.agent(actor);
				if (rest[2]) store.message(teamId, "user", actor, rest[2]);
				if (!(await runAgent(service, actor, controller.signal))) console.log("No pending messages");
				break;
			}
			case "work":
				console.log(
					`Completed ${await workTeam(service, rest[1] === undefined ? 10 : Number(rest[1]), controller.signal)} run(s)`,
				);
				break;
			case "chat": {
				const actor = required(rest[1], "agent");
				service.agent(actor);
				const rl = createInterface({ input: process.stdin, output: process.stdout });
				try {
					console.log(`Chat with ${teamId}/${actor}. /board, /work, /exit`);
					while (!controller.signal.aborted) {
						const message = await rl.question("you > ", { signal: controller.signal });
						if (message === "/exit") break;
						if (message === "/board") {
							board(service);
							continue;
						}
						if (message === "/work") {
							await workTeam(service, 10, controller.signal);
							continue;
						}
						if (!message.trim()) continue;
						store.message(teamId, "user", actor, message);
						await runAgent(service, actor, controller.signal);
					}
				} finally {
					rl.close();
				}
				break;
			}
			case "runs":
				for (const run of store.runs(teamId)) console.log(`${run.id}\t${run.agent}\t${run.status}\t${run.error}`);
				break;
			case "recover":
				console.log(`Recovered ${store.recover(teamId)} expired run(s)`);
				break;
			default:
				throw new Error(`Unknown command: ${command}`);
		}
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		store.close();
	}
}

main().catch((error: unknown) => {
	console.error(`teamx: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
