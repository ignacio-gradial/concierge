// Messages waiting for the Opus session. The loop runs in its own tab, so a dead or restarting session loses nothing:
// the tick appends here and each tick delivers whatever is waiting, as one prompt. Only the tick writes this file.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { conciergeAgents, loopPrompt, typedInBox } from "./messages.mjs";
import { appendLog, herdrWorkspace, notify } from "./signals.mjs";

const run = promisify(execFile);
const HOME = path.join(os.homedir(), "concierge");
const OUTBOX = path.join(HOME, "state/outbox.txt");
// Written when the toast for stuck messages has fired, so it fires once per outage.
const STUCK_MARKER = path.join(HOME, "state/outbox.stuck");
const STUCK_MS = 10 * 60_000;

// The pane also shows it, for whoever looks at the Loop tab.
export function post(text) {
	process.stdout.write(text);
	fs.appendFileSync(OUTBOX, text);
}

// The Claude agent running in ~/concierge in this workspace. Its pane changes on restart and it may have no name.
async function conciergeAgent() {
	const { stdout } = await run("herdr", ["agent", "list"], { timeout: 10_000 });
	const ownPane = process.env.HERDR_PANE_ID;
	if (!ownPane) throw new Error("HERDR_PANE_ID unset: run the loop inside its herdr pane");
	const found = conciergeAgents(JSON.parse(stdout).result.agents, { workspace: herdrWorkspace(), home: HOME, ownPane });
	if (found.length !== 1) throw new Error(`${found.length} agents run in ${HOME} in this workspace, expected 1`);
	return found[0];
}

// Why the prompt can't go now, or undefined. It waits on Ignacio's typing and on a blocked agent, which rejects prompts.
async function waitReason(agent) {
	if (agent.agent_status === "blocked") return "the agent is blocked, waiting on Ignacio";
	const { stdout } = await run("herdr", ["pane", "read", agent.pane_id, "--source", "visible", "--format", "ansi"], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
	const typed = typedInBox(stdout);
	if (typed === null) return "no prompt box on screen";
	if (typed) return `text in the prompt box (${typed.length} characters)`;
	return undefined;
}

// Returns whether messages have been stuck long enough for the ✗. A prompt that reached the agent but failed its
// confirmation is sent again next tick: a duplicate is better than a lost event.
export async function deliver() {
	if (!fs.existsSync(OUTBOX)) return false;
	const pending = fs.readFileSync(OUTBOX, "utf8");
	const lines = pending.split("\n").length - 1;
	let reason;
	try {
		const agent = await conciergeAgent();
		reason = await waitReason(agent);
		if (!reason) {
			// Waiting only for working or blocked confirms the agent took the prompt; an agent already working queues it.
			await run("herdr", ["agent", "prompt", agent.pane_id, loopPrompt(pending), "--wait", "--until", "working", "--until", "blocked", "--timeout", "20000"], { timeout: 30_000 });
			fs.rmSync(OUTBOX);
			fs.rmSync(STUCK_MARKER, { force: true });
			appendLog(`delivered · ${lines} lines → ${agent.pane_id} (${agent.agent_status})`);
			return false;
		}
	} catch (error) {
		reason = String(error?.stderr || error?.message || error).trim().slice(0, 300);
	}
	const stuck = Date.now() - fs.statSync(OUTBOX).birthtimeMs > STUCK_MS;
	appendLog(`delivery waiting · ${lines} lines · ${reason}`);
	if (stuck && !fs.existsSync(STUCK_MARKER)) {
		fs.writeFileSync(STUCK_MARKER, "");
		// Never throws: the tick's failure path would restore the state from before this tick and repeat its events.
		await notify("Concierge messages stuck", reason.slice(0, 120), "request").catch((error) => appendLog(`**stuck toast failed** · ${String(error?.message ?? error).slice(0, 200)}`));
	}
	return stuck;
}
