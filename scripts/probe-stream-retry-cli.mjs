#!/usr/bin/env node
// smarty-dev#3200: built CLI acceptance regression; no SDK/mode mocks or external endpoints.
// Run after npm run build:offline:
// PI_RETRY_PROBE_OUT="$TASK_OUT/cli-head" node scripts/probe-stream-retry-cli.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "packages/coding-agent/dist/bundle/cli.js");
assert.ok(existsSync(cli), "Build the CLI before running this probe");
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
const dirty = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "pi-cli-retry-"));
const out = process.env.PI_RETRY_PROBE_OUT ? resolve(process.env.PI_RETRY_PROBE_OUT) : join(scratch, "evidence");
mkdirSync(out, { recursive: true });
const provider = "retry-local-stub";
const models = ["primary", "alternate"].map((id) => ({
	id,
	name: id,
	reasoning: false,
	input: ["text"],
	contextWindow: 1000000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}));
const cases = [
	{ name: "json-one-drop", mode: "json", steps: ["drop", "ok"], calls: 2, retries: 1, outcome: "completed" },
	{ name: "print-one-drop", mode: "text", steps: ["drop", "ok"], calls: 2, retries: 1, outcome: "completed" },
	{
		name: "default-fallback-off",
		mode: "json",
		steps: ["drop", "drop", "drop", "ok"],
		calls: 3,
		retries: 2,
		outcome: "error",
	},
	{
		name: "configured-fallback",
		mode: "json",
		fallback: true,
		steps: ["drop", "drop", "drop", "ok"],
		calls: 4,
		retries: 2,
		outcome: "completed",
	},
	{
		name: "no-replay-after-text",
		mode: "json",
		fallback: true,
		steps: ["text-drop", "ok"],
		calls: 1,
		retries: 0,
		outcome: "error",
	},
	{
		name: "no-replay-after-failed-usage",
		mode: "json",
		fallback: true,
		steps: ["failed-usage", "ok"],
		calls: 1,
		retries: 0,
		outcome: "error",
	},
	// smarty-dev#3200 / PR #114 round 3: a truncated alternate cannot naturally continue.
	...[0, 2].map((maxRetries) => ({
		name: `fallback-truncated-tool-${maxRetries}-retries`,
		mode: "json",
		fallback: true,
		maxRetries,
		steps: [...Array(maxRetries + 1).fill("drop"), "truncated-tool", "truncated-tool", "ok"],
		calls: maxRetries + 2,
		retries: maxRetries,
		outcome: "error",
	})),
	// Use actual built SSE adapters with a rejecting public raw-event callback.
	...["responses", "codex"].map((observerApi) => ({
		name: `no-replay-after-${observerApi}-observer-usage`,
		mode: "json",
		fallback: true,
		observerApi,
		steps: ["failed-usage", "ok"],
		calls: 1,
		retries: 0,
		outcome: "error",
	})),
	{
		name: "fallback-tool-later-budget",
		mode: "json",
		fallback: true,
		steps: ["drop", "drop", "drop", "tool", "drop", "drop", "ok"],
		calls: 7,
		retries: 4,
		outcome: "completed",
	},
];
const states = new Map(cases.map((item) => [item.name, { ...item, requests: [], timeline: [] }]));
const server = createServer(async (request, response) => {
	try {
		const name = request.url?.split("/")[1];
		const state = states.get(name);
		assert.ok(state, `Unexpected request URL ${request.url}`);
		assert.equal(request.method, "POST");
		assert.equal(request.url, `/${name}/v1/${state.observerApi === "codex" ? "codex/responses" : "responses"}`);
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const bytes = Buffer.concat(chunks);
		const body = JSON.parse(
			(request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8"),
		);
		const index = state.requests.length;
		const step = state.steps[index] || "unexpected";
		state.requests.push({ model: body.model, step, input: body.input });
		state.timeline.push({ kind: "request", attempt: index + 1, model: body.model, step });
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		let sequence = 0;
		const send = (event) =>
			response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
		const id = `resp_${name}_${index}`;
		send({ type: "response.created", response: { id, status: "in_progress", output: [] } });
		if (step === "drop") {
			// EOF after headers/created, with neither output nor a terminal Responses event.
			response.end();
			return;
		}
		if (step === "failed-usage") {
			send({
				type: "response.failed",
				response: {
					id,
					status: "failed",
					output: [],
					error: { code: "server_error", message: "503 overloaded" },
					usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
				},
			});
			response.end();
			return;
		}
		let output;
		if (step === "tool" || step === "truncated-tool") {
			output = {
				type: "function_call",
				id: `fc_${index}`,
				call_id: `call_${index}`,
				name: "read",
				arguments: step === "truncated-tool" ? '{"path":' : JSON.stringify({ path: join(scratch, "tool-marker.txt") }),
				status: "completed",
			};
			send({
				type: "response.output_item.added",
				output_index: 0,
				item: { ...output, arguments: "", status: "in_progress" },
			});
			send({
				type: "response.function_call_arguments.delta",
				output_index: 0,
				item_id: output.id,
				delta: output.arguments,
			});
		} else {
			const text = step === "text-drop" ? "partial output must not replay" : "recovered by real CLI";
			output = {
				type: "message",
				id: `msg_${index}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			};
			send({
				type: "response.output_item.added",
				output_index: 0,
				item: { ...output, content: [], status: "in_progress" },
			});
			send({
				type: "response.output_text.delta",
				output_index: 0,
				item_id: output.id,
				content_index: 0,
				delta: text,
			});
			if (step === "text-drop") {
				response.end();
				return;
			}
		}
		if (step === "truncated-tool") {
			send({
				type: "response.incomplete",
				response: {
					id,
					status: "incomplete",
					output: [],
					incomplete_details: { reason: "max_output_tokens" },
					usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
				},
			});
			response.end();
			return;
		}
		send({ type: "response.output_item.done", output_index: 0, item: output });
		send({
			type: "response.completed",
			response: {
				id,
				status: "completed",
				output: [output],
				usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
			},
		});
		response.end();
	} catch (error) {
		response.destroy(error);
	}
});

function runCli(args, cwd, env, state) {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let pending = "";
		const events = [];
		const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
		child.stdout.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			stdout += text;
			if (state.mode === "text") {
				state.timeline.push({ kind: "stdout", text });
				return;
			}
			pending += text;
			let newline;
			while ((newline = pending.indexOf("\n")) >= 0) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				if (!line) continue;
				try {
					const event = JSON.parse(line);
					events.push(event);
					state.timeline.push({
						kind: "event",
						type: event.type,
						...(event.outcome ? { outcome: event.outcome } : {}),
					});
				} catch (error) {
					// Retain parse evidence and wait for the child before rejecting the probe.
					state.timeline.push({ kind: "invalid-json", line, error: String(error) });
				}
			}
		});
		child.stderr.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			stderr += text;
			state.timeline.push({ kind: "stderr", text });
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			rejectRun(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timeout);
			resolveRun({ code, signal, stdout, stderr, events, pending });
		});
	});
}

const summaries = [];
writeFileSync(join(scratch, "tool-marker.txt"), "deterministic tool result marker\n");
try {
	await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
	const port = server.address().port;
	for (const state of states.values()) {
		const dir = join(out, state.name);
		const agentDir = join(dir, "agent");
		const sessionDir = join(dir, "sessions");
		const cwd = join(scratch, state.name);
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify(
				{
					retry: {
						baseDelayMs: 50,
						maxRetries: state.maxRetries ?? 2,
						...(state.fallback ? { fallbackModel: `${provider}/alternate` } : {}),
					},
					compaction: { enabled: false },
					cacheWarming: "off",
				},
				null,
				2,
			),
		);
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify(
				{
					providers: {
						[provider]: {
							baseUrl: `http://127.0.0.1:${port}/${state.name}/v1`,
							api: "openai-responses",
							apiKey: "non-secret-local-stub",
							models,
						},
					},
				},
				null,
				2,
			),
		);
		const observerExtension = join(cwd, "observer-provider.mjs");
		if (state.observerApi) {
			const adapter = pathToFileURL(
				join(repo, `packages/ai/dist/api/openai-${state.observerApi === "codex" ? "codex-responses" : "responses"}.js`),
			).href;
			// Synthetic local-only token, not credentials; no external service is used.
			const apiKey = state.observerApi === "codex"
				? `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local-test" } })).toString("base64")}.test`
				: "non-secret-local-stub";
			writeFileSync(observerExtension, `
import { stream } from ${JSON.stringify(adapter)};
export default function (pi) {
  pi.registerProvider(${JSON.stringify(provider)}, {
    api: "retry-observer-api",
    apiKey: ${JSON.stringify(apiKey)},
    baseUrl: ${JSON.stringify(`http://127.0.0.1:${port}/${state.name}/v1`)},
    models: ${JSON.stringify(models)},
    streamSimple(model, context, options) {
      return stream({ ...model, api: ${JSON.stringify(state.observerApi === "codex" ? "openai-codex-responses" : "openai-responses")} }, context, {
        ...options, transport: "sse",
        async onProviderStreamEvent(event, eventModel) {
          await options?.onProviderStreamEvent?.(event, eventModel);
          if (event.type === "response.failed") {
            await Promise.resolve();
            throw new Error("fetch failed");
          }
        },
      });
    },
  });
}
`);
			writeFileSync(join(dir, "observer-provider.mjs"), readFileSync(observerExtension));
			// Model config must not override the extension's observer wrapper API.
			writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
		}
		const args = [
			...(state.mode === "json" ? ["--mode", "json"] : ["-p"]),
			"--provider",
			provider,
			"--model",
			"primary",
			"--thinking",
			"off",
			"--session-dir",
			sessionDir,
			"--offline",
			"--no-extensions",
			...(state.observerApi ? ["--extension", observerExtension] : []),
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-approve",
			"--tools",
			"read",
			"Run the deterministic retry task",
		];
		// Do not inherit provider credentials, proxy settings, fleet extensions or parent session state.
		const env = {
			PATH: process.env.PATH,
			HOME: join(scratch, "home"),
			TMPDIR: scratch,
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			PI_TELEMETRY: "0",
			NO_COLOR: "1",
		};
		const result = await runCli(args, cwd, env, state);
		writeFileSync(
			join(dir, "command.json"),
			JSON.stringify({ command: [process.execPath, cli, ...args], cwd, env, head, trackedDirty: dirty }, null, 2),
		);
		writeFileSync(join(dir, "stdout.jsonl"), result.stdout);
		writeFileSync(join(dir, "stderr.log"), result.stderr);
		writeFileSync(join(dir, "requests.json"), JSON.stringify(state.requests, null, 2));
		writeFileSync(join(dir, "timeline.json"), JSON.stringify(state.timeline, null, 2));
		const sessions = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
		const entries = sessions.flatMap((name) =>
			readFileSync(join(sessionDir, name), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		);
		const switches = entries.filter((entry) => entry.type === "custom" && entry.customType === "auto_retry_fallback");
		const retries = (result.stderr.match(/Retrying \(/g) || []).length;
		let failure;
		try {
			assert.equal(result.signal, null, "CLI must exit normally");
			assert.equal(result.code, 0, result.stderr);
			assert.equal(state.requests.length, state.calls, "request attempt count");
			assert.equal(retries, state.retries, "stderr retry notices");
			const primaryAttempts = (state.maxRetries ?? 2) + 1;
			const fallbackExpected = state.fallback && state.calls > primaryAttempts;
			assert.equal(switches.length, fallbackExpected ? 1 : 0, "persisted fallback custom record");
			assert.equal(
				entries.filter((entry) => entry.type === "model_change" && entry.modelId === "alternate").length,
				fallbackExpected ? 1 : 0,
				"persisted model change",
			);
			// A notice must have arrived on the actual stderr pipe before the HTTP continuation.
			for (const [index, event] of state.timeline.entries()) {
				if (event.kind !== "request" || event.attempt === 1) continue;
				const previousRequest = state.timeline.findLastIndex(
					(entry, position) => position < index && entry.kind === "request",
				);
				if (state.timeline[previousRequest].step === "tool") continue; // Natural tool turn, not recovery.
				assert.ok(
					state.timeline
						.slice(previousRequest + 1, index)
						.some((entry) => entry.kind === "stderr" && /Retrying \(|Failed over from/.test(entry.text)),
					"stderr notice precedes the retried HTTP request",
				);
			}
			assert.deepEqual(
				state.requests.map((request) => request.model),
				Array.from({ length: state.calls }, (_, index) =>
					fallbackExpected && index >= primaryAttempts ? "alternate" : "primary",
				),
			);
			if (state.mode === "json") {
				assert.equal(result.pending, "", "complete LF-delimited JSON records");
				assert.equal(result.events[0]?.type, "session");
				assert.equal(result.events.at(-1)?.type, "agent_settled", "caller reads through final settlement");
				assert.equal(result.events.at(-1)?.outcome, state.outcome);
				assert.equal(result.events.filter((event) => event.type === "auto_retry_start").length, state.retries);
				assert.equal(state.timeline.filter((event) => event.kind === "invalid-json").length, 0);
				for (const [index, event] of result.events.entries()) {
					if (event.type !== "auto_retry_start" && event.type !== "auto_retry_fallback") continue;
					assert.ok(
						result.events.slice(index + 1).some((next) => next.type === "agent_start"),
						"retry/fallback notice precedes continuation",
					);
				}
			} else {
				assert.equal(result.stdout.trim(), "recovered by real CLI");
				assert.ok(
					state.timeline.findIndex((event) => event.kind === "stderr" && event.text.includes("Retrying")) <
						state.timeline.findIndex((event) => event.kind === "stdout"),
				);
			}
			if (fallbackExpected)
				assert.match(result.stderr, /Failed over from retry-local-stub\/primary to retry-local-stub\/alternate/);
			if (state.name === "fallback-tool-later-budget") {
				assert.equal(result.events.filter((event) => event.type === "tool_execution_start").length, 1);
				assert.ok(JSON.stringify(state.requests.at(-1).input).includes("deterministic tool result marker"));
			}
			if (state.name.startsWith("fallback-truncated-tool-")) {
				assert.equal(state.requests.filter((request) => request.model === "alternate").length, 1);
				assert.equal(result.events.filter((event) => event.type === "auto_retry_end" && !event.success).length, 1);
				assert.equal(result.events.filter((event) => event.type === "auto_retry_end" && event.success).length, 0);
				const toolEnds = result.events.filter((event) => event.type === "tool_execution_end");
				assert.equal(toolEnds.length, 1);
				assert.equal(toolEnds[0].isError, true);
				assert.match(toolEnds[0].result.content[0].text, /was not executed/);
			}
			if (state.observerApi) {
				const message = entries.findLast((entry) => entry.message?.role === "assistant").message;
				assert.equal(message.usage.output, 1, "observer failure retains the reported output usage");
				assert.equal(message.content.length, 0);
				assert.match(message.errorMessage, /fetch failed/);
			}
			if (state.name === "no-replay-after-failed-usage")
				assert.equal(entries.findLast((entry) => entry.message?.role === "assistant").message.usage.output, 1);
		} catch (error) {
			failure = error.message;
		}
		const summary = {
			case: state.name,
			pass: !failure,
			calls: state.requests.length,
			models: state.requests.map((request) => request.model),
			stderrRetries: retries,
			fallbackRecords: switches.length,
			settlement: result.events.at(-1)?.outcome,
			exitCode: result.code,
			assistantTerminals: entries.filter((entry) => entry.message?.role === "assistant").map(({ message }) => ({
				model: message.model,
				stopReason: message.stopReason,
				outputTokens: message.usage.output,
				...(message.errorMessage ? { error: message.errorMessage } : {}),
			})),
			...(failure ? { failure } : {}),
		};
		summaries.push(summary);
		console.log(JSON.stringify(summary));
	}
	const files = readdirSync(dirname(cli), { recursive: true })
		.filter((name) => String(name).endsWith(".js"))
		.sort();
	const hash = createHash("sha256");
	for (const file of files) hash.update(String(file)).update(readFileSync(join(dirname(cli), String(file))));
	const builtAdapterSha256 = Object.fromEntries(
		["openai-responses", "openai-responses-shared", "openai-codex-responses"].map((name) => [
			name,
			createHash("sha256").update(readFileSync(join(repo, `packages/ai/dist/api/${name}.js`))).digest("hex"),
		]),
	);
	writeFileSync(
		join(out, "receipt.json"),
		JSON.stringify(
			{ head, trackedDirty: dirty, cli, bundleSha256: hash.digest("hex"), builtAdapterSha256, summaries },
			null,
			2,
		),
	);
	assert.ok(
		summaries.every((summary) => summary.pass),
		"Built CLI regression failed; see case artifacts",
	);
} finally {
	server.closeAllConnections();
	await new Promise((closed) => server.close(closed));
	if (!process.env.PI_RETRY_PROBE_OUT) console.log(`Ephemeral evidence removed; set PI_RETRY_PROBE_OUT to keep it`);
	rmSync(scratch, { recursive: true, force: true });
}
