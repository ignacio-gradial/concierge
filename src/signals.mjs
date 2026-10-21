// Side effects shared by the watcher and the ack hook: state files, the
// Obsidian log, and herdr signals.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const STATE_FILE = path.join(os.homedir(), "concierge/state/state.json");
export const ACK_FILE = path.join(os.homedir(), "concierge/state/ack.json");
export const LOG_DIR = path.join(os.homedir(), "obsidian/concierge/log");

export const ALERT_SOURCE = "concierge-alert";
export const LIVE_SOURCE = "concierge-live";
export const READY_SOURCE = "concierge-ready";
// 2.4 ticks: one slow tick is fine, a dead watcher drops the ◉ within 6 minutes.
const LIVE_TTL_MS = 360_000;

export function readJson(file, fallback) {
	if (!fs.existsSync(file)) return fallback;
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJsonAtomic(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`);
	fs.renameSync(tmp, file);
}

const ptParts = new Intl.DateTimeFormat("en-CA", {
	timeZone: "America/Los_Angeles",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
});

export function pacific(date = new Date()) {
	const p = Object.fromEntries(ptParts.formatToParts(date).map((x) => [x.type, x.value]));
	return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

// One Markdown file per Pacific day; every line starts with its PT time.
export function appendLog(text, date = new Date()) {
	const { day, time } = pacific(date);
	const file = path.join(LOG_DIR, `${day}.md`);
	if (!fs.existsSync(file)) fs.writeFileSync(file, `# Concierge log ${day}\n\nTimes are Pacific.\n\n`);
	const [first, ...rest] = text.split("\n");
	fs.appendFileSync(file, `- ${time} · ${[first, ...rest.map((l) => `\t${l}`)].join("\n")}\n`);
}

export function herdrWorkspace() {
	const ws = process.env.HERDR_WORKSPACE_ID;
	if (!ws || !process.env.HERDR_SOCKET_PATH) {
		throw new Error("HERDR_WORKSPACE_ID/HERDR_SOCKET_PATH unset: run inside the Concierge Bot herdr pane");
	}
	return ws;
}

async function herdr(args) {
	await run("herdr", args, { timeout: 10_000 });
}

export function setAlert(on) {
	const ws = herdrWorkspace();
	const token = on ? ["--token", "concierge_alert=✗"] : ["--clear-token", "concierge_alert"];
	return herdr(["workspace", "report-metadata", ws, "--source", ALERT_SOURCE, ...token]);
}

export function heartbeat() {
	const ws = herdrWorkspace();
	return herdr(["workspace", "report-metadata", ws, "--source", LIVE_SOURCE, "--token", "concierge_live=◉", "--ttl-ms", String(LIVE_TTL_MS)]);
}

// No TTL, like the ✗: the count stays until the Ready list changes.
export function setReady(count) {
	const ws = herdrWorkspace();
	const token = count ? ["--token", `concierge_ready=✓${count}`] : ["--clear-token", "concierge_ready"];
	return herdr(["workspace", "report-metadata", ws, "--source", READY_SOURCE, ...token]);
}

export function notify(title, body, sound) {
	return herdr(["notification", "show", title, "--body", body, "--sound", sound]);
}

// The ✗ stays until a human message in the Concierge session is newer than the last attention event.
export function alertActive(state, ack) {
	return Boolean(state.lastAttentionAt) && (!ack.ackedAt || state.lastAttentionAt > ack.ackedAt);
}
