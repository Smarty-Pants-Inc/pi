import { readFileSync } from "node:fs";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

// smarty-dev#11900: the exact Codex wording is covered by dedicated tests; this suite keeps generic retry policy coverage.
const disconnect = "stream closed before response.completed";

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
		// smarty-dev#6730: reasoning followed by answer text or a tool call stays final.
		{ content: [fauxThinking("partial"), { type: "text" as const, text: "answer" }] },
		{ content: [fauxThinking("partial"), fauxToolCall("write", { path: "file", content: "once" })] },
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
		{ content: [fauxThinking("partial"), { type: "text" as const, text: " " }] },
	])("remembers streamed output even when the terminal error discards it: $content", async ({ content }) => {
		const h = await createHarness({
			models: [{ id: "primary" }, { id: "alternate" }],
			settings: { retry: { baseDelayMs: 1 } },
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
		expect(h.eventsOfType("tool_execution_start")).toEqual([]);
	});
});

// smarty-dev#6730: Luna streams reasoning summaries before its answer; a close during reasoning is restarted.
describe("reasoning-only premature stream recovery", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});
	const reasoning = { ...fauxThinking("planning the luna answer"), thinkingSignature: "rs_failed_attempt" };

	it("restarts and keeps the failed reasoning out of messages, events and the session file", async () => {
		const h = await createHarness({ persistSession: true, settings: { retry: { baseDelayMs: 1 } } });
		harnesses.push(h);
		const requests: string[] = [];
		h.setResponses(
			[
				fauxAssistantMessage([reasoning], { stopReason: "error", errorMessage: disconnect }),
				fauxAssistantMessage([fauxThinking("fresh reasoning"), { type: "text", text: "recovered" }]),
			].map((response) => (context) => {
				requests.push(JSON.stringify(context.messages));
				return response;
			}),
		);
		await h.session.prompt("test");

		expect(h.faux.state.callCount).toBe(2);
		expect(requests[1]).not.toContain("planning");
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([
			{ attempt: 1, maxAttempts: 2, errorMessage: disconnect },
		]);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
		expect(h.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(h.eventsOfType("agent_settled")).toMatchObject([{ outcome: "completed" }]);
		expect(h.session.getLastAssistantText()).toBe("recovered");
		// The failed attempt's message_end is a clean empty close, as for a close before any output.
		const ends = h.eventsOfType("message_end").filter((event) => event.message.role === "assistant");
		expect(ends.map((event) => event.message)).toMatchObject([
			{ stopReason: "error", content: [{ type: "thinking", thinking: "" }] },
			{ stopReason: "stop" },
		]);
		expect(JSON.stringify(h.session.messages)).not.toContain("planning");
		expect(h.session.messages.filter((m) => m.role === "assistant")).toMatchObject([{ stopReason: "stop" }]);

		const path = h.sessionManager.getSessionFile();
		expect(path).toBeDefined();
		const file = readFileSync(path!, "utf8");
		expect(file).not.toContain("planning");
		expect(file).not.toContain("rs_failed_attempt");
		const reopened = SessionManager.open(path!).buildSessionContext().messages;
		expect(reopened.filter((m) => m.role === "assistant")).toMatchObject([{ stopReason: "stop" }]);
	});

	it("restarts after streamed reasoning even when the terminal error discards it", async () => {
		const h = await createHarness({ settings: { retry: { baseDelayMs: 1 } } });
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
		h.setResponses([
			fauxAssistantMessage([reasoning], { stopReason: "error", errorMessage: disconnect }),
			fauxAssistantMessage("recovered"),
		]);
		await h.session.prompt("test");
		expect(h.faux.state.callCount).toBe(2);
		expect(h.session.getLastAssistantText()).toBe("recovered");
	});

	/** Rewrite the terminal error the way a provider can that drops streamed content. */
	const rewriteTerminalError = (h: Harness, rewrite: (error: AssistantMessage) => AssistantMessage) => {
		const original = h.session.agent.streamFunction;
		h.session.agent.streamFunction = (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				for await (const event of await original(model, context, options)) {
					stream.push(event.type === "error" ? { ...event, error: rewrite(event.error) } : event);
				}
				stream.end();
			});
			return stream;
		};
	};

	it("restarts after streamed reasoning when the terminal error drops content but reports output tokens", async () => {
		const h = await createHarness({ settings: { retry: { baseDelayMs: 1 } } });
		harnesses.push(h);
		rewriteTerminalError(h, (error) => ({ ...error, content: [], usage: { ...error.usage, output: 9 } }));
		h.setResponses([
			fauxAssistantMessage([reasoning], { stopReason: "error", errorMessage: disconnect }),
			fauxAssistantMessage("recovered"),
		]);
		await h.session.prompt("test");
		expect(h.faux.state.callCount).toBe(2);
		expect(h.session.getLastAssistantText()).toBe("recovered");
	});

	it.each([
		{ name: "answer text", block: { type: "text" as const, text: "visible answer" } },
		{ name: "tool call", block: fauxToolCall("write", { path: "file", content: "once" }) },
	])("never retries after streamed $name when the terminal error keeps only thinking", async ({ block }) => {
		const h = await createHarness({ settings: { retry: { baseDelayMs: 1 } } });
		harnesses.push(h);
		rewriteTerminalError(h, (error) => ({
			...error,
			content: error.content.filter((content) => content.type === "thinking"),
		}));
		h.setResponses([
			fauxAssistantMessage([reasoning, block], { stopReason: "error", errorMessage: disconnect }),
			fauxAssistantMessage("must not replay"),
		]);
		await h.session.prompt("test");
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
		expect(h.eventsOfType("tool_execution_start")).toEqual([]);
	});

	it("keeps the final failed reasoning once retries are exhausted", async () => {
		const h = await createHarness({ settings: { retry: { maxRetries: 1, baseDelayMs: 1 } } });
		harnesses.push(h);
		h.setResponses(
			Array.from({ length: 2 }, () =>
				fauxAssistantMessage([reasoning], { stopReason: "error", errorMessage: disconnect }),
			),
		);
		await h.session.prompt("test");
		expect(h.faux.state.callCount).toBe(2);
		expect(h.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, attempt: 1 }]);
		expect(h.session.messages.filter((m) => m.role === "assistant")).toMatchObject([
			{ stopReason: "error", content: [{ thinking: "planning the luna answer" }] },
		]);
	});

	it.each(["400 invalid_request_error: unsupported parameter", "503 overloaded"])(
		"keeps the output rule for other errors after reasoning: %s",
		async (errorMessage) => {
			const h = await createHarness({ settings: { retry: { baseDelayMs: 1 } } });
			harnesses.push(h);
			h.setResponses([
				fauxAssistantMessage([reasoning], { stopReason: "error", errorMessage }),
				fauxAssistantMessage("must not replay"),
			]);
			await h.session.prompt("test");
			expect(h.faux.state.callCount).toBe(1);
			expect(h.eventsOfType("auto_retry_start")).toEqual([]);
			expect(h.eventsOfType("agent_end")).toMatchObject([{ willRetry: false }]);
			expect(h.session.messages.at(-1)).toMatchObject({
				stopReason: "error",
				errorMessage,
				content: [{ thinking: "planning the luna answer" }],
			});
		},
	);
});

