#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const resolver = fileURLToPath(
	new URL("../../packages/coding-agent/src/experimental/source-resolver.ts", import.meta.url),
);
const entry = fileURLToPath(new URL("src/cli.ts", import.meta.url));
const child = spawn(process.execPath, ["--import", resolver, entry, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("error", (error) => {
	console.error(error.message);
	process.exitCode = 1;
});
child.on("exit", (code) => {
	process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
