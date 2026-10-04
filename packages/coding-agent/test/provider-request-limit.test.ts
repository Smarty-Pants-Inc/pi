// Regression for Smarty-Pants-Inc/smarty-dev#2751: real print/agent/runtime paths with synthetic HTTP only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, normalizeContext, Type } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import { CacheWarmer } from "../src/core/cache-warmer.ts";
import type { ToolDefinition } from "../src/core/extensions/index.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

// Keep protocol body output out of request-count test logs; output transport has its own tests.
vi.mock("../src/core/output-guard.ts", () => ({
	writeRawStdout: vi.fn(),
	flushRawStdout: async () => {},
	waitForRawStdoutBackpressure: async () => {},
}));

let session: AgentSession | undefined;
let directory: string | undefined;
afterEach(async () => {
	await session?.abort();
	session?.dispose();
	session = undefined;
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function completion(tool = false, toolName = "unavailable"): Response {
	const chunk = {
		id: "test",
		object: "chat.completion.chunk",
		created: 0,
		model: "gpt-4o-mini",
		choices: [
			{
				index: 0,
				delta: tool
					? {
							tool_calls: [
								{
									index: 0,
									id: "unknown",
									type: "function",
									function: { name: toolName, arguments: "{}" },
								},
							],
						}
					: { content: "OK" },
				finish_reason: null,
			},
		],
	};
	const final = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] };
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

async function host(settings: Parameters<typeof SettingsManager.inMemory>[0] = {}, customTools: ToolDefinition[] = []) {
	directory = mkdtempSync(join(tmpdir(), "pi-request-limit-"));
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("deepseek", async () => ({ type: "api_key", key: "synthetic-key" }));
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		const modelRuntime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.registerCommand("replace", {
					description: "Replace test session",
					handler: async (_args, ctx) => {
						await ctx.newSession();
					},
				});
			},
		]);
		const created = await createAgentSession({
			...options,
			modelRuntime,
			model: getBuiltinModel("deepseek", "deepseek-flash"),
			thinkingLevel: "off",
			noTools: customTools.length ? "builtin" : "all",
			customTools,
			settingsManager: SettingsManager.inMemory({
				cacheWarming: "off",
				compaction: { enabled: false },
				retry: { enabled: false },
				...settings,
			}),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		session = created.session;
		return {
			...created,
			services: { cwd: options.cwd, agentDir: options.agentDir } as AgentSessionServices,
			diagnostics: [],
		};
	};
	const created = await createRuntime({
		cwd: directory,
		agentDir: directory,
		sessionManager: SessionManager.inMemory(),
	});
	return new AgentSessionRuntime(created.session, created.services, createRuntime);
}

