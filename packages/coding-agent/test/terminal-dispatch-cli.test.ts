import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type RecordLine = Record<string, unknown>;
const cli = resolve("dist/bundle/cli.js");
const fixture = `import { createFauxCore, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(resolve("../ai/dist/providers/faux.js"))};
export default function(pi) {
  const hook = process.env.PI_TERMINAL_HOOK;
  const faux = createFauxCore({ provider: "terminal-faux" });
  faux.setResponses([
    ...(hook === "tool_call" || hook === "tool_result" ? [fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" })] : []),
    ...Array.from({ length: 8 }, () => fauxAssistantMessage("offline answer")),
  ]);
  pi.registerProvider(faux.provider, { baseUrl: faux.getModel().baseUrl, apiKey: "offline-faux-test-only", api: faux.api, streamSimple: faux.streamSimple, models: faux.models });
  if (process.env.PI_NATIVE_API) pi.registerProvider("terminal-native", { baseUrl: process.env.PI_NATIVE_URL, apiKey: "offline-native-test-only", api: process.env.PI_NATIVE_API, models: [{ id: "native", name: "native", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  pi.registerTool({ name: "probe", label: "probe", description: "offline probe", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "probe-ran" }], details: {} }) });
  pi.on("session_start", async (_event, ctx) => {
    await pi.setModel(process.env.PI_NATIVE_API ? ctx.modelRegistry.find("terminal-native", "native") : faux.getModel());
    ctx.ui.notify("ready");
  });
  pi.on(hook, async (event, ctx) => {
    if (hook === "message_end" && event.message.role !== "assistant") return;
    ctx.ui.notify("dispatch-held");
    await new Promise(resolve => setTimeout(resolve, 60000));
    return { block: true, cancel: true, content: [{ type: "text", text: "late-result" }], message: { ...event.message, content: "late-result" }, continue: true, entries: [] };
  });
  pi.on(hook, async (event, ctx) => {
    if (hook === "message_end" && event.message.role !== "assistant") return;
    ctx.ui.notify("late-second-handler");
  });
  pi.registerCommand("tree-hold", { handler: async (_args, ctx) => {
    const entry = ctx.sessionManager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user");
    await ctx.navigateTree(entry.id);
  } });
  pi.on("session_shutdown", (_event, ctx) => { ctx.ui.notify("cleanup-ran"); });
}`;

