import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const disconnect = "stream error: stream disconnected before completion: stream closed before response.completed";

// smarty-dev#3200: an empty Responses stream must not terminate a task agent.
describe("premature stream recovery", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it.each([
		{ content: [] },
		{ content: [{ ...fauxThinking(""), thinkingSignature: "encrypted reasoning metadata" }] },
	])("retries a dropped stream with empty content $content", async ({ content }) => {
		const h = await createHarness({ settings: { retry: { baseDelayMs: 1 } } });
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage(content, { stopReason: "error", errorMessage: disconnect }),
			fauxAssistantMessage("recovered"),
		]);
		await h.session.prompt("test");
		expect(h.faux.state.callCount).toBe(2);
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, maxAttempts: 2, delayMs: 1 }]);
		expect(h.session.getLastAssistantText()).toBe("recovered");
	});

	it.each([false, true])(
		"records one fallback after three dropped streams (alternate fails: %s)",
		async (alternateFails) => {
			const h = await createHarness({
				persistSession: true,
				models: [{ id: "primary" }, { id: "alternate" }],
				settings: { retry: { baseDelayMs: 1, fallbackModel: "faux/alternate" } },
			});
			harnesses.push(h);
			const requests: string[] = [];
			h.setResponses(
				[
					...Array.from({ length: 3 }, () =>
						fauxAssistantMessage("", { stopReason: "error", errorMessage: disconnect }),
					),
					alternateFails
						? fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded" })
						: fauxAssistantMessage("alternate completed"),
				].map((response) => (_context, _options, _state, model) => {
					requests.push(model.id);
					return response;
				}),
			);
			await h.session.prompt("test");
			expect(requests).toEqual(["primary", "primary", "primary", "alternate"]);
			expect(h.eventsOfType("auto_retry_start").map((e) => e.attempt)).toEqual([1, 2]);
			expect(h.eventsOfType("auto_retry_fallback")).toMatchObject([
				{ fromModel: "faux/primary", toModel: "faux/alternate", attempt: 2, errorMessage: disconnect },
			]);
			expect(h.eventsOfType("agent_end").map((e) => e.willRetry)).toEqual([true, true, true, false]);
			expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: !alternateFails, attempt: 2 }]);
			expect(h.sessionManager.getBranch()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "model_change", provider: "faux", modelId: "alternate" }),
					expect.objectContaining({
						type: "custom",
						customType: "auto_retry_fallback",
						data: expect.objectContaining({ fromModel: "faux/primary", toModel: "faux/alternate" }),
					}),
				]),
			);
			expect(h.session.messages.filter((m) => m.role === "assistant" && m.stopReason === "error")).toHaveLength(
				alternateFails ? 1 : 0,
			);
			expect(h.settingsManager.getGlobalSettings().defaultModel).toBeUndefined();
			const path = h.sessionManager.getSessionFile();
			expect(path).toBeDefined();
			const reopened = SessionManager.open(path!);
			expect(reopened.buildSessionContext().model).toEqual({ provider: "faux", modelId: "alternate" });
			expect(
				reopened
					.getBranch()
					.filter((entry) => entry.type === "custom" && entry.customType === "auto_retry_fallback"),
			).toHaveLength(1);
		},
	);

	it.each(["faux/missing", "faux/primary", "missing-provider/alternate"])(
		"does not switch to an unavailable or identical alternate: %s",
		async (fallbackModel) => {
			const h = await createHarness({
				models: [{ id: "primary" }],
				settings: { retry: { baseDelayMs: 0, fallbackModel } },
			});
			harnesses.push(h);
			h.setResponses(
				Array.from({ length: 3 }, () =>
					fauxAssistantMessage("", { stopReason: "error", errorMessage: disconnect }),
				),
			);
			await h.session.prompt("test");
			expect(h.faux.state.callCount).toBe(3);
			expect(h.session.model?.id).toBe("primary");
			expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
			expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, attempt: 2 }]);
		},
	);

	it("refuses an alternate whose context window is too small and clears retry state", async () => {
		const h = await createHarness({
			models: [
				{ id: "primary", contextWindow: 1_000_000 },
				{ id: "alternate", contextWindow: 64 },
			],
			settings: { retry: { baseDelayMs: 0, fallbackModel: "faux/alternate" } },
		});
		harnesses.push(h);
		h.setResponses(
			Array.from({ length: 3 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: disconnect })),
		);
		await expect(h.session.prompt("context ".repeat(200))).rejects.toThrow("Model switch refused");
		expect(h.faux.state.callCount).toBe(3);
		expect(h.session.model?.id).toBe("primary");
		expect(h.session.retryAttempt).toBe(0);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([
			{ success: false, attempt: 2, finalError: expect.stringContaining("faux/alternate") },
		]);
	});

	it("does not fail over if aborted after the last primary failure", async () => {
		const h = await createHarness({
			models: [{ id: "primary" }, { id: "alternate" }],
			settings: { retry: { baseDelayMs: 0, fallbackModel: "faux/alternate" } },
		});
		harnesses.push(h);
		h.setResponses(
			Array.from({ length: 3 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: disconnect })),
		);
		let aborting: Promise<void> | undefined;
		h.session.subscribe((event) => {
			if (event.type === "agent_end" && h.faux.state.callCount === 3) aborting = h.session.abort();
		});
		await h.session.prompt("test");
		await aborting;
		expect(h.faux.state.callCount).toBe(3);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
		expect(h.session.retryAttempt).toBe(0);
	});

	it("honors retry.enabled=false even with an alternate configured", async () => {
		const h = await createHarness({
			models: [{ id: "primary" }, { id: "alternate" }],
			settings: { retry: { enabled: false, fallbackModel: "faux/alternate" } },
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: disconnect })]);
		await h.session.prompt("test");
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
	});

	it("stops after two retries without a fallback", async () => {
		const h = await createHarness({ settings: { retry: { maxRetries: 10, baseDelayMs: 1 } } });
		harnesses.push(h);
		h.setResponses(
			Array.from({ length: 3 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: disconnect })),
		);
		await h.session.prompt("test");
		expect(h.faux.state.callCount).toBe(3);
		expect(h.eventsOfType("auto_retry_start").map((e) => [e.attempt, e.delayMs])).toEqual([
			[1, 1],
			[2, 2],
		]);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, attempt: 2, finalError: disconnect }]);
		expect(h.session.messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: disconnect });
		expect(h.eventsOfType("agent_settled")).toMatchObject([{ outcome: "error" }]);
	});

	it.each([
		{ content: [fauxToolCall("write", { path: "file", content: "once" })] },
		{ content: [{ type: "text" as const, text: "partial" }] },
		{ content: [fauxThinking("partial")] },
	])("never retries after output $content", async ({ content }) => {
		const h = await createHarness({ settings: { retry: { baseDelayMs: 1 } } });
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage(content, { stopReason: "error", errorMessage: disconnect })]);
		await h.session.prompt("test");
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
		expect(h.eventsOfType("agent_end")).toMatchObject([{ willRetry: false }]);
		expect(h.eventsOfType("tool_execution_start")).toEqual([]);
	});
	it.each([
		{ content: [fauxToolCall("write", { path: "file", content: "once" })] },
		{ content: [{ type: "text" as const, text: " " }] },
		{ content: [fauxThinking("partial")] },
	])("remembers streamed output even when the terminal error discards it: $content", async ({ content }) => {
		const h = await createHarness({
			models: [{ id: "primary" }, { id: "alternate" }],
			settings: { retry: { baseDelayMs: 1, fallbackModel: "faux/alternate" } },
		});
		harnesses.push(h);
		const original = h.session.agent.streamFunction;
		h.session.agent.streamFunction = (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				const source = await original(model, context, options);
				for await (const event of source) {
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
		h.setResponses([fauxAssistantMessage(content, { stopReason: "error", errorMessage: disconnect })]);
		await h.session.prompt("test");
		expect(h.session.messages.at(-1)).toMatchObject({ content: [], usage: { output: 0 }, stopReason: "error" });
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
		expect(h.eventsOfType("tool_execution_start")).toEqual([]);
	});
});
