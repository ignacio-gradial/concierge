// The PR source: Forge's event feed and PR board through `./gx forge`, which
// ask Forge only, never GitHub. Haiku reads GitHub once per finished review.
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readJson, writeJsonAtomic } from "./signals.mjs";

const run = promisify(execFile);
const REPO = path.join(os.homedir(), "v2.main");
// The built CLI, not the `gx` launcher: the launcher runs scripts/gx/prepare.mjs first, which rebuilds the CLI
// (60-105 s) after most pulls of ~/v2.main. Concierge only needs a CLI that is built, not fresh. A missing or
// half-written bundle fails the tick loudly, and the next tick retries.
const CLI = path.join(REPO, "apps/cli/bin/run.js");
const FEED_TYPES = ["feed:pull_request:review", "feed:pull_request:checks_settled", "feed:pull_request:state_changed", "feed:workflow_run:completed"];
// A cancelled run was replaced by a newer push; a skipped one wrote no review.
const NO_REVIEW = new Set(["cancelled", "skipped"]);
// Merge-queue commits name their PR only in the branch of their workflow runs, gh-readonly-queue/<base>/pr-<N>-<sha>:
// Merge Gate's checks_settled on them carries `numbers: []`. { "<merge-group sha>": { pr, branch, at } }
const MERGE_GROUPS_FILE = path.join(os.homedir(), "concierge/state/merge-groups.json");
const QUEUE_BRANCH = /^gh-readonly-queue\/[^/]+\/pr-(\d+)-/;
const MERGE_GROUP_TTL_MS = 2 * 24 * 60 * 60 * 1000;
// Ignacio's PRs the board last showed in the merge queue. { "<pr>": { since, text, missingSince? } }
const MERGE_QUEUE_FILE = path.join(os.homedir(), "concierge/state/merge-queue.json");

