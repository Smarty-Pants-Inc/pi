import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	contentText,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { compact, prepareCompaction } from "../src/core/compaction/compaction.ts";
import type {
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionCompactFailedEvent,
} from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SETTINGS_DEFAULTS } from "../src/core/settings-defaults.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { SettingsSchema } from "../src/core/settings-schema.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const primary: Model<"openai-responses"> = {
	id: "primary-summary",
	name: "Primary summary",
	api: "openai-responses",
	provider: "primary-fixture",
	baseUrl: "https://invalid.example",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};
const fallback: Model<"openai-responses"> = { ...primary, id: "fallback-summary", provider: "fallback-fixture" };
const fallbackReference = `${fallback.provider}/${fallback.id}`;
const sessions: AgentSession[] = [];
const scratchDirs: string[] = [];
type Request = { model: Parameters<StreamFn>[0]; context: Parameters<StreamFn>[1]; options: Parameters<StreamFn>[2] };
type Script = (request: Request, index: number) => AssistantMessage | "hang";

function response(model: Model<string>, text = "COMPLETE_CHECKPOINT", errorMessage?: string): AssistantMessage {
	return {
		...fauxAssistantMessage(text),
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: errorMessage ? "error" : "stop",
		...(errorMessage ? { errorMessage } : {}),
	};
}
function transient(model: Model<string>) {
	return response(model, "PARTIAL_MUST_NOT_BE_SAVED", "503 overloaded");
}

