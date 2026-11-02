// Haiku through `claude -p`, for the tick's triage and for extracting saved reviews. Every run, failed ones included,
// gets a line in state/usage.jsonl.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const MODEL = "claude-haiku-5-5";
// Absolute path: a shell can resolve /opt/homebrew/bin/claude (2.1.220), which predates Haiku 5.5 and runs it with
// fallback limits and prices (200k context, ~40x reported cost).
const CLAUDE = path.join(os.homedir(), ".local/bin/claude");
// A cwd outside ~/concierge keeps Haiku from loading this project's hooks, CLAUDE.md and skills.
const HAIKU_CWD = path.join(os.tmpdir(), "concierge-haiku");
const USAGE_FILE = path.join(os.homedir(), "concierge/state/usage.jsonl");

function logUsage(purpose, started, result, error) {
	const line = { at: new Date().toISOString(), purpose, seconds: Number(((Date.now() - started) / 1000).toFixed(1)), session: result?.session_id, cost: result?.total_cost_usd, usage: result?.modelUsage, speed: result?.usage?.speed, tier: result?.usage?.service_tier, ...(error ? { error: String(error).slice(0, 300) } : {}) };
	fs.appendFileSync(USAGE_FILE, `${JSON.stringify(line)}\n`);
}

// claude -p exits non-zero on its own errors but still prints the JSON result; keep that result as the error instead of
// the bare "Command failed" line. A killed run prints nothing and leaves no cost.
async function claudeJson(args, options, purpose, started) {
	const pending = run(CLAUDE, args, options);
	pending.child.stdin.end();
	try {
		return (await pending).stdout;
	} catch (error) {
		let result;
		try {
			result = error.stdout ? JSON.parse(error.stdout) : undefined;
		} catch {}
		const detail = result ? `${result.subtype ?? "error"}: ${result.result ?? JSON.stringify(result.errors ?? result)}` : error.stderr || error.message;
		logUsage(purpose, started, result, `exited ${error.code ?? error.signal}`);
		throw new Error(`claude -p exited ${error.code ?? error.signal}: ${String(detail).slice(0, 400)}`);
	}
}

// One Haiku run whose answer must match `schema`. Returns the parsed claude -p result. `purpose` names the run in
// state/usage.jsonl.
export async function haiku(prompt, schema, { args = [], timeout = 240_000, purpose }) {
	if (!purpose) throw new Error("haiku needs a purpose for state/usage.jsonl");
	fs.mkdirSync(HAIKU_CWD, { recursive: true });
	const started = Date.now();
	const stdout = await claudeJson(["-p", prompt, "--model", MODEL, "--json-schema", JSON.stringify(schema), "--output-format", "json", ...args], {
		cwd: HAIKU_CWD,
		timeout,
		maxBuffer: 16 * 1024 * 1024,
	}, purpose, started);
	const result = JSON.parse(stdout);
	const failed = result.is_error || !result.structured_output;
	logUsage(purpose, started, result, failed ? result.subtype ?? "no structured output" : undefined);
	if (failed) throw new Error(`Haiku failed: ${result.subtype ?? ""} ${String(result.result ?? stdout).slice(0, 300)}`);
	return result;
}
