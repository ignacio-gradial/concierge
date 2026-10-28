// The Ready list: open PRs whose latest Code Review has no Blocking findings, so Ignacio can ask for review now.
// GitHub's review requests don't count: CODEOWNERS adds team requests on its own (Ignacio, 2026-10-22).
// Shown as ✓N in the sidebar and listed in the Concierge Bot "Ready" tab.
import os from "node:os";
import path from "node:path";
import { appendLog, pacific, readJson, setReady, writeJsonAtomic } from "./signals.mjs";

export const READY_FILE = path.join(os.homedir(), "concierge/state/ready.json");
// Who approved each PR, from the feed's review events: the board has no review state. { "<pr>": { "<login>": { at, commit } } }
export const APPROVALS_FILE = path.join(os.homedir(), "concierge/state/approvals.json");
// Ignacio's cap on each PR's line in the Ready tab (20 words on 2026-10-21, 7 on 2026-10-27). Haiku writes to it; going over is logged, not cut.
const ASK_WORDS = 7;

// Keeps each reviewer's latest stance, as GitHub does: an approval adds them, their later changes-requested review or
// a dismissal removes them, and a close drops the PR.
export function updateApprovals(activity) {
	const approvals = readJson(APPROVALS_FILE, {});
	for (const { pr, forge } of activity) {
		for (const e of forge) {
			if (e.type === "feed:pull_request:state_changed" && e.state === "closed") delete approvals[pr];
			if (e.type !== "feed:pull_request:review" || !e.review || e.review.authorLogin?.endsWith("[bot]")) continue;
			const by = e.review.authorLogin;
			if (e.action === "submitted" && e.review.state === "approved") {
				approvals[pr] = { ...approvals[pr], [by]: { at: e.receivedAt, commit: e.review.commitId } };
			} else if ((e.action === "submitted" && e.review.state === "changes_requested") || e.action === "dismissed") {
				if (approvals[pr]) delete approvals[pr][by];
				if (approvals[pr] && !Object.keys(approvals[pr]).length) delete approvals[pr];
			}
		}
	}
	writeJsonAtomic(APPROVALS_FILE, approvals);
	return approvals;
}

// Why a PR no longer belongs on the list, or undefined if it still does. `pr` is its row on Forge's board, and
// `change` the last open/close Forge's feed saw for it this tick.
function leaveReason(entry, pr, change) {
	if (change?.state === "closed") return change.merged ? "merged" : "closed";
	// The board lists only PRs updated in its 30-day window, so a missing PR may just be idle: closes come from the feed.
	if (!pr) return undefined;
	if (pr.headSha !== entry.head) return "new push";
	return undefined;
}

// Applies this tick's review events, then drops PRs that left the clean state. `board` and `activity` come from
// forge.mjs: Ignacio's PRs on Forge's board, and this tick's feed events on them.
export async function updateReady(events, board, activity) {
	const ready = new Map(readJson(READY_FILE, []).map((e) => [e.pr, e]));
	const open = new Map(board.pullRequests.map((pr) => [pr.number, pr]));
	const approvals = updateApprovals(activity);
	// Feed order, so a later reopen wins over a close.
	const changes = new Map(activity.flatMap(({ pr, forge }) => forge.filter((e) => e.type === "feed:pull_request:state_changed").map((e) => [pr, e])));
	for (const event of events) {
		if (event.kind === "review_finished" && event.blocking.length === 0) {
			const pr = open.get(event.pr);
			if (!pr) {
				appendLog(`ready · #${event.pr} clean review, but not on Forge's board (closed?), not listed`);
				continue;
			}
			// The head is the board's now, not the review's: a push in the gap is caught when its own review finishes.
			if (!ready.has(event.pr)) appendLog(`ready + #${event.pr} · clean review`);
			if (!event.ask?.line) appendLog(`ready · #${event.pr} clean review without an ask line from Haiku, listed by title`);
			const words = event.ask?.line.split(/\s+/).filter(Boolean).length ?? 0;
			if (words > ASK_WORDS) appendLog(`**ready · #${event.pr} ask line has ${words} words, over the ${ASK_WORDS}-word cap**`);
			ready.set(event.pr, { pr: event.pr, title: event.prTitle, url: event.url.replace(/#.*$/, ""), nonBlocking: event.nonBlocking.length, cleanAt: event.key.split(":review:")[1], head: pr.headSha, ask: event.ask });
		} else if ((event.kind === "review_finished" || event.kind === "review_failed") && ready.delete(event.pr)) {
			appendLog(`ready − #${event.pr} · ${event.kind === "review_failed" ? "review failed" : "blocking findings"}`);
		}
	}
	for (const entry of ready.values()) {
		const pr = open.get(entry.pr);
		const reason = leaveReason(entry, pr, changes.get(entry.pr));
		if (reason) {
			ready.delete(entry.pr);
			appendLog(`ready − #${entry.pr} · ${reason}`);
		} else if (pr) {
			entry.isDraft = pr.isDraft;
			entry.stackedOn = pr.stackedOn;
		}
		entry.approvedBy = Object.keys(approvals[entry.pr] ?? {});
	}
	const list = [...ready.values()];
	writeJsonAtomic(READY_FILE, list);
	await setReady(shownReady(list).length);
}

// A clean PR stacked on one that isn't on the list is held back (Ignacio, 2026-10-22), also down a chain of stacked
// PRs. It stays in ready.json, so it shows again as soon as its parent is ready.
function shownReady(list) {
	let shown = list;
	for (;;) {
		const listed = new Set(shown.map((e) => e.pr));
		const next = shown.filter((e) => !e.stackedOn || listed.has(e.stackedOn));
		if (next.length === shown.length) return shown;
		shown = next;
	}
}

// Stef's review-ask style, so everything under the first line pastes into Slack as is: an area line, then one line
// per PR saying what it changes and why, its size, and its link. Haiku writes `ask` when the review comes back clean.
export function renderReady(all = readJson(READY_FILE, [])) {
	const now = pacific();
	const list = shownReady(all);
	const held = all.filter((e) => !list.includes(e)).map((e) => `#${e.pr} on #${e.stackedOn}`);
	const lines = [`Ready for review · ${list.length}${held.length ? ` · held back, stacked on a PR that isn't ready: ${held.join(", ")}` : ""} · updated ${now.time} PT`, ""];
	if (!list.length) lines.push("Nothing to ask review for.");
	const areas = new Map();
	for (const e of list) {
		const area = e.ask?.line ? e.ask.area : "no ask line from haiku";
		areas.set(area, [...(areas.get(area) ?? []), e]);
	}
	for (const [area, entries] of areas) {
		lines.push(area, "");
		for (const e of entries) {
			const notes = [e.ask?.size, e.stackedOn && `stacked on #${e.stackedOn}`, e.isDraft && "draft", e.approvedBy?.length && `approved by ${e.approvedBy.join(", ")}`].filter(Boolean);
			lines.push(`- ${e.approvedBy?.length ? "✅ " : ""}${e.ask?.line || e.title}${notes.length ? ` (${notes.join(", ")})` : ""} ${e.url}`);
		}
		lines.push("", "");
	}
	return lines.join("\n").trimEnd();
}
