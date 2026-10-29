// One Concierge tick: this runner reads what Forge saw on Ignacio's PRs since
// the cursor, Haiku triages it (reading a finished review through the GitHub
// MCP), and the runner dedups by event key, queues and logs every event, and
// raises the herdr notification + ✗ for needs_attention.
// stdout carries only EVENT / ACTION / REPORT / ERROR / RECOVERED messages (src/monitor-lines.mjs): the Opus
// loop's Monitor turns each into a message.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { forgeBoard, forgeEvents, myActivity, trackMergeGroups, trackMergeQueue } from "./forge.mjs";
import { READY_FILE, updateReady } from "./ready.mjs";
import { ciGreen, closeWorkspace, fileReport } from "./act.mjs";
import { sendPrompt } from "./handoff.mjs";
import { haiku } from "./haiku.mjs";
import { eventMessage, message } from "./monitor-lines.mjs";

const HOME = path.join(os.homedir(), "concierge");
const QUEUE_FILE = path.join(HOME, "state/events.jsonl");
// gx advances its cursor file as soon as it prints a batch. It works on the copy, and the tick commits the copy
// only after handling the batch, so a failed tick replays it.
const FORGE_CURSOR = path.join(HOME, "state/forge.cursor");
const FORGE_CURSOR_NEXT = `${FORGE_CURSOR}.next`;
const SKILL_FILE = path.join(os.homedir(), "obsidian/concierge/skills/concierge-triage/SKILL.md");
const SEEN_LIMIT = 1000;
// Herdr's reports (bin/concierge-report), and how much of that file the Opus session has been sent.
const REPORTS_FILE = path.join(HOME, "state/reports.jsonl");
const REPORTS_OFFSET = path.join(HOME, "state/reports.offset");

const emit = (text) => process.stdout.write(text);
// Kinds whose `commit` is the reviewed head, which `concierge-act handoff --event` hands to the PR's agent.
const REVIEWED = new Set(["review_finished", "review_failed", "approved", "teammate_review"]);

