// Concierge's herdr and GitHub actions as deterministic commands. They replaced the Herdr agent on 2026-10-28. Since
// 2026-10-30 Concierge (the Opus session) picks every target itself from `agents` and passes it in; Haiku only triages
// events (Ignacio). The tick runs only actions with a fixed target: the merge-queue hand-off and retrigger-review.
//   concierge-act agents
//   concierge-act handoff <pr> address|discuss [<reviewed-sha>] (--event <key> [--non-blocking] | --file <path>) (--pane <Session/pane> | --new --label <name>) [--also <text>] [--wait-minutes N]
//   concierge-act ci-green <pr> (--workspace <Session/workspace> | --label <name>) [--run <forge run url>]
//   concierge-act close-workspace <pr> --workspace <Session/workspace> [--tabs <tab-id,…>]
//   concierge-act close-tab <tab-id>
//   concierge-act retrigger-review <pr>
//   concierge-act endorse <pr> [--note <text>]
//   concierge-act review <pr> [--label <name>] [--effort high] [--thermo-nuclear] [--comment-on-blockers]
// Each prints one result line and logs it as `act · …`. With --report, the result also goes to state/reports.jsonl, so
// the next tick relays it as a REPORT line.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { sendPrompt } from "./handoff.mjs";
import { appendLog } from "./signals.mjs";

const run = promisify(execFile);
const HOME = os.homedir();
const REPO = path.join(HOME, "v2.main");
const SESSIONS_DIR = path.join(HOME, ".config/herdr/sessions");
const REPORTS_FILE = path.join(HOME, "concierge/state/reports.jsonl");
const EVENTS_FILE = path.join(HOME, "concierge/state/events.jsonl");
const RETRIGGERS_FILE = path.join(HOME, "concierge/state/retriggers.json");
const ENDORSED_FILE = path.join(HOME, "concierge/state/endorsed.json");
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

// A target Concierge picked from `agents`: "Session/pane" (or a bare pane id in Concierge's session).
async function agentById(id) {
	const want = id.includes("/") ? id : `${path.basename(path.dirname(CONCIERGE_SOCKET))}/${id}`;
	const agent = (await candidates()).find((a) => a.id === want);
	if (!agent) throw new Error(`no running agent at ${want}; run concierge-act agents`);
	return agent;
}