describe("print dispatch provider request limit", () => {
	// PR #139 / smarty-dev#2751: warming exhaustion must cancel tools and join native shutdown, including rebinds.
	it.each([
		["text", false],
		["json", false],
		["text", true],
		["json", true],
	] as const)("cancels a tool waiting for abort in %s mode (rebound %s)", async (mode, rebound) => {
		vi.useFakeTimers();
		let toolCancelled = false;
		let started!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let warmer: CacheWarmer | undefined;
		let runtime!: AgentSessionRuntime;
		runtime = await host({}, [
			{
				name: "wait",
				label: "Wait",
				description: "Wait for cancellation",
				parameters: Type.Object({}),
				execute: async (_id, _params, signal) => {
					warmer = new CacheWarmer(
						runtime.session.modelRuntime,
						runtime.session.sessionManager,
						() => "streaming",
						async () => "warm",
					);
					warmer.start(
						{
							model: { ...runtime.session.model!, promptCache: { short: 20 } },
							context: normalizeContext({ messages: [] }),
							options: {},
						},
						() => true,
					);
					started();
					await new Promise<void>((resolve) => {
						signal?.addEventListener(
							"abort",
							() => {
								toolCancelled = true;
								resolve();
							},
							{ once: true },
						);
					});
					return { content: [{ type: "text", text: "cancelled" }], details: undefined };
				},
			},
		]);
		const originalSession = runtime.session;
		const fetch = vi.fn(async () => completion(true, "wait"));
		if (rebound) fetch.mockImplementationOnce(async () => completion());
		vi.stubGlobal("fetch", fetch);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const dispose = vi.spyOn(runtime, "dispose");
		let result: number | undefined;
		const cap = rebound ? 2 : 1;
		const running = runPrintMode(runtime, {
			mode,
			initialMessage: "test",
			messages: rebound ? ["/replace", "wait"] : [],
			maxProviderRequests: cap,
		}).then((code) => {
			result = code;
			return code;
		});
		try {
			await toolStarted;
			if (rebound) expect(runtime.session).not.toBe(originalSession);
			await vi.advanceTimersByTimeAsync(10_000);
			expect.soft(toolCancelled).toBe(true);
			expect(result).toBe(1);
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(runtime.session.shutdownSignal.aborted).toBe(true);
			expect(fetch).toHaveBeenCalledTimes(cap);
			expect(errors).toHaveBeenCalledWith(
				`Provider request limit reached (${cap}/${cap}); no further requests allowed`,
			);
		} finally {
			warmer?.cancel();
			await runtime.dispose();
			await running;
		}
	});
	it.each(["text", "json"] as const)("stops unknown-tool continuations at exactly N in %s mode", async (mode) => {
		const bodies: string[] = [];
		const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
			bodies.push(String(init?.body));
			return completion(true);
		});
		vi.stubGlobal("fetch", fetch);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const runtime = await host();
		const result = await runPrintMode(runtime, { mode, initialMessage: "test", maxProviderRequests: 2 });
		expect(result).toBe(1);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(bodies.every((body) => !JSON.parse(body).tools?.length)).toBe(true);
		expect(errors).toHaveBeenCalledWith("Provider request limit reached (2/2); no further requests allowed");
	});

	it("shares the counter with provider retries rather than double counting agent streams", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { message: "synthetic transient" } }), {
					status: 503,
					headers: { "retry-after-ms": "0" },
				}),
		);
		vi.stubGlobal("fetch", fetch);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const runtime = await host({ retry: { enabled: false, provider: { maxRetries: 5 } } });
		expect(await runPrintMode(runtime, { mode: "text", initialMessage: "test", maxProviderRequests: 2 })).toBe(1);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it.each([1, 2, undefined])(
		"shares the one-shot throttle retry counter with settings.retry disabled (cap %s)",
		async (maxProviderRequests) => {
			vi.useFakeTimers();
			const fetch = vi
				.fn(async () => completion())
				.mockImplementationOnce(
					async () =>
						new Response(
							JSON.stringify({
								error: { code: "smarty_limit", message: "one request at a time", throttled: true },
							}),
							{ status: 429, headers: { "retry-after": "1", "content-type": "application/json" } },
						),
				);
			vi.stubGlobal("fetch", fetch);
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});
			const runtime = await host();
			const waits: number[] = [];
			runtime.session.subscribe((event) => {
				if (event.type === "auto_retry_start") waits.push(event.delayMs);
			});
			const running = runPrintMode(runtime, { mode: "text", initialMessage: "test", maxProviderRequests });
			await vi.runAllTimersAsync();
			expect(await running).toBe(maxProviderRequests === 1 ? 1 : 0);
			expect(waits).toEqual([1000]);
			expect(fetch).toHaveBeenCalledTimes(maxProviderRequests === 1 ? 1 : 2);
			if (maxProviderRequests === 1)
				expect(errors).toHaveBeenCalledWith("Provider request limit reached (1/1); no further requests allowed");
		},
	);

	it.each([1, 2, undefined])("keeps the counter across agent retries (cap %s)", async (maxProviderRequests) => {
		const fetch = vi
			.fn(async () => completion())
			.mockImplementationOnce(
				async () => new Response(JSON.stringify({ error: { message: "synthetic server error" } }), { status: 503 }),
			);
		vi.stubGlobal("fetch", fetch);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const runtime = await host({
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, provider: { maxRetries: 0 } },
		});
		expect(await runPrintMode(runtime, { mode: "text", initialMessage: "test", maxProviderRequests })).toBe(
			maxProviderRequests === 1 ? 1 : 0,
		);
		expect(fetch).toHaveBeenCalledTimes(maxProviderRequests === 1 ? 1 : 2);
		if (maxProviderRequests === 1)
			expect(errors).toHaveBeenCalledWith("Provider request limit reached (1/1); no further requests allowed");
	});

	it("does not reset the dispatch counter for additional prompts", async () => {
		const fetch = vi.fn(async () => completion());
		vi.stubGlobal("fetch", fetch);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const runtime = await host();
		expect(
			await runPrintMode(runtime, {
				mode: "text",
				initialMessage: "test",
				messages: ["again", "denied"],
				maxProviderRequests: 2,
			}),
		).toBe(1);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("counts cache refreshes and cancels an owned in-flight request when warming reaches the cap", async () => {
		vi.useFakeTimers();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const runtime = await host();
		const warmer = new CacheWarmer(
			runtime.session.modelRuntime,
			SessionManager.inMemory(),
			() => "streaming",
			async () => "warm",
		);
		const model = { ...runtime.session.model!, promptCache: { short: 20 } };
		let started!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let cancelled = false;
		const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_input, init) => {
			if (!cancelled && fetch.mock.calls.length === 1) {
				warmer.start({ model, context: normalizeContext({ messages: [] }), options: {} }, () => true);
				started();
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => {
							cancelled = true;
							reject(init.signal?.reason);
						},
						{ once: true },
					);
				});
			}
			return completion();
		});
		vi.stubGlobal("fetch", fetch);
		const running = runPrintMode(runtime, { mode: "text", initialMessage: "test", maxProviderRequests: 2 });
		try {
			await firstStarted;
			await vi.advanceTimersByTimeAsync(10_000);
			expect(fetch).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(await running).toBe(1);
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(cancelled).toBe(true);
			expect(warmer.status.state).toBe("inactive");
			expect(warmer.status.reason).toContain("Provider request limit reached (2/2)");
			expect(errors).toHaveBeenCalledWith("Provider request limit reached (2/2); no further requests allowed");
		} finally {
			warmer.cancel();
		}
	});

	it.each([undefined, 1])("allows the first clean request (limit %s)", async (maxProviderRequests) => {
		const fetch = vi.fn(async () => completion());
		vi.stubGlobal("fetch", fetch);
		const runtime = await host();
		expect(await runPrintMode(runtime, { mode: "text", initialMessage: "test", maxProviderRequests })).toBe(0);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("default off preserves unknown-tool continuation and multiple prompts", async () => {
		const fetch = vi.fn(async () => completion()).mockImplementationOnce(async () => completion(true));
		vi.stubGlobal("fetch", fetch);
		const runtime = await host();
		expect(await runPrintMode(runtime, { mode: "text", initialMessage: "test", messages: ["again"] })).toBe(0);
		expect(fetch).toHaveBeenCalledTimes(3);
	});
});
