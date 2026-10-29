// Concierge's herdr actions as deterministic commands. They replaced the Herdr agent on 2026-10-28, so the same
// inputs always do the same thing (Ignacio). The tick runs close-workspace, ci-green and the merge-queue hand-off on
// its own; the Opus session runs handoff and close-tab when Ignacio asks.
//   concierge-act close-workspace <pr>
//   concierge-act ci-green <pr>
//   concierge-act handoff <pr> address|discuss [<reviewed-sha>] (--event <key> [--non-blocking] | --file <path>) [--also <text>] [--label <workspace name>] [--new] [--wait-minutes N]
//   concierge-act close-tab <tab-id>
//   concierge-act find-agent <pr>
// Each prints one result line and logs it. With --report, the result also goes to state/reports.jsonl, so the next
// tick relays it as a REPORT line.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { sendPrompt } from "./handoff.mjs";
import { haiku } from "./haiku.mjs";
import { appendLog } from "./signals.mjs";

const run = promisify(execFile);
const HOME = os.homedir();
const REPO = path.join(HOME, "v2.main");
const SESSIONS_DIR = path.join(HOME, ".config/herdr/sessions");
const REPORTS_FILE = path.join(HOME, "concierge/state/reports.jsonl");
const EVENTS_FILE = path.join(HOME, "concierge/state/events.jsonl");
const CONCIERGE_SOCKET = process.env.HERDR_SOCKET_PATH;
const CONCIERGE_WORKSPACE = process.env.HERDR_WORKSPACE_ID;
const IDLE = new Set(["idle", "done"]);

async function herdr(socket, args, timeout = 30_000) {
	const { stdout } = await run("herdr", args, { timeout, env: { ...process.env, HERDR_SOCKET_PATH: socket } });
	return JSON.parse(stdout).result;
}

