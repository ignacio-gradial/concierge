// The PR source: Forge's event feed and PR board through `./gx forge`, which
// ask Forge only, never GitHub. Haiku reads GitHub once per finished review.
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO = path.join(os.homedir(), "v2.main");
// The built CLI, not the `gx` launcher: the launcher runs scripts/gx/prepare.mjs first, which rebuilds the CLI
// (60-105 s) after most pulls of ~/v2.main. Concierge only needs a CLI that is built, not fresh. A missing or
// half-written bundle fails the tick loudly, and the next tick retries.
const CLI = path.join(REPO, "apps/cli/bin/run.js");
const FEED_TYPES = ["feed:pull_request:review", "feed:pull_request:checks_settled", "feed:pull_request:state_changed", "feed:workflow_run:completed"];
// A cancelled run was replaced by a newer push; a skipped one wrote no review.
const NO_REVIEW = new Set(["cancelled", "skipped"]);

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
