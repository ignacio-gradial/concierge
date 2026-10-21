// Sends a prompt to another herdr agent and logs the hand-off, so the Concierge log records every piece of work
// the Opus session hands out. Usage: concierge-handoff <agent> <prompt-file> <what>
// <agent> is a herdr agent name or pane in the session at $HERDR_SOCKET_PATH, and <what> is the log line's summary.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { appendLog } from "./signals.mjs";

const run = promisify(execFile);

const herdr = async (args) => JSON.parse((await run("herdr", args, { timeout: 30_000 })).stdout).result;

const [agent, promptFile, what] = process.argv.slice(2);
if (!agent || !promptFile || !what) throw new Error("usage: concierge-handoff <agent> <prompt-file> <what>");
if (!process.env.HERDR_SOCKET_PATH) throw new Error("HERDR_SOCKET_PATH unset: export the target session's socket first");
// ~/.config/herdr/sessions/<Session>/herdr.sock
const session = path.basename(path.dirname(process.env.HERDR_SOCKET_PATH));
const prompt = fs.readFileSync(promptFile, "utf8");

try {
	// Without --until, --wait lasts the whole turn. Waiting only for working or blocked confirms the agent took the
	// prompt, so a prompt left unsent in the box fails here (agent_prompt_stalled).
	await run("herdr", ["agent", "prompt", agent, prompt, "--wait", "--until", "working", "--until", "blocked", "--timeout", "20000"], { timeout: 30_000 });
} catch (error) {
	appendLog(`**handoff failed** · ${what} → ${agent} in ${session} · ${String(error.stderr || error.message).trim().slice(0, 300)}`);
	throw error;
}
const { agent: info } = await herdr(["agent", "get", agent]);
const { workspace } = await herdr(["workspace", "get", info.workspace_id]);
const { tab } = await herdr(["tab", "get", info.tab_id]);
const line = `handoff · ${what} → ${info.name ?? agent} (${info.agent_status}) · ${session} · ${workspace.label} / tab ${tab.label} (${info.pane_id}) · ${info.cwd}`;
appendLog(line);
console.log(line);
