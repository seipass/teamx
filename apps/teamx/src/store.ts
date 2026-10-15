import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type TaskStatus = "ready" | "in_progress" | "review" | "done" | "blocked" | "cancelled";
export interface Task {
	id: string;
	team: string;
	title: string;
	assignee: string | null;
	status: TaskStatus;
	dependencies: string[];
	result: string;
	reviewer: string | null;
}
export interface ChatMessage {
	id: string;
	team: string;
	sender: string;
	recipient: string | null;
	body: string;
	delivered: number;
	created: number;
}
export interface Run {
	id: string;
	team: string;
	agent: string;
	status: string;
	snapshot: string;
	error: string;
	heartbeat: number;
}

export class Store {
	db: DatabaseSync;
	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(path);
		chmodSync(path, 0o600);
		this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, team TEXT NOT NULL, title TEXT NOT NULL, assignee TEXT, status TEXT NOT NULL, dependencies TEXT NOT NULL, result TEXT NOT NULL DEFAULT '', reviewer TEXT);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, team TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT, body TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, team TEXT NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL, snapshot TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', heartbeat INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(team, agent) WHERE status = 'running';
      CREATE INDEX IF NOT EXISTS pending_messages ON messages(team, recipient, delivered);
    `);
	}
	close() {
		this.db.close();
	}
	listTasks(team: string): Task[] {
		return this.db
			.prepare("SELECT * FROM tasks WHERE team = ? ORDER BY rowid")
			.all(team)
			.map((row) => ({ ...row, dependencies: JSON.parse(String(row.dependencies)) }) as Task);
	}
	task(team: string, id: string): Task {
		const row = this.db.prepare("SELECT * FROM tasks WHERE team = ? AND id = ?").get(team, id);
		if (!row) throw new Error(`Task not found in team ${team}: ${id}`);
		return { ...row, dependencies: JSON.parse(String(row.dependencies)) } as Task;
	}
	createTask(team: string, title: string, assignee: string | null, dependencies: string[] = [], sender = "user"): Task {
		if (!title.trim()) throw new Error("Task title is required");
		for (const dependency of dependencies) this.task(team, dependency);
		const id = randomUUID();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare("INSERT INTO tasks (id,team,title,assignee,status,dependencies) VALUES (?,?,?,?,'ready',?)")
				.run(id, team, title, assignee, JSON.stringify(dependencies));
			if (assignee && assignee !== sender) this.message(team, sender, assignee, `Task assigned: ${id}\n${title}`);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		return this.task(team, id);
	}
	claim(team: string, id: string, actor: string): Task {
		const result = this.db
			.prepare(`UPDATE tasks SET status='in_progress', assignee=? WHERE team=? AND id=? AND status='ready' AND (assignee IS NULL OR assignee=?)
      AND NOT EXISTS (SELECT 1 FROM json_each(tasks.dependencies) d LEFT JOIN tasks t ON t.id=d.value AND t.team=tasks.team WHERE t.id IS NULL OR t.status != 'done')`)
			.run(actor, team, id, actor);
		if (result.changes !== 1)
			throw new Error("Task is unavailable, assigned to another agent, or has unfinished dependencies");
		return this.task(team, id);
	}
	submit(team: string, id: string, actor: string, result: string): Task {
		if (!result.trim()) throw new Error("A result is required");
		const updated = this.db
			.prepare(
				"UPDATE tasks SET status='review', result=? WHERE team=? AND id=? AND assignee=? AND status='in_progress'",
			)
			.run(result, team, id, actor);
		if (updated.changes !== 1) throw new Error("Only the active task owner can submit work");
		return this.task(team, id);
	}
	review(team: string, id: string, actor: string, approve: boolean, note: string): Task {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const updated = this.db
				.prepare(
					"UPDATE tasks SET status=?, reviewer=?, result=result || ? WHERE team=? AND id=? AND status='review' AND assignee != ?",
				)
				.run(approve ? "done" : "ready", actor, `\nReview by ${actor}: ${note}`, team, id, actor);
			if (updated.changes !== 1) throw new Error("Review requires submitted work and a different reviewer");
			const task = this.task(team, id);
			if (!approve && task.assignee) this.message(team, actor, task.assignee, `Changes requested for ${id}: ${note}`);
			if (approve) {
				const tasks = this.listTasks(team);
				for (const ready of tasks) {
					if (
						ready.status === "ready" &&
						ready.assignee &&
						ready.dependencies.includes(id) &&
						ready.dependencies.every((dependency) =>
							tasks.some((candidate) => candidate.id === dependency && candidate.status === "done"),
						)
					) {
						this.message(team, actor, ready.assignee, `Dependencies completed for task ${ready.id}: ${ready.title}`);
					}
				}
			}
			this.db.exec("COMMIT");
			return task;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	message(team: string, sender: string, recipient: string | null, body: string): ChatMessage {
		if (!body.trim()) throw new Error("Message is empty");
		const message = { id: randomUUID(), team, sender, recipient, body, delivered: 0, created: Date.now() };
		this.db
			.prepare("INSERT INTO messages (id,team,sender,recipient,body,created) VALUES (?,?,?,?,?,?)")
			.run(message.id, team, sender, recipient, body, message.created);
		return message;
	}
	messages(team: string, agent?: string): ChatMessage[] {
		return (agent
			? this.db
					.prepare(
						"SELECT * FROM messages WHERE team=? AND (recipient IS NULL OR recipient=? OR sender=?) ORDER BY rowid",
					)
					.all(team, agent, agent)
			: this.db.prepare("SELECT * FROM messages WHERE team=? ORDER BY rowid").all(team)) as unknown as ChatMessage[];
	}
	pending(team: string, agent: string): ChatMessage[] {
		return this.db
			.prepare("SELECT * FROM messages WHERE team=? AND recipient=? AND delivered=0 ORDER BY rowid LIMIT 50")
			.all(team, agent) as unknown as ChatMessage[];
	}
	delivered(team: string, ids: string[]) {
		const update = this.db.prepare("UPDATE messages SET delivered=1 WHERE team=? AND id=?");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const id of ids) update.run(team, id);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	startRun(team: string, agent: string, snapshot: unknown): Run {
		const id = randomUUID();
		this.db
			.prepare("INSERT INTO runs (id,team,agent,status,snapshot,heartbeat) VALUES (?,?,?,'running',?,?)")
			.run(id, team, agent, JSON.stringify(snapshot), Date.now());
		return this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as unknown as Run;
	}
	finishRun(id: string, status: "done" | "failed" | "cancelled", error = "") {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (status !== "done")
				this.db
					.prepare(
						"UPDATE tasks SET status='blocked' WHERE status='in_progress' AND (team,assignee) IN (SELECT team,agent FROM runs WHERE id=? AND status='running')",
					)
					.run(id);
			this.db
				.prepare("UPDATE runs SET status=?, error=?, heartbeat=? WHERE id=? AND status='running'")
				.run(status, error, Date.now(), id);
			this.db.exec("COMMIT");
		} catch (failure) {
			this.db.exec("ROLLBACK");
			throw failure;
		}
	}
	heartbeat(id: string) {
		this.db.prepare("UPDATE runs SET heartbeat=? WHERE id=? AND status='running'").run(Date.now(), id);
	}
	recover(team: string, before = Date.now() - 60_000) {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare(
					"UPDATE tasks SET status='blocked' WHERE team=? AND status='in_progress' AND assignee IN (SELECT agent FROM runs WHERE team=? AND status='running' AND heartbeat<?)",
				)
				.run(team, team, before);
			const result = this.db
				.prepare(
					"UPDATE runs SET status='failed', error='Worker lease expired; inspect task and external effects before retrying' WHERE team=? AND status='running' AND heartbeat<?",
				)
				.run(team, before);
			this.db.exec("COMMIT");
			return result.changes;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	resumeTask(team: string, id: string) {
		if (
			this.db.prepare("UPDATE tasks SET status='ready' WHERE team=? AND id=? AND status='blocked'").run(team, id)
				.changes !== 1
		)
			throw new Error("Only blocked tasks can be resumed");
		return this.task(team, id);
	}
	runs(team: string): Run[] {
		return this.db
			.prepare("SELECT * FROM runs WHERE team=? ORDER BY rowid DESC LIMIT 30")
			.all(team) as unknown as Run[];
	}
}
