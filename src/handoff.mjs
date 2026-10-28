// Sends a prompt to another herdr agent and logs the hand-off, so the Concierge log records every piece of work
// Concierge hands out. Usage: concierge-handoff <agent> <prompt-file> <what>
// <agent> is a herdr agent name or pane in the session at $HERDR_SOCKET_PATH, and <what> is the log line's summary.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { appendLog } from "./signals.mjs";

const run = promisify(execFile);

// `socket` picks the herdr session; it defaults to the one this process runs in.
export async function sendPrompt({ agent, prompt, what, socket = process.env.HERDR_SOCKET_PATH }) {
	if (!socket) throw new Error("HERDR_SOCKET_PATH unset: export the target session's socket first");
	const env = { ...process.env, HERDR_SOCKET_PATH: socket };
	const herdr = async (args) => JSON.parse((await run("herdr", args, { timeout: 30_000, env })).stdout).result;
	// ~/.config/herdr/sessions/<Session>/herdr.sock
	const session = path.basename(path.dirname(socket));
	try {
		// Without --until, --wait lasts the whole turn. Waiting only for working or blocked confirms the agent took the
		// prompt, so a prompt left unsent in the box fails here (agent_prompt_stalled).
		await run("herdr", ["agent", "prompt", agent, prompt, "--wait", "--until", "working", "--until", "blocked", "--timeout", "20000"], { timeout: 30_000, env });
	} catch (error) {
		appendLog(`**handoff failed** · ${what} → ${agent} in ${session} · ${String(error.stderr || error.message).trim().slice(0, 300)}`);
		throw error;
	}
	const { agent: info } = await herdr(["agent", "get", agent]);
	const { workspace } = await herdr(["workspace", "get", info.workspace_id]);
	const { tab } = await herdr(["tab", "get", info.tab_id]);
	const line = `handoff · ${what} → ${info.name ?? agent} (${info.agent_status}) · ${session} · ${workspace.label} / tab ${tab.label} (${info.pane_id}) · ${info.cwd}`;
	appendLog(line);
	return line;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [agent, promptFile, what] = process.argv.slice(2);
	if (!agent || !promptFile || !what) throw new Error("usage: concierge-handoff <agent> <prompt-file> <what>");
	console.log(await sendPrompt({ agent, prompt: fs.readFileSync(promptFile, "utf8"), what }));
}
