import { type LoadedTeam, loadTeams, resolveSelection } from "./config.ts";
import type { Store } from "./store.ts";

export class TeamService {
	loaded: LoadedTeam;
	store: Store;
	cwd: string;
	constructor(loaded: LoadedTeam, store: Store, cwd: string) {
		this.loaded = loaded;
		this.store = store;
		this.cwd = cwd;
	}
	agent(id: string) {
		const agent = Object.hasOwn(this.loaded.team.agents, id) ? this.loaded.team.agents[id] : undefined;
		if (!agent) throw new Error(`Agent not found in team ${this.loaded.id}: ${id}`);
		return agent;
	}
	currentSelection(id: string) {
		const current = loadTeams(this.cwd).get(this.loaded.id);
		if (!current || !Object.hasOwn(current.team.agents, id)) throw new Error("Team or agent has been removed");
		return resolveSelection(current.team, current.team.agents[id].capabilities);
	}
	dispatch(
		actor: string,
		tool: string,
		input: {
			action?: string;
			id?: string;
			title?: string;
			assignee?: string;
			dependencies?: string[];
			result?: string;
			recipient?: string;
			body?: string;
			approve?: boolean;
		},
	) {
		this.agent(actor);
		const team = this.loaded.id;
		if (tool === "team_tasks") {
			switch (input.action) {
				case "list":
					return this.store.listTasks(team);
				case "create":
					if (input.assignee) this.agent(input.assignee);
					return this.store.createTask(team, input.title ?? "", input.assignee ?? null, input.dependencies, actor);
				case "claim":
					return this.store.claim(team, input.id ?? "", actor);
				case "submit":
					return this.store.submit(team, input.id ?? "", actor, input.result ?? "");
				case "review":
					return this.store.review(team, input.id ?? "", actor, input.approve === true, input.result ?? "");
				default:
					throw new Error("Unknown task action");
			}
		}
		if (tool === "team_messages") {
			if (input.action === "list") return this.store.messages(team, actor);
			if (input.action !== "send") throw new Error("Unknown message action");
			if (input.recipient) {
				this.agent(input.recipient);
				if (input.recipient === actor) throw new Error("Use the current run for your own work");
			}
			return this.store.message(team, actor, input.recipient ?? null, input.body ?? "");
		}
		if (tool === "team_handoff") {
			this.agent(input.recipient ?? "");
			const task = this.store.task(team, input.id ?? "");
			if (task.assignee !== actor || task.status !== "review")
				throw new Error("Submit your task before handing it off");
			if (input.recipient === actor) throw new Error("Hand off to another agent");
			return this.store.message(
				team,
				actor,
				input.recipient ?? null,
				`Review requested for task ${task.id}: ${task.title}\n${task.result}\n${input.body ?? ""}`,
			);
		}
		throw new Error("Unknown team tool");
	}
}
