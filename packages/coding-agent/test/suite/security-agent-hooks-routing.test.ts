import type { AfterToolCallContext, AgentTool, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolDefinitionFromAgentTool } from "../../src/core/tools/tool-definition-wrapper.ts";
import { type ModelRouteRequest, VIRTUAL_MODEL_STATE_ENTRY } from "../../src/core/virtual-models.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness, type HarnessOptions } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("SDK Agent hooks on direct and Codemode routes", () => {
	// #2241 F1: exercise the installed public hooks, not a private dispatcher or a mocked sandbox.
	it.each(["direct", "nested"] as const)(
		"keeps authorization, redaction and allow ordering on %s calls",
		async (route) => {
			const phases: string[] = [];
			const executions: string[] = [];
			const metadata: Array<{ id: string; parent?: string; issuer: string; signal?: AbortSignal }> = [];
			const schema = Type.Object({ action: Type.String() });
			const guarded: AgentTool<typeof schema> = {
				name: "guarded",
				label: "Guarded",
				description: "A host-authorized tool",
				parameters: schema,
				outputSchema: Type.Object({ secret: Type.String() }),
				execute: async (_id, { action }) => {
					phases.push("execute");
					executions.push(action);
					return {
						content: [{ type: "text", text: "secret-value" }],
						details: { secret: "secret-value" },
						structuredContent: { secret: "secret-value" },
					};
				},
			};
			const harness = await createHarness({
				tools: [],
				initialActiveToolNames: ["guarded", "codemode"],
				extensionFactories: [
					createCodemodeExtension(),
					(pi) => {
						pi.registerTool(createToolDefinitionFromAgentTool(guarded));
						pi.on("tool_call", (event) => {
							if (event.toolName !== "guarded") return;
							phases.push("extension-call");
							expect(event.parentToolCallId).toBe(route === "nested" ? "parent" : undefined);
						});
						pi.on("tool_result", (event) => {
							if (event.toolName !== "guarded") return;
							phases.push("extension-result");
							expect(event.parentToolCallId).toBe(route === "nested" ? "parent" : undefined);
							return { details: { extension: true } };
						});
					},
				],
			});
			harnesses.push(harness);
			const agent = harness.session.agent;
			const sessionBefore = agent.beforeToolCall;
			const sessionAfter = agent.afterToolCall;
			let beforeCount = 0;
			let afterCount = 0;
			agent.beforeToolCall = async (context, signal) => {
				if (context.toolCall.name !== "guarded") return sessionBefore?.(context, signal);
				beforeCount++;
				phases.push("host-before");
				metadata.push({
					id: context.toolCall.id,
					parent: context.parentToolCallId,
					issuer: context.assistantMessage.content.find((block) => block.type === "toolCall")?.name ?? "",
					signal,
				});
				const result = await sessionBefore?.(context, signal);
				if (result?.block) return result;
				return (context.args as { action: string }).action === "deny"
					? { block: true, reason: "host denied guarded" }
					: result;
			};
			agent.afterToolCall = async (context, signal) => {
				if (context.toolCall.name !== "guarded") return sessionAfter?.(context, signal);
				afterCount++;
				phases.push("host-after");
				expect(context.parentToolCallId).toBe(route === "nested" ? "parent" : undefined);
				const result = await sessionAfter?.(context, signal);
				expect(result?.details).toEqual({ extension: true });
				return (context.args as { action: string }).action === "redact"
					? {
							...result,
							content: [{ type: "text", text: "host-redacted" }],
							details: { redacted: true },
							structuredContent: undefined,
						}
					: result;
			};

			for (const action of ["deny", "redact", "allow"]) {
				phases.length = 0;
				harness.setResponses([
					fauxAssistantMessage(
						fauxToolCall(
							route === "direct" ? "guarded" : "codemode",
							route === "direct" ? { action } : { code: `return await tools.guarded({ action: "${action}" });` },
							{ id: route === "direct" ? "direct" : "parent" },
						),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt(action);
				const result = getToolResult(harness, route === "direct" ? "guarded" : "codemode");
				expect(result.isError).toBe(action === "deny");
				const text = getMessageText(result);
				if (action === "deny") {
					expect(text).toContain("host denied guarded");
					expect(phases).toEqual(["host-before", "extension-call"]);
				} else {
					expect(phases).toEqual(["host-before", "extension-call", "execute", "host-after", "extension-result"]);
					expect(text).toContain(action === "redact" ? "host-redacted" : "secret-value");
				}
				if (action !== "allow") expect(JSON.stringify(result)).not.toContain("secret-value");
			}
			expect(executions).toEqual(["redact", "allow"]);
			expect(beforeCount).toBe(3);
			expect(afterCount).toBe(2);
			expect(metadata.map(({ id, parent, issuer }) => ({ id, parent, issuer }))).toEqual(
				Array.from({ length: 3 }, () => ({
					id: route === "direct" ? "direct" : "parent/1",
					parent: route === "nested" ? "parent" : undefined,
					issuer: route === "direct" ? "guarded" : "codemode",
				})),
			);
			expect(metadata.every(({ signal }) => signal !== undefined && !signal.aborted)).toBe(true);
		},
	);

	// #2241 F1: replacing (rather than wrapping) a public hook must also govern both routes.
	it.each(["direct", "nested"] as const)("uses SDK-installed replacement hooks on %s calls", async (route) => {
		let executed = 0;
		const before: BeforeToolCallContext[] = [];
		const after: AfterToolCallContext[] = [];
		const schema = Type.Object({ deny: Type.Boolean() });
		const harness = await createHarness({
			tools: [],
			initialActiveToolNames: ["guarded", "codemode"],
			extensionFactories: [
				createCodemodeExtension(),
				(pi) =>
					pi.registerTool({
						name: "guarded",
						label: "Guarded",
						description: "Guarded",
						parameters: schema,
						execute: async () => {
							executed++;
							return { content: [{ type: "text", text: "secret" }], details: {} };
						},
					}),
			],
		});
		harnesses.push(harness);
		harness.session.agent.beforeToolCall = async (context) => {
			if (context.toolCall.name !== "guarded") return;
			before.push(context);
			return (context.args as { deny: boolean }).deny ? { block: true, reason: "SDK denied" } : undefined;
		};
		harness.session.agent.afterToolCall = async (context) => {
			if (context.toolCall.name !== "guarded") return;
			after.push(context);
			return { content: [{ type: "text", text: "SDK redacted" }] };
		};
		for (const deny of [true, false]) {
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall(
						route === "direct" ? "guarded" : "codemode",
						route === "direct" ? { deny } : { code: `return await tools.guarded({ deny: ${deny} });` },
						{ id: "caller" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			const result = getToolResult(harness, route === "direct" ? "guarded" : "codemode");
			expect(result.isError).toBe(deny);
			expect(getMessageText(result)).toContain(deny ? "SDK denied" : "SDK redacted");
			expect(JSON.stringify(result)).not.toContain("secret");
		}
		expect(executed).toBe(1);
		expect(before).toHaveLength(2);
		expect(after).toHaveLength(1);
		expect([...before, ...after].map((context) => context.parentToolCallId)).toEqual(
			Array.from({ length: 3 }, () => (route === "nested" ? "caller" : undefined)),
		);
	});
});

async function createRoutedHarness(
	route: (
		request: ModelRouteRequest,
		harness: Harness,
	) => Promise<ReturnType<typeof physicalRoute>> | ReturnType<typeof physicalRoute>,
	options: HarnessOptions = {},
): Promise<Harness> {
	const harness = await createHarness({
		...options,
		models: [
			{ id: "large", contextWindow: 50_000, maxTokens: 4000 },
			{ id: "small", contextWindow: 1000, maxTokens: 256 },
		],
		tools: [],
		settings: {
			compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 100 },
			retry: { enabled: false },
		},
	});
	harnesses.push(harness);
	const runtime = harness.session.modelRuntime;
	runtime.registerVirtualModel({
		provider: "router",
		id: "auto",
		name: "Auto",
		contextWindow: 50_000,
		route: (request) => route(request, harness),
	});
	harness.session.agent.streamFunction = (model, context, streamOptions) =>
		runtime.streamSimple(model, context, streamOptions);
	await harness.session.setModel(runtime.getModel("router", "auto")!);
	return harness;
}

function physicalRoute(harness: Harness, id: string, state?: unknown) {
	return { model: harness.session.modelRuntime.getPhysicalModel("faux", id)!, thinkingLevel: "off" as const, state };
}

function routeStates(harness: Harness) {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === VIRTUAL_MODEL_STATE_ENTRY);
}

describe("cancelled virtual routing and originating compaction signals", () => {
	// #2241 F10: release an actual router fallback only after the public session aborts.
	it.each([false, true])(
		"fences paused routing before publication or dispatch (SDK resolver override: %s)",
		async (overrideResolver) => {
			const paused = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let calls = 0;
			let routingSignal: AbortSignal | undefined;
			const harness = await createRoutedHarness(async (request, current) => {
				if (request.reason === "direct" || ++calls === 1) return physicalRoute(current, "large");
				routingSignal = request.signal;
				paused.resolve();
				await release.promise;
				return physicalRoute(current, "small", { fallback: true });
			});
			const runtime = harness.session.modelRuntime;
			if (overrideResolver) {
				// A host-supplied resolver can omit cancellation. The session still owns its publication fence.
				const resolve = runtime.resolveModel.bind(runtime);
				vi.spyOn(runtime, "resolveModel").mockImplementation((model, messages, options) =>
					resolve(model, messages, { ...options, signal: undefined }),
				);
			}
			harness.setResponses([fauxAssistantMessage("y".repeat(8000)), fauxAssistantMessage("must not be requested")]);
			await harness.session.prompt("first");
			expect(harness.faux.state.callCount).toBe(1);
			const running = harness.session.prompt("next");
			await paused.promise;
			const beforeCancel = harness.sessionManager.getEntries().length;
			const cancelled = harness.session.abort();
			if (!overrideResolver) expect(routingSignal?.aborted).toBe(true);
			release.resolve();
			await Promise.all([running, cancelled]);

			expect(routeStates(harness)).toHaveLength(0);
			expect(harness.eventsOfType("entry_appended")).toHaveLength(0);
			expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.getPendingResponseCount()).toBe(1);
			// Normal aborted lifecycle publication is retained; no router state, summary or extra input is appended.
			expect(harness.sessionManager.getEntries().slice(beforeCancel)).toEqual([
				expect.objectContaining({
					type: "message",
					message: expect.objectContaining({ role: "assistant", stopReason: "aborted" }),
				}),
			]);
			expect(harness.eventsOfType("agent_settled").at(-1)?.outcome).toBe("aborted");
			expect(harness.session.isIdle).toBe(true);
		},
	);

	// #2241 F10: the public runtime rejects a cancelled fallback without touching the session/provider.
	it("rejects a late fallback from ModelRuntime.resolveModel", async () => {
		const paused = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const harness = await createRoutedHarness(async (_request, current) => {
			paused.resolve();
			await release.promise;
			return physicalRoute(current, "small", { cancelled: true });
		});
		const controller = new AbortController();
		const before = harness.sessionManager.getEntries();
		const resolving = harness.session.modelRuntime.resolveModel(harness.session.model!, [], {
			reason: "direct",
			thinkingLevel: "off",
			signal: controller.signal,
		});
		const rejected = expect(resolving).rejects.toMatchObject({ name: "AbortError" });
		await paused.promise;
		controller.abort();
		release.resolve();
		await rejected;
		expect(harness.sessionManager.getEntries()).toEqual(before);
		expect(harness.faux.state.callCount).toBe(0);
	});

	// #2241 F10: ordinary live routing still stores state, summarizes, then sends the smaller-model request.
	it("keeps non-aborted smaller-model routing and manual compaction working", async () => {
		const reasons: string[] = [];
		let turns = 0;
		const harness = await createRoutedHarness((request, current) => {
			reasons.push(request.reason);
			return physicalRoute(
				current,
				request.reason === "direct" || ++turns === 1 ? "large" : "small",
				request.reason === "direct" ? undefined : { turn: turns },
			);
		});
		const dispatched: string[] = [];
		harness.setResponses([
			fauxAssistantMessage("y".repeat(8000)),
			(_context, options, _state, model) => {
				dispatched.push(`summary:${model.id}`);
				expect(options?.signal?.aborted).toBe(false);
				return fauxAssistantMessage("summary");
			},
			(_context, _options, _state, model) => {
				dispatched.push(`answer:${model.id}`);
				expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
				return fauxAssistantMessage("small answer");
			},
		]);
		await harness.session.prompt("first");
		await harness.session.prompt("next");
		expect(dispatched).toEqual(["summary:large", "answer:small"]);
		expect(reasons).toEqual(["user", "user", "direct"]);
		expect(routeStates(harness)).toHaveLength(2);
		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold"]);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", model: "small", stopReason: "stop" });
		harness.setResponses([fauxAssistantMessage("manual summary"), fauxAssistantMessage("manual prefix")]);
		const result = await harness.session.compact();
		expect(result.summary).toContain("manual");
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ reason: "manual", aborted: false });
		expect(routeStates(harness)).toHaveLength(2);
	});

	// #2241 F10: Agent.abort() must cancel auto-compaction even without session.abortCompaction().
	it("links in-flight automatic compaction to Agent cancellation and leaves later manual compaction independent", async () => {
		const paused = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let compactionSignal: AbortSignal | undefined;
		let turns = 0;
		const harness = await createRoutedHarness(
			(request, current) => physicalRoute(current, request.reason === "direct" || ++turns === 1 ? "large" : "small"),
			{
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							if (event.reason === "manual") return;
							compactionSignal = event.signal;
							paused.resolve();
							await release.promise;
							return {
								compaction: {
									summary: "must not append",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				],
			},
		);
		harness.setResponses([fauxAssistantMessage("y".repeat(8000)), fauxAssistantMessage("manual summary")]);
		await harness.session.prompt("first");
		const running = harness.session.prompt("next");
		await paused.promise;
		harness.session.agent.abort();
		expect(compactionSignal?.aborted).toBe(true);
		release.resolve();
		await running;
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true, result: undefined });
		expect(harness.eventsOfType("agent_settled").at(-1)?.outcome).toBe("aborted");
		expect(harness.session.isIdle).toBe(true);
		const result = await harness.session.compact();
		expect(result.summary).toContain("manual summary");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
	});
});
