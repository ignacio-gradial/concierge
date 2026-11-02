// UserPromptSubmit hook for the Concierge session: a message from Ignacio
// clears the ✗. Prints nothing on stdout because hook stdout becomes model context.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLoopPrompt } from "./messages.mjs";
import { ACK_FILE, alertActive, appendLog, readJson, setAlert, STATE_FILE, writeJsonAtomic } from "./signals.mjs";

const input = JSON.parse(fs.readFileSync(0, "utf8"));
// Evidence for which prompts reach this hook (loop prompts, task notifications, typed messages).
fs.appendFileSync(
	path.join(os.homedir(), "concierge/state/hook.log"),
	`${new Date().toISOString()} ${JSON.stringify(String(input.prompt).slice(0, 160))}\n`,
);
if (isLoopPrompt(input.prompt)) process.exit(0);
// Verified 2026-10-19: background task notifications reach this hook as prompts starting with <task-notification>.
if (String(input.prompt).startsWith("<task-notification>")) process.exit(0);
const wasActive = alertActive(readJson(STATE_FILE, {}), readJson(ACK_FILE, {}));
writeJsonAtomic(ACK_FILE, { ackedAt: new Date().toISOString() });
await setAlert(false);
if (wasActive) appendLog("✗ cleared · your message in Concierge Bot");
