// One Concierge tick: this runner reads what Forge saw on Ignacio's PRs since
// the cursor, Haiku triages it (reading a finished review through the GitHub
// MCP), and the runner dedups by event key, queues and logs every event, and
// raises the herdr notification + ✗ for needs_attention.
// stdout carries only EVENT / ERROR lines: the Opus loop's Monitor turns each
// into a message.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
	ACK_FILE,
	alertActive,
	appendLog,
	heartbeat,
	herdrWorkspace,
	notify,
	readJson,
	setAlert,
	STATE_FILE,
	writeJsonAtomic,
} from "./signals.mjs";
import { forgeBoard, forgeEvents, myActivity } from "./forge.mjs";
import { updateReady } from "./ready.mjs";

const run = promisify(execFile);
const HOME = path.join(os.homedir(), "concierge");
const QUEUE_FILE = path.join(HOME, "state/events.jsonl");
// gx advances its cursor file as soon as it prints a batch. It works on the copy, and the tick commits the copy
// only after handling the batch, so a failed tick replays it.
const FORGE_CURSOR = path.join(HOME, "state/forge.cursor");
const FORGE_CURSOR_NEXT = `${FORGE_CURSOR}.next`;
const SKILL_FILE = path.join(os.homedir(), "obsidian/concierge/skills/concierge-triage/SKILL.md");
const MODEL = "claude-haiku-5-5";
// Absolute path: the Monitor shell can resolve /opt/homebrew/bin/claude (2.1.220), which predates
// Haiku 5.5 and runs it with fallback limits and prices (200k context, ~40x reported cost).
const CLAUDE = path.join(os.homedir(), ".local/bin/claude");
const HAIKU_CWD = path.join(os.tmpdir(), "concierge-haiku");
const SEEN_LIMIT = 1000;

const emit = (kind, payload) => process.stdout.write(`${kind} ${JSON.stringify(payload)}\n`);

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

