import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, isRetryableAnthropicMidOutputFallback } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { type AnthropicOptions, stream as streamAnthropic } from "../../ai/src/api/anthropic-messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, type Harness, type HarnessOptions } from "./suite/harness.ts";

type SseEvent = { type: string; [key: string]: unknown };
type Fixture = SseEvent[] | { status: number };
type Block =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; signature: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

const requestedModel = "claude-opus-5";
const partialText = "discard this partial answer";
const partialThinking = "discard this partial reasoning";
const partialToolInput = "discard this unexecuted tool input";
const rawMarker = "record-only-provider-marker";
const markerError = "Anthropic performed an unsupported mid-output model fallback";

function messageStart(): SseEvent {
	return {
		type: "message_start",
		message: { id: "fixture-response", model: requestedModel, usage: { input_tokens: 12, output_tokens: 0 } },
	};
}

function contentEvents(blocks: Block[], offset = 0): SseEvent[] {
	return blocks.flatMap((block, i) => {
		const index = offset + i;
		const start =
			block.type === "text"
				? { ...block, text: "" }
				: block.type === "thinking"
					? { ...block, thinking: "" }
					: { ...block, input: {} };
		const delta =
			block.type === "text"
				? { type: "text_delta", text: block.text }
				: block.type === "thinking"
					? { type: "thinking_delta", thinking: block.thinking }
					: { type: "input_json_delta", partial_json: JSON.stringify(block.input) };
		return [
			{ type: "content_block_start", index, content_block: start },
			{ type: "content_block_delta", index, delta },
			{ type: "content_block_stop", index },
		];
	});
}

function fallbackEvent(index: number): SseEvent {
	return {
		type: "content_block_start",
		index,
		content_block: {
			type: "fallback",
			from: { model: requestedModel },
			to: { model: "older-model" },
			provider_field: rawMarker,
		},
	};
}

function finish(stopReason = "end_turn"): SseEvent[] {
	return [
		{ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	];
}

function success(text = "recovered answer"): SseEvent[] {
	return [messageStart(), ...contentEvents([{ type: "text", text }]), ...finish()];
}

function midOutput(blocks: Block[] = [{ type: "text", text: partialText }]): SseEvent[] {
	return [messageStart(), ...contentEvents(blocks), fallbackEvent(blocks.length)];
}

function toolResponse(content: string, id = "fixture-tool"): SseEvent[] {
	return [
		messageStart(),
		...contentEvents([{ type: "tool_use", id, name: "record", input: { content } }]),
		...finish("tool_use"),
	];
}

function assistantHistory(h: Harness): AssistantMessage[] {
	return h.sessionManager
		.getEntries()
		.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
}

function retryEntries(h: Harness) {
	return h.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "anthropic_fallback_retry");
}

