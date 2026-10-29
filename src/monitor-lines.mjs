// What the tick prints for the Opus loop's Monitor. The Monitor cuts every stdout line at 500 characters (168 of
// the 170 cut lines in the 2026-10-19 to 10-28 transcripts), and lines printed within 200 ms arrive as one
// notification. So each message is one write of short lines: the first starts with its kind, the rest are indented.
const LINE_LIMIT = 480;

export function wrap(line, indent = "    ") {
	const lines = [];
	while (line.length > LINE_LIMIT) {
		const space = line.lastIndexOf(" ", LINE_LIMIT);
		const at = space > indent.length ? space : LINE_LIMIT;
		lines.push(line.slice(0, at));
		line = indent + line.slice(at).trimStart();
	}
	return [...lines, line];
}

export const message = (kind, head, body = []) => `${[...wrap(`${kind} ${head}`, "  "), ...body.flatMap((l) => wrap(l, `${l.match(/^\s*/)[0]}  `))].join("\n")}\n`;

// The event as the Opus session relays it, with the key for `concierge-act handoff --event`. events.jsonl keeps the JSON.
export function eventMessage(event) {
	const items = (label, list, head) => list.flatMap((item, i) => [`  ${label} ${i + 1} · ${head(item)}`, `    ${item.explanation}`]);
	const body = [
		`  ${event.prTitle} · ${event.url}`,
		`  ${event.summary}`,
		...items("Blocking", event.blocking, (f) => `${f.title} · ${f.anchor}`),
		...items("Non-blocking", event.nonBlocking, (f) => `${f.title} · ${f.anchor}`),
		...items("Feedback", event.feedback, (f) => `${f.author} · ${f.anchor}`),
		...(event.ask?.line ? [`  Ask · ${event.ask.area} · ${event.ask.line} · ${event.ask.size}`] : []),
	];
	return message("EVENT", `#${event.pr} ${event.kind} · ${event.decision} · commit ${event.commit || "none"} · key ${event.key}`, body);
}
