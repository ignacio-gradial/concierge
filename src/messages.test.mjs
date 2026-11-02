// node --test src/messages.test.mjs. Inputs are what herdr and Claude Code produced on 2026-10-31.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isLoopPrompt, loopPrompt, message, typedInBox } from "./messages.mjs";

test("a wrapped loop prompt is the loop's, so it leaves the ✗ up", () => {
	assert.equal(isLoopPrompt('\n\n<pasted_content id="8643">\n<concierge-loop>\nREPORT x\n</concierge-loop>\n</pasted_content id="8643">\n'), true);
	assert.equal(isLoopPrompt(loopPrompt("REPORT x\n")), true);
});

test("Ignacio's text submitted with a loop prompt is his, so it clears the ✗", () => {
	assert.equal(isLoopPrompt('hi there\n\n<pasted_content id="8643">\n<concierge-loop>\nREPORT x\n</concierge-loop>\n</pasted_content id="8643">\n'), false);
	assert.equal(isLoopPrompt("what is the current status?"), false);
});

test("a paste of Ignacio's that merely quotes the loop isn't the loop's", () => {
	assert.equal(isLoopPrompt('> \n\n<pasted_content id="ca40">\n<concierge-loop>\nEVENT x\n</concierge-loop>\n</pasted_content id="ca40">\n'), false);
});

test("an empty box and a dim suggestion hold nothing typed", () => {
	assert.equal(typedInBox("old output\n❯ \r\n"), "");
	assert.equal(typedInBox("\x1b[0m\x1b[38;2;153;153;153m❯ \x1b[0m\r"), "");
	assert.equal(typedInBox("❯ \x1b[0m\x1b[2mrun it in the background\x1b[0m\r"), "");
});

test("typed text is seen, in the box rather than in earlier prompts", () => {
	assert.equal(typedInBox("❯ hi there\r"), "hi there");
	assert.equal(typedInBox("❯ an earlier prompt\nanswer\n❯ \r"), "");
});

test("no box on screen is null, so delivery waits", () => {
	assert.equal(typedInBox("Compacting conversation…\n"), null);
});

test("a message keeps long lines whole", () => {
	const long = "x".repeat(2000);
	assert.equal(message("REPORT", long, ["  body"]), `REPORT ${long}\n  body\n`);
});