describe("AgentSession Anthropic mid-output fallback replay", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length) await harnesses.pop()?.cleanup();
	});

	async function setup(
		fixtures: Fixture[],
		options: HarnessOptions = {},
		streamOptions: Partial<AnthropicOptions> = {},
	) {
		// The suite harness owns auth, tools, session setup and teardown. Only the response transport is fake:
		// AgentSession -> agent loop -> Anthropic SDK request -> real SSE parser -> owned error classification.
		const h = await createHarness({
			models: [{ id: requestedModel, reasoning: true }, { id: "alternate" }],
			settings: { compaction: { enabled: false }, retry: { maxRetries: 20, baseDelayMs: 1 } },
			...options,
		});
		harnesses.push(h);
		h.session.agent.state.model = { ...h.getModel(), api: "anthropic-messages" };
		const requests: Array<{
			provider: string;
			model: string;
			thinkingLevel: string;
			messages: string;
			sessionId?: string;
		}> = [];
		const payloads: string[] = [];
		h.session.agent.streamFunction = (model, context, requestOptions) => {
			requests.push({
				provider: model.provider,
				model: model.id,
				thinkingLevel: requestOptions?.reasoning ?? "off",
				messages: JSON.stringify(context.messages),
				sessionId: requestOptions?.sessionId,
			});
			const fixture = fixtures[requests.length - 1];
			return streamAnthropic({ ...model, api: "anthropic-messages", compat: undefined }, context, {
				...requestOptions,
				...streamOptions,
				apiKey: "fixture-key",
				maxRetries: 0,
				fetch: async (_input, init) => {
					payloads.push(String(init?.body));
					if (!fixture) throw new Error("Unexpected fixture request");
					if (!Array.isArray(fixture)) {
						return new Response(JSON.stringify({ error: { type: "api_error", message: "503 unavailable" } }), {
							status: fixture.status,
							headers: { "content-type": "application/json" },
						});
					}
					return new Response(
						fixture.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			});
		};
		return { h, requests, payloads };
	}

	// smarty-dev#2890: production thinking/text fallback loses the partial response, not the user's input.
	it("replays once on the same model, discards thinking and durably omits the failed partial", async () => {
		const { h, requests, payloads } = await setup(
			[
				midOutput([
					{ type: "thinking", thinking: partialThinking, signature: "partial-signature" },
					{ type: "text", text: partialText },
				]),
				success(),
			],
			{ persistSession: true },
		);

		await h.session.prompt("original user request");

		expect(requests.map(({ provider, model }) => ({ provider, model }))).toEqual([
			{ provider: "faux", model: requestedModel },
			{ provider: "faux", model: requestedModel },
		]);
		expect(requests[1]).toEqual(requests[0]);
		expect(payloads[1]).toBe(payloads[0]);
		expect(h.session.model?.id).toBe(requestedModel);
		expect(h.session.getLastAssistantText()).toBe("recovered answer");
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, maxAttempts: 1, delayMs: 1 }]);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
		expect(retryEntries(h)).toMatchObject([{ data: { requestedProvider: "faux", requestedModel, attempt: 1 } }]);
		expect(retryEntries(h)[0]).toHaveProperty("data", {
			requestedProvider: "faux",
			requestedModel,
			attempt: 1,
			retries: 1,
		});
		const failed = assistantHistory(h)[0];
		expect(failed.stopReason).toBe("error");
		expect(isRetryableAnthropicMidOutputFallback(failed)).toBe(true);
		expect(failed.fallback).toHaveLength(1);
		expect(failed.fallback?.[0].position).toBe("mid-output");
		expect(failed.content).toContainEqual({ type: "text", text: partialText });
		expect(failed.content.filter((block) => block.type === "thinking")).toEqual([{ type: "thinking", thinking: "" }]);
		expect(failed.diagnostics).toContainEqual(
			expect.objectContaining({ type: "anthropic_model_fallback", fallbackCount: 1 }),
		);
		const entries = h.sessionManager.getEntries();
		const failedEntry = entries.find((entry) => entry.type === "message" && entry.message === failed);
		expect(entries).toContainEqual(
			expect.objectContaining({ type: "context_edit", targetId: failedEntry?.id, replacement: null }),
		);
		expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
		const reopened = SessionManager.open(h.session.sessionFile!);
		for (const marker of [partialThinking, "partial-signature", partialText, rawMarker]) {
			expect(requests[1].messages).not.toContain(marker);
			expect(payloads[1]).not.toContain(marker);
			expect(JSON.stringify(reopened.buildSessionProjection().messages)).not.toContain(marker);
		}
		expect(readFileSync(h.session.sessionFile!, "utf8")).toContain("anthropic_fallback_retry");
		expect(JSON.stringify(reopened.getEntries())).not.toContain(partialThinking);
		expect(JSON.stringify(reopened.getEntries())).toContain(partialText);
	});

	// smarty-dev#2890: thinking alone counts as mid-output, and its held events must not survive recovery.
	it("drops held thinking-only output when replaying a marker failure", async () => {
		const { h, requests } = await setup([
			midOutput([{ type: "thinking", thinking: partialThinking, signature: "partial-signature" }]),
			success(),
		]);
		await h.session.prompt("test request");
		expect(requests).toHaveLength(2);
		expect(
			h.eventsOfType("message_update").filter((event) => event.assistantMessageEvent.type.startsWith("thinking_")),
		).toEqual([]);
		expect(JSON.stringify(assistantHistory(h))).not.toContain(partialThinking);
		expect(requests[1].messages).not.toContain(partialThinking);
		expect(h.session.getLastAssistantText()).toBe("recovered answer");
	});

	// smarty-dev#2890: a marker's fresh request is terminal on any failure, not another ordinary retry episode.
	it.each([
		{ name: "a second marker", failure: midOutput() },
		{ name: "an ordinary 503", failure: { status: 503 } },
	])("stops after $name despite a large budget and configured alternate", async ({ failure }) => {
		const { h, requests } = await setup([midOutput(), failure, success("must not be requested")], {
			settings: { retry: { maxRetries: 20, baseDelayMs: 1, fallbackModel: "faux/alternate" } },
		});
		await h.session.prompt("test request");
		expect(requests).toHaveLength(2);
		expect(requests.every((request) => request.model === requestedModel)).toBe(true);
		expect(h.session.model?.id).toBe(requestedModel);
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, maxAttempts: 1 }]);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, attempt: 1 }]);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
		expect(h.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(retryEntries(h)).toHaveLength(1);
	});

	// smarty-dev#2890: ordinary failures before the first marker retain their existing retry allowance.
	it("allows ordinary retries before the marker without extending its one-shot replay", async () => {
		const { h, requests } = await setup([{ status: 503 }, midOutput(), { status: 503 }, success()], {
			settings: { retry: { maxRetries: 20, baseDelayMs: 1, fallbackModel: "faux/alternate" } },
		});
		await h.session.prompt("test request");
		expect(requests).toHaveLength(3);
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([
			{ attempt: 1, maxAttempts: 20 },
			{ attempt: 2, maxAttempts: 2 },
		]);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, attempt: 2 }]);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
		expect(retryEntries(h)).toMatchObject([{ data: { requestedProvider: "faux", requestedModel, attempt: 2 } }]);
	});

	// smarty-dev#2890: request preparation (including virtual routing) must not substitute a replay's model.
	it("pins the failed request's model even when request preparation selects an alternate", async () => {
		let prepared = 0;
		const { h, requests } = await setup([midOutput(), success()], {
			prepareRequest: (request) => {
				prepared++;
				return { model: { ...request.model, id: prepared === 1 ? requestedModel : "alternate" } };
			},
		});
		await h.session.prompt("test request");
		expect(prepared).toBe(2);
		expect(requests.map((request) => request.model)).toEqual([requestedModel, requestedModel]);
		expect(h.session.model?.id).toBe(requestedModel);
	});

	// smarty-dev#2890: virtual selection stays virtual, but the marker replay must keep its physical model.
	it("retains a virtual route's physical model and non-default thinking level", async () => {
		const { h, requests } = await setup([midOutput(), success()]);
		h.modelRuntime.registerProvider("faux", {
			api: h.faux.api,
			apiKey: "faux-key",
			baseUrl: h.getModel().baseUrl,
			models: h.models.map((model) => ({ ...model, thinkingLevelMap: { xhigh: "xhigh" } })),
		});
		let routes = 0;
		h.modelRuntime.registerVirtualModel({
			provider: "faux",
			id: "router",
			name: "Router",
			route: () => ({ model: ++routes === 1 ? h.getModel() : h.getModel("alternate")!, thinkingLevel: "xhigh" }),
		});
		await h.modelRuntime.refresh({ allowNetwork: false });
		h.session.agent.state.model = h.modelRuntime.getModel("faux", "router")!;
		await h.session.prompt("test request");
		expect(routes).toBe(1);
		expect(requests.map((request) => request.model)).toEqual([requestedModel, requestedModel]);
		expect(requests.map((request) => request.thinkingLevel)).toEqual(["xhigh", "xhigh"]);
		expect(h.session.model?.id).toBe("router");
		expect(h.session.thinkingLevel).toBe("off");
		expect(retryEntries(h)).toMatchObject([{ data: { requestedProvider: "faux", requestedModel, attempt: 1 } }]);
	});

	// smarty-dev#2890: start markers are record + continue, not failures and not same-model retry consumption.
	it("records a start marker and continues the original stream", async () => {
		const { h, requests, payloads } = await setup([
			[
				messageStart(),
				fallbackEvent(0),
				...contentEvents([{ type: "text", text: "start fallback accepted" }], 1),
				...finish(),
			],
			success("next prompt"),
		]);
		await h.session.prompt("first request");
		expect(requests).toHaveLength(1);
		expect(h.session.getLastAssistantText()).toBe("start fallback accepted");
		const message = assistantHistory(h)[0];
		expect(message.fallback).toHaveLength(1);
		expect(message.fallback?.[0].position).toBe("start");
		expect(message.diagnostics).toContainEqual(
			expect.objectContaining({ type: "anthropic_model_fallback", fallbackCount: 1 }),
		);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
		expect(retryEntries(h)).toEqual([]);
		await h.session.prompt("second request");
		expect(payloads[1]).not.toContain(rawMarker);
	});

	// smarty-dev#4605 (F2): prove the real SDK exchange/reflection cannot reach actual session persistence.
	it("discards a START marker reflecting an SDK-managed federated credential before persisting", async () => {
		const { h } = await setup([], { persistSession: true });
		const identityTokenFile = join(h.tempDir, "identity.jwt");
		writeFileSync(identityTokenFile, "synthetic.session.identity");
		const credential = "synthetic-session-federation-token";
		const block = { type: "fallback", echo: credential, provider_field: rawMarker, content: "PRIVATE_CONTENT" };
		const serialized = JSON.stringify({ type: "fallback", echo: credential, provider_field: rawMarker });
		const paths: string[] = [];
		const payloads: string[] = [];
		const terminals: Array<Promise<AssistantMessage>> = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			paths.push(path);
			if (path === "/v1/oauth/token") {
				expect(await request.json()).toMatchObject({
					grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
					assertion: "synthetic.session.identity",
					federation_rule_id: "fdrl_synthetic_session",
					organization_id: "org-synthetic-session",
				});
				return Response.json({ access_token: credential, expires_in: 3600 });
			}
			expect(path).toBe("/v1/messages");
			expect(request.headers.get("authorization")).toBe(`Bearer ${credential}`);
			expect(request.headers.has("x-api-key")).toBe(false);
			payloads.push(await request.text());
			const fixture =
				payloads.length === 1
					? [
							messageStart(),
							{ type: "content_block_start", index: 0, content_block: block },
							{ type: "content_block_stop", index: 0 },
							...contentEvents([{ type: "text", text: "federated START accepted" }], 1),
							...finish(),
						]
					: success("next federated response");
			return new Response(
				fixture.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
				{ headers: { "content-type": "text/event-stream" } },
			);
		};
		// Keep the harness's faux route/auth in memory; only this adapter call selects Anthropic federation.
		// No injected or mocked SDK client: Pi constructs it and the SDK reads only our synthetic identity file.
		h.session.agent.streamFunction = (model, context, options) => {
			const stream = streamAnthropic(
				{
					...model,
					provider: "anthropic",
					api: "anthropic-messages",
					baseUrl: "https://session-federation-fallback.invalid",
					compat: undefined,
				},
				context,
				{
					...options,
					apiKey: undefined,
					headers: undefined,
					env: {
						ANTHROPIC_FEDERATION_RULE_ID: "fdrl_synthetic_session",
						ANTHROPIC_ORGANIZATION_ID: "org-synthetic-session",
						ANTHROPIC_IDENTITY_TOKEN_FILE: identityTokenFile,
						ANTHROPIC_WORKSPACE_ID: "wrkspc-synthetic-session",
						ANTHROPIC_SERVICE_ACCOUNT_ID: "svcacct-synthetic-session",
					},
					maxRetries: 0,
					fetch,
				},
			);
			terminals.push(stream.result());
			return stream;
		};

		await h.session.prompt("first federated request");

		expect(paths).toEqual(["/v1/oauth/token", "/v1/messages"]);
		expect(terminals).toHaveLength(1);
		const terminal = await terminals[0];
		expect(terminal.stopReason).toBe("stop");
		expect(terminal.provider).toBe("anthropic");
		expect(h.session.getLastAssistantText()).toBe("federated START accepted");
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
		expect(retryEntries(h)).toEqual([]);
		const persistedBytes = readFileSync(h.session.sessionFile!, "utf8");
		const reopened = SessionManager.open(h.session.sessionFile!);
		for (const published of [
			JSON.stringify(terminal),
			JSON.stringify(h.events),
			persistedBytes,
			JSON.stringify(reopened.getEntries()),
			JSON.stringify(reopened.buildSessionProjection().messages),
		]) {
			for (const forbidden of [credential, rawMarker, "PRIVATE_CONTENT"])
				expect.soft(published).not.toContain(forbidden);
		}
		const record = {
			position: "start",
			blockIndex: 0,
			blockState: "discarded",
			blockBytes: Buffer.byteLength(serialized),
			blockSha256: createHash("sha256").update(serialized).digest("hex"),
		};
		const reopenedMessage = reopened
			.getEntries()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
		expect(reopenedMessage).toHaveLength(1);
		for (const message of [terminal, assistantHistory(h)[0], reopenedMessage[0]]) {
			expect(message.fallback).toEqual([record]);
			expect(message.diagnostics).toContainEqual(
				expect.objectContaining({ type: "anthropic_model_fallback", fallbackCount: 1 }),
			);
		}
		expect(persistedBytes).toContain("anthropic_model_fallback");
		expect(persistedBytes).toContain("federated START accepted");
		await h.session.prompt("second federated request");
		expect(paths).toEqual(["/v1/oauth/token", "/v1/messages", "/v1/messages"]);
		expect(payloads[1]).toContain("federated START accepted");
		for (const forbidden of [credential, rawMarker, "rawBlock", "blockBytes", "blockSha256"])
			expect(payloads[1]).not.toContain(forbidden);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
	});

	// smarty-dev#2890: a partial, unexecuted call is discardable; a started tool effect is not.
	it("retries a partial tool call but refuses replay after a tool effect started in that response", async () => {
		let effects = 0;
		const tool: AgentTool = {
			name: "record",
			label: "Record",
			description: "Count an in-memory test effect",
			parameters: Type.Object({ content: Type.String() }),
			execute: async () => {
				effects++;
				return { content: [{ type: "text", text: "recorded" }], details: undefined };
			},
		};
		const partialCall = midOutput([
			{ type: "tool_use", id: "partial-tool", name: "record", input: { content: partialToolInput } },
		]);
		const recoverable = await setup([partialCall, success()], { tools: [tool] });
		await recoverable.h.session.prompt("test request");
		expect(recoverable.requests).toHaveLength(2);
		expect(effects).toBe(0);
		expect(recoverable.h.eventsOfType("tool_execution_start")).toEqual([]);
		expect(recoverable.payloads[1]).not.toContain(partialToolInput);

		const { h, requests } = await setup([midOutput(), success("must not be requested")], { tools: [tool] });
		const receiver = h.session as unknown as { _handleAgentEvent(event: AgentEvent): Promise<void> };
		let started = false;
		h.session.agent.subscribe(async (event) => {
			if (started || event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta") return;
			started = true;
			await receiver._handleAgentEvent({
				type: "tool_execution_start",
				toolCallId: "started-tool",
				toolName: "record",
				args: { content: "started in this response" },
			});
			// A synthetic assistant message_start in the same turn must not erase the effect evidence.
			await receiver._handleAgentEvent({
				type: "message_start",
				message: { ...assistantHistory(recoverable.h)[0], content: [] },
			});
			await tool.execute("started-tool", { content: "started in this response" });
		});
		await h.session.prompt("test request");
		expect(started).toBe(true);
		expect(effects).toBe(1);
		expect(requests).toHaveLength(1);
		expect(isRetryableAnthropicMidOutputFallback(assistantHistory(h)[0])).toBe(true);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
		expect(retryEntries(h)).toEqual([]);
	});

	// smarty-dev#2890: a completed tool response is a genuinely fresh response boundary, not an error retry.
	it("restores ordinary retries and the marker allowance after a successful tool response", async () => {
		let effects = 0;
		const tool: AgentTool = {
			name: "record",
			label: "Record",
			description: "Count an in-memory test effect",
			parameters: Type.Object({ content: Type.String() }),
			execute: async () => {
				effects++;
				return { content: [{ type: "text", text: "recorded" }], details: undefined };
			},
		};
		const { h, requests } = await setup(
			[midOutput(), toolResponse("completed response tool"), { status: 503 }, midOutput(), success()],
			{ tools: [tool] },
		);
		await h.session.prompt("test request");
		expect(requests).toHaveLength(5);
		expect(effects).toBe(1);
		expect(h.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 1, 2]);
		expect(retryEntries(h)).toHaveLength(2);
		expect(h.session.getLastAssistantText()).toBe("recovered answer");
	});

	// smarty-dev#2890: successful tool responses reset the local allowance, not the prompt-wide backstop.
	// smarty-dev#4605 (F1): an agent_settled custom continuation is still part of the same user prompt.
	it.each([
		{
			title: "caps marker retries at three per prompt without repeating tools, then resets for fresh input",
			settledContinuation: false,
		},
		{
			title: "caps marker retries after settled custom continuation at three per prompt without repeating tools, then resets for fresh input",
			settledContinuation: true,
		},
	])("$title", async ({ settledContinuation }) => {
		const effects: string[] = [];
		const tool: AgentTool = {
			name: "record",
			label: "Record",
			description: "Count an in-memory test effect",
			parameters: Type.Object({ content: Type.String() }),
			execute: async (toolCallId) => {
				effects.push(toolCallId);
				return { content: [{ type: "text", text: "recorded" }], details: undefined };
			},
		};
		const cappedPartial = "fourth marker must remain a durable failed attempt";
		const cappedFailure: SseEvent[] = [
			{
				type: "message_start",
				message: {
					id: "capped-response",
					model: requestedModel,
					usage: { input_tokens: 1_000_000, output_tokens: 0 },
				},
			},
			...contentEvents([{ type: "text", text: cappedPartial }]),
			fallbackEvent(1),
		];
		const { h, requests } = await setup(
			[
				midOutput(),
				toolResponse("first effect", "tool-1"),
				midOutput(),
				toolResponse("second effect", "tool-2"),
				midOutput(),
				toolResponse("third effect", "tool-3"),
				{ status: 503 },
				...(settledContinuation ? [success("completed before custom continuation")] : []),
				cappedFailure,
				midOutput(),
				success("fresh prompt recovered"),
			],
			{
				tools: [tool],
				persistSession: true,
				settings: {
					compaction: { enabled: true },
					retry: { maxRetries: 20, baseDelayMs: 1, fallbackModel: "faux/alternate" },
				},
			},
		);
		let originalPromptResolved = false;
		let customScheduled = false;
		let customAcceptance: Promise<void> | undefined;
		const settlements: Array<{ outcome: string; promptResolved: boolean; requestCount: number }> = [];
		if (settledContinuation) {
			h.session.subscribe((event) => {
				if (event.type !== "agent_settled") return;
				settlements.push({
					outcome: event.outcome,
					promptResolved: originalPromptResolved,
					requestCount: requests.length,
				});
				if (customScheduled) return;
				customScheduled = true;
				customAcceptance = h.session.sendCustomMessage(
					{ customType: "cap-continuation", content: "continue without a new user prompt", display: false },
					{ triggerTurn: true },
				);
			});
		}
		await h.session.prompt("one user prompt with several tool responses");
		originalPromptResolved = true;

		expect(requests).toHaveLength(settledContinuation ? 9 : 8);
		if (settledContinuation) {
			expect(customAcceptance).toBeDefined();
			await customAcceptance;
			expect(settlements).toEqual([
				{ outcome: "completed", promptResolved: false, requestCount: 8 },
				{ outcome: "error", promptResolved: false, requestCount: 9 },
			]);
			expect(
				h.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom_message" && entry.customType === "cap-continuation"),
			).toHaveLength(1);
		}
		expect(h.eventsOfType("message_start").filter((event) => event.message.role === "user")).toHaveLength(1);
		expect(requests.every((request) => request.model === requestedModel)).toBe(true);
		expect(effects).toEqual(["tool-1", "tool-2", "tool-3"]);
		expect(h.eventsOfType("tool_execution_start").map((event) => event.toolCallId)).toEqual(effects);
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([
			{ attempt: 1, maxAttempts: 1 },
			{ attempt: 1, maxAttempts: 1 },
			{ attempt: 1, maxAttempts: 1 },
			{ attempt: 1, maxAttempts: 20 },
		]);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([
			{ success: true, attempt: 1 },
			{ success: true, attempt: 1 },
			{ success: true, attempt: 1 },
			{ success: settledContinuation, attempt: 1 },
		]);
		expect(h.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([
			true,
			true,
			true,
			true,
			false,
			...(settledContinuation ? [false] : []),
		]);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
		expect(h.eventsOfType("compaction_start")).toEqual([]);
		expect(h.session.model?.id).toBe(requestedModel);
		expect(retryEntries(h).map((entry) => entry.type === "custom" && entry.data)).toEqual(
			[1, 2, 3].map((retries) => ({ requestedProvider: "faux", requestedModel, attempt: 1, retries })),
		);
		const reopened = SessionManager.open(h.session.sessionFile!);
		const entries = reopened.getEntries();
		expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
		expect(
			entries
				.filter((entry) => entry.type === "custom" && entry.customType === "anthropic_fallback_retry")
				.map((entry) => entry.type === "custom" && entry.data),
		).toEqual([1, 2, 3].map((retries) => ({ requestedProvider: "faux", requestedModel, attempt: 1, retries })));
		const capEntries = entries.filter(
			(entry) => entry.type === "custom" && entry.customType === "anthropic_fallback_retry_cap_hit",
		);
		expect(capEntries).toHaveLength(1);
		expect(capEntries[0]).toHaveProperty("data", {
			requestedProvider: "faux",
			requestedModel,
			retries: 3,
			limit: 3,
		});
		expect(entries.filter((entry) => entry.type === "context_edit")).toHaveLength(4);
		const failures = entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error"
				? [entry.message]
				: [],
		);
		expect(failures).toHaveLength(5);
		expect(failures.filter(isRetryableAnthropicMidOutputFallback)).toHaveLength(4);
		expect(failures[4].content).toEqual([{ type: "text", text: cappedPartial }]);
		expect(reopened.buildSessionProjection().messages).toContainEqual(failures[4]);
		expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")).toHaveLength(
			3,
		);
		expect(JSON.stringify(entries.filter((entry) => entry.type === "custom"))).not.toContain(rawMarker);

		// The deliberately oversized failure must not request a pre-prompt summary in this reset check.
		h.session.setAutoCompactionEnabled(false);
		await h.session.prompt("a genuinely fresh user prompt");
		expect(requests).toHaveLength(settledContinuation ? 11 : 10);
		expect(h.eventsOfType("message_start").filter((event) => event.message.role === "user")).toHaveLength(2);
		expect(effects).toEqual(["tool-1", "tool-2", "tool-3"]);
		expect(h.eventsOfType("auto_retry_start")).toHaveLength(5);
		expect(retryEntries(h).at(-1)).toHaveProperty("data", {
			requestedProvider: "faux",
			requestedModel,
			attempt: 1,
			retries: 1,
		});
		expect(
			h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "anthropic_fallback_retry_cap_hit"),
		).toHaveLength(1);
		expect(h.session.getLastAssistantText()).toBe("fresh prompt recovered");
	});

	// smarty-dev#2890: error continuations do not reset the cap, but a genuinely new user request does.
	it("resets the exhausted allowance for a fresh prompt", async () => {
		const { h, requests } = await setup([midOutput(), midOutput(), midOutput(), success()]);
		await h.session.prompt("first request");
		expect(requests).toHaveLength(2);
		await h.session.prompt("fresh request");
		expect(requests).toHaveLength(4);
		expect(h.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 1]);
		expect(retryEntries(h)).toHaveLength(2);
		expect(h.session.getLastAssistantText()).toBe("recovered answer");
	});

	it.each([
		{ name: "disabled retries", retry: { enabled: false, maxRetries: 20, baseDelayMs: 1 } },
		{ name: "zero retries", retry: { maxRetries: 0, baseDelayMs: 1, fallbackModel: "faux/alternate" } },
	])("honors $name", async ({ retry }) => {
		const { h, requests } = await setup([midOutput(), success()], { settings: { retry } });
		await h.session.prompt("test request");
		expect(requests).toHaveLength(1);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
		expect(retryEntries(h)).toEqual([]);
	});

	it("does not replay an ordinary transient error with partial output", async () => {
		const { h, requests } = await setup([
			[
				messageStart(),
				...contentEvents([{ type: "text", text: partialText }]),
				{ type: "error", error: { type: "overloaded_error", message: "503 unavailable" } },
			],
			success(),
		]);
		await h.session.prompt("test request");
		expect(requests).toHaveLength(1);
		expect(h.session.getLastAssistantText()).toBe(partialText);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("does not mistake a stream observer's marker-shaped exception for an owned marker", async () => {
		let observed = 0;
		const { h, requests } = await setup(
			[midOutput(), success()],
			{},
			{
				onProviderStreamEvent: () => {
					if (++observed === 2) throw new Error(markerError);
				},
			},
		);
		await h.session.prompt("test request");
		expect(requests).toHaveLength(1);
		expect(isRetryableAnthropicMidOutputFallback(assistantHistory(h)[0])).toBe(false);
		expect(assistantHistory(h)[0].diagnostics).toContainEqual(
			expect.objectContaining({ type: "provider_stream_observer_error" }),
		);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("does not replay after the user aborts while output is arriving", async () => {
		const { h, requests } = await setup([midOutput(), success()]);
		let abort: Promise<void> | undefined;
		h.session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				abort ??= h.session.abort();
			}
		});
		await h.session.prompt("test request");
		await abort;
		expect(abort).toBeDefined();
		expect(requests).toHaveLength(1);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
		expect(retryEntries(h)).toEqual([]);
		expect(h.eventsOfType("agent_settled")).toMatchObject([{ outcome: "aborted", aborted: true }]);
	});
});