async function triage(activity) {
	const stdout = await claudeJson(
		[
			"-p",
			`Run one Concierge tick on this Forge activity:\n${JSON.stringify(activity)}`,
			"--model",
			MODEL,
			"--mcp-config",
			path.join(HOME, ".mcp.json"),
			"--strict-mcp-config",
			"--append-system-prompt-file",
			SKILL_FILE,
			"--json-schema",
			fs.readFileSync(path.join(HOME, "src/event-schema.json"), "utf8"),
			"--output-format",
			"json",
			"--allowedTools=mcp__github",
		],
		// A cwd outside ~/concierge keeps Haiku from loading this project's hooks, CLAUDE.md and skills.
		{ cwd: HAIKU_CWD, timeout: 240_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GITHUB_PAT: await githubToken() } },
	);
	const result = JSON.parse(stdout);
	if (result.is_error || !result.structured_output) {
		throw new Error(`Haiku tick failed: ${result.subtype ?? ""} ${String(result.result ?? stdout).slice(0, 300)}`);
	}
	const models = Object.keys(result.modelUsage ?? {}).join("+");
	fs.appendFileSync(path.join(HOME, "state/usage.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), session: result.session_id, cost: result.total_cost_usd, usage: result.modelUsage, speed: result.usage?.speed, tier: result.usage?.service_tier })}\n`);
	return { events: result.structured_output.events, cost: result.total_cost_usd, turns: result.num_turns, models };
}

async function githubToken() {
	const { stdout } = await run("gh", ["auth", "token"], { timeout: 10_000 });
	return stdout.trim();
}

function logEvent(event) {
	const head = `**${event.decision}** · [#${event.pr} — ${event.prTitle}](${event.url}) · ${event.summary}`;
	const blocking = event.blocking.map((b, i) => `${i + 1}. ${b.title} \`${b.anchor}\``);
	const feedback = event.feedback.map((f, i) => `${i + 1}. ${f.author} \`${f.anchor}\`: ${f.explanation}`);
	appendLog([head, ...blocking, ...feedback].join("\n"));
}

function notificationTitle(event) {
	if (event.kind === "review_finished") return `#${event.pr} review finished`;
	if (event.kind === "approved") return `#${event.pr} approved`;
	return `#${event.pr} needs you`;
}

function notificationBody(event) {
	if (event.kind === "approved") return `${event.feedback.length} feedback items`;
	if (event.kind !== "review_finished") return event.summary.slice(0, 120);
	return `${event.blocking.length} blocking, ${event.nonBlocking} non-blocking`;
}

// The only action: an approval with no feedback gets an agent to make the PR's CI green, unless it already is.
// The Opus session dispatches the agent on the ACTION line; the runner only decides whether one is needed.
async function act(event, board) {
	const ci = board.pullRequests.find((pr) => pr.number === event.pr)?.ci ?? null;
	if (ci?.state === "passed") {
		appendLog(`action skipped · #${event.pr} approved with no feedback and CI already passed`);
		await notify(notificationTitle(event), "no feedback, CI already green", "done");
		return;
	}
	appendLog(`action · #${event.pr} ci_green · CI ${ci?.state ?? "unknown"}`);
	await notify(notificationTitle(event), `no feedback, sending a CI agent (CI ${ci?.state ?? "unknown"})`, "done");
	emit("ACTION", { action: "ci_green", ...event, ci });
}

async function main() {
	herdrWorkspace();
	const started = new Date();
	const state = readJson(STATE_FILE, undefined);
	if (!state) {
		// First run: start the cursor now so history does not flood the queue.
		writeJsonAtomic(STATE_FILE, { cursor: started.toISOString(), seen: [] });
		appendLog(`bootstrap · cursor set to ${started.toISOString()}`);
		await heartbeat();
		return;
	}
	try {
		fs.rmSync(FORGE_CURSOR_NEXT, { force: true });
		// The first Forge tick resumes from the GitHub-search cursor (an ISO time) instead of a Forge cursor.
		const resumed = fs.existsSync(FORGE_CURSOR);
		if (resumed) fs.copyFileSync(FORGE_CURSOR, FORGE_CURSOR_NEXT);
		const feed = await forgeEvents(FORGE_CURSOR_NEXT, resumed ? undefined : state.cursor);
		// After the feed, so the board is at least as new as the events.
		const board = await forgeBoard();
		const activity = myActivity(feed, board);
		fs.mkdirSync(HAIKU_CWD, { recursive: true });
		const { events, cost, turns, models } = activity.length ? await triage(activity) : { events: [], cost: 0, turns: 0, models: "no triage" };
		const seen = new Set(state.seen);
		const fresh = events.filter((e) => !seen.has(e.key));
		const next = { ...state, cursor: started.toISOString(), failing: undefined };
		// Before any notification: if this fails, the next tick retries these events without re-notifying.
		await updateReady(fresh, board, activity);
		for (const event of fresh) {
			fs.appendFileSync(QUEUE_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
			logEvent(event);
			if (event.decision === "needs_attention") {
				const sound = event.blocking.length || event.feedback.length ? "request" : "done";
				await notify(notificationTitle(event), notificationBody(event), sound);
				next.lastAttentionAt = new Date().toISOString();
				emit("EVENT", event);
			} else if (event.decision === "needs_action") {
				await act(event, board);
			}
		}
		next.seen = [...state.seen, ...fresh.map((e) => e.key)].slice(-SEEN_LIMIT);
		if (state.failing) {
			appendLog("recovered · tick succeeded again");
			emit("RECOVERED", { message: "tick succeeded again" });
		}
		if (fs.existsSync(FORGE_CURSOR_NEXT)) fs.renameSync(FORGE_CURSOR_NEXT, FORGE_CURSOR);
		writeJsonAtomic(STATE_FILE, next);
		await setAlert(alertActive(next, readJson(ACK_FILE, {})));
		const seconds = ((Date.now() - started.getTime()) / 1000).toFixed(1);
		appendLog(`tick · forge ${feed.length} events, ${activity.length} PRs of mine · ${events.length} events (${fresh.length} new) · ${turns} turns · ${models} · $${cost.toFixed(4)} · ${seconds}s`);
	} catch (error) {
		const message = String(error?.stderr || error?.message || error).trim().slice(0, 500);
		appendLog(`**tick failed** · ${message}`);
		// Loud once per outage; the cursor stays put so the next success covers the gap.
		if (!state.failing) {
			writeJsonAtomic(STATE_FILE, { ...state, failing: true, lastAttentionAt: new Date().toISOString() });
			emit("ERROR", { message });
			await notify("Concierge error", message.slice(0, 120), "request");
			await setAlert(true);
		}
	}
	await heartbeat();
}

await main();
