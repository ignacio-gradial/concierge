// Haiku through `claude -p`, for the tick's triage and for concierge-act's choice of a PR's agent.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const MODEL = "claude-haiku-5-5";
// Absolute path: the Monitor shell can resolve /opt/homebrew/bin/claude (2.1.220), which predates
// Haiku 5.5 and runs it with fallback limits and prices (200k context, ~40x reported cost).
const CLAUDE = path.join(os.homedir(), ".local/bin/claude");
// A cwd outside ~/concierge keeps Haiku from loading this project's hooks, CLAUDE.md and skills.
const HAIKU_CWD = path.join(os.tmpdir(), "concierge-haiku");

// claude -p exits non-zero on its own errors but still prints the JSON result;
// keep that result as the error instead of the bare "Command failed" line.
async function claudeJson(args, options) {
	const pending = run(CLAUDE, args, options);
	pending.child.stdin.end();
	try {
		return (await pending).stdout;
	} catch (error) {
		const result = error.stdout ? JSON.parse(error.stdout) : undefined;
		const detail = result ? `${result.subtype ?? "error"}: ${result.result ?? JSON.stringify(result.errors ?? result)}` : error.stderr || error.message;
		throw new Error(`claude -p exited ${error.code ?? error.signal}: ${String(detail).slice(0, 400)}`);
	}
}

// One Haiku run whose answer must match `schema`. Returns the parsed claude -p result.
export async function haiku(prompt, schema, { args = [], timeout = 240_000 } = {}) {
	fs.mkdirSync(HAIKU_CWD, { recursive: true });
	const stdout = await claudeJson(["-p", prompt, "--model", MODEL, "--json-schema", JSON.stringify(schema), "--output-format", "json", ...args], {
		cwd: HAIKU_CWD,
		timeout,
		maxBuffer: 16 * 1024 * 1024,
	});
	const result = JSON.parse(stdout);
	if (result.is_error || !result.structured_output) {
		throw new Error(`Haiku failed: ${result.subtype ?? ""} ${String(result.result ?? stdout).slice(0, 300)}`);
	}
	return result;
}
