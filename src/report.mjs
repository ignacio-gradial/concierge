// Herdr's report of a finished instruction: concierge-report <what> <message-file>. The next tick relays it to the
// Opus session as a REPORT line, and the log keeps it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendLog } from "./signals.mjs";

const REPORTS_FILE = path.join(os.homedir(), "concierge/state/reports.jsonl");

const [what, messageFile] = process.argv.slice(2);
if (!what || !messageFile) throw new Error("usage: concierge-report <what> <message-file>");
const message = fs.readFileSync(messageFile, "utf8").trim();
if (!message) throw new Error(`concierge-report: ${messageFile} is empty`);
fs.appendFileSync(REPORTS_FILE, `${JSON.stringify({ at: new Date().toISOString(), what, message })}\n`);
appendLog(`report · ${what} · ${message.split("\n")[0].slice(0, 200)}`);
console.log(`reported · ${what}`);
