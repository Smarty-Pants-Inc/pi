import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../../src/core/compaction/utils.ts";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getToolResult } from "./harness.ts";

const result = { content: [], details: { credential: "fake-secret" } };
const leaf: AgentTool = {
	name: "leaf",
	label: "leaf",
	description: "leaf",
	parameters: Type.Object({}),
	execute: async () => result,
};
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const image: ImageContent = { type: "image", data: "ZmFrZQ==", mimeType: "image/png" };

for (const hook of ["public", "extension"] as const) {
	for (const nested of [false, true]) {
		// PR #131 F01: direct and ordinary nested public/extension redaction reaches end events and journal.
		it(`persists ${hook} details:null redaction for ${nested ? "nested" : "direct"} calls`, async () => {
			const harness = await createHarness({
				persistSession: true,
				tools: [leaf],
				extensionFactories: [
					(pi) => {
						pi.registerTool({
							name: "parent",
							label: "parent",
							description: "parent",
							parameters: Type.Object({}),
							async execute(_id, _args, _signal, _update, ctx) {
								const outcome = await ctx.executeTool("leaf", {});
								return outcome.result;
							},
						});
						if (hook === "extension") pi.on("tool_result", () => ({ details: null }));
					},
				],
			});
			if (hook === "public") harness.session.agent.afterToolCall = async () => ({ details: null });
			try {
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall(nested ? "parent" : "leaf", {}), { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt("go");
				const ends = harness.eventsOfType("tool_execution_end");
				expect(ends).toHaveLength(nested ? 2 : 1);
				expect(ends.every((event) => event.result.details === null)).toBe(true);
				const reopened = SessionManager.open(harness.sessionManager.getSessionFile()!);
				expect(reopened.buildSessionContext().messages.filter((m) => m.role === "toolResult")).toMatchObject([
					{ details: null },
				]);
				expect(JSON.stringify(ends)).not.toContain("fake-secret");
			} finally {
				harness.session.dispose();
				harness.faux.unregister();
			}
		});
	}
}

// PR #131 F12: session override conversion must preserve prototype/private preparation and execution.
it("preserves class AgentTool override receivers", async () => {
	class PrivateTool implements AgentTool {
		name = "leaf";
		label = "leaf";
		description = "leaf";
		parameters = Type.Object({ value: Type.Number() });
		#value = 11;
		get executionMode(): "sequential" {
			return "sequential";
		}
		prepareArguments() {
			return { value: this.#value };
		}
		async execute(_id: string, args: unknown) {
			return { content: [], details: (args as { value: number }).value + this.#value };
		}
	}
	const harness = await createHarness({ tools: [new PrivateTool()] });
	try {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("leaf", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(getToolResult(harness, "leaf")).toMatchObject({ isError: false, details: 22 });
	} finally {
		harness.session.dispose();
		harness.faux.unregister();
	}
});
// PR #131 F12: extension ToolDefinition prototype methods also retain their original receiver.
it("preserves class extension definition receivers and nested admission", async () => {
	class PrivateDefinition implements ToolDefinition {
		name = "leaf";
		label = "leaf";
		description = "leaf";
		parameters = Type.Object({ value: Type.Number() });
		#value = 13;
		get executionMode(): "sequential" {
			return "sequential";
		}
		prepareArguments() {
			return { value: this.#value };
		}
		async execute(_id: string, args: unknown) {
			return { content: [], details: (args as { value: number }).value + this.#value };
		}
	}
	const harness = await createHarness({
		tools: [],
		extensionFactories: [
			(pi) => {
				pi.registerTool(new PrivateDefinition());
				pi.registerTool({
					name: "parent",
					label: "parent",
					description: "parent",
					parameters: Type.Object({}),
					async execute(_id, _args, _signal, _update, ctx) {
						return (await ctx.executeTool("leaf", {})).result;
					},
				});
			},
		],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("parent", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(getToolResult(harness, "parent")).toMatchObject({ isError: false, details: 26 });
		expect(harness.eventsOfType("tool_execution_end").find((event) => event.parentToolCallId)).toMatchObject({
			isError: false,
			result: { details: 26 },
		});
	} finally {
		harness.session.dispose();
		harness.faux.unregister();
	}
});

// PR #131 F09: cancellation at a physical tool boundary above threshold cannot admit compaction.
it("does not start physical automatic compaction after tool-turn cancellation", async () => {
	const harness = await createHarness({
		tools: [
			{ ...leaf, execute: async () => ({ content: [{ type: "text", text: "x".repeat(20000) }], details: {} }) },
		],
		models: [{ id: "tiny", contextWindow: 5000, maxTokens: 100 }],
		settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 } },
	});
	const append = vi.spyOn(harness.sessionManager, "appendCompaction");
	const originalStream = harness.session.agent.streamFunction;
	let summarizationCalls = 0;
	harness.session.agent.streamFunction = (model, context, options) => {
		if (
			context.messages.some(
				(message) => message.role === "system" && message.content === SUMMARIZATION_SYSTEM_PROMPT,
			)
		)
			summarizationCalls++;
		return originalStream(model, context, options);
	};
	try {
		harness.setResponses([fauxAssistantMessage("seed")]);
		await harness.session.prompt("seed");
		harness.setResponses([
			() => {
				const message = fauxAssistantMessage(fauxToolCall("leaf", {}), { stopReason: "toolUse" });
				message.usage = { ...message.usage, input: 4500, totalTokens: 4500 };
				return message;
			},
			fauxAssistantMessage("unwanted compaction"),
			fauxAssistantMessage("done"),
		]);
		harness.session.subscribe((event) => {
			if (event.type === "turn_end") harness.session.agent.abort();
		});
		await harness.session.prompt("go");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(append).not.toHaveBeenCalled();
		expect(summarizationCalls).toBe(0);
		expect(harness.getPendingResponseCount()).toBeGreaterThanOrEqual(1);
	} finally {
		append.mockRestore();
		harness.session.dispose();
		harness.faux.unregister();
	}
});

for (const behavior of ["steer", "followUp"] as const) {
	for (const publication of ["message_start", "message_end"] as const) {
		// PR #131 F13: accepted queued text/images survive throwing publication subscribers and reopen.
		it(`journals ${behavior} text/images before throwing ${publication}`, async () => {
			const entered = deferred();
			const release = deferred();
			const harness = await createHarness({ persistSession: true, tools: [] });
			let run: Promise<unknown> | undefined;
			try {
				harness.setResponses([
					async () => {
						entered.resolve();
						await release.promise;
						return fauxAssistantMessage("first");
					},
					fauxAssistantMessage("second"),
				]);
				run = harness.session.prompt("initial");
				await entered.promise;
				await harness.session[behavior]("queued", [image]);
				harness.session.subscribe((event) => {
					if (
						event.type === publication &&
						event.message.role === "user" &&
						Array.isArray(event.message.content) &&
						event.message.content.some((part) => part.type === "text" && part.text === "queued")
					)
						throw new Error("subscriber failed");
				});
				release.resolve();
				await run;
				const reopened = SessionManager.open(harness.sessionManager.getSessionFile()!);
				expect(
					reopened
						.buildSessionContext()
						.messages.find(
							(message) =>
								message.role === "user" &&
								Array.isArray(message.content) &&
								message.content.some((part) => part.type === "text" && part.text === "queued"),
						),
				).toMatchObject({ content: [{ type: "text", text: "queued" }, image] });
				expect(harness.session.agent.peekQueuedMessages()).toHaveLength(0);
			} finally {
				release.resolve();
				if (run) await run;
				harness.session.dispose();
				harness.faux.unregister();
			}
		});
	}
	// PR #131 F13: a definite failed append leaves both queues owning exact accepted text/images.
	it(`retains ${behavior} input when journal admission throws before append`, async () => {
		const entered = deferred();
		const release = deferred();
		const harness = await createHarness({ persistSession: true, tools: [] });
		const append = harness.sessionManager.appendMessage.bind(harness.sessionManager);
		let run: Promise<unknown> | undefined;
		const spy = vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation((message) => {
			if (
				message.role === "user" &&
				Array.isArray(message.content) &&
				message.content.some((part) => part.type === "text" && part.text === "queued")
			)
				throw new Error("append refused");
			return append(message);
		});
		try {
			harness.setResponses([
				async () => {
					entered.resolve();
					await release.promise;
					return fauxAssistantMessage("first");
				},
				fauxAssistantMessage("second"),
			]);
			run = harness.session.prompt("initial");
			await entered.promise;
			await harness.session[behavior]("queued", [image]);
			release.resolve();
			await run;
			expect(harness.session.agent.peekQueuedMessages()).toMatchObject([
				{ content: [{ type: "text", text: "queued" }, image] },
			]);
			expect(
				behavior === "steer" ? harness.session.getSteeringMessages() : harness.session.getFollowUpMessages(),
			).toEqual(["queued"]);
			spy.mockRestore();
			harness.setResponses([fauxAssistantMessage("retried"), fauxAssistantMessage("done")]);
			await harness.session.prompt("retry");
			const reopened = SessionManager.open(harness.sessionManager.getSessionFile()!);
			expect(
				reopened
					.buildSessionContext()
					.messages.filter(
						(message) =>
							message.role === "user" &&
							Array.isArray(message.content) &&
							message.content.some((part) => part.type === "text" && part.text === "queued"),
					),
			).toMatchObject([{ content: [{ type: "text", text: "queued" }, image] }]);
		} finally {
			release.resolve();
			if (run) await run;
			spy.mockRestore();
			harness.session.dispose();
			harness.faux.unregister();
		}
	});
}

// PR #131 F09: a physical automatic compaction already preparing retains its initiating run signal.
it("cancels physical automatic compaction preparation but leaves later manual compaction independent", async () => {
	const entered = deferred();
	const release = deferred();
	let hookSignal: AbortSignal | undefined;
	const harness = await createHarness({
		tools: [
			{ ...leaf, execute: async () => ({ content: [{ type: "text", text: "x".repeat(20000) }], details: {} }) },
		],
		models: [{ id: "tiny", contextWindow: 5000, maxTokens: 100 }],
		settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => {
					hookSignal = event.signal;
					entered.resolve();
					await release.promise;
					return {
						compaction: {
							summary: "offline summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
			},
		],
	});
	const append = vi.spyOn(harness.sessionManager, "appendCompaction");
	let run: Promise<unknown> | undefined;
	try {
		harness.setResponses([fauxAssistantMessage("seed")]);
		await harness.session.prompt("seed");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("leaf", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		run = harness.session.prompt("go");
		await entered.promise;
		harness.session.agent.abort();
		const originWasCancelled = hookSignal?.aborted;
		release.resolve();
		await run;
		expect(originWasCancelled).toBe(true);
		expect(append).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(2);
		await harness.session.compact();
		expect(hookSignal?.aborted).toBe(false);
		expect(append).toHaveBeenCalledTimes(1);
	} finally {
		release.resolve();
		if (run) await run;
		append.mockRestore();
		harness.session.dispose();
		harness.faux.unregister();
	}
});

// PR #131 F13: an append that throws after publication is uncertain, not permission to replay accepted input.
it("retains and fail-closes an uncertain queued append without replay", async () => {
	const entered = deferred();
	const release = deferred();
	const harness = await createHarness({ persistSession: true, tools: [] });
	const original = harness.sessionManager.appendMessage.bind(harness.sessionManager);
	let attempts = 0;
	const append = vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation((message) => {
		const id = original(message);
		if (
			message.role === "user" &&
			Array.isArray(message.content) &&
			message.content.some((part) => part.type === "text" && part.text === "uncertain")
		) {
			attempts++;
			throw new Error("uncertain append");
		}
		return id;
	});
	let run: Promise<unknown> | undefined;
	try {
		harness.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("second"),
		]);
		run = harness.session.prompt("initial");
		await entered.promise;
		await harness.session.followUp("uncertain", [image]);
		release.resolve();
		await run;
		expect(harness.session.agent.peekQueuedMessages()).toMatchObject([
			{ content: [{ type: "text", text: "uncertain" }, image] },
		]);
		expect(harness.session.getFollowUpMessages()).toEqual(["uncertain"]);
		const providerCalls = harness.faux.state.callCount;
		await expect(harness.session.prompt("retry")).rejects.toThrow("uncertain append");
		expect(harness.faux.state.callCount).toBe(providerCalls);
		expect(attempts).toBe(1);
		const reopened = SessionManager.open(harness.sessionManager.getSessionFile()!);
		expect(
			reopened
				.buildSessionContext()
				.messages.filter(
					(message) =>
						message.role === "user" &&
						Array.isArray(message.content) &&
						message.content.some((part) => part.type === "text" && part.text === "uncertain"),
				),
		).toHaveLength(1);
	} finally {
		release.resolve();
		if (run) await run;
		append.mockRestore();
		harness.session.dispose();
		harness.faux.unregister();
	}
});

// PR #131 F13 control: queued message_end replacement remains supported after early journal custody.
it("preserves queued message_end replacement on reopen without duplicating accepted input", async () => {
	const entered = deferred();
	const release = deferred();
	const harness = await createHarness({
		persistSession: true,
		tools: [],
		extensionFactories: [
			(pi) => {
				pi.on("message_end", (event) => {
					if (
						event.message.role === "user" &&
						Array.isArray(event.message.content) &&
						event.message.content.some((part) => part.type === "text" && part.text === "queued")
					)
						return { message: { ...event.message, content: [{ type: "text", text: "replaced" }, image] } };
				});
			},
		],
	});
	let run: Promise<unknown> | undefined;
	try {
		harness.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("second"),
		]);
		run = harness.session.prompt("initial");
		await entered.promise;
		await harness.session.steer("queued", [image]);
		release.resolve();
		await run;
		const reopened = SessionManager.open(harness.sessionManager.getSessionFile()!);
		const users = reopened.buildSessionContext().messages.filter((message) => message.role === "user");
		expect(users).toHaveLength(2);
		expect(users[1]).toMatchObject({ content: [{ type: "text", text: "replaced" }, image] });
	} finally {
		release.resolve();
		if (run) await run;
		harness.session.dispose();
		harness.faux.unregister();
	}
});

// PR #131 F18: a refused shared-to-exclusive upgrade also terminates its published start.
it("finalizes refused nested lease admission without execution or result hooks", async () => {
	const release = deferred();
	let effects = 0;
	let resultHooks = 0;
	const harness = await createHarness({
		persistSession: true,
		tools: [],
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "parent",
					label: "parent",
					description: "parent",
					parameters: Type.Object({}),
					async execute(_id, _args, _signal, _update, ctx) {
						await ctx.executeTool("leaf", {}).catch(() => {});
						return result;
					},
				});
				pi.registerTool({
					name: "leaf",
					label: "leaf",
					description: "leaf",
					parameters: Type.Object({}),
					executionMode: "sequential",
					async execute() {
						effects++;
						return result;
					},
				});
				pi.on("tool_result", (event) => {
					if (event.toolName === "leaf") resultHooks++;
				});
			},
		],
	});
	const blocker = harness.session.agent.toolCallQueue.run({ id: "unrelated", exclusive: false }, async () => {
		await release.promise;
	});
	let run: Promise<unknown> | undefined;
	try {
		harness.session.agent.toolExecution = "parallel";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("parent", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		run = harness.session.prompt("go");
		await run;
		const ends = harness.eventsOfType("tool_execution_end").filter((event) => event.parentToolCallId);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			isError: true,
			result: { content: [{ type: "text", text: "TOOL_QUEUE_CONFLICTING_REENTRY" }] },
		});
		expect(effects).toBe(0);
		expect(resultHooks).toBe(0);
		expect(getToolResult(harness, "parent").nestedCalls).toMatchObject({
			complete: true,
			calls: [{ status: "error" }],
		});
	} finally {
		release.resolve();
		await blocker;
		if (run) await run;
		harness.session.dispose();
		harness.faux.unregister();
	}
});

