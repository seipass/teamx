import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const TEAM_TOOLS = ["team_tasks", "team_messages", "team_handoff"];
export const BUILTIN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
export interface Selection {
	tools: string[];
	skills: string[];
	mcp: Record<string, string[]>;
}
export interface AgentConfig {
	name: string;
	role: string;
	instructions?: string;
	model?: string;
	capabilities?: Partial<Selection>;
}
export interface McpBinding {
	config: Record<string, unknown>;
	tools: string[];
}
export interface TeamConfig {
	name: string;
	instructions?: string;
	tools: string[];
	skills: Record<string, string>;
	mcp: Record<string, McpBinding>;
	defaults?: Partial<Selection>;
	agents: Record<string, AgentConfig>;
}
export interface TeamFile {
	version: 1;
	teams: Record<string, TeamConfig>;
}
export interface LoadedTeam {
	id: string;
	team: TeamConfig;
	file: string;
	base: string;
}

export function configPaths(cwd = process.cwd()) {
	const global = resolve(process.env.TEAMX_CONFIG_DIR || join(homedir(), ".teamx"));
	return { global, project: join(resolve(cwd), ".teamx"), auth: join(global, "agent", "auth.json") };
}

export function validId(value: string): string {
	if (!/^[a-z][a-z0-9_]{0,47}$/.test(value))
		throw new Error(`Invalid identifier: ${value}. Use lowercase letters, digits and underscores.`);
	return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}
function strings(value: unknown, label: string): asserts value is string[] {
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim()))
		throw new Error(`${label} must be a string array`);
}
function text(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
}
function selection(value: unknown, label: string) {
	const record = object(value, label);
	for (const key of Object.keys(record))
		if (!["tools", "skills", "mcp"].includes(key)) throw new Error(`Unknown ${label}.${key}`);
	if (record.tools !== undefined) strings(record.tools, `${label}.tools`);
	if (record.skills !== undefined) strings(record.skills, `${label}.skills`);
	if (record.mcp !== undefined)
		for (const [id, tools] of Object.entries(object(record.mcp, `${label}.mcp`))) {
			validId(id);
			strings(tools, `${label}.mcp.${id}`);
		}
}

export function validateConfig(value: unknown): TeamFile {
	const file = object(value, "config");
	if (file.version !== 1) throw new Error("Config version must be 1");
	for (const [id, raw] of Object.entries(object(file.teams, "teams"))) {
		validId(id);
		const team = object(raw, id);
		text(team.name, `${id}.name`);
		if (team.instructions !== undefined) text(team.instructions, `${id}.instructions`);
		strings(team.tools, `${id}.tools`);
		for (const tool of team.tools)
			if (![...BUILTIN_TOOLS, ...TEAM_TOOLS].includes(tool)) throw new Error(`Unknown tool ${tool}`);
		for (const [skill, path] of Object.entries(object(team.skills, `${id}.skills`))) {
			validId(skill);
			text(path, `Skill ${skill}`);
		}
		for (const [server, entry] of Object.entries(object(team.mcp, `${id}.mcp`))) {
			validId(server);
			const binding = object(entry, `MCP ${server}`);
			object(binding.config, `MCP ${server}.config`);
			strings(binding.tools, `MCP ${server}.tools`);
			for (const tool of binding.tools)
				if (tool !== "*" && !/^[a-zA-Z0-9_]+$/.test(tool))
					throw new Error("MCP tool names must use letters, digits and underscores, or *");
		}
		if (team.defaults !== undefined) selection(team.defaults, `${id}.defaults`);
		for (const [agentId, entry] of Object.entries(object(team.agents, `${id}.agents`))) {
			validId(agentId);
			const agent = object(entry, agentId);
			text(agent.name, `${agentId}.name`);
			text(agent.role, `${agentId}.role`);
			if (agent.instructions !== undefined) text(agent.instructions, `${agentId}.instructions`);
			if (agent.model !== undefined) {
				text(agent.model, `${agentId}.model`);
				if (!agent.model.includes("/")) throw new Error("Model must be provider/model-id");
			}
			if (agent.capabilities !== undefined) selection(agent.capabilities, agentId);
		}
	}
	const result = value as TeamFile;
	for (const team of Object.values(result.teams)) {
		resolveSelection(team, {});
		for (const agent of Object.values(team.agents)) resolveSelection(team, agent.capabilities);
	}
	return result;
}

