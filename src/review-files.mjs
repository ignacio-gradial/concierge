// Reviews that agents in herdr tabs save to ~/reviews/<pr>-<sha8>-<unix time>.md become events like a Code Review's,
// so Concierge can hand their findings off to address or discuss (Ignacio, 2026-10-30). Haiku extracts the findings:
// that is triage, the one job Haiku keeps.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { haiku } from "./haiku.mjs";

const REVIEWS_DIR = path.join(os.homedir(), "reviews");
const NAME = /^(\d+)-([0-9a-f]{7,40})-(\d+)\.md$/;
// A file younger than this may still be being written.
const SETTLE_MS = 60_000;

const FINDING = {
	type: "object",
	additionalProperties: false,
	required: ["title", "anchor", "explanation"],
	properties: { title: { type: "string" }, anchor: { type: "string" }, explanation: { type: "string" } },
};
const SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["prTitle", "reviewer", "verdict", "posted", "blocking", "nonBlocking"],
	properties: {
		prTitle: { type: "string" },
		reviewer: { type: "string" },
		verdict: { type: "string" },
		posted: { type: "string" },
		blocking: { type: "array", items: FINDING },
		nonBlocking: { type: "array", items: FINDING },
	},
};

async function extract(file, pr, sha) {
	const text = fs.readFileSync(file, "utf8").slice(0, 80_000);
	const prompt = [
		`An agent saved this code review of gradial/v2 PR #${pr} at commit ${sha}. Extract it for Ignacio, without judging it.`,
		"- `prTitle`: the PR's title or name as the review gives it. `reviewer`: the model, effort and harness it names, briefly. `verdict`: one line, such as \"not ready, 8 blocking items\" or \"approved\".",
		"- `posted`: what the review says it posted on GitHub (an approval, a comment, or nothing), \"unknown\" when it doesn't say.",
		"- `blocking` and `nonBlocking`: every finding in the review's blocking and non-blocking sections, in order. Low, nit and simplification sections count as non-blocking. `title` verbatim from its heading without the number. `anchor`: its first file:line. `explanation`: about 50 words of plain English from the finding's body: what breaks, in which scenario, and the fix it suggests.",
		`Review:\n${text}`,
	].join("\n\n");
	const { structured_output: out } = await haiku(prompt, SCHEMA, { args: ["--tools", "", "--strict-mcp-config"], timeout: 180_000 });
	return out;
}

// Review files saved since `since` (ms) and settled, as events. The first run only sets the cursor.
export async function reviewFileEvents(since) {
	const now = Date.now();
	if (since === undefined) return { events: [], cursor: now };
	if (!fs.existsSync(REVIEWS_DIR)) return { events: [], cursor: now };
	const fresh = fs
		.readdirSync(REVIEWS_DIR)
		.map((name) => ({ name, match: name.match(NAME), mtime: fs.statSync(path.join(REVIEWS_DIR, name)).mtimeMs }))
		.filter((f) => f.match && f.mtime > since && f.mtime <= now - SETTLE_MS)
		.sort((a, b) => a.mtime - b.mtime);
	const events = [];
	for (const { name, match } of fresh) {
		const [, prText, sha] = match;
		const pr = Number(prText);
		const file = path.join(REVIEWS_DIR, name);
		const base = { key: `review_file:${name}`, source: "review_file", pr, url: `https://github.com/gradial/v2/pull/${pr}`, kind: "tab_review", decision: "needs_attention", feedback: [], ask: { area: "", line: "", size: "" }, commit: sha };
		try {
			const out = await extract(file, pr, sha);
			events.push({ ...base, prTitle: out.prTitle, summary: `${out.reviewer} review at ${sha}: ${out.verdict.replace(/\.+$/, "")}. Posted: ${out.posted.replace(/\.+$/, "")}. Full review: ${file}`, blocking: out.blocking, nonBlocking: out.nonBlocking });
		} catch (error) {
			events.push({ ...base, prTitle: `#${pr}`, summary: `A review was saved at ${file}, but Haiku couldn't extract it: ${String(error?.message ?? error).slice(0, 200)}`, blocking: [], nonBlocking: [] });
		}
	}
	// Up to the newest settled file; younger ones are picked up next tick.
	return { events, cursor: Math.max(since, ...fresh.map((f) => f.mtime)) };
}