// PR #131 F18: an accepted nested start waiting for an exclusive lease gets one terminal error, no child/hook effects.
it("finalizes a cancelled queued nested start exactly once and persists its terminal record", async () => {
	const started = deferred();
	const blockerEntered = deferred();
	const release = deferred();
	let childCalls = 0;
	let childHooks = 0;
	const harness = await createHarness({
		persistSession: true,
		tools: [],
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "parent",
					label: "parent",
					description: "parent",
					parameters: Type.Object({}),
					executionMode: "sequential",
					async execute(_id, _args, _signal, _update, ctx) {
						const blocker = ctx.executeTool("blocker", {});
						await blockerEntered.promise;
						const child = ctx.executeTool("leaf", {});
						await Promise.allSettled([blocker, child]);
						return result;
					},
				});
				pi.registerTool({
					name: "blocker",
					label: "blocker",
					description: "blocker",
					parameters: Type.Object({}),
					executionMode: "parallel",
					async execute() {
						blockerEntered.resolve();
						await release.promise;
						return { content: [], details: {} };
					},
				});
				pi.registerTool({
					name: "leaf",
					label: "leaf",
					description: "leaf",
					parameters: Type.Object({}),
					executionMode: "sequential",
					async execute() {
						childCalls++;
						return result;
					},
				});
				pi.on("tool_result", (event) => {
					if (event.toolName === "leaf") childHooks++;
				});
			},
		],
	});
	let run: Promise<unknown> | undefined;
	try {
		harness.session.agent.toolExecution = "parallel";
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.parentToolCallId && event.toolName === "leaf")
				started.resolve();
		});
		harness.setResponses([fauxAssistantMessage(fauxToolCall("parent", {}), { stopReason: "toolUse" })]);
		run = harness.session.prompt("go");
		await started.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(childCalls).toBe(0);
		expect(harness.eventsOfType("tool_execution_end").filter((event) => event.toolName === "leaf")).toHaveLength(0);
		const abort = harness.session.abort();
		release.resolve();
		await Promise.all([run, abort]);
		const ends = harness
			.eventsOfType("tool_execution_end")
			.filter((event) => event.parentToolCallId && event.toolName === "leaf");
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({ isError: true });
		expect(childCalls).toBe(0);
		expect(childHooks).toBe(0);
		const parent = getToolResult(harness, "parent");
		expect(parent.nestedCalls).toMatchObject({
			complete: true,
			calls: [
				{ name: "blocker", status: "ok" },
				{ name: "leaf", status: "error" },
			],
		});
		const reopened = SessionManager.open(harness.sessionManager.getSessionFile()!);
		expect(reopened.buildSessionContext().messages.find((message) => message.role === "toolResult")).toMatchObject({
			nestedCalls: {
				complete: true,
				calls: [
					{ name: "blocker", status: "ok" },
					{ name: "leaf", status: "error" },
				],
			},
		});
	} finally {
		release.resolve();
		if (run) await run;
		harness.session.dispose();
		harness.faux.unregister();
	}
});
