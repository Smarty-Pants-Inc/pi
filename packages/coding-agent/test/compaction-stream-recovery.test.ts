import { createServer } from "node:http";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, contentText, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamResponses } from "../../ai/src/api/openai-responses.ts";
import { isRetryableAssistantError } from "../../ai/src/utils/retry.ts";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { completeSummarization } from "../src/core/compaction/compaction.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

type Failure = "eof" | "error" | "failed";
type WireEvent = { type: string; [key: string]: unknown };
type RequestBody = { model: string; stream: boolean; input: unknown; tools?: unknown };
const failures: Failure[] = ["eof", "error", "failed"];
const partialText = "INCOMPLETE_SUMMARY_MUST_NOT_BE_SAVED";
const recoveredText = "COMPLETE_RECOVERED_SUMMARY";
const steeringText = "steering held through compaction failure";
const queuedText = "follow-up held through compaction failure";
const triggeringText = "prompt retained after compaction failure";
const cleanups: Array<() => void | Promise<void>> = [];

function outputEvents(text: string): WireEvent[] {
	return [
		{ type: "response.created", sequence_number: 0, response: { id: "resp-local", status: "in_progress" } },
		{
			type: "response.output_item.added",
			sequence_number: 1,
			output_index: 0,
			item: { type: "message", id: "msg-local", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", sequence_number: 2, output_index: 0, content_index: 0, delta: text },
	];
}

/** Real TCP/HTTP/SSE, including SDK parsing; no fetch, SDK or adapter mocks. */
async function localSse(failure: Failure, failureCount: number, partial = true) {
	const fixture = {
		baseUrl: "",
		failureCount,
		requests: [] as RequestBody[],
		frames: [] as string[][],
		errors: [] as string[],
	};
	const server = createServer((request, response) => {
		void (async () => {
			if (request.method !== "POST" || request.url !== "/v1/responses") {
				throw new Error(`Unexpected local request: ${request.method} ${request.url}`);
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			fixture.requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as RequestBody);
			const failed = fixture.requests.length <= fixture.failureCount;
			const events = failed ? (partial ? outputEvents(partialText) : []) : outputEvents(recoveredText);
			if (failed && failure === "error") {
				events.push({
					type: "error",
					sequence_number: 3,
					code: "server_is_overloaded",
					message: "local fixture overload",
					status: 503,
				});
			} else if (failed && failure === "failed") {
				events.push({
					type: "response.failed",
					sequence_number: 3,
					response: {
						id: "resp-local",
						status: "failed",
						error: { code: "server_is_overloaded", message: "local fixture overload", status: 503 },
					},
				});
			} else if (!failed) {
				events.push(
					{
						type: "response.output_item.done",
						sequence_number: 3,
						output_index: 0,
						item: {
							type: "message",
							id: "msg-local",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: recoveredText, annotations: [] }],
						},
					},
					{
						type: "response.completed",
						sequence_number: 4,
						response: {
							id: "resp-local",
							status: "completed",
							usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
						},
					},
				);
			}
			fixture.frames.push(events.map((event) => event.type));
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			// EOF is a clean HTTP 200 end with no Responses terminal event, not a fake adapter exception.
			response.end();
		})().catch((error: unknown) => {
			fixture.errors.push(String(error));
			response.destroy(error instanceof Error ? error : new Error(String(error)));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing local SSE server address");
	fixture.baseUrl = `http://127.0.0.1:${address.port}/v1`;
	cleanups.push(
		() =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
	);
	return fixture;
}

function localModel(baseUrl: string, id = "local-compaction-probe"): Model<"openai-responses"> {
	return {
		id,
		name: "Local compaction probe",
		api: "openai-responses",
		provider: "openai",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

async function compactableSession(fixture: Awaited<ReturnType<typeof localSse>>) {
	const model = localModel(fixture.baseUrl);
	const terminals: AssistantMessage[] = [];
	const streamFn: StreamFn = (requested, context, options) => {
		if (requested.api !== model.api || requested.baseUrl !== fixture.baseUrl) {
			throw new Error("The probe must never leave its loopback Responses endpoint");
		}
		const stream = streamResponses({ ...requested, api: "openai-responses" }, context, {
			...options,
			apiKey: "local-fixture-key",
			env: {},
			maxRetries: 0,
		});
		void stream.result().then((result) => terminals.push(result));
		return stream;
	};
	const auth = AuthStorage.inMemory({ openai: { type: "api_key", key: "local-fixture-key" } });
	const registry = await createInMemoryModelRegistry(auth);
	const fallback = localModel(fixture.baseUrl, "local-compaction-fallback-probe");
	// #17478: both summary models use a declared real adapter and the same loopback-only endpoint.
	registry.registerProvider(model.provider, {
		baseUrl: fixture.baseUrl,
		api: model.api,
		apiKey: "local-fixture-key",
		models: [model, fallback],
	});
	const manager = SessionManager.inMemory();
	const settings = SettingsManager.inMemory({
		compaction: {
			enabled: true,
			keepRecentTokens: 1,
			reserveTokens: 1024,
			fallbackModel: `${fallback.provider}/${fallback.id}`,
		},
		retry: { enabled: false, maxRetries: 7, baseDelayMs: 0 },
	});
	const session = new AgentSession({
		agent: new Agent({ streamFn, initialState: { model, systemPrompt: "Local probe", tools: [] } }),
		sessionManager: manager,
		settingsManager: settings,
		cwd: process.cwd(),
		modelRuntime: getModelRuntime(registry),
		resourceLoader: createTestResourceLoader(),
	});
	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => events.push(event));
	manager.appendMessage({ role: "user", content: "history to summarize", timestamp: Date.now() - 2000 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "previous answer" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: 7500,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 7510,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now() - 1000,
	});
	session.agent.state.messages = manager.buildSessionContext().messages;
	cleanups.push(() => {
		console.info(
			"STREAM_PROBE_SESSION",
			JSON.stringify({
				frames: fixture.frames,
				terminals: terminals.map(({ stopReason, errorMessage, content, recovery }) => ({
					stopReason,
					errorMessage,
					content,
					recovery,
				})),
				events: events.filter(
					(event) => event.type.startsWith("compaction_") || event.type.startsWith("summarization_retry_"),
				),
				steering: session.getSteeringMessages(),
				followUps: session.getFollowUpMessages(),
				compactions: manager.getEntries().filter((entry) => entry.type === "compaction"),
			}),
		);
		session.clearQueue();
		session.dispose();
	});
	return { session, manager, events, terminals, settings, streamFn, model };
}

afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

// smarty-dev#17478: distinguish terminal adapter failures from the summary owner's retry decision.
describe("compaction recovery across the real local Responses SSE boundary", () => {
	it.each(failures)("surfaces %s after partial output as a terminal adapter error", async (failure) => {
		const fixture = await localSse(failure, Number.POSITIVE_INFINITY);
		const stream = streamResponses(
			localModel(fixture.baseUrl),
			normalizeContext({ messages: [{ role: "user", content: "summarize", timestamp: 1 }] }),
			{ apiKey: "local-fixture-key", maxRetries: 0, env: {} },
		);
		const events: string[] = [];
		const deltas: string[] = [];
		for await (const event of stream) {
			events.push(event.type);
			if (event.type === "text_delta") deltas.push(event.delta);
		}
		const result = await stream.result();
		console.info("STREAM_PROBE_ADAPTER", JSON.stringify({ failure, frames: fixture.frames, events, result }));
		expect(fixture.errors).toEqual([]);
		expect(fixture.requests).toHaveLength(1);
		expect(deltas).toEqual([partialText]);
		expect(events.at(-1)).toBe("error");
		expect(events).not.toContain("done");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
		expect(result.content).toContainEqual({ type: "text", text: partialText });
		expect(result.recovery?.retryable).toBe(true);
		// Ordinary turns must not replay answer output, even though the failure itself is transient.
		expect(isRetryableAssistantError(result)).toBe(false);
	});

	it("preserves the existing retry for an overload before summary output", async () => {
		const fixture = await localSse("failed", 1, false);
		const { session, events } = await compactableSession(fixture);
		await expect(session.compact()).resolves.toMatchObject({ summary: expect.stringContaining(recoveredText) });
		expect(fixture.requests).toHaveLength(2);
		expect(events.filter((event) => event.type === "summarization_retry_scheduled")).toHaveLength(1);
	});

	it.each(failures)("retries partial %s summaries and saves only the completed replacement", async (failure) => {
		const fixture = await localSse(failure, 2);
		const { session, manager, events } = await compactableSession(fixture);
		await expect(session.compact()).resolves.toMatchObject({ summary: expect.stringContaining(recoveredText) });
		expect(fixture.errors).toEqual([]);
		expect(fixture.requests).toHaveLength(3);
		expect(fixture.requests.every((request) => request.tools === undefined)).toBe(true);
		expect(events.filter((event) => event.type === "summarization_retry_scheduled")).toMatchObject([
			{ attempt: 1, maxAttempts: 2, delayMs: 2000 },
			{ attempt: 2, maxAttempts: 2, delayMs: 4000 },
		]);
		const saved = manager.getEntries().filter((entry) => entry.type === "compaction");
		expect(saved).toHaveLength(1);
		expect(saved[0]?.summary).toContain(recoveredText);
		expect(JSON.stringify(manager.getEntries())).not.toContain(partialText);
	});

	// #17478: primary exhaustion crosses the real SDK/SSE boundary before compaction-only fallback.
	it.each(["manual", "auto"] as const)("uses one fallback after %s primary exhaustion", async (path) => {
		const fixture = await localSse("eof", 3);
		const { session, manager, events, model } = await compactableSession(fixture);
		if (path === "manual") {
			await expect(session.compact()).resolves.toMatchObject({ summary: expect.stringContaining(recoveredText) });
		} else {
			await session.prompt(triggeringText);
			await session.waitForIdle();
		}
		expect(fixture.errors).toEqual([]);
		expect(fixture.requests.map((request) => request.model)).toEqual([
			model.id,
			model.id,
			model.id,
			"local-compaction-fallback-probe",
			...(path === "auto" ? [model.id] : []),
		]);
		expect(session.model).toBe(model);
		expect(events.filter((event) => event.type === "summarization_retry_scheduled")).toHaveLength(2);
		const checkpoints = manager.getEntries().filter((entry) => entry.type === "compaction");
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]?.summary).toContain(recoveredText);
		expect(JSON.stringify(manager.getEntries())).not.toContain(partialText);
		expect(manager.getEntries().filter((entry) => entry.type === "model_change")).toEqual([]);
		expect(events.filter((event) => event.type === "agent_start")).toHaveLength(path === "auto" ? 1 : 0);
	});

	it.each(failures)("keeps follow-ups through %s failure and recovery", async (failure) => {
		const fixture = await localSse(failure, Number.POSITIVE_INFINITY);
		const { session, manager, events, settings } = await compactableSession(fixture);
		await session.steer(steeringText);
		await session.followUp(queuedText);
		const retryQueues: Array<{ steering: string[]; followUps: string[] }> = [];
		session.subscribe((event) => {
			if (event.type === "summarization_retry_scheduled") {
				retryQueues.push({
					steering: [...session.getSteeringMessages()],
					followUps: [...session.getFollowUpMessages()],
				});
			}
		});
		await expect(session.prompt(triggeringText, { streamingBehavior: "followUp" })).rejects.toThrow(
			"Input is retained in the followUp queue",
		);
		expect(fixture.errors).toEqual([]);
		expect(session.getSteeringMessages()).toEqual([steeringText]);
		expect(session.getFollowUpMessages()).toEqual([queuedText, triggeringText]);
		expect(session.pendingMessageCount).toBe(3);
		expect(session.agent.hasQueuedMessages()).toBe(true);
		expect(events.filter((event) => event.type === "agent_start")).toHaveLength(0);
		expect(events.filter((event) => event.type === "compaction_end").at(-1)).toMatchObject({
			result: undefined,
			aborted: false,
			errorMessage: expect.stringContaining("Auto-compaction failed"),
		});
		expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(JSON.stringify(manager.getEntries())).not.toContain(partialText);
		console.info(
			"STREAM_PROBE_QUEUE_HELD",
			JSON.stringify({
				failure,
				calls: fixture.requests.length,
				steering: session.getSteeringMessages(),
				followUps: session.getFollowUpMessages(),
				retryQueues,
			}),
		);
		// Two primary retries plus one fallback request, independent of ordinary settings.retry.
		expect(fixture.requests.map((request) => request.model)).toEqual([
			"local-compaction-probe",
			"local-compaction-probe",
			"local-compaction-probe",
			"local-compaction-fallback-probe",
		]);
		expect(retryQueues).toEqual([
			{ steering: [steeringText], followUps: [queuedText] },
			{ steering: [steeringText], followUps: [queuedText] },
		]);

		fixture.failureCount = fixture.requests.length;
		await expect(session.compact()).resolves.toMatchObject({ summary: expect.stringContaining(recoveredText) });
		expect(session.getSteeringMessages()).toEqual([steeringText]);
		expect(session.getFollowUpMessages()).toEqual([queuedText, triggeringText]);
		settings.applyOverrides({ compaction: { enabled: false } });
		await session.prompt("resume after successful compaction");
		await session.waitForIdle();
		const userTexts = manager.getEntries().flatMap((entry) => {
			if (entry.type !== "message" || entry.message.role !== "user") return [];
			const content = entry.message.content;
			return [typeof content === "string" ? content : contentText(content)];
		});
		expect(userTexts.filter((text) => text === steeringText)).toHaveLength(1);
		expect(userTexts.filter((text) => text === queuedText)).toHaveLength(1);
		expect(userTexts.filter((text) => text === triggeringText)).toHaveLength(1);
		expect(session.getSteeringMessages()).toEqual([]);
		expect(session.getFollowUpMessages()).toEqual([]);
		expect(session.pendingMessageCount).toBe(0);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(JSON.stringify(manager.getEntries())).not.toContain(partialText);
		expect(manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("does not grant partial-output retries to a tools-bearing context", async () => {
		const fixture = await localSse("failed", 1);
		const { model, streamFn } = await compactableSession(fixture);
		const response = await completeSummarization(
			model,
			normalizeContext({
				messages: [{ role: "user", content: "not a tool-free summary", timestamp: 1 }],
				tools: [{ name: "unsafe_to_replay", description: "fixture", parameters: Type.Object({}) }],
			}),
			{},
			streamFn,
			{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
		);
		expect(response.stopReason).toBe("error");
		expect(fixture.requests).toHaveLength(1);
		expect(fixture.requests[0]?.tools).toBeDefined();
	});
});
