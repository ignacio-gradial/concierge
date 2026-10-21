// The Ready list: open PRs whose latest Code Review has no Blocking findings
// and that have no review request yet, so Ignacio can ask for review now.
// Shown as ✓N in the sidebar and listed in the Concierge Bot "Ready" tab.
import os from "node:os";
import path from "node:path";
import { appendLog, pacific, readJson, setReady, writeJsonAtomic } from "./signals.mjs";

export const READY_FILE = path.join(os.homedir(), "concierge/state/ready.json");
// Who approved each PR, from the feed's review events: the board has no review state. { "<pr>": { "<login>": { at, commit } } }
export const APPROVALS_FILE = path.join(os.homedir(), "concierge/state/approvals.json");

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
	if (pr.reviewRequests.length) return "review requested";
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
			ready.set(event.pr, { pr: event.pr, title: event.prTitle, url: event.url.replace(/#.*$/, ""), nonBlocking: event.nonBlocking, cleanAt: event.key.split(":review:")[1], head: pr.headSha });
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
		}
		entry.approvedBy = Object.keys(approvals[entry.pr] ?? {});
	}
	const list = [...ready.values()];
	writeJsonAtomic(READY_FILE, list);
	await setReady(list.length);
}

export function renderReady(list = readJson(READY_FILE, [])) {
	const now = pacific();
	const lines = [`Ready for review · ${list.length} · updated ${now.time} PT`, ""];
	if (!list.length) lines.push("Nothing to ask review for.");
	for (const e of list) {
		const at = pacific(new Date(e.cleanAt));
		const when = at.day === now.day ? at.time.slice(0, 5) : `${at.day} ${at.time.slice(0, 5)}`;
		const approved = e.approvedBy?.length ? ` · approved by ${e.approvedBy.join(", ")}` : "";
		lines.push(`#${e.pr}  ${e.approvedBy?.length ? "✅ " : ""}${e.title}`, `        clean since ${when} PT · ${e.nonBlocking} non-blocking${e.isDraft ? " · draft" : ""}${approved}`, `        ${e.url}`, "");
	}
	return lines.join("\n");
}
