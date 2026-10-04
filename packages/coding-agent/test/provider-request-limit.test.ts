// Regression for Smarty-Pants-Inc/smarty-dev#2751: real print/agent/runtime paths with synthetic HTTP only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, normalizeContext } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { CacheWarmer } from "../src/core/cache-warmer.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { createTestResourceLoader } from "./utilities.ts";

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

function completion(tool = false): Response {
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
									function: { name: "unavailable", arguments: "{}" },
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

async function host(settings: Parameters<typeof SettingsManager.inMemory>[0] = {}) {
	directory = mkdtempSync(join(tmpdir(), "pi-request-limit-"));
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("deepseek", async () => ({ type: "api_key", key: "synthetic-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const model = getBuiltinModel("deepseek", "deepseek-flash");
	const created = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		modelRuntime,
		model,
		thinkingLevel: "off",
		noTools: "all",
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory({
			cacheWarming: "off",
			compaction: { enabled: false },
			retry: { enabled: false },
			...settings,
		}),
		resourceLoader: createTestResourceLoader(),
	});
	session = created.session;
	return {
		session,
		setRebindSession: () => {},
		dispose: async () => {
			await created.session.abort();
			created.session.dispose();
		},
	} as unknown as AgentSessionRuntime;
}

describe("print dispatch provider request limit", () => {
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