// smarty-dev#3048 / PR #110: terminal dispatch repair is independent of input-admission accounting.
describe.skipIf(!existsSync(cli))("built CLI terminal extension dispatch cancellation", () => {
	const cleanups: Array<() => Promise<void>> = [];
	let sequence = 0;
	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()?.();
	});

	async function launch(hook: string, ending: string, api?: "anthropic-messages" | "openai-completions") {
		let baseUrl: string | undefined;
		if (api) {
			const server = createServer((request, response) => {
				request.resume();
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				if (api === "anthropic-messages") {
					response.write(
						`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "offline", type: "message", role: "assistant", model: "native", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`,
					);
				} else {
					response.write(
						`data: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", created: 1, model: "native", choices: [{ index: 0, delta: { role: "assistant", content: "must-not-normalize" }, finish_reason: null }] })}\n\n`,
					);
				}
			});
			await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
			cleanups.push(async () => {
				server.closeAllConnections();
				await new Promise<void>((done, failed) => server.close((error) => (error ? failed(error) : done())));
			});
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected local SSE server address");
			baseUrl = `http://127.0.0.1:${address.port}${api === "anthropic-messages" ? "" : "/v1"}`;
		}
		const temp = mkdtempSync(join(tmpdir(), "pi-terminal-dispatch-"));
		const extension = join(temp, "terminal.mjs");
		const agentDir = join(temp, "agent");
		mkdirSync(agentDir);
		writeFileSync(extension, fixture);
		const child = spawn(
			process.execPath,
			[
				cli,
				"--offline",
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				...(hook.startsWith("tool_") ? ["--tools", "probe"] : ["--no-tools"]),
				"-e",
				extension,
			],
			{
				cwd: temp,
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					PATH: process.env.PATH,
					HOME: temp,
					USERPROFILE: temp,
					TMPDIR: temp,
					PI_CODING_AGENT_DIR: agentDir,
					PI_OFFLINE: "1",
					PI_PACKAGE_DIR: resolve("."),
					PI_TERMINAL_HOOK: hook,
					PI_NATIVE_API: api,
					PI_NATIVE_URL: baseUrl,
					PI_NO_LOCAL_LLM: "1",
					AWS_EC2_METADATA_DISABLED: "true",
				},
			},
		);
		const records: RecordLine[] = [];
		let stdout = "",
			stderr = "",
			framed = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			framed += chunk;
			let boundary = framed.indexOf("\n");
			while (boundary !== -1) {
				const line = framed.slice(0, boundary);
				framed = framed.slice(boundary + 1);
				if (line.trim()) records.push(JSON.parse(line) as RecordLine);
				boundary = framed.indexOf("\n");
			}
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.stdin.on("error", () => {});
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, failed) => {
			child.once("error", failed);
			child.once("close", (code, signal) => done({ code, signal }));
		});
		const proof = `${process.env.PI_PROOF_PREFIX ?? "green"}-${++sequence}-${hook}-${api ?? "faux"}-${ending}`;
		cleanups.push(async () => {
			child.stdin.end();
			const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
			try {
				const result = await exited;
				if (process.env.TASK_OUT) {
					writeFileSync(join(process.env.TASK_OUT, `terminal-${proof}.jsonl`), stdout);
					writeFileSync(join(process.env.TASK_OUT, `terminal-${proof}.stderr.log`), stderr);
					writeFileSync(join(process.env.TASK_OUT, `terminal-${proof}.exit.json`), JSON.stringify(result));
				}
			} finally {
				clearTimeout(timer);
				rmSync(temp, { recursive: true, force: true });
			}
		});
		const send = (command: RecordLine) => child.stdin.write(`${JSON.stringify(command)}\n`);
		const wait = async (predicate: (record: RecordLine) => boolean) => {
			await vi.waitFor(() => expect(records.some(predicate), stderr).toBe(true), { timeout: 15000 });
			return records.find(predicate)!;
		};
		await wait((record) => record.type === "extension_ui_request" && record.message === "ready");
		return { child, records, send, wait, exited };
	}

	const hooks = [
		{ hook: "provider_stream_event", api: "anthropic-messages" as const },
		{ hook: "provider_stream_event", api: "openai-completions" as const },
		...["before_provider_request", "before_provider_headers", "after_provider_response"].map((hook) => ({
			hook,
			api: "anthropic-messages" as const,
		})),
		...[
			"tool_call",
			"tool_result",
			"turn_end",
			"agent_before_settle",
			"agent_settled",
			"agent_start",
			"message_end",
			"context",
			"context_with_system",
			"session_before_tree",
		].map((hook) => ({ hook, api: undefined })),
	];
	it.each(
		hooks.flatMap(({ hook, api }) =>
			(["EOF", "SIGTERM", "SIGHUP"] as const).map((ending) => ({ hook, api, ending })),
		),
	)("$hook ($api) releases under $ending without late results", async ({ hook, api, ending }) => {
		const p = await launch(hook, ending, api);
		p.send({ id: "run", type: "prompt", message: "run" });
		if (hook === "session_before_tree") {
			await p.wait((record) => record.type === "agent_settled");
			p.send({ id: "tree", type: "prompt", message: "/tree-hold" });
		}
		await p.wait((record) => record.type === "extension_ui_request" && record.message === "dispatch-held");
		if (ending === "EOF") p.child.stdin.end();
		else p.child.kill(ending);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			expect(
				await Promise.race([
					p.exited,
					new Promise((done) => {
						timer = setTimeout(() => done("hung"), 2500);
					}),
				]),
			).toEqual({ code: ending === "EOF" ? 0 : ending === "SIGTERM" ? 143 : 129, signal: null });
		} finally {
			clearTimeout(timer);
		}
		expect(JSON.stringify(p.records)).not.toContain("late-result");
		expect(JSON.stringify(p.records)).not.toContain("late-second-handler");
		expect(p.records.filter((record) => record.type === "response" && record.id === "run")).toHaveLength(1);
		expect(
			p.records.some((record) => record.type === "extension_ui_request" && record.message === "cleanup-ran"),
		).toBe(true);
		if (hook === "provider_stream_event") {
			const aborted = p.records.findIndex(
				(record) => record.type === "message_end" && (record.message as RecordLine)?.role === "assistant",
			);
			const ended = p.records.findIndex((record) => record.type === "agent_end");
			expect(aborted).toBeGreaterThan(-1);
			expect((p.records[aborted].message as RecordLine).stopReason).toBe("aborted");
			expect(ended).toBeGreaterThan(aborted);
			expect(JSON.stringify(p.records)).not.toContain("must-not-normalize");
		}
	});
});