async function fixture(
	script: Script,
	options: {
		fallbackModel?: string;
		missingKey?: boolean;
		previous?: boolean;
		readFiles?: string[];
		hangSetup?: boolean;
		sessionDir?: string;
		beforeCompact?: (
			event: SessionBeforeCompactEvent,
		) => SessionBeforeCompactResult | undefined | Promise<SessionBeforeCompactResult | undefined>;
		afterCompact?: () => void | Promise<void>;
		afterFailure?: () => void | Promise<void>;
	} = {},
) {
	const auth = AuthStorage.inMemory({
		[primary.provider]: { type: "api_key", key: "primary-authorized-key" },
		...(!options.missingKey
			? { [fallback.provider]: { type: "api_key" as const, key: "fallback-authorized-key" } }
			: {}),
	});
	const registry = await createInMemoryModelRegistry(auth);
	for (const model of [primary, fallback]) {
		registry.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
	}
	const requests: Request[] = [];
	const held: ReturnType<typeof createAssistantMessageEventStream>[] = [];
	const streamFn: StreamFn = (model, context, streamOptions) => {
		const request = { model, context, options: streamOptions };
		requests.push(request);
		const stream = createAssistantMessageEventStream();
		const result = script(request, requests.length);
		if (result === "hang" && options.hangSetup)
			return new Promise<ReturnType<typeof createAssistantMessageEventStream>>(() => {});
		if (result === "hang") held.push(stream);
		else if (result.stopReason === "pending") throw new Error("Fixture script returned a pending assistant message");
		else if (result.stopReason === "error" || result.stopReason === "aborted") {
			stream.push({ type: "error", reason: result.stopReason, error: result });
		} else stream.push({ type: "done", reason: result.stopReason, message: result });
		return stream;
	};
	const manager = options.sessionDir
		? SessionManager.create(process.cwd(), options.sessionDir)
		: SessionManager.inMemory();
	const settings = SettingsManager.inMemory({
		compaction: {
			enabled: true,
			keepRecentTokens: 1,
			reserveTokens: 1024,
			fallbackModel: options.fallbackModel ?? fallbackReference,
		},
		retry: { enabled: false, maxRetries: 99, baseDelayMs: 0 },
	});
	const failedEvents: SessionCompactFailedEvent[] = [];
	const hooks = { preparations: 0 };
	const extensionsResult = await createTestExtensionsResult([
		(pi) => {
			pi.on("session_before_compact", (event) => {
				hooks.preparations++;
				return options.beforeCompact?.(event);
			});
			pi.on("session_compact", () => options.afterCompact?.());
			pi.on("session_compact_failed", (event) => {
				failedEvents.push(event);
				return options.afterFailure?.();
			});
		},
	]);
	const runtime = getModelRuntime(registry);
	const session = new AgentSession({
		agent: new Agent({ streamFn, initialState: { model: primary, systemPrompt: "Fixture", tools: [] } }),
		sessionManager: manager,
		settingsManager: settings,
		cwd: process.cwd(),
		modelRuntime: runtime,
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});
	sessions.push(session);
	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => events.push(event));
	const user = (content: string) => manager.appendMessage({ role: "user", content, timestamp: Date.now() - 2000 });
	if (options.previous) {
		const id = user("older source");
		manager.appendCompaction("PREVIOUS_REFERENCE /evidence/previous.json", id, 500);
	}
	user("HISTORY_SOURCE /evidence/original.json");
	manager.appendMessage(response(primary, "HISTORY_ANSWER"));
	for (const [index, path] of (options.readFiles ?? []).entries()) {
		const id = `read-${index}`;
		manager.appendMessage({
			...response(primary),
			content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
		});
		manager.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text: "fixture evidence" }],
			isError: false,
			timestamp: 1,
		});
	}
	user("TURN_PREFIX_TASK task-17478 active requirement");
	manager.appendMessage(response(primary, "PREFIX_WORK"));
	const tailId = manager.appendMessage({
		...response(primary, "RETAINED_TAIL_NOT_TO_RECONSTRUCT"),
		usage: {
			input: 7500,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 7510,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	session.agent.state.messages = manager.buildSessionContext().messages;
	vi.useFakeTimers();
	return { session, manager, settings, registry, runtime, requests, held, events, tailId, failedEvents, hooks };
}

async function settle<T>(promise: Promise<T>, milliseconds = 6000) {
	const observed = promise.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
	await vi.advanceTimersByTimeAsync(milliseconds);
	return observed;
}

afterEach(() => {
	for (const session of sessions.splice(0)) {
		session.clearQueue();
		session.dispose();
	}
	vi.useRealTimers();
	for (const path of scratchDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

// smarty-dev#17478: only the native compaction owner may make this one extra request.
describe("native compaction single fallback", () => {
	it("publishes the central default and optional schema setting without reducing reserves", () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getCompactionFallbackModel()).toBe(SETTINGS_DEFAULTS.compaction.fallbackModel);
		expect(SettingsSchema.properties.compaction.properties.fallbackModel).toMatchObject({
			default: SETTINGS_DEFAULTS.compaction.fallbackModel,
		});
		expect(settings.getCompactionSettings()).toEqual({
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
			maxSummaryTokens: 8000,
			primaryTimeoutMs: 300000,
			fallbackTimeoutMs: 240000,
		});
	});

	it("uses primary concise prompts and the two shared retries when primary recovers", async () => {
		const f = await fixture(({ model }, index) => (index <= 2 ? transient(model) : response(model)));
		const result = await settle(f.session.compact("CUSTOM_FOCUS"));
		expect(result).toHaveProperty("value");
		expect(f.requests).toHaveLength(4); // history: three calls; turn prefix: one.
		expect(f.requests.every(({ model }) => model.id === primary.id)).toBe(true);
		const prompts = f.requests
			.flatMap(({ context }) => context.messages.map((message) => contentText(message.content)))
			.join(" ");
		expect(prompts).not.toContain("6000");
		expect(prompts).toContain("Checkpoint output allowance");
		expect(prompts).toContain("every active requirement");
		expect(f.events.filter((event) => event.type === "summarization_retry_scheduled")).toHaveLength(2);
	});

	it("does not resolve malformed fallback configuration when primary succeeds", async () => {
		const f = await fixture(({ model }) => response(model), { fallbackModel: "malformed" });
		expect(await settle(f.session.compact(), 0)).toHaveProperty("value");
		expect(f.requests).toHaveLength(2);
		expect(f.requests.every(({ model }) => model.id === primary.id)).toBe(true);
	});

	it("admits one combined fallback over original history, previous summary and turn prefix", async () => {
		const f = await fixture(({ model }) => (model.id === primary.id ? transient(model) : response(model)), {
			previous: true,
		});
		const preparation = prepareCompaction(f.manager.getBranch(), f.settings.getCompactionSettings(primary))!;
		expect(preparation.isSplitTurn).toBe(true);
		const result = await settle(f.session.compact("CUSTOM_FOCUS"));
		expect(result).toHaveProperty("value");
		expect(f.requests.map(({ model }) => model.id)).toEqual([primary.id, primary.id, primary.id, fallback.id]);
		const request = f.requests[3];
		const text = request.context.messages.map((message) => contentText(message.content)).join("\n");
		for (const expected of [
			"HISTORY_SOURCE",
			"TURN_PREFIX_TASK task-17478",
			"PREVIOUS_REFERENCE",
			"CUSTOM_FOCUS",
			"6000",
			"do not reconstruct",
		])
			expect(text).toContain(expected);
		expect(text).not.toContain("RETAINED_TAIL_NOT_TO_RECONSTRUCT");
		expect(request.options?.apiKey).toBe("fallback-authorized-key");
		expect(request.options?.maxTokens).toBe(primary.maxTokens);
		expect(request.options?.cacheRetention).toBe("none");
		expect(f.session.model).toBe(primary);
		expect(f.manager.getEntries().filter((entry) => entry.type === "model_change")).toEqual([]);
		const saved = f.manager
			.getEntries()
			.filter((entry) => entry.type === "compaction")
			.at(-1)!;
		expect(saved.firstKeptEntryId).toBe(f.tailId);
		expect(saved.tokensBefore).toBe(preparation.tokensBefore);
		expect(saved.summary).not.toContain("PARTIAL_MUST_NOT_BE_SAVED");
		expect(f.manager.getEntry(f.tailId)).toBeDefined();
	});

	it.each(["history", "prefix", "both"] as const)("bounds %s retries and checkpoints", async (part) => {
		const f = await fixture(({ model, context }, index) => {
			if (model.id === fallback.id) return response(model, "FALLBACK_PARTIAL", "502 fallback unavailable");
			const prefix = context.messages.some((message) => contentText(message.content).includes("# Conversation"));
			if (part === "prefix" && !prefix) return response(model, "SUCCESSFUL_HISTORY_DISCARDED");
			if (part === "both" && index === 2) return response(model, "SUCCESSFUL_HISTORY_DISCARDED");
			return transient(model);
		});
		const result = await settle(f.session.compact());
		expect(result).toHaveProperty("error");
		if (!("error" in result) || !(result.error instanceof AggregateError))
			throw new Error("Expected native aggregate failure");
		expect(result.error.message).toContain("503 overloaded");
		expect(result.error.message).toContain("502 fallback unavailable");
		expect(result.error.errors).toHaveLength(2);
		expect(result.error.cause).toBe(result.error.errors[0]);
		expect(result.error.errors[0].cause.usage).toBeDefined();
		expect(f.requests.filter(({ model }) => model.id === fallback.id)).toHaveLength(1);
		expect(f.requests).toHaveLength(part === "history" ? 4 : 5);
		expect(f.events.filter((event) => event.type === "summarization_retry_scheduled")).toHaveLength(2);
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
		expect(f.events.at(-1)).toMatchObject({
			type: "compaction_end",
			reason: "manual",
			aborted: false,
			willRetry: false,
			errorMessage: expect.stringContaining("fallback"),
		});
		expect(f.session.isCompacting).toBe(false);
		expect(f.hooks.preparations).toBe(1);
		expect(f.failedEvents).toMatchObject([
			{ type: "session_compact_failed", aborted: false, willRetry: false, fromExtension: false },
		]);
	});

	it("retains usage of a successful history subcall when prefix failure needs fallback", async () => {
		const f = await fixture(({ model }, index) => {
			if (index !== 1 && model.id === primary.id) return transient(model);
			const message = response(model);
			message.usage = {
				...message.usage,
				input: index === 1 ? 7 : 11,
				output: index === 1 ? 3 : 2,
				totalTokens: index === 1 ? 10 : 13,
			};
			return message;
		});
		const result = await settle(f.session.compact());
		expect(result).toHaveProperty("value.usage.input", 18);
		expect(result).toHaveProperty("value.usage.output", 5);
		expect(result).toHaveProperty("value.usage.totalTokens", 23);
	});

	it.each(["401 unauthorized", "403 permission denied", "insufficient_quota billing exhausted", "prompt is too long"])(
		"does not fall back for %s",
		async (error) => {
			const f = await fixture(({ model }) => response(model, "PARTIAL", error));
			expect(await settle(f.session.compact())).toHaveProperty("error");
			expect(f.requests).toHaveLength(1);
			expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
		},
	);

	it.each(["aborted", "length", "tool", "provider_limit", "provider_stream_observer_error"] as const)(
		"rejects excluded %s summary",
		async (kind) => {
			const f = await fixture(({ model }) => {
				const message = transient(model);
				if (kind === "length" || kind === "aborted") message.stopReason = kind;
				else if (kind === "tool")
					message.content.push({ type: "toolCall", id: "not-offered", name: "bash", arguments: {} });
				else message.diagnostics = [{ type: kind, timestamp: Date.now() }];
				return message;
			});
			expect(await settle(f.session.compact())).toHaveProperty("error");
			expect(f.requests).toHaveLength(1);
			expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
		},
	);

	it.each(["invalid", "unknown/model", "missing-key", "denied"])("rejects fallback admission %s", async (kind) => {
		const f = await fixture(({ model }) => transient(model), {
			fallbackModel: kind === "invalid" || kind === "unknown/model" ? kind : fallbackReference,
			missingKey: kind === "missing-key",
		});
		if (kind === "denied") f.settings.applyOverrides({ modelPolicy: { allow: [`${primary.provider}/*`] } });
		const result = await settle(f.session.compact());
		expect(result).toHaveProperty("error");
		expect(f.requests).toHaveLength(3);
		expect(f.requests.every(({ model }) => model.id === primary.id)).toBe(true);
		expect(f.events.at(-1)).toMatchObject({
			type: "compaction_end",
			aborted: false,
			errorMessage: expect.stringContaining("fallback"),
		});
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
	});

	it.each(["primary", "backoff", "fallback"])("settles immediately on operator abort during %s", async (phase) => {
		const f = await fixture(({ model }) =>
			phase === "primary" || model.id === fallback.id ? "hang" : transient(model),
		);
		const observed = f.session.compact().then(
			() => "unexpected-success",
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(phase === "fallback" ? 6000 : 1);
		f.session.abortCompaction();
		expect(await observed).toBeInstanceOf(Error);
		expect(f.requests).toHaveLength(phase === "fallback" ? 4 : 1);
		expect(f.events.at(-1)).toMatchObject({ type: "compaction_end", aborted: true, willRetry: false });
		expect(f.session.isCompacting).toBe(false);
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(f.requests).toHaveLength(phase === "fallback" ? 4 : 1);
	});

	it.each([false, true])(
		"bounds uncooperative fallback at four minutes (setup=%s) and ignores late results",
		async (hangSetup) => {
			const f = await fixture(({ model }) => (model.id === primary.id ? transient(model) : "hang"), { hangSetup });
			const observed = f.session.compact().catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(6000 + 4 * 60_000 - 1);
			expect(f.requests).toHaveLength(4);
			expect(f.session.isCompacting).toBe(true);
			await vi.advanceTimersByTimeAsync(1);
			expect(await observed).toBeInstanceOf(AggregateError);
			expect(f.events.at(-1)).toMatchObject({
				type: "compaction_end",
				aborted: false,
				errorMessage: expect.stringContaining("240000ms deadline"),
			});
			expect(f.requests[3].options?.signal?.aborted).toBe(true);
			f.held[0]?.push({ type: "done", reason: "stop", message: response(fallback, "LATE_INVALID_CHECKPOINT") });
			await vi.advanceTimersByTimeAsync(30 * 60_000);
			expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
			expect(f.requests).toHaveLength(4);
		},
	);

	it("spends five shared primary minutes then accepts one fallback without extra primary requests", async () => {
		const f = await fixture(({ model }) => (model.id === primary.id ? "hang" : response(model)));
		const result = await settle(f.session.compact(), 5 * 60_000);
		expect(result).toHaveProperty("value.summary", expect.stringContaining("COMPLETE_CHECKPOINT"));
		expect(f.requests.map(({ model }) => model.id)).toEqual([primary.id, fallback.id]);
		expect(f.events.filter((event) => event.type === "summarization_retry_scheduled")).toHaveLength(0);
		expect(f.requests[0].options?.signal?.aborted).toBe(true);
		expect(f.events.at(-1)).toMatchObject({
			type: "compaction_end",
			aborted: false,
			result: expect.objectContaining({ summary: expect.stringContaining("COMPLETE_CHECKPOINT") }),
		});
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		for (const stream of f.held)
			stream.push({ type: "done", reason: "stop", message: response(primary, "LATE_PRIMARY") });
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(f.requests).toHaveLength(2);
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("holds auto-compaction queues and exposes one terminal failure without ordinary replay", async () => {
		const f = await fixture(({ model }) => transient(model));
		await f.session.steer("STEERING_TASK_17478");
		await f.session.followUp("FOLLOWUP_TASK_17478");
		const result = await settle(f.session.prompt("TRIGGER_TASK_17478", { streamingBehavior: "followUp" }));
		expect(result).toHaveProperty("error");
		expect(f.requests).toHaveLength(4);
		expect(f.session.getSteeringMessages()).toEqual(["STEERING_TASK_17478"]);
		expect(f.session.getFollowUpMessages()).toEqual(["FOLLOWUP_TASK_17478", "TRIGGER_TASK_17478"]);
		expect(f.session.pendingMessageCount).toBe(3);
		expect(f.events.filter((event) => event.type === "agent_start")).toEqual([]);
		expect(f.failedEvents).toMatchObject([
			{ reason: "threshold", aborted: false, willRetry: false, fromExtension: false },
		]);
		expect(f.events.filter((event) => event.type === "compaction_end")).toMatchObject([
			{ aborted: false, errorMessage: expect.stringContaining("fallback") },
		]);
		expect(f.session.model).toBe(primary);
	});

	it.each([1, 100000])("shares one output cap independently of reserve=%s", async (reserveTokens) => {
		const f = await fixture(({ model }) => response(model), { readFiles: ["/evidence/keep-required-path.ts"] });
		f.settings.applyOverrides({ compaction: { maxSummaryTokens: 300, reserveTokens } });
		const result = await settle(f.session.compact(), 0);
		expect(result).toHaveProperty("value");
		expect(f.requests).toHaveLength(2);
		const limits = f.requests.map(({ options }) => options?.maxTokens ?? 0);
		expect(limits.every((limit) => limit > 0 && limit < 300)).toBe(true);
		expect(limits.reduce((sum, limit) => sum + limit, 0)).toBeLessThan(300); // merge-marker reserve
		expect(f.settings.getCompactionReserveTokens()).toBe(reserveTokens);
		expect(f.settings.getCompactionKeepRecentTokens()).toBe(1);
		if (!("value" in result)) throw result.error;
		const saved = f.manager.getEntries().filter((entry) => entry.type === "compaction")[0];
		expect(result.value.summary).toContain("/evidence/keep-required-path.ts");
		expect(saved).toHaveProperty("details.readFiles", ["/evidence/keep-required-path.ts"]);
		expect(saved).toHaveProperty("details.summaryChars", result.value.summary.length);
		expect(saved).toHaveProperty("details.summaryTokensEstimate", Math.ceil(result.value.summary.length / 4));
		expect(saved).toHaveProperty("details.durationMs", expect.any(Number));
		expect(result.value).toHaveProperty("details.durationMs", expect.any(Number));
	});

	it.each(["primary", "fallback"])("rejects oversized %s output without truncation or checkpoint", async (phase) => {
		const f = await fixture(({ model }) =>
			phase === "fallback" && model.id === primary.id ? transient(model) : response(model, "x".repeat(2000)),
		);
		f.settings.applyOverrides({ compaction: { maxSummaryTokens: 100 } });
		const result = await settle(f.session.compact());
		expect(result).toHaveProperty("error");
		expect(f.requests).toHaveLength(phase === "primary" ? 2 : 4);
		expect(f.events.at(-1)).toMatchObject({
			type: "compaction_end",
			aborted: false,
			errorMessage: expect.stringContaining("exceeds maxSummaryTokens"),
		});
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
	});

	it("persists distinct length and duration metrics for twenty native checkpoints in the existing journal", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "compaction-metrics-"));
		scratchDirs.push(sessionDir);
		const f = await fixture(
			({ model }) => {
				const message = response(model);
				message.usage.output = 777;
				message.usage.totalTokens = 777;
				return message;
			},
			{ sessionDir },
		);
		for (let index = 0; index < 20; index++) {
			expect(await settle(f.session.compact(), 0)).toHaveProperty("value");
			if (index === 19) break;
			f.manager.appendMessage({
				role: "user",
				content: `ACTIVE_TASK_${index} /evidence/task-${index}.json`,
				timestamp: Date.now(),
			});
			f.manager.appendMessage({
				...response(primary, "RETAINED_WORK"),
				usage: { ...response(primary).usage, input: 7500, totalTokens: 7500 },
			});
			f.session.agent.state.messages = f.manager.buildSessionContext().messages;
		}
		const file = f.manager.getSessionFile();
		if (!file) throw new Error("Missing persisted session file");
		const entries = SessionManager.open(file)
			.getEntries()
			.filter((entry) => entry.type === "compaction");
		expect(entries).toHaveLength(20);
		for (const entry of entries) {
			expect(entry).toHaveProperty("details.summaryChars", entry.summary.length);
			expect(entry).toHaveProperty("details.summaryTokensEstimate", Math.ceil(entry.summary.length / 4));
			expect(entry).toHaveProperty("details.durationMs", expect.any(Number));
			expect(entry.usage?.output).toBeGreaterThan(Math.ceil(entry.summary.length / 4));
		}
	});

	it.each([0, -1, 8001, 1.5, Number.POSITIVE_INFINITY])(
		"rejects invalid summary output setting %s without changing reserves",
		(maxSummaryTokens) => {
			const settings = SettingsManager.inMemory({ compaction: { reserveTokens: 300000 } });
			settings.applyOverrides({ compaction: { maxSummaryTokens } });
			expect(() => settings.getCompactionMaxSummaryTokens()).toThrow("compaction.maxSummaryTokens");
			expect(settings.getCompactionReserveTokens()).toBe(300000);
		},
	);

	it("refuses an allowance that cannot fit exact file references rather than truncating them", async () => {
		const f = await fixture(({ model }) => response(model), {
			readFiles: [`/evidence/${"active-path".repeat(100)}`],
		});
		f.settings.applyOverrides({ compaction: { maxSummaryTokens: 100 } });
		expect(await settle(f.session.compact())).toHaveProperty("error");
		expect(f.requests).toEqual([]);
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
	});

	// smarty-dev#17478: native deadline failures must publish terminal state, not only a watchdog receipt.
	it.each(["manual", "threshold"] as const)("terminates %s primary+fallback hangs at nine minutes", async (reason) => {
		const f = await fixture(() => "hang");
		const operation = reason === "manual" ? f.session.compact() : f.session.prompt("TRIGGER");
		const observed = operation.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(299999);
		expect(f.requests.map(({ model }) => model.id)).toEqual([primary.id]);
		await vi.advanceTimersByTimeAsync(1);
		expect(f.requests.map(({ model }) => model.id)).toEqual([primary.id, fallback.id]);
		await vi.advanceTimersByTimeAsync(239999);
		expect(f.events.filter((event) => event.type === "compaction_end")).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(await observed).toBeInstanceOf(Error);
		expect(f.events.filter((event) => event.type === "compaction_end")).toMatchObject([
			{ reason, aborted: false, willRetry: false, errorMessage: expect.stringContaining("240000ms deadline") },
		]);
		expect(f.failedEvents).toMatchObject([{ reason, aborted: false, willRetry: false }]);
		expect(f.session.isCompacting).toBe(false);
		for (const stream of f.held) stream.push({ type: "done", reason: "stop", message: response(primary, "LATE") });
		await vi.advanceTimersByTimeAsync(600000);
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
		expect(f.requests).toHaveLength(2);
		expect(f.events.filter((event) => event.type === "agent_start")).toEqual([]);
	});

	it("uses configured phase budgets rather than request-specific timers", async () => {
		const f = await fixture(() => "hang");
		f.settings.applyOverrides({ compaction: { primaryTimeoutMs: 120, fallbackTimeoutMs: 80 } });
		const observed = f.session.compact().catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(120);
		expect(f.requests.map(({ model }) => model.id)).toEqual([primary.id, fallback.id]);
		await vi.advanceTimersByTimeAsync(80);
		expect(await observed).toBeInstanceOf(Error);
		expect(f.events.at(-1)).toMatchObject({ type: "compaction_end", aborted: false });
	});

	it.each([false, true])("counts initial primary auth in durationMs (expired=%s)", async (expired) => {
		const f = await fixture(({ model }) => response(model));
		const originalAuth = f.runtime.getAuth.bind(f.runtime);
		const primaryAuth = Promise.withResolvers<Awaited<ReturnType<typeof originalAuth>>>();
		vi.spyOn(f.runtime, "getAuth").mockImplementation(async (model, options) => {
			if (model.id === primary.id) return primaryAuth.promise;
			await new Promise<void>((resolve) => setTimeout(resolve, 10000));
			return originalAuth(model, options);
		});
		const observed = f.session.compact();
		await vi.advanceTimersByTimeAsync(expired ? 300000 : 60000);
		expect(f.requests).toEqual([]);
		if (!expired) primaryAuth.resolve(await originalAuth(primary));
		await vi.advanceTimersByTimeAsync(expired ? 10000 : 0);
		const result = await observed;
		expect(result).toHaveProperty("details.durationMs", expired ? 310000 : 60000);
		expect(f.requests.map(({ model }) => model.id)).toEqual(expired ? [fallback.id] : [primary.id, primary.id]);
		expect(f.hooks.preparations).toBe(1);
		primaryAuth.resolve(await originalAuth(primary));
		await vi.advanceTimersByTimeAsync(600000);
		expect(f.requests).toHaveLength(expired ? 1 : 2);
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("does not admit fallback for an explicit primary routing/auth denial", async () => {
		const f = await fixture(({ model }) => response(model));
		f.session.agent.state.model = { ...primary, api: "pi-virtual" };
		vi.spyOn(f.runtime, "resolveModel").mockRejectedValue(new Error("401 unauthorized routing auth"));
		expect(await settle(f.session.compact(), 0)).toHaveProperty("error.message", "401 unauthorized routing auth");
		expect(f.requests).toEqual([]);
		expect(f.events.at(-1)).toMatchObject({ type: "compaction_end", aborted: false, willRetry: false });
	});

	it.each(["manual", "threshold"] as const)("falls back after %s hook expiry without replay", async (reason) => {
		const hook = Promise.withResolvers<void>();
		const f = await fixture(({ model }) => (reason === "manual" ? response(model) : "hang"), {
			beforeCompact: async (event) => {
				event.preparation.previousSummary = "PARTIAL_MUTABLE_HOOK_DRAFT";
				await hook.promise;
				return { cancel: true };
			},
		});
		const operation = reason === "manual" ? f.session.compact() : f.session.prompt("TRIGGER");
		const observed = operation.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(300000);
		expect(f.requests.map(({ model }) => model.id)).toEqual([fallback.id]);
		expect(f.requests[0].context.messages.map((message) => contentText(message.content)).join(" ")).not.toContain(
			"PARTIAL_MUTABLE_HOOK_DRAFT",
		);
		if (reason === "threshold") await vi.advanceTimersByTimeAsync(240000);
		const result = await observed;
		if (reason === "manual") expect(result).toHaveProperty("details.durationMs", 0);
		else expect(result).toBeInstanceOf(Error);
		expect(f.hooks.preparations).toBe(1);
		expect(f.events.filter((event) => event.type === "compaction_end")).toHaveLength(1);
		hook.resolve();
		await vi.advanceTimersByTimeAsync(600000);
		expect(f.hooks.preparations).toBe(1);
		expect(f.requests).toHaveLength(1);
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(
			reason === "manual" ? 1 : 0,
		);
	});

	it.each(["manual", "threshold"] as const)("honors a timely %s hook veto without fallback", async (reason) => {
		const f = await fixture(({ model }) => response(model), { beforeCompact: () => ({ cancel: true }) });
		const operation = reason === "manual" ? f.session.compact() : f.session.prompt("TRIGGER");
		await settle<unknown>(operation, 0);
		await vi.advanceTimersByTimeAsync(600000);
		expect(f.requests).toEqual([]);
		expect(f.hooks.preparations).toBe(1);
		expect(f.events.filter((event) => event.type === "compaction_end")).toMatchObject([
			{ reason, aborted: true, willRetry: false },
		]);
	});

	it.each(["auth", "preparation-hook"] as const)("cancels hung %s without fallback", async (phase) => {
		const f = await fixture(({ model }) => response(model), {
			beforeCompact: phase === "preparation-hook" ? () => new Promise(() => {}) : undefined,
		});
		if (phase === "auth") vi.spyOn(f.runtime, "getAuth").mockImplementation(() => new Promise(() => {}));
		const observed = f.session.compact().catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(1);
		f.session.abortCompaction();
		expect(await observed).toBeInstanceOf(Error);
		expect(f.events.at(-1)).toMatchObject({ type: "compaction_end", aborted: true, willRetry: false });
		await vi.advanceTimersByTimeAsync(600000);
		expect(f.requests).toEqual([]);
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
	});

	it.each(["manual", "threshold"] as const)("bounds %s post-append observer hang", async (reason) => {
		const observer = Promise.withResolvers<void>();
		const f = await fixture(({ model }) => response(model), { afterCompact: () => observer.promise });
		const operation = reason === "manual" ? f.session.compact() : f.session.prompt("TRIGGER");
		const observed = operation.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(1);
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(299999);
		expect(await observed).toBeInstanceOf(Error);
		expect(f.events.filter((event) => event.type === "compaction_end")).toMatchObject([
			{ reason, aborted: false, willRetry: false, errorMessage: expect.stringContaining("300000ms deadline") },
		]);
		observer.resolve();
		await vi.advanceTimersByTimeAsync(600000);
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(f.requests.map(({ model }) => model.id)).toEqual([primary.id, primary.id]);
		expect(f.events.filter((event) => event.type === "agent_start")).toEqual([]);
	});

	it.each(["manual", "threshold"] as const)("does not replay %s post-append observer failure", async (reason) => {
		const f = await fixture(({ model }) => response(model), {
			afterCompact: () => {
				throw new Error("503 post-append observer failure");
			},
		});
		await f.session.bindExtensions({
			onError: (event) => {
				throw new Error(event.error);
			},
		});
		const operation = reason === "manual" ? f.session.compact() : f.session.prompt("TRIGGER");
		expect(await settle<unknown>(operation, 0)).toHaveProperty("error");
		await vi.advanceTimersByTimeAsync(600000);
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(f.requests.map(({ model }) => model.id)).toEqual([primary.id, primary.id]);
		expect(f.events.filter((event) => event.type === "agent_start")).toEqual([]);
		expect(f.events.filter((event) => event.type === "compaction_end")).toMatchObject([
			{ reason, aborted: false, willRetry: false, errorMessage: expect.stringContaining("observer failure") },
		]);
	});

	it("does not spend fallback on a retry observer error that looks transient", async () => {
		const f = await fixture(({ model }) => transient(model));
		f.session.subscribe((event) => {
			if (event.type === "summarization_retry_scheduled") throw new Error("503 retry observer failure");
		});
		expect(await settle(f.session.compact(), 0)).toHaveProperty("error");
		expect(f.requests.map(({ model }) => model.id)).toEqual([primary.id]);
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
	});

	it("bounds the outer wait for failure observers and publishes native terminal state first", async () => {
		const observer = Promise.withResolvers<void>();
		const f = await fixture(({ model }) => response(model, "PARTIAL", "403 permission denied"), {
			afterFailure: () => observer.promise,
		});
		const observed = f.session.compact().catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(0);
		expect(f.events.at(-1)).toMatchObject({ type: "compaction_end", aborted: false, willRetry: false });
		await vi.advanceTimersByTimeAsync(300000);
		expect(await observed).toBeInstanceOf(Error);
		observer.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.requests).toHaveLength(1);
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
	});

	it("bounds primary and fallback auth hangs within nine minutes", async () => {
		const f = await fixture(({ model }) => response(model));
		const auth = vi.spyOn(f.runtime, "getAuth").mockImplementation(() => new Promise(() => {}));
		const observed = f.session.compact().catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(300000);
		expect(auth.mock.calls.map(([model]) => model.id)).toEqual([primary.id, fallback.id]);
		await vi.advanceTimersByTimeAsync(240000);
		expect(await observed).toBeInstanceOf(Error);
		expect(f.events.at(-1)).toMatchObject({ type: "compaction_end", aborted: false, willRetry: false });
		expect(f.requests).toEqual([]);
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
	});

	it("does not start auth after an abandoned virtual primary route returns late", async () => {
		const f = await fixture(({ model }) => response(model));
		f.session.agent.state.model = { ...primary, api: "pi-virtual" };
		const route = Promise.withResolvers<Awaited<ReturnType<typeof f.runtime.resolveModel>>>();
		vi.spyOn(f.runtime, "resolveModel").mockImplementation(() => route.promise);
		const auth = vi.spyOn(f.runtime, "getAuth");
		expect(await settle(f.session.compact(), 300000)).toHaveProperty("value");
		route.resolve({ model: primary, thinkingLevel: "off" });
		await vi.advanceTimersByTimeAsync(600000);
		expect(auth.mock.calls.map(([model]) => model.id)).toEqual([fallback.id]);
		expect(f.requests.map(({ model }) => model.id)).toEqual([fallback.id]);
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it.each(["schedule", "finish"] as const)("bounds a hung %s retry observer without fallback", async (phase) => {
		const f = await fixture(({ model }, index) =>
			phase === "schedule" || index === 1 ? transient(model) : response(model),
		);
		const preparation = prepareCompaction(f.manager.getBranch(), f.settings.getCompactionSettings(primary))!;
		const deadline = new AbortController();
		const fallbackStart = vi.fn(() => new AbortController().signal);
		const observer = Promise.withResolvers<void>();
		const observed = compact(
			preparation,
			primary,
			undefined,
			undefined,
			undefined,
			deadline.signal,
			"off",
			f.session.agent.streamFunction,
			undefined,
			{ enabled: true, maxRetries: 2, baseDelayMs: 1 },
			phase === "schedule"
				? { onRetryScheduled: () => observer.promise }
				: { onRetryFinished: () => observer.promise },
			undefined,
			{ signal: new AbortController().signal, start: fallbackStart, resolve: async () => ({ model: fallback }) },
		).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(300000);
		deadline.abort(new DOMException("Primary deadline", "TimeoutError"));
		expect(await observed).toMatchObject({ message: "Summarization observer failed" });
		observer.resolve();
		await vi.advanceTimersByTimeAsync(600000);
		expect(fallbackStart).not.toHaveBeenCalled();
		expect(f.requests).toHaveLength(phase === "schedule" ? 1 : 2);
	});

	it("shares the primary deadline across successful history and hanging prefix", async () => {
		const f = await fixture(({ model }) => (model.id === primary.id ? "hang" : response(model)));
		const observed = f.session.compact();
		await vi.advanceTimersByTimeAsync(180000);
		expect(f.requests).toHaveLength(1);
		f.held[0].push({
			type: "done",
			reason: "stop",
			message: response(primary, "PRIMARY_HISTORY_NOT_FALLBACK_INPUT"),
		});
		await vi.advanceTimersByTimeAsync(119999);
		expect(f.requests.map(({ model }) => model.id)).toEqual([primary.id, primary.id]);
		await vi.advanceTimersByTimeAsync(1);
		expect(await observed).toHaveProperty("details.durationMs", 300000);
		expect(f.requests.map(({ model }) => model.id)).toEqual([primary.id, primary.id, fallback.id]);
		const prompt = f.requests[2].context.messages.map((message) => contentText(message.content)).join(" ");
		expect(prompt).toContain("HISTORY_SOURCE");
		expect(prompt).toContain("TURN_PREFIX_TASK");
		expect(prompt).not.toContain("PRIMARY_HISTORY_NOT_FALLBACK_INPUT");
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("does not extend a near-deadline primary retry backoff", async () => {
		const f = await fixture(({ model }) => (model.id === primary.id ? transient(model) : response(model)));
		f.settings.applyOverrides({ compaction: { primaryTimeoutMs: 10, fallbackTimeoutMs: 10 } });
		expect(await settle(f.session.compact(), 10)).toHaveProperty("value");
		expect(f.requests.map(({ model }) => model.id)).toEqual([primary.id, fallback.id]);
		expect(f.events.filter((event) => event.type === "summarization_retry_scheduled")).toHaveLength(1);
	});

	it("cancels a hanging fallback auth lookup immediately", async () => {
		const f = await fixture(({ model }) => transient(model));
		const originalAuth = f.runtime.getAuth.bind(f.runtime);
		vi.spyOn(f.runtime, "getAuth").mockImplementation((model, options) =>
			model.id === fallback.id ? new Promise(() => {}) : originalAuth(model, options),
		);
		const observed = f.session.compact().catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(6000);
		f.session.abortCompaction();
		expect(await observed).toBeInstanceOf(Error);
		expect(f.events.at(-1)).toMatchObject({ type: "compaction_end", aborted: true, willRetry: false });
		await vi.advanceTimersByTimeAsync(600000);
		expect(f.requests.map(({ model }) => model.id)).toEqual([primary.id, primary.id, primary.id]);
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
	});

	it.each(["manual", "threshold"] as const)("bounds %s terminal-listener error cleanup", async (reason) => {
		const observer = Promise.withResolvers<void>();
		const f = await fixture(({ model }) => response(model), { afterFailure: () => observer.promise });
		f.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.result) throw new Error("503 terminal observer failure");
		});
		const operation = reason === "manual" ? f.session.compact() : f.session.prompt("TRIGGER");
		const observed = operation.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(300000);
		expect(await observed).toBeInstanceOf(Error);
		expect(f.events.filter((event) => event.type === "compaction_end").at(-1)).toMatchObject({
			type: "compaction_end",
			reason,
			aborted: false,
			willRetry: false,
			errorMessage: expect.stringContaining("terminal observer failure"),
		});
		observer.resolve();
		await vi.advanceTimersByTimeAsync(600000);
		expect(f.requests.map(({ model }) => model.id)).toEqual([primary.id, primary.id]);
		expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(f.events.filter((event) => event.type === "agent_start")).toEqual([]);
	});

	it("does not grant ordinary partial-EOF turns the compaction retry/fallback allowance", async () => {
		const f = await fixture(({ model }) => response(model, "PARTIAL_ORDINARY_ANSWER", "terminated"));
		f.settings.applyOverrides({
			compaction: { enabled: false },
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, fallbackModel: fallbackReference },
		});
		await settle(f.session.prompt("ORDINARY_USER_TURN"));
		expect(f.requests).toHaveLength(1);
		expect(f.session.model).toBe(primary);
		expect(
			f.events.filter(
				(event) =>
					event.type === "auto_retry_start" ||
					event.type === "auto_retry_fallback" ||
					event.type === "compaction_start",
			),
		).toEqual([]);
	});
});