// The worktree an agent works in, from the status line Claude Code and omp print at the bottom of the pane
// ("/Users/iguridi/v2.main/.worktrees/x (branch) Opus 5.5 …").
function agentWorktree(agent) {
	const paths = [...agent.screen.matchAll(/(\/Users\/[^\s()]+)\s+\(/g)].map((m) => m[1]);
	// ~/v2.main stays on main, so an agent showing it works in some other worktree Concierge can't see: no check.
	const dir = paths.at(-1) ?? null;
	return dir && path.resolve(dir) !== REPO ? dir : null;
}

async function worktreeState(dir) {
	const head = (await run("git", ["-C", dir, "rev-parse", "HEAD"], { timeout: 30_000 })).stdout.trim();
	const dirty = (await run("git", ["-C", dir, "status", "--porcelain"], { timeout: 30_000 })).stdout.trim() !== "";
	return { dir, head, dirty };
}

// One line per running agent, for Concierge to pick a target: where it sits, what it shows, and its status line.
export async function listAgents() {
	return (await candidates())
		.map((a) => {
			const status = a.screen.split("\n").filter((l) => /\/Users\/|PR #\d+/.test(l)).slice(-2).map((l) => l.trim()).join(" · ");
			return `${a.id} · "${a.workspace}" / ${a.tab} · ${a.agent_status} · ${a.title}${status ? ` · ${status}` : ""}`.slice(0, 300);
		})
		.join("\n");
}

export const fileReport = (what, message) => result(what, message, true);

function result(what, message, report) {
	appendLog(`act · ${what} · ${message.split("\n")[0].slice(0, 300)}`);
	if (report) fs.appendFileSync(REPORTS_FILE, `${JSON.stringify({ at: new Date().toISOString(), what, message })}\n`);
	return message;
}

// A merged PR's workspace, which Concierge picked, closes only when every agent in it is idle and none of them signs
// another open PR of Ignacio's; one workspace often serves a stack. Agent sessions and worktrees stay on disk.
export async function closeWorkspace(pr, { workspace, tabs = [], report = false } = {}) {
	const what = `#${pr} close_workspace`;
	if (!workspace) throw new Error("close-workspace needs --workspace <Session/workspace>, picked from concierge-act agents");
	const info = await prInfo(pr);
	const [session, workspaceId] = workspace.split("/");
	const socket = path.join(SESSIONS_DIR, session, "herdr.sock");
	const open = (await gh(["pr", "list", "--author", "ignacio-gradial", "--state", "open", "--limit", "200", "--json", "number,body"])).filter((p) => p.number !== pr);
	const members = (await allAgents()).filter((a) => a.socket === socket && a.workspace_id === workspaceId);
	const { workspace: ws } = await herdr(socket, ["workspace", "get", workspaceId]);
	const label = `"${ws.label}" (${workspaceId}, ${session})`;
	if (socket === CONCIERGE_SOCKET && workspaceId === CONCIERGE_WORKSPACE) return result(what, `Refused: ${label} is Concierge's own workspace.`, report);
	const busy = members.filter((a) => !IDLE.has(a.agent_status));
	const signed = open.filter((p) => members.some((a) => signs(a, signatures(p.body)))).map((p) => `#${p.number}`);
	let line;
	// A workspace that still serves other work keeps running; the merged PR's own tabs, which Concierge picked, close
	// instead when their agents are idle (Ignacio, 2026-10-30).
	if (tabs.length && (busy.length || signed.length)) {
		const closed = [];
		for (const tabId of tabs) {
			const inTab = members.filter((a) => a.tab_id === tabId);
			if (inTab.some((a) => !IDLE.has(a.agent_status))) continue;
			const { tab } = await herdr(socket, ["tab", "get", tabId]);
			await herdr(socket, ["tab", "close", tabId]);
			closed.push(`"${tab.label}" (${tabId})`);
		}
		const kept = tabs.length - closed.length;
		line = `Left ${label} open for its other work and closed the PR's tab${closed.length === 1 ? "" : "s"} ${closed.join(", ") || "none"}${kept ? `; ${kept} still working, kept` : ""}.`;
	} else if (busy.length) line = `Left ${label} open: ${busy.map((a) => a.name ?? a.pane_id).join(", ")} still working.`;
	else if (signed.length) line = `Left ${label} open: its agents also sign open ${signed.join(", ")}.`;
	else {
		await herdr(socket, ["workspace", "close", workspaceId]);
		line = `Closed ${label}: ${members.length} idle agent${members.length === 1 ? "" : "s"}, none signing another open PR.`;
	}
	return result(what, `#${pr} ${info.title} merged. ${line} Agent sessions and worktrees stay on disk.`, report);
}

// An approval with no feedback while CI is failing: a new Claude agent, in a new tab of the workspace Concierge picked
// or in a new workspace named --label, makes CI green.
export async function ciGreen(pr, { ci = null, workspace, label, report = false } = {}) {
	const what = `#${pr} ci_green`;
	const info = await prInfo(pr);
	const name = `ci-${pr}`;
	let socket = CONCIERGE_SOCKET;
	let pane;
	if (workspace) {
		const [session, workspaceId] = workspace.split("/");
		socket = path.join(SESSIONS_DIR, session, "herdr.sock");
		pane = (await herdr(socket, ["tab", "create", "--workspace", workspaceId, "--cwd", REPO, "--label", `CI #${pr}`, "--no-focus"])).root_pane.pane_id;
	} else {
		pane = (await herdr(socket, ["workspace", "create", "--cwd", REPO, "--label", label ?? `#${pr} CI`, "--no-focus"])).root_pane.pane_id;
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
export async function handoff(pr, kind, reviewedSha, { findings, also, label, pane, fresh: forceNew = false, waitMinutes = 20, report = false, dryRun = false }) {
	const what = `#${pr} ${kind} hand-off`;
	if (!TEMPLATES[kind]) throw new Error(`kind must be address or discuss, not ${kind}`);
	const info = await prInfo(pr);
	if (!pane && !forceNew) throw new Error("handoff needs --pane <Session/pane> (from concierge-act agents) or --new --label <name>");
	const agent = pane ? await agentById(pane) : null;
	const reason = agent ? "Concierge picked it" : "no agent works on it";
	// The worktree to check is the agent's own, from its status line; for a new agent, the one on the PR's branch.
	const agentDir = agent && agentWorktree(agent);
	const worktree = agent ? (agentDir ? await worktreeState(agentDir).catch(() => null) : null) : await prWorktree(info.headRefName);
	// A worktree behind the reviewed head is fine (a bot or another session pushed, such as gradial-gitops restamping a
	// migration on 2026-10-28); one ahead of it or diverged may already address the feedback.
	let behind = false;
	if (worktree && !worktree.head.startsWith(reviewedSha)) {
		await run("git", ["-C", worktree.dir, "fetch", "--quiet", "origin", info.headRefName], { timeout: 120_000 });
		behind = await run("git", ["-C", worktree.dir, "merge-base", "--is-ancestor", worktree.head, reviewedSha], { timeout: 30_000 }).then(() => true, () => false);
		if (!behind && agent) return result(what, `#${pr} ${info.title}: sent nothing, its worktree ${worktree.dir} is at ${worktree.head.slice(0, 8)}, ahead of or diverged from the reviewed ${reviewedSha}.`, report);
	}
	if (worktree?.dirty && agent) return result(what, `#${pr} ${info.title}: sent nothing, its worktree ${worktree.dir} has uncommitted changes at ${worktree.head.slice(0, 8)}.`, report);
	// With no agent on the PR, a diverged or dirty worktree is leftover state (on 2026-10-29 #11700's was a 09-25 commit
	// from before a rebase): the new agent leaves it alone and makes its own.
	const unusable = worktree && !agent && (worktree.dirty || (!behind && !worktree.head.startsWith(reviewedSha)));
	const prompt = [
		`Concierge Bot hands you ${kind === "address" ? "feedback to address" : "feedback to discuss"} on PR #${pr} (${info.url}), reviewed at ${reviewedSha}. Ignacio asked for this.`,
		behind && agent ? `Your worktree ${worktree.dir} is at ${worktree.head.slice(0, 8)}, behind the reviewed ${reviewedSha}: pull origin/${info.headRefName} first.` : "",
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
			`No agent was working on this PR when Concierge started you. Get the context from the PR (description, comments, reviews), the linked Linear ticket and ~/obsidian/memory. ${unusable ? `The worktree ${worktree.dir} is at ${worktree.head.slice(0, 8)}${worktree.dirty ? " with uncommitted changes" : ", diverged from the PR's head"}; leave it alone and make your own worktree on origin/${info.headRefName}.` : `Work in the PR's worktree if \`git -C ~/v2.main worktree list\` shows one on ${info.headRefName} and it is clean; otherwise make your own worktree on that branch.`} ~/v2.main stays on main.`,
		].join("\n\n");
		if (dryRun) return `dry run · no running agent works on it (${reason}); would start one in a new workspace "${workspaceLabel}" · worktree ${worktree ? `${worktree.dir} at ${worktree.head.slice(0, 8)}` : "none found"}\n\n${fresh}`;
		const pane = (await herdr(CONCIERGE_SOCKET, ["workspace", "create", "--cwd", REPO, "--label", workspaceLabel, "--no-focus"])).root_pane.pane_id;
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		await herdr(CONCIERGE_SOCKET, ["agent", "start", `pr-${pr}`, "--kind", "claude", "--pane", pane, "--timeout", "60000"], 90_000);
		// A just-started agent can miss its first prompt (agent_prompt_stalled, #11700 on 2026-10-30), so it gets one retry.
		const send = () => sendPrompt({ agent: pane, prompt: fresh, what: `#${pr} ${kind}`, socket: CONCIERGE_SOCKET });
		const line = await send().catch(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10_000));
			return send();
		});
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

// A failed Code Review run on the PR's current head gets re-run, once per head (Ignacio, 2026-10-30). This is one of
// the few GitHub writes Concierge makes itself; state/retriggers.json remembers which heads were re-run.
export async function retriggerReview(pr, { report = false } = {}) {
	const what = `#${pr} retrigger_review`;
	const info = await prInfo(pr);
	const runs = await gh(["run", "list", "--workflow", "code-review.yml", "--branch", info.headRefName, "--limit", "10", "--json", "databaseId,status,conclusion,headSha,event"]);
	const latest = runs.find((r) => r.headSha === info.headRefOid && r.event === "pull_request");
	if (!latest) return result(what, `#${pr} ${info.title}: no Code Review run on head ${info.headRefOid.slice(0, 8)}. Re-ran nothing.`, report);
	if (latest.status !== "completed" || latest.conclusion !== "failure") return result(what, `#${pr} ${info.title}: the latest Code Review run ${latest.databaseId} on ${info.headRefOid.slice(0, 8)} is ${latest.status}/${latest.conclusion ?? "none"}, not failed. Re-ran nothing.`, report);
	const done = (() => { try { return JSON.parse(fs.readFileSync(RETRIGGERS_FILE, "utf8")); } catch { return {}; } })();
	const key = `${pr}:${info.headRefOid}`;
	if (done[key]) return result(what, `#${pr} ${info.title}: Code Review on ${info.headRefOid.slice(0, 8)} was already re-run once (run ${done[key].run} at ${done[key].at}). Re-ran nothing; Ignacio decides.`, report);
	await run("gh", ["run", "rerun", String(latest.databaseId), "--repo", "gradial/v2"], { timeout: 60_000 });
	done[key] = { run: latest.databaseId, at: new Date().toISOString() };
	fs.writeFileSync(RETRIGGERS_FILE, `${JSON.stringify(done, null, 1)}\n`);
	return result(what, `#${pr} ${info.title}: re-ran failed Code Review run ${latest.databaseId} on ${info.headRefOid.slice(0, 8)}.`, report);
}

// GitHub logins Ignacio knows by first name (people.json; Ignacio, 2026-10-30). Unknown logins stay as they are.
function personName(login) {
	try {
		return JSON.parse(fs.readFileSync(path.join(HOME, "concierge/people.json"), "utf8"))[login] ?? login;
	} catch {
		return login;
	}
}

function readEndorsed() {
	try {
		return JSON.parse(fs.readFileSync(ENDORSED_FILE, "utf8"));
	} catch {
		return {};
	}
}

// Why Ignacio counts as having seen the PR's goal and approach, or null.
function endorsement(pr, reviews = []) {
	const given = readEndorsed()[pr];
	if (given) return `endorsed to Concierge ${given.at}${given.note ? `: ${given.note}` : ""}`;
	const approved = reviews.find((r) => r.author?.login === "ignacio-gradial" && r.state === "APPROVED");
	return approved ? `he approved it earlier, at ${approved.commit?.oid?.slice(0, 8) ?? "an earlier head"}` : null;
}

// Ignacio has seen a PR and approves of its goal and approach, so a clean review may approve it.
export function endorse(pr, { note = "", report = false } = {}) {
	const all = readEndorsed();
	all[pr] = { at: new Date().toISOString(), note };
	fs.writeFileSync(ENDORSED_FILE, `${JSON.stringify(all, null, 1)}\n`);
	return result(`#${pr} endorse`, `#${pr}: endorsed, so a clean review may approve it${note ? ` (${note})` : ""}.`, report);
}

// A readable tab name from a PR title, for reviews the tick starts on its own: the first three words after the
// conventional-commit prefix and ticket, in Title Case ("build(deps): move pnpm overrides …" → "Move Pnpm Overrides").
export function labelFromTitle(title) {
	const words = title.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "").replace(/^\[[A-Z]+-\d+\]\s*/, "").split(/\s+/).filter(Boolean).slice(0, 3);
	return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// Someone asked Ignacio by name to review their PR: a new Claude agent reviews it (a thermo-nuclear review, a review
// guide in the repo that agents find, only with --thermo-nuclear) and approves it from Ignacio's account when it finds no blocking items (Ignacio,
// 2026-10-30). With blocking items it posts nothing and waits for him in its tab. It goes in a new tab of the
// "Reviews" workspace when that exists in Concierge's session, otherwise in a new workspace named --label.
export async function review(pr, { label, effort = "high", thermoNuclear = false, commentOnBlockers = false, report = false } = {}) {
	const what = `#${pr} review`;
	const info = await gh(["pr", "view", String(pr), "--json", "number,title,url,author,headRefName,headRefOid,isDraft,additions,deletions,state,reviews"]);
	// A request can outlive its PR: #14073 had merged by the time Concierge offered it (2026-10-30).
	if (info.state !== "OPEN") return result(what, `#${pr} ${info.title}: ${info.state.toLowerCase()}, so no review started.`, report);
	// The author first, so Ignacio finds a review tab by who asked (2026-10-30): "hyperb1iss · Client Address".
	const name = `${personName(info.author.login)} · ${label ?? labelFromTitle(info.title)}`;
	const { workspaces } = await herdr(CONCIERGE_SOCKET, ["workspace", "list"]);
	const reviews = workspaces.find((w) => w.label === "Reviews");
	const pane = reviews
		? (await herdr(CONCIERGE_SOCKET, ["tab", "create", "--workspace", reviews.workspace_id, "--cwd", REPO, "--label", name, "--no-focus"])).root_pane.pane_id
		: (await herdr(CONCIERGE_SOCKET, ["workspace", "create", "--cwd", REPO, "--label", name, "--no-focus"])).root_pane.pane_id;
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	// A second pass on the same PR gets review-<pr>-2, -3…, since herdr agent names are unique.
	const taken = new Set((await allAgents()).map((a) => a.name).filter(Boolean));
	let agentName = `review-${pr}`;
	for (let n = 2; taken.has(agentName); n += 1) agentName = `review-${pr}-${n}`;
	await herdr(CONCIERGE_SOCKET, ["agent", "start", agentName, "--kind", "claude", "--pane", pane, "--timeout", "60000", "--", "--effort", effort], 90_000);
	// Auto-approval needs Ignacio to have seen the PR and approved of its goal and approach (2026-10-31): an endorsement
	// he gave Concierge (`concierge-act endorse`), or his own earlier approval of the PR.
	const endorsedBy = endorsement(pr, info.reviews);
	const prompt = [
		// Thermo-nuclear reviews only when Ignacio asks for one (2026-10-30); otherwise a regular full review.
		thermoNuclear ? `thermo-nuclear review for ${info.url}` : `Review ${info.url} for correctness bugs, security and permission holes, and missing tests.`,
		`"${info.title}" by ${info.author.login} (+${info.additions}/-${info.deletions}, branch ${info.headRefName}, head ${info.headRefOid.slice(0, 8)}${info.isDraft ? ", draft" : ""}). Ignacio was asked by name to review it, and asked Concierge Bot to send it to you.`,
		"- Review the whole PR in a temporary worktree or checkout, against current main source, not docs. ~/v2.main stays on main.",
		`- Save the full review to ~/reviews/${pr}-<8-char head sha>-<unix time>.md per Ignacio's global CLAUDE.md (all feedback, review time, prompt, model, effort, harness, duration, branch).`,
		"- End the saved review and your reply with one decision line: `auto-approve: yes` when there are no blocking items and nothing surprises you, `needs-ignacio: <why>` for a change in user-facing behavior, policy or security posture or anything you aren't confident about, or `needs-context: <question>` when it depends on a decision, ticket or conversation you can't see.",
		endorsedBy
			? `- Ignacio has seen this PR and approved of its goal and approach (${endorsedBy}). With \`auto-approve: yes\`, approve it from his account with \`gh pr review ${pr} --repo gradial/v2 --approve\` and a short body listing any non-blocking notes, ending with your signature (model and session ID).`
			: "- Ignacio hasn't seen this PR's goal and approach yet, so never approve it. With no blocking items, post nothing and reply here with a short summary of the PR's goal and approach and your decision line, so he can decide.",
		commentOnBlockers
			? `- Blocking items: post a review comment from Ignacio's account with \`gh pr review ${pr} --repo gradial/v2 --comment\`: each blocking item with file:line evidence and the fix you suggest, then the non-blocking notes, ending with your signature. Don't request changes.`
			: "- Blocking items: post nothing on GitHub. Report each one here with file:line evidence and the fix you suggest, then wait for Ignacio.",
		"- Never push to the PR's branch. Reply here with the verdict and what you posted.",
	].join("\n");
	const send = () => sendPrompt({ agent: pane, prompt, what: `#${pr} review`, socket: CONCIERGE_SOCKET });
	const line = await send().catch(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10_000));
		return send();
	});
	return result(what, `#${pr} ${info.title}: started ${agentName} (${thermoNuclear ? "thermo-nuclear" : "regular"} review, effort ${effort}; ${endorsedBy ? "approves when clean" : "never approves, not endorsed"}, ${commentOnBlockers ? "comments" : "waits for Ignacio"} on blockers). ${line.replace(/^handoff · /, "")}`, report);
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
	const pane = flag("--pane");
	const workspace = flag("--workspace");
	const runUrl = flag("--run");
	const [command, ...rest] = args;
	let message;
	if (command === "close-workspace") message = await closeWorkspace(Number(rest[0]), { workspace, tabs: (flag("--tabs") ?? "").split(",").filter(Boolean), report });
	else if (command === "ci-green") message = await ciGreen(Number(rest[0]), { ci: runUrl ? { forgeRunUrl: runUrl } : null, workspace, label, report });
	else if (command === "retrigger-review") message = await retriggerReview(Number(rest[0]), { report });
	else if (command === "agents") message = await listAgents();
	else if (command === "endorse") message = endorse(Number(rest[0]), { note: flag("--note") ?? "", report });
	else if (command === "review") message = await review(Number(rest[0]), { label, effort: flag("--effort") ?? "high", commentOnBlockers: has("--comment-on-blockers"), thermoNuclear: has("--thermo-nuclear"), report });
	else if (command === "handoff") {
		const [pr, kind, typed] = rest;
		if (!pr || !kind || !(event || file)) throw new Error("usage: concierge-act handoff <pr> address|discuss [<reviewed-sha>] (--event <key> [--non-blocking] | --file <path>)");
		const { findings, commit } = file ? { findings: fs.readFileSync(file, "utf8").trim() } : fromEvent(event, nonBlocking);
		if (typed && commit && !commit.startsWith(typed)) throw new Error(`reviewed sha ${typed} is not event ${event}'s commit ${commit}`);
		const sha = commit || typed;
		if (!sha) throw new Error(file ? "--file needs the reviewed sha" : `event ${event} has no commit (queued before 2026-10-29?): pass the reviewed sha`);
		message = await handoff(Number(pr), kind, sha, { findings, also, label, pane, fresh: forceNew, waitMinutes, report, dryRun });
	} else if (command === "close-tab") message = await closeTab(rest[0], { report });
	else throw new Error("usage: concierge-act agents|handoff|ci-green|close-workspace|close-tab|retrigger-review|review …");
	console.log(message);
}