async function gx(args) {
	// This process's node runs the CLI, and goes first on PATH for anything it spawns: in the Monitor shell PATH can
	// resolve proto's shim, which printed a notice to stdout (2026-10-20), and the CLI's stdout is parsed line by line.
	const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` };
	try {
		const { stdout } = await run(process.execPath, [CLI, "forge", ...args], { cwd: REPO, env, timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
		return stdout;
	} catch (error) {
		if (error.code === 77) throw new Error("Forge session missing or expired: Ignacio runs `cd ~/v2.main && ./gx forge login`");
		throw new Error(`gx forge ${args[0]} exited ${error.code ?? error.signal}: ${String(error.stderr ?? error.message).trim().slice(-300)}`);
	}
}

// Replays the feed from the cursor file (or `since` on the first run) to now. gx writes the new cursor into
// `cursorFile` once it has printed the events, so the caller commits that file only after handling them.
export async function forgeEvents(cursorFile, since) {
	const args = ["events", "--cursor-file", cursorFile, "--repository", "gradial/v2", "--type", FEED_TYPES.join(",")];
	if (since) args.push("--since", since);
	return (await gx(args))
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				throw new Error(`gx forge events printed a non-JSON line: ${line.slice(0, 200)}`);
			}
		});
}

// Ignacio's open PRs on Forge's board. `all` lists only the board's 30-day window but, unlike `mine`, doesn't make
// Forge search GitHub for his older PRs every 5 minutes. A PR with new activity is always inside the window.
export async function forgeBoard() {
	const board = JSON.parse(await gx(["prs", "--scope", "all", "--json"]));
	if (board.version !== 1) throw new Error(`gx forge prs answered version ${board.version}; Concierge reads version 1`);
	if (!board.viewer?.login) throw new Error("gx forge prs answered without viewer.login: Forge has not linked Ignacio's GitHub account");
	return { ...board, pullRequests: board.pullRequests.filter((pr) => pr.author === board.viewer.login) };
}

// Remembers which of Ignacio's PRs each merge-queue commit belongs to, and how Merge Gate ended on it, for the agent
// that investigates a removal. It outlives the tick: a group's first workflow run (Approval Validity) finishes about
// 10 s after the PR is queued, and its Merge Gate settles minutes later.
export function trackMergeGroups(events, board) {
	const open = new Set(board.pullRequests.map((pr) => pr.number));
	const groups = readJson(MERGE_GROUPS_FILE, {});
	for (const event of events) {
		const pr = event.type === "feed:workflow_run:completed" ? Number(QUEUE_BRANCH.exec(event.branch ?? "")?.[1]) : NaN;
		if (open.has(pr) && !groups[event.headSha]) groups[event.headSha] = { pr, branch: event.branch, at: new Date().toISOString() };
	}
	for (const event of events) {
		if (event.type === "feed:pull_request:checks_settled" && groups[event.headSha]) {
			groups[event.headSha].gate = { conclusion: event.conclusion, url: event.url, at: event.occurredAt };
		}
	}
	for (const [sha, group] of Object.entries(groups)) if (Date.now() - Date.parse(group.at) > MERGE_GROUP_TTL_MS) delete groups[sha];
	writeJsonAtomic(MERGE_GROUPS_FILE, groups);
	return groups;
}

// A PR left the merge queue when its board row loses the `merge-queue` condition while the PR stays open. A Merge Gate
// failure on its queue commit is not enough: with PRs ahead in the group, GitHub drops the failing head of the group
// and re-tests the rest (2026-10-21: #13426 merged after one). The board has to say so on two reads in a row, so a
// merge the feed hasn't reported yet, or a blip while the queue regroups, isn't taken for a removal. Adds a
// Concierge-made event per removal to `activity`, and returns `commit` to save the queue state once the tick has
// handled them, so a failed tick finds the removals again.
export function trackMergeQueue(board, activity, groups) {
	const queued = readJson(MERGE_QUEUE_FILE, {});
	const now = new Date().toISOString();
	const rows = new Map(board.pullRequests.map((pr) => [pr.number, pr]));
	const inQueue = (pr) => pr?.conditions?.find((c) => c.kind === "merge-queue");
	const closed = new Set(activity.filter((a) => a.forge.some((e) => e.type === "feed:pull_request:state_changed" && e.state === "closed")).map((a) => a.pr));
	for (const pr of board.pullRequests) {
		const condition = inQueue(pr);
		if (condition) queued[pr.number] = { since: queued[pr.number]?.since ?? now, text: condition.text };
	}
	for (const [key, entry] of Object.entries(queued)) {
		const number = Number(key);
		const pr = rows.get(number);
		if (inQueue(pr)) continue;
		if (!pr || closed.has(number)) {
			delete queued[key];
		} else if (!entry.missingSince) {
			entry.missingSince = now;
		} else {
			const [sha, group] = Object.entries(groups).filter(([, g]) => g.pr === number).sort(([, a], [, b]) => b.at.localeCompare(a.at))[0] ?? [];
			const removal = { id: `merge-queue-removed:${number}:${entry.since}`, type: "concierge:merge_queue:removed", number, queuedSince: entry.since, lastQueueText: entry.text, missingSince: entry.missingSince, mergeGroup: sha ? { sha, ...group } : null };
			const mine = activity.find((a) => a.pr === number);
			if (mine) mine.forge.push(removal);
			else activity.push({ pr: number, title: pr.title, url: pr.url, forge: [removal] });
			delete queued[key];
		}
	}
	return { commit: () => writeJsonAtomic(MERGE_QUEUE_FILE, queued) };
}

// The feed events on Ignacio's PRs, grouped by PR, for Haiku to triage. Other workflow runs are left out:
// Merge Gate's checks_settled already says how CI ended.
export function myActivity(events, board) {
	const open = new Map(board.pullRequests.map((pr) => [pr.number, pr]));
	const byBranch = new Map(board.pullRequests.map((pr) => [pr.headBranch, pr.number]));
	const prsOf = (event) => {
		switch (event.type) {
			case "feed:pull_request:review":
				// Forge leaves `author` null on some submitted reviews (166 of 363 since 2026-10-20), approvals included;
				// the board knows which open PRs are his.
				return event.author === board.viewer.login || open.has(event.number) ? [event.number] : [];
			case "feed:pull_request:state_changed":
				return event.author === board.viewer.login ? [event.number] : [];
			case "feed:pull_request:checks_settled":
				return (event.numbers ?? []).filter((n) => open.has(n));
			case "feed:workflow_run:completed":
				if (event.name !== "Code Review" || NO_REVIEW.has(event.conclusion)) return [];
				return [...new Set([...(event.pullRequests ?? []), byBranch.get(event.branch)])].filter((n) => open.has(n));
			default:
				// The raw line says who printed it (2026-10-21: a one-off `type: message` line, source unknown).
				throw new Error(`unexpected Forge event type ${event.type}: ${JSON.stringify(event).slice(0, 300)}`);
		}
	};
	const grouped = new Map();
	for (const event of events) {
		for (const number of prsOf(event)) {
			// A closed PR has left the board; its state_changed event still carries the title and url.
			const pr = open.get(number) ?? event;
			const entry = grouped.get(number) ?? { pr: number, title: pr.title, url: pr.url, forge: [] };
			entry.forge.push(event);
			grouped.set(number, entry);
		}
	}
	return [...grouped.values()];
}
