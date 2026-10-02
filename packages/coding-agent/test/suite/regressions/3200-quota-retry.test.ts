import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { InMemorySettingsStorage, SettingsManager } from "../../../src/core/settings-manager.ts";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

const io = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("../../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		io.lines.push(line);
	},
}));
const quota = '429: {"error":{"code":"insufficient_quota","message":"quota exceeded"}}';

// smarty-dev#3200: let the fleet gateway reselect an account/model once, without replaying output.
describe("pre-output quota recovery", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
		vi.restoreAllMocks();
		io.lines = [];
	});

	it.each([quota, "quota exceeded", "billing limit reached", "out of budget"])(
		"retries a quota refusal once then completes: %s",
		async (errorMessage) => {
			const h = await createHarness({ settings: { retry: { quotaDelayMs: 1 } } });
			harnesses.push(h);
			const model = h.session.model;
			h.setResponses([
				fauxAssistantMessage([], { stopReason: "error", errorMessage }),
				fauxAssistantMessage("recovered"),
			]);
			await h.session.prompt("test");
			expect(h.faux.state.callCount).toBe(2);
			expect(h.session.model).toEqual(model);
			expect(h.eventsOfType("auto_retry_start")).toMatchObject([
				{ attempt: 1, maxAttempts: 1, delayMs: 1, retryReason: "quota", errorMessage },
			]);
			expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
			expect(h.eventsOfType("agent_end").map((e) => e.willRetry)).toEqual([true, false]);
			expect(h.eventsOfType("agent_settled")).toMatchObject([{ outcome: "completed" }]);
			expect(h.session.getLastAssistantText()).toBe("recovered");
			expect(h.session.messages.filter((m) => m.role === "assistant" && m.stopReason === "error")).toEqual([]);
			expect(h.sessionManager.getBranch()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "message", message: expect.objectContaining({ errorMessage }) }),
				]),
			);
		},
	);

	it.each([quota, "503 overloaded", "429 smarty_limit: quota exceeded"])(
		"stops after the one-shot retry, preserving its original error: %s",
		async (finalError) => {
			const h = await createHarness({
				models: [{ id: "primary" }, { id: "alternate" }],
				settings: { retry: { maxRetries: 10, quotaDelayMs: 1, baseDelayMs: 0, fallbackModel: "faux/alternate" } },
			});
			harnesses.push(h);
			h.setResponses([
				fauxAssistantMessage([], { stopReason: "error", errorMessage: quota }),
				fauxAssistantMessage([], { stopReason: "error", errorMessage: finalError }),
				fauxAssistantMessage("must not be requested"),
			]);
			await h.session.prompt("test");
			expect(h.faux.state.callCount).toBe(2);
			expect(h.eventsOfType("auto_retry_start")).toHaveLength(1);
			expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
			expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, attempt: 1, finalError }]);
			expect(h.eventsOfType("agent_end").map((e) => e.willRetry)).toEqual([true, false]);
			expect(h.eventsOfType("agent_settled")).toMatchObject([{ outcome: "error" }]);
			expect(h.session.messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: finalError });
			expect(h.session.retryAttempt).toBe(0);
		},
	);

	it.each([
		{ content: [{ type: "text" as const, text: "partial" }] },
		{ content: [fauxThinking("partial")] },
		{ content: [fauxToolCall("write", { path: "file", content: "once" })] },
		{ content: [], output: 1 },
	])("never retries after assistant output: $content/$output", async ({ content, output }) => {
		const h = await createHarness({ settings: { retry: { quotaDelayMs: 1 } } });
		harnesses.push(h);
		const message = fauxAssistantMessage(content, { stopReason: "error", errorMessage: quota });
		if (output !== undefined) {
			// Faux estimates usage from content; inject the provider's reported tokens at the stream boundary.
			const original = h.session.agent.streamFunction;
			h.session.agent.streamFunction = (model, context, options) => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(async () => {
					for await (const event of await original(model, context, options)) {
						stream.push(
							event.type === "error"
								? { ...event, error: { ...event.error, usage: { ...event.error.usage, output } } }
								: event,
						);
					}
					stream.end();
				});
				return stream;
			};
		}
		h.setResponses([message]);
		await h.session.prompt("test");
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
		expect(h.eventsOfType("agent_end")).toMatchObject([{ willRetry: false }]);
		expect(h.eventsOfType("tool_execution_start")).toEqual([]);
	});

	it("remembers streamed text even if the final quota error drops all output", async () => {
		const h = await createHarness({ settings: { retry: { quotaDelayMs: 1 } } });
		harnesses.push(h);
		const original = h.session.agent.streamFunction;
		h.session.agent.streamFunction = (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				for await (const event of await original(model, context, options)) {
					stream.push(
						event.type === "error"
							? { ...event, error: { ...event.error, content: [], usage: fauxAssistantMessage("").usage } }
							: event,
					);
				}
				stream.end();
			});
			return stream;
		};
		h.setResponses([fauxAssistantMessage("partial", { stopReason: "error", errorMessage: quota })]);
		await h.session.prompt("test");
		expect(h.eventsOfType("message_update").some((e) => e.assistantMessageEvent.type === "text_delta")).toBe(true);
		expect(h.session.messages.at(-1)).toMatchObject({ content: [], usage: { output: 0 } });
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it.each([{ enabled: false }, { maxRetries: 0 }])("honors disabled retry settings: %j", async (retry) => {
		const h = await createHarness({ settings: { retry: { ...retry, quotaDelayMs: 1 } } });
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: quota })]);
		await h.session.prompt("test");
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it.each(["401 invalid_api_key", "400 invalid request", "GoUsageLimitError", "FreeUsageLimitError"])(
		"keeps other deterministic failures final: %s",
		async (errorMessage) => {
			const h = await createHarness({ settings: { retry: { quotaDelayMs: 1 } } });
			harnesses.push(h);
			h.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage })]);
			await h.session.prompt("test");
			expect(h.faux.state.callCount).toBe(1);
			expect(h.eventsOfType("auto_retry_start")).toEqual([]);
		},
	);

	it("does not retry a marked provider plan limit containing quota wording", async () => {
		const h = await createHarness({ settings: { retry: { quotaDelayMs: 1 } } });
		harnesses.push(h);
		h.setResponses([
			{
				...fauxAssistantMessage([], { stopReason: "error", errorMessage: quota }),
				diagnostics: [{ type: "provider_limit", timestamp: 0 }],
			},
		]);
		await h.session.prompt("test");
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("has a quota allowance after an ordinary transient retry and resets on success", async () => {
		const h = await createHarness({ settings: { retry: { baseDelayMs: 0, quotaDelayMs: 1, maxRetries: 1 } } });
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 overloaded" }),
			fauxAssistantMessage([], { stopReason: "error", errorMessage: quota }),
			fauxAssistantMessage("first success"),
			fauxAssistantMessage([], { stopReason: "error", errorMessage: quota }),
			fauxAssistantMessage("second success"),
		]);
		await h.session.prompt("first");
		await h.session.prompt("second");
		expect(h.faux.state.callCount).toBe(5);
		expect(h.eventsOfType("auto_retry_start").map((e) => e.retryReason)).toEqual([undefined, "quota", "quota"]);
		expect(h.session.getLastAssistantText()).toBe("second success");
	});

	it.each([undefined, 17])("uses the default/configured abortable delay (%s)", async (quotaDelayMs) => {
		const h = await createHarness({ settings: { retry: { quotaDelayMs } } });
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: quota })]);
		const started = new Promise<void>((resolve) =>
			h.session.subscribe((e) => {
				if (e.type === "auto_retry_start") resolve();
			}),
		);
		const prompting = h.session.prompt("test");
		await Promise.race([
			started,
			prompting.then(() => {
				throw new Error("No quota retry scheduled");
			}),
		]);
		h.session.abortRetry();
		await prompting;
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([{ delayMs: quotaDelayMs ?? 5000 }]);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, finalError: "Retry cancelled" }]);
		expect(h.session.isRetrying).toBe(false);
	});

	it("resolves a zero quota delay and project overrides without changing other retry settings", () => {
		expect(SettingsManager.inMemory().getQuotaRetryDelayMs()).toBe(5000);
		expect(SettingsManager.inMemory({ retry: { quotaDelayMs: 0 } }).getQuotaRetryDelayMs()).toBe(0);
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ retry: { quotaDelayMs: 37, baseDelayMs: 123 } }));
		storage.withLock("project", () => JSON.stringify({ retry: { quotaDelayMs: 11 } }));
		const settings = SettingsManager.fromStorage(storage);
		expect(settings.getQuotaRetryDelayMs()).toBe(11);
		expect(settings.getRetrySettings().baseDelayMs).toBe(123);
	});

	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects an invalid quota delay: %s", (quotaDelayMs) => {
		expect(() => SettingsManager.inMemory({ retry: { quotaDelayMs } }).getQuotaRetryDelayMs()).toThrow(
			"Invalid retry.quotaDelayMs",
		);
	});

	it("caps the quota delay using the agent retry delay cap", async () => {
		const h = await createHarness({ settings: { retry: { maxAgentDelayMs: 1 } } });
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: quota }),
			fauxAssistantMessage("ok"),
		]);
		await h.session.prompt("test");
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([{ delayMs: 1 }]);
	});

	it("JSON print mode writes the quota notice before the second provider call", async () => {
		const h = await createHarness({ settings: { retry: { quotaDelayMs: 1 } } });
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: quota }),
			fauxAssistantMessage("ok"),
		]);
		const notices: { callCount: number; message: string }[] = [];
		vi.spyOn(console, "error").mockImplementation((message: unknown) => {
			notices.push({ callCount: h.faux.state.callCount, message: String(message) });
		});
		const runtime = {
			session: h.session,
			setRebindSession: vi.fn(),
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSessionRuntime;
		expect(await runPrintMode(runtime, { mode: "json", initialMessage: "test" })).toBe(0);
		expect(h.faux.state.callCount).toBe(2);
		expect(notices).toEqual([{ callCount: 1, message: "quota refusal; retrying once in 1s" }]);
		const records = io.lines.map((line) => JSON.parse(line) as { type: string; outcome?: string });
		expect(records.filter((record) => record.type === "auto_retry_start")).toHaveLength(1);
		expect(records.at(-1)).toMatchObject({ type: "agent_settled", outcome: "completed" });
	});
});
