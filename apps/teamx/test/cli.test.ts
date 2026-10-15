import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("CLI initializes a project, creates tasks, and persists team messages across processes", () => {
	const dir = mkdtempSync(join(tmpdir(), "teamx-cli-"));
	const entry = fileURLToPath(new URL("../launch.mjs", import.meta.url));
	const cli = (...args: string[]) =>
		execFileSync(process.execPath, [entry, ...args], {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, TEAMX_CONFIG_DIR: join(dir, "global") },
		});
	try {
		assert.match(cli("init"), /\.teamx\/config.json/);
		assert.match(cli("config", "validate"), /Valid: 1/);
		assert.match(cli("teams"), /Development/);
		assert.match(cli("task", "add", "dev", "CLI task", "builder"), /CLI task/);
		assert.match(cli("board", "dev"), /READY \(1\)/);
		cli("send", "dev", "lead", "Please coordinate");
		assert.match(cli("messages", "dev"), /user → lead.*Please coordinate/);
		assert.match(cli("config", "path"), /global/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