async function gh(args) {
	const { stdout } = await run("gh", [...args, "--repo", "gradial/v2"], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
	return JSON.parse(stdout);
}

// Running herdr sessions, Concierge's first. A session directory whose server is down answers nothing and is skipped.
async function sessions() {
	const found = [];
	for (const name of fs.readdirSync(SESSIONS_DIR)) {
		const socket = path.join(SESSIONS_DIR, name, "herdr.sock");
		if (!fs.existsSync(socket)) continue;
		try {
			await herdr(socket, ["workspace", "list"], 5_000);
			found.push({ session: name, socket });
		} catch {}
	}
	return found.sort((a, b) => (b.socket === CONCIERGE_SOCKET) - (a.socket === CONCIERGE_SOCKET));
}

async function allAgents() {
	const agents = [];
	for (const { session, socket } of await sessions()) {
		for (const agent of (await herdr(socket, ["agent", "list"])).agents) agents.push({ ...agent, session, socket });
	}
	return agents;
}

// PR descriptions end with the authoring sessions, as "Claude Code session `2a3a2f35-…`" or "Session: 01a15fe9-…",
// sometimes shortened. A Claude agent's session value is the UUID, an omp agent's is a path that contains it.
export function signatures(body) {
	const ids = new Set();
	for (const line of (body ?? "").split("\n")) {
		if (!/session/i.test(line)) continue;
		for (const match of line.matchAll(/\b[0-9a-f]{8}(?![0-9a-f])(?:-[0-9a-f]{4,12})*/gi)) ids.add(match[0].toLowerCase());
	}
	return [...ids];
}

const signs = (agent, ids) => ids.some((id) => String(agent.agent_session?.value ?? "").toLowerCase().includes(id));
const where = (agent) => `"${agent.workspace}" / tab ${agent.tab} (${agent.name ?? agent.pane_id}, ${agent.session}, ${agent.agent_status})`;

async function prInfo(pr) {
	return gh(["pr", "view", String(pr), "--json", "number,title,body,headRefName,baseRefName,headRefOid,state,url"]);
}

// Every running agent with where it sits and what its tab shows, minus Concierge's own: its workspace and the
// sessions working in ~/concierge*.
async function candidates() {
	const found = [];
	for (const { session, socket } of await sessions()) {
		const [{ agents }, { workspaces }, { tabs }, { panes }] = await Promise.all(["agent", "workspace", "tab", "pane"].map((kind) => herdr(socket, [kind, "list"])));
		for (const agent of agents) {
			if ((socket === CONCIERGE_SOCKET && agent.workspace_id === CONCIERGE_WORKSPACE) || (agent.cwd ?? "").startsWith(path.join(HOME, "concierge"))) continue;
			const { stdout } = await run("herdr", ["pane", "read", agent.pane_id, "--source", "recent", "--lines", "60"], { timeout: 10_000, env: { ...process.env, HERDR_SOCKET_PATH: socket } });
			found.push({
				...agent,
				session,
				socket,
				id: `${session}/${agent.pane_id}`,
				workspace: workspaces.find((w) => w.workspace_id === agent.workspace_id)?.label,
				tab: tabs.find((t) => t.tab_id === agent.tab_id)?.label,
				title: panes.find((p) => p.pane_id === agent.pane_id)?.terminal_title_stripped ?? "",
				screen: stdout.split("\n").filter((l) => l.trim()).slice(-30).map((l) => l.slice(0, 200)).join("\n"),
			});
		}
	}
	return found;
}

// The PR's agent is the one whose tab works on the PR, read from where it sits and what its tab shows, not from the
// session that signed the PR: sessions end and their work moves to other tabs (Ignacio, 2026-10-28). Haiku picks it.
// `openPrs` are Ignacio's other open PRs, for close-workspace to learn which of them the chosen workspace also serves.
export async function prAgent(info, { openPrs = [] } = {}) {
	const ids = signatures(info.body);
	const found = await candidates();
	if (!found.length) return { agent: null, reason: "no agent runs in any herdr session", alsoServes: [] };
	const shown = found.map((a) => ({ id: a.id, workspace: a.workspace, tab: a.tab, title: a.title, agent: a.agent_session?.agent, status: a.agent_status, signsPr: signs(a, ids), screen: a.screen }));
	const prompt = [
		`Which herdr pane's agent is working on gradial/v2 PR #${info.number} "${info.title}"? Its branch is ${info.headRefName}, based on ${info.baseRefName}.`,
		"A pane is the PR's when its terminal title, tab or workspace label, or recent screen shows it working on this PR: its number, its branch or worktree, or this PR's change. Concierge hands that agent the PR's review feedback or CI fixes, so among several prefer the one that writes the PR's code over one that only reviews or explains it.",
		"Not the PR's: a pane that only mentions the PR while working on something else, or one working on another PR in the same area, including the PR this one is stacked on. Name the closest such pane in `reason`.",
		"`signsPr` means the agent's session id is in the PR description, so it wrote the PR at some point. It is a hint; the pane's current work decides.",
		"Answer `pane` with one candidate's `id`, or none when no pane is the PR's. `reason` is one sentence of evidence from the candidates. `alsoServes` lists the numbers from Other open PRs that any pane in the chosen pane's workspace works on, [] when none or when `pane` is none.",
		`Candidates:\n${JSON.stringify(shown)}`,
		`Other open PRs: ${openPrs.length ? JSON.stringify(openPrs.map((p) => ({ number: p.number, title: p.title, branch: p.headRefName }))) : "none"}`,
	].join("\n\n");
	const schema = {
		type: "object",
		additionalProperties: false,
		required: ["pane", "reason", "alsoServes"],
		properties: { pane: { enum: [...found.map((a) => a.id), "none"] }, reason: { type: "string" }, alsoServes: { type: "array", items: { type: "integer" } } },
	};
	const { structured_output: pick } = await haiku(prompt, schema, { args: ["--tools", "", "--strict-mcp-config"], timeout: 120_000 });
	if (pick.pane === "none") return { agent: null, reason: pick.reason, alsoServes: [] };
	const agent = found.find((a) => a.id === pick.pane);
	if (!agent) throw new Error(`Haiku picked ${pick.pane}, which is not a running agent: ${pick.reason}`);
	return { agent, reason: pick.reason, alsoServes: pick.alsoServes.filter((n) => openPrs.some((p) => p.number === n)) };
}

export const fileReport = (what, message) => result(what, message, true);

function result(what, message, report) {
	appendLog(`act · ${what} · ${message.split("\n")[0].slice(0, 300)}`);
	if (report) fs.appendFileSync(REPORTS_FILE, `${JSON.stringify({ at: new Date().toISOString(), what, message })}\n`);
	return message;
}

// A merged PR's workspace closes only when every agent in it is idle and it works on no other open PR of Ignacio's;
// one workspace often serves a stack. Agent sessions and worktrees stay on disk.
export async function closeWorkspace(pr, { report = false } = {}) {
	const what = `#${pr} close_workspace`;
	const info = await prInfo(pr);
	const open = (await gh(["pr", "list", "--author", "ignacio-gradial", "--state", "open", "--limit", "200", "--json", "number,title,headRefName,body"])).filter((p) => p.number !== pr);
	const { agent, reason, alsoServes } = await prAgent(info, { openPrs: open });
	if (!agent) return result(what, `#${pr} ${info.title}: no running agent works on it (${reason}). Closed nothing.`, report);
	const members = (await allAgents()).filter((a) => a.socket === agent.socket && a.workspace_id === agent.workspace_id);
	const label = `"${agent.workspace}" (${agent.workspace_id}, ${agent.session})`;
	const busy = members.filter((a) => !IDLE.has(a.agent_status));
	// Signatures still count here: a workspace stays open when its agents signed another open PR.
	const signed = open.filter((p) => members.some((a) => signs(a, signatures(p.body)))).map((p) => p.number);
	const stillUsed = [...new Set([...alsoServes, ...signed])].map((n) => `#${n}`);
	let line;
	if (busy.length) line = `Left ${label} open: ${busy.map((a) => a.name ?? a.pane_id).join(", ")} still working.`;
	else if (stillUsed.length) line = `Left ${label} open: it also works on open ${stillUsed.join(", ")}.`;
	else {
		await herdr(agent.socket, ["workspace", "close", agent.workspace_id]);
		line = `Closed ${label}: ${members.length} idle agent${members.length === 1 ? "" : "s"}, no other open PR.`;
	}
	return result(what, `#${pr} ${info.title} merged. Its agent: ${where(agent)}, because ${reason} ${line} Agent sessions and worktrees stay on disk.`, report);
}

// An approval with no feedback while CI is failing: a new Claude agent in the PR's workspace, or in a new workspace
// when no running agent works on the PR, makes CI green.
export async function ciGreen(pr, { ci = null, report = false } = {}) {
	const what = `#${pr} ci_green`;
	const info = await prInfo(pr);
	const { agent } = await prAgent(info);
	const name = `ci-${pr}`;
	let socket = CONCIERGE_SOCKET;
	let pane;
	if (agent) {
		socket = agent.socket;
		pane = (await herdr(socket, ["tab", "create", "--workspace", agent.workspace_id, "--cwd", REPO, "--label", `CI #${pr}`, "--no-focus"])).root_pane.pane_id;
	} else {
		pane = (await herdr(socket, ["workspace", "create", "--cwd", REPO, "--label", `#${pr} CI`, "--no-focus"])).root_pane.pane_id;
	}
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	await herdr(socket, ["agent", "start", name, "--kind", "claude", "--pane", pane, "--timeout", "60000"], 90_000);
	const prompt = [
		`Make CI green for PR #${pr} (${info.url}), "${info.title}", branch ${info.headRefName}, head ${info.headRefOid.slice(0, 8)}. It was approved with no feedback. Use the pr-creation skill.`,
		ci?.failedLanes?.length ? `Failed lanes on Forge's board: ${ci.failedLanes.join(", ")}.` : "",
		ci?.forgeRunUrl ? `Forge run: ${ci.forgeRunUrl}` : "",
		`Work in the PR's worktree if \`git -C ~/v2.main worktree list\` shows one on ${info.headRefName} and it is clean; otherwise make your own worktree. ~/v2.main stays on main.`,
		"Change nothing beyond what CI needs. Push new commits only: no amend, no --no-verify. Add a PR comment for each iteration.",
		"If a failure is unrelated to the PR (a flake, infra, or main being broken), stop and report it instead of working around it.",
	].filter(Boolean).join("\n\n");
	const line = await sendPrompt({ agent: pane, prompt, what: `#${pr} CI agent`, socket });
	return result(what, `#${pr} ${info.title}: started CI agent ${name}. ${line.replace(/^handoff · /, "")}`, report);
}

// The items and the reviewed commit of the event with `key` in the queue.
function fromEvent(key, nonBlocking) {
	const line = fs.readFileSync(EVENTS_FILE, "utf8").split("\n").filter((l) => l.includes(`"key":"${key}"`)).at(-1);
	if (!line) throw new Error(`no event with key ${key} in ${EVENTS_FILE}`);
	const event = JSON.parse(line);
	const items = [
		...event.blocking.map((f) => `Blocking: "${f.title}" at ${f.anchor}\n${f.explanation}`),
		...(nonBlocking ? event.nonBlocking.map((f) => `Non-blocking: "${f.title}" at ${f.anchor}\n${f.explanation}`) : []),
		...event.feedback.map((f) => `${f.author}, ${f.anchor}\n${f.explanation}`),
	];
	if (!items.length) throw new Error(`event ${key} has no items to hand off`);
	return { findings: items.map((item, i) => `${i + 1}. ${item}`).join("\n\n"), commit: event.commit };
}

async function prWorktree(branch) {
	const { stdout } = await run("git", ["-C", REPO, "worktree", "list", "--porcelain"], { timeout: 30_000 });
	const entry = stdout.split("\n\n").find((block) => block.includes(`branch refs/heads/${branch}\n`) || block.endsWith(`branch refs/heads/${branch}`));
	if (!entry) return null;
	const dir = entry.match(/^worktree (.+)$/m)[1];
	const head = entry.match(/^HEAD (\w+)$/m)[1];
	const dirty = (await run("git", ["-C", dir, "status", "--porcelain"], { timeout: 30_000 })).stdout.trim() !== "";
	return { dir, head, dirty };
}

const TEMPLATES = {
	address: [
		"With the pr-creation skill, write a test that fails without the fix, fix it, and show the test passing.",
		"Push new commits only: no amend, no --no-verify.",
		"Add a PR comment for this iteration. For a teammate's comment, also reply on their thread with what changed and in which commit.",
		"If an item is wrong, stop and report why with evidence.",
		"Name any PR stacked on this branch that will need restacking.",
	],
	discuss: [
		"Ignacio will ask you questions about these items in this tab before deciding what to fix.",
		"For each item, say whether it holds and what fixing it would take, with file:line evidence, then wait for his questions.",
		"Change no code, push nothing and post nothing on GitHub until Ignacio asks in this tab.",
	],
};

// Hands PR feedback to the PR's own agent, or to a new agent in a new workspace named --label when none works on the
// PR. It sends nothing when the PR's worktree is ahead of or diverged from the reviewed head
// or has uncommitted changes, or when the agent stays busy past the wait, and says why.
// --dry-run prints the chosen agent and the prompt and sends nothing.
export async function handoff(pr, kind, reviewedSha, { findings, also, label, fresh: forceNew = false, waitMinutes = 20, report = false, dryRun = false }) {
	const what = `#${pr} ${kind} hand-off`;
	if (!TEMPLATES[kind]) throw new Error(`kind must be address or discuss, not ${kind}`);
	const info = await prInfo(pr);
	// --new skips the search, for when Ignacio wants a fresh agent rather than the one Haiku would pick.
	const { agent, reason } = forceNew ? { agent: null, reason: "Ignacio asked for a new agent" } : await prAgent(info);
	const worktree = await prWorktree(info.headRefName);
	// A worktree behind the reviewed head is fine (a bot or another session pushed, such as gradial-gitops restamping a
	// migration on 2026-10-28); one ahead of it or diverged may already address the feedback.
	let behind = false;
	if (worktree && !worktree.head.startsWith(reviewedSha)) {
		await run("git", ["-C", worktree.dir, "fetch", "--quiet", "origin", info.headRefName], { timeout: 120_000 });
		behind = await run("git", ["-C", worktree.dir, "merge-base", "--is-ancestor", worktree.head, reviewedSha], { timeout: 30_000 }).then(() => true, () => false);
		if (!behind) return result(what, `#${pr} ${info.title}: sent nothing, its worktree ${worktree.dir} is at ${worktree.head.slice(0, 8)}, ahead of or diverged from the reviewed ${reviewedSha}.`, report);
	}
	if (worktree?.dirty) return result(what, `#${pr} ${info.title}: sent nothing, its worktree ${worktree.dir} has uncommitted changes at ${worktree.head.slice(0, 8)}.`, report);
	const prompt = [
		`Concierge Bot hands you ${kind === "address" ? "feedback to address" : "feedback to discuss"} on PR #${pr} (${info.url}), reviewed at ${reviewedSha}. Ignacio asked for this.`,
		behind ? `Your worktree ${worktree.dir} is at ${worktree.head.slice(0, 8)}, behind the reviewed ${reviewedSha}: pull origin/${info.headRefName} first.` : "",
		"Read the full feedback on GitHub first: the Code Review sticky comment, or the teammate's review and its threads.",
		`The items, verbatim:\n\n${findings}`,
		TEMPLATES[kind].join("\n"),
		also ? `Also, from Ignacio: ${also}` : "",
	].filter(Boolean).join("\n\n");
	if (!agent) {
		// No agent works on the PR: a new one gets it, in a workspace Ignacio can recognize by name. Everything it needs is
		// in the PR, memory, docs and Linear; Concierge never relies on a previous agent's context (Ignacio, 2026-10-29).
		const workspaceLabel = label ?? `#${pr}`;
		const fresh = [
			prompt,
			`No agent was working on this PR when Concierge started you. Get the context from the PR (description, comments, reviews), the linked Linear ticket and ~/obsidian/memory. Work in the PR's worktree if \`git -C ~/v2.main worktree list\` shows one on ${info.headRefName} and it is clean; otherwise make your own worktree on that branch. ~/v2.main stays on main.`,
		].join("\n\n");
		if (dryRun) return `dry run · no running agent works on it (${reason}); would start one in a new workspace "${workspaceLabel}" · worktree ${worktree ? `${worktree.dir} at ${worktree.head.slice(0, 8)}` : "none found"}\n\n${fresh}`;
		const pane = (await herdr(CONCIERGE_SOCKET, ["workspace", "create", "--cwd", REPO, "--label", workspaceLabel, "--no-focus"])).root_pane.pane_id;
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		await herdr(CONCIERGE_SOCKET, ["agent", "start", `pr-${pr}`, "--kind", "claude", "--pane", pane, "--timeout", "60000"], 90_000);
		const line = await sendPrompt({ agent: pane, prompt: fresh, what: `#${pr} ${kind}`, socket: CONCIERGE_SOCKET });
		return result(what, `#${pr} ${info.title}: no running agent worked on it, so started pr-${pr} in a new workspace "${workspaceLabel}". ${line.replace(/^handoff · /, "")}`, report);
	}
	if (dryRun) return `dry run · would send to ${where(agent)}, because ${reason} · worktree ${worktree ? `${worktree.dir} at ${worktree.head.slice(0, 8)}` : "none found"}\n\n${prompt}`;
	if (!IDLE.has(agent.agent_status)) {
		try {
			await herdr(agent.socket, ["agent", "wait", agent.pane_id, "--until", "idle", "--until", "done", "--timeout", String(waitMinutes * 60_000)], waitMinutes * 60_000 + 30_000);
		} catch {
			return result(what, `#${pr} ${info.title}: sent nothing, ${where(agent)} stayed busy for ${waitMinutes} minutes.`, report);
		}
	}
	const line = await sendPrompt({ agent: agent.pane_id, prompt, what: `#${pr} ${kind}`, socket: agent.socket });
	return result(what, `#${pr} ${info.title}: sent to ${where(agent)}, because ${reason} ${line.replace(/^handoff · /, "")}`, report);
}

// Concierge's own tabs (tab 1, Ready, Merge Queue) never close.
export async function closeTab(tabId, { report = false } = {}) {
	const what = `close tab ${tabId}`;
	const socket = (await sessions()).find((s) => s.socket === CONCIERGE_SOCKET)?.socket ?? CONCIERGE_SOCKET;
	const { tab } = await herdr(socket, ["tab", "get", tabId]);
	if (tab.workspace_id === CONCIERGE_WORKSPACE) return result(what, `Refused: ${tabId} ("${tab.label}") is one of Concierge's own tabs.`, report);
	await herdr(socket, ["tab", "close", tabId]);
	return result(what, `Closed tab ${tabId} ("${tab.label}").`, report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = process.argv.slice(2);
	const flag = (name) => {
		const i = args.indexOf(name);
		return i === -1 ? undefined : args.splice(i, 2)[1];
	};
	const has = (name) => {
		const i = args.indexOf(name);
		return i !== -1 && args.splice(i, 1).length === 1;
	};
	const report = has("--report");
	const nonBlocking = has("--non-blocking");
	const dryRun = has("--dry-run");
	const forceNew = has("--new");
	const event = flag("--event");
	const file = flag("--file");
	const waitMinutes = Number(flag("--wait-minutes") ?? 20);
	const also = flag("--also");
	const label = flag("--label");
	const [command, ...rest] = args;
	let message;
	if (command === "close-workspace") message = await closeWorkspace(Number(rest[0]), { report });
	else if (command === "ci-green") message = await ciGreen(Number(rest[0]), { report });
	else if (command === "handoff") {
		const [pr, kind, typed] = rest;
		if (!pr || !kind || !(event || file)) throw new Error("usage: concierge-act handoff <pr> address|discuss [<reviewed-sha>] (--event <key> [--non-blocking] | --file <path>)");
		const { findings, commit } = file ? { findings: fs.readFileSync(file, "utf8").trim() } : fromEvent(event, nonBlocking);
		if (typed && commit && !commit.startsWith(typed)) throw new Error(`reviewed sha ${typed} is not event ${event}'s commit ${commit}`);
		const sha = commit || typed;
		if (!sha) throw new Error(file ? "--file needs the reviewed sha" : `event ${event} has no commit (queued before 2026-10-29?): pass the reviewed sha`);
		message = await handoff(Number(pr), kind, sha, { findings, also, label, fresh: forceNew, waitMinutes, report, dryRun });
	} else if (command === "close-tab") message = await closeTab(rest[0], { report });
	else if (command === "find-agent") {
		const { agent, reason } = await prAgent(await prInfo(Number(rest[0])));
		message = `#${rest[0]}: ${agent ? where(agent) : "no running agent works on it"}, because ${reason}`;
	} else throw new Error("usage: concierge-act close-workspace|ci-green|handoff|close-tab|find-agent …");
	console.log(message);
}