export function resolveSelection(team: TeamConfig, override: Partial<Selection> = {}): Selection {
	const result = {
		tools: override.tools ?? team.defaults?.tools ?? team.tools,
		skills: override.skills ?? team.defaults?.skills ?? Object.keys(team.skills),
		mcp:
			override.mcp ??
			team.defaults?.mcp ??
			Object.fromEntries(Object.entries(team.mcp).map(([id, binding]) => [id, binding.tools])),
	};
	for (const tool of result.tools)
		if (!team.tools.includes(tool)) throw new Error(`Tool exceeds team permissions: ${tool}`);
	for (const skill of result.skills)
		if (!Object.hasOwn(team.skills, skill)) throw new Error(`Skill exceeds team permissions: ${skill}`);
	for (const [id, tools] of Object.entries(result.mcp)) {
		const binding = Object.hasOwn(team.mcp, id) ? team.mcp[id] : undefined;
		if (!binding) throw new Error(`MCP server exceeds team permissions: ${id}`);
		for (const tool of tools)
			if (!binding.tools.includes("*") && !binding.tools.includes(tool))
				throw new Error(`MCP tool exceeds team permissions: ${id}/${tool}`);
	}
	return structuredClone(result);
}

export function toolAllowed(selection: Selection, name: string): boolean {
	if (selection.tools.includes(name)) return true;
	for (const [server, tools] of Object.entries(selection.mcp)) {
		const prefix = `mcp__${server}__`;
		if (name.startsWith(prefix)) return tools.includes("*") || tools.includes(name.slice(prefix.length));
	}
	return false;
}

export function loadTeams(cwd = process.cwd()): Map<string, LoadedTeam> {
	const paths = configPaths(cwd);
	const teams = new Map<string, LoadedTeam>();
	for (const file of [join(paths.global, "config.json"), join(paths.project, "config.json")]) {
		if (!existsSync(file)) continue;
		const config = validateConfig(JSON.parse(readFileSync(file, "utf8")));
		for (const [id, team] of Object.entries(config.teams)) teams.set(id, { id, team, file, base: dirname(file) });
	}
	return teams;
}

export function skillPath(loaded: LoadedTeam, id: string): string {
	const path = loaded.team.skills[id];
	if (!path) throw new Error(`Unknown skill: ${id}`);
	return isAbsolute(path) ? path : resolve(loaded.base, path);
}

export function initProject(cwd = process.cwd()) {
	const paths = configPaths(cwd);
	mkdirSync(paths.project, { recursive: true, mode: 0o700 });
	const file = join(paths.project, "config.json");
	const tools = [...BUILTIN_TOOLS, ...TEAM_TOOLS];
	const config: TeamFile = {
		version: 1,
		teams: {
			dev: {
				name: "Development",
				instructions: "Coordinate through the shared board and messages. Submit work for review before completion.",
				tools,
				skills: {},
				mcp: {},
				defaults: { tools: ["read", ...TEAM_TOOLS], skills: [], mcp: {} },
				agents: {
					lead: { name: "Lead", role: "Break requests into tasks, assign specialists, and coordinate reviews." },
					builder: {
						name: "Builder",
						role: "Implement assigned tasks and submit results for review.",
						capabilities: { tools },
					},
					reviewer: { name: "Reviewer", role: "Review submitted work, report findings, and approve completed tasks." },
				},
			},
		},
	};
	writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	const ignore = join(paths.project, ".gitignore");
	if (!existsSync(ignore)) writeFileSync(ignore, "state/\n", { mode: 0o600 });
	return file;
}
