// First POST: throttled (or not) smarty_limit 429; later POSTs: an OpenAI chat-completions 200 stream.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [port, logFile, throttled, retryAfter] = [Number(process.argv[2]), process.argv[3], process.argv[4] !== "false", process.argv[5] ?? "8"];
const t0 = Date.now();
let count = 0;
const server = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		if (req.method !== "POST") return res.writeHead(404).end();
		count++;
		const status = count === 1 ? 429 : 200;
		appendFileSync(logFile, `${new Date().toISOString()} request ${count} ${req.method} ${req.url} +${((Date.now() - t0) / 1000).toFixed(2)}s -> ${status}${count === 1 ? ` retry-after=${retryAfter}` : ""}\n`);
		if (count === 1) {
			const message = throttled ? "Flash runs one request at a time. Retry in a few seconds." : "Your 5-hour limit is used up.";
			res.writeHead(429, { "content-type": "application/json", "retry-after": retryAfter });
			return res.end(JSON.stringify({ error: { type: "smarty_limit", code: "smarty_limit", message, throttled, window: "5h", resets_at: null } }));
		}
		const stream = JSON.parse(body).stream;
		const chunk = (delta, finish) => ({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] });
		if (!stream) {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ id: "c1", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "OK, answered after the wait." }, finish_reason: "stop" }] }));
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "OK, answered after the wait." }, null))}\n\n`);
		res.write(`data: ${JSON.stringify({ ...chunk({}, "stop"), usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
});
server.listen(port, "127.0.0.1");