async function triage(activity) {
	const areas = [...new Set(readJson(READY_FILE, []).map((e) => e.ask?.area).filter(Boolean))];
	const result = await haiku(
		`Run one Concierge tick on this Forge activity:\n${JSON.stringify(activity)}\n\nAreas already on the Ready list: ${areas.length ? areas.join("; ") : "none"}`,
		JSON.parse(fs.readFileSync(path.join(HOME, "src/event-schema.json"), "utf8")),
		// The MCP's token comes from bin/concierge-github-headers, its headersHelper.
		{ args: ["--mcp-config", path.join(HOME, ".mcp.json"), "--strict-mcp-config", "--append-system-prompt-file", SKILL_FILE, "--allowedTools=mcp__github"] },
	);
	const models = Object.keys(result.modelUsage ?? {}).join("+");
	fs.appendFileSync(path.join(HOME, "state/usage.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), session: result.session_id, cost: result.total_cost_usd, usage: result.modelUsage, speed: result.usage?.speed, tier: result.usage?.service_tier })}\n`);
	return { events: result.structured_output.events, cost: result.total_cost_usd, turns: result.num_turns, models };
}

function logEvent(event) {
	const head = `**${event.decision}** · [#${event.pr} — ${event.prTitle}](${event.url}) · ${event.summary}`;
	const blocking = event.blocking.map((b, i) => `${i + 1}. ${b.title} \`${b.anchor}\``);
	const nonBlocking = event.nonBlocking.map((b, i) => `${i + 1}. (non-blocking) ${b.title} \`${b.anchor}\``);
	const feedback = event.feedback.map((f, i) => `${i + 1}. ${f.author} \`${f.anchor}\`: ${f.explanation}`);
	appendLog([head, ...blocking, ...nonBlocking, ...feedback].join("\n"));
}

function notificationTitle(event) {
	if (event.kind === "review_finished") return `#${event.pr} review finished`;
	if (event.kind === "approved") return `#${event.pr} approved`;
	if (event.kind === "teammate_review") return `#${event.pr} teammate review`;
	if (event.kind === "dequeued") return `#${event.pr} left the merge queue`;
	if (event.kind === "merged") return `#${event.pr} merged`;
	return `#${event.pr} needs you`;
}

function notificationBody(event) {
	if (event.kind === "approved" || event.kind === "teammate_review") return `${event.feedback.length} feedback items`;
	if (event.kind !== "review_finished") return event.summary.slice(0, 120);
	return `${event.blocking.length} blocking, ${event.nonBlocking.length} non-blocking`;
}

// Haiku copies `commit` from the PR's Forge events. One that isn't among them is cleared, so a hand-off never gets a
// commit nobody reviewed.
function checkCommit(event, activity) {
	const forge = activity.find((a) => a.pr === event.pr)?.forge ?? [];
	const known = new Set(forge.flatMap((e) => [e.headSha, e.review?.commitId]).filter(Boolean));
	if (event.commit && !known.has(event.commit)) {
		appendLog(`**event commit not in Forge's events, cleared** · #${event.pr} ${event.kind} · ${event.commit} · key ${event.key}`);
		event.commit = "";
	}
	if (!event.commit && REVIEWED.has(event.kind)) appendLog(`**event without a reviewed commit** · #${event.pr} ${event.kind} · key ${event.key}`);
}

// The actions, carried out here by src/act.mjs since 2026-10-28 (Ignacio): a merged PR's herdr workspace gets closed,
// a merge-queue removal goes to the Merge Queue agent, and an approval with no feedback gets a CI agent once CI fails.
// Results reach the Opus session as REPORT lines. A failed action is reported, never retried, so a tick can't start
// the same agent twice.
async function act(event, board, activity, next) {
	try {
		if (event.kind === "merged") {
			appendLog(`action · #${event.pr} close_workspace`);
			await notify(notificationTitle(event), "closing its herdr workspace", "done");
			await closeWorkspace(event.pr, { report: true });
			return;
		}
		if (event.kind === "dequeued") {
			const removal = activity.find((a) => a.pr === event.pr)?.forge.find((e) => e.type === "concierge:merge_queue:removed");
			if (!removal) appendLog(`**dequeued event without a merge queue removal** · #${event.pr} · key ${event.key}`);
			const group = removal?.mergeGroup;
			appendLog(`action · #${event.pr} investigate_dequeue · last queue commit ${group?.sha.slice(0, 8) ?? "unknown"}, Merge Gate ${group?.gate?.conclusion ?? "unknown"}`);
			await notify(notificationTitle(event), "sending an agent to find out why", "request");
			const action = { action: "investigate_dequeue", ...event, queue: removal ? { since: removal.queuedSince, lastText: removal.lastQueueText, goneSince: removal.missingSince } : null, mergeGroup: group ?? null };
			const prompt = `Carry out this ACTION line from the Concierge loop, per concierge-merge-queue (investigate_dequeue): #${event.pr} left the merge queue.\n\nACTION ${JSON.stringify(action)}`;
			try {
				await sendPrompt({ agent: "merge-queue", prompt, what: `#${event.pr} investigate_dequeue` });
			} catch (error) {
				// The Opus session forwards it by hand.
				emit(`ACTION ${JSON.stringify(action)}\n`);
				throw error;
			}
			return;
		}
		const ci = board.pullRequests.find((pr) => pr.number === event.pr)?.ci ?? null;
		if (ci?.state === "passed") {
			appendLog(`action skipped · #${event.pr} approved with no feedback and CI already passed`);
			await notify(notificationTitle(event), "no feedback, CI already green", "done");
			return;
		}
		if (ci?.state === "failed") {
			appendLog(`action · #${event.pr} ci_green · CI failed`);
			await notify(notificationTitle(event), "no feedback, sending a CI agent (CI failed)", "done");
			await ciGreen(event.pr, { ci, report: true });
			return;
		}
		appendLog(`action · #${event.pr} ci_green · CI ${ci?.state ?? "unknown"}, watching until it passes or fails`);
		await notify(notificationTitle(event), `no feedback, watching CI (${ci?.state ?? "unknown"})`, "done");
		next.ciWatch = { ...next.ciWatch, [event.pr]: { since: new Date().toISOString(), key: event.key } };
	} catch (error) {
		fileReport(`#${event.pr} ${event.kind} action failed`, `#${event.pr}: the ${event.kind} action failed: ${String(error?.stderr || error?.message || error).trim().slice(0, 400)}`);
	}
}

// Approved PRs whose CI was still running: a CI agent once Forge's board says failed, nothing once it says passed. A
// PR gone from the board (merged, closed, or idle past its window) stops being watched.
async function watchCi(board, next) {
	for (const [number, watch] of Object.entries(next.ciWatch ?? {})) {
		const pr = Number(number);
		const ci = board.pullRequests.find((p) => p.number === pr)?.ci;
		if (ci?.state !== undefined && ci.state !== "passed" && ci.state !== "failed") continue;
		const { [number]: _, ...rest } = next.ciWatch;
		next.ciWatch = rest;
		try {
			if (!ci) appendLog(`ci watch · #${pr} left Forge's board, stopped watching (approved ${watch.since})`);
			else if (ci.state === "passed") fileReport(`#${pr} ci_green`, `#${pr}: CI passed after the approval, no CI agent needed.`);
			else await ciGreen(pr, { ci, report: true });
		} catch (error) {
			fileReport(`#${pr} ci_green failed`, `#${pr}: starting the CI agent failed: ${String(error?.stderr || error?.message || error).trim().slice(0, 400)}`);
		}
	}
}

// Before Forge and Haiku, so action and agent reports reach Ignacio even while ticks fail.
function relayReports() {
	if (!fs.existsSync(REPORTS_FILE)) return;
	const reports = fs.readFileSync(REPORTS_FILE, "utf8");
	const offset = Number(fs.existsSync(REPORTS_OFFSET) ? fs.readFileSync(REPORTS_OFFSET, "utf8") : 0);
	for (const line of reports.slice(offset).split("\n").filter(Boolean)) {
		const report = JSON.parse(line);
		emit(message("REPORT", report.what, report.message.split("\n").filter((l) => l.trim()).map((l) => `  ${l}`)));
	}
	fs.writeFileSync(REPORTS_OFFSET, String(reports.length));
}

async function main() {
	herdrWorkspace();
	relayReports();
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
		const groups = trackMergeGroups(feed, board);
		const activity = myActivity(feed, board);
		const mergeQueue = trackMergeQueue(board, activity, groups);
		const { events, cost, turns, models } = activity.length ? await triage(activity) : { events: [], cost: 0, turns: 0, models: "no triage" };
		const seen = new Set(state.seen);
		const fresh = events.filter((e) => !seen.has(e.key));
		const next = { ...state, cursor: started.toISOString(), failing: undefined };
		// Before any notification: if this fails, the next tick retries these events without re-notifying.
		await updateReady(fresh, board, activity);
		for (const event of fresh) {
			checkCommit(event, activity);
			fs.appendFileSync(QUEUE_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
			logEvent(event);
			if (event.decision === "needs_attention") {
				const sound = event.blocking.length || event.feedback.length ? "request" : "done";
				await notify(notificationTitle(event), notificationBody(event), sound);
				next.lastAttentionAt = new Date().toISOString();
				emit(eventMessage(event));
			} else if (event.decision === "needs_action") {
				await act(event, board, activity, next);
			}
		}
		await watchCi(board, next);
		next.seen = [...state.seen, ...fresh.map((e) => e.key)].slice(-SEEN_LIMIT);
		if (state.failing) {
			appendLog("recovered · tick succeeded again");
			emit(message("RECOVERED", "tick succeeded again"));
		}
		if (fs.existsSync(FORGE_CURSOR_NEXT)) fs.renameSync(FORGE_CURSOR_NEXT, FORGE_CURSOR);
		mergeQueue.commit();
		writeJsonAtomic(STATE_FILE, next);
		await setAlert(alertActive(next, readJson(ACK_FILE, {})));
		const seconds = ((Date.now() - started.getTime()) / 1000).toFixed(1);
		appendLog(`tick · forge ${feed.length} events, ${activity.length} PRs of mine · ${events.length} events (${fresh.length} new) · ${turns} turns · ${models} · $${cost.toFixed(4)} · ${seconds}s`);
	} catch (error) {
		const detail = String(error?.stderr || error?.message || error).trim().slice(0, 500);
		appendLog(`**tick failed** · ${detail}`);
		// Loud once per outage; the cursor stays put so the next success covers the gap.
		if (!state.failing) {
			writeJsonAtomic(STATE_FILE, { ...state, failing: true, lastAttentionAt: new Date().toISOString() });
			emit(message("ERROR", detail));
			await notify("Concierge error", detail.slice(0, 120), "request");
			await setAlert(true);
		}
	}
	await heartbeat();
}

await main();