// smarty-dev#6730 (pi#171 review): reasoning of an attempt that is retried never reaches extensions or listeners.
describe("reasoning updates of a retried attempt", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	/** A harness whose extension and listener record assistant update kinds and thinking text, in order. */
	const recordingHarness = async (maxRetries = 3) => {
		const extension: string[] = [];
		const record = (log: string[], update: AssistantMessageEvent) => {
			if (update.type === "thinking_delta") log.push(`thinking:${update.delta}`);
			else if (update.type === "text_delta") log.push(`text:${update.delta}`);
		};
		const h = await createHarness({
			settings: { retry: { baseDelayMs: 1, maxRetries } },
			extensionFactories: [
				(pi) => {
					pi.on("message_update", (event) => record(extension, event.assistantMessageEvent));
				},
			],
		});
		harnesses.push(h);
		const listener = () => {
			const log: string[] = [];
			for (const event of h.eventsOfType("message_update")) record(log, event.assistantMessageEvent);
			return log;
		};
		return { h, extension, listener };
	};
	const joined = (log: string[], kind: string) =>
		log
			.filter((entry) => entry.startsWith(`${kind}:`))
			.map((entry) => entry.slice(kind.length + 1))
			.join("");

	it("drops the reasoning updates of a reasoning-only premature close", async () => {
		const { h, extension, listener } = await recordingHarness();
		h.setResponses([
			fauxAssistantMessage([fauxThinking("planning the luna answer")], {
				stopReason: "error",
				errorMessage: disconnect,
			}),
			fauxAssistantMessage([fauxThinking("fresh reasoning"), { type: "text", text: "recovered" }]),
		]);
		await h.session.prompt("test");
		expect(h.faux.state.callCount).toBe(2);
		for (const log of [extension, listener()]) {
			expect(joined(log, "thinking")).toBe("fresh reasoning");
			expect(joined(log, "text")).toBe("recovered");
		}
	});

	it("delivers reasoning before the answer, in order, for a completed stream", async () => {
		const { h, extension, listener } = await recordingHarness();
		const thinking = "first step, second step, third step";
		h.setResponses([fauxAssistantMessage([fauxThinking(thinking), { type: "text", text: "answer" }])]);
		await h.session.prompt("test");
		for (const log of [extension, listener()]) {
			expect(joined(log, "thinking")).toBe(thinking);
			expect(joined(log, "text")).toBe("answer");
			expect(log.findLastIndex((entry) => entry.startsWith("thinking:"))).toBeLessThan(
				log.findIndex((entry) => entry.startsWith("text:")),
			);
		}
	});

	it("delivers reasoning of a premature close after answer output, which is not retried", async () => {
		const { h, extension, listener } = await recordingHarness();
		h.setResponses([
			fauxAssistantMessage([fauxThinking("planning the luna answer"), { type: "text", text: "partial" }], {
				stopReason: "error",
				errorMessage: disconnect,
			}),
			fauxAssistantMessage("must not replay"),
		]);
		await h.session.prompt("test");
		expect(h.faux.state.callCount).toBe(1);
		for (const log of [extension, listener()]) {
			expect(joined(log, "thinking")).toBe("planning the luna answer");
			expect(joined(log, "text")).toBe("partial");
		}
	});

	it("delivers the reasoning of a final reasoning-only close once retries are exhausted", async () => {
		const { h, extension, listener } = await recordingHarness(0);
		h.setResponses([
			fauxAssistantMessage([fauxThinking("planning the luna answer")], {
				stopReason: "error",
				errorMessage: disconnect,
			}),
		]);
		await h.session.prompt("test");
		expect(h.faux.state.callCount).toBe(1);
		for (const log of [extension, listener()]) expect(joined(log, "thinking")).toBe("planning the luna answer");
	});
});
