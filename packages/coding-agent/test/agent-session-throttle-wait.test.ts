// smarty-net#136: a throttled smarty_limit with a short Retry-After waits and retries once, outside settings.retry.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

// Injectable sleep: record the delay and resolve at once, or park until the signal aborts.
const sleepState = vi.hoisted(() => ({
	delays: [] as number[],
	hold: false,
	onHold: undefined as (() => void) | undefined,
}));
vi.mock("../src/utils/sleep.ts", () => ({
	sleep: (ms: number, signal?: AbortSignal) => {
		sleepState.delays.push(ms);
		if (!sleepState.hold) return Promise.resolve();
		return new Promise<void>((_resolve, reject) => {
			signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
			sleepState.onHold?.();
		});
	},
}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

const LIMIT = "Flash runs one request at a time. Retry in 10s.";

function assistant(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "smarty",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

/** What openai-completions produces for a smarty_limit 429; `retryAfterSeconds` only for throttled with Retry-After <= 30. */
function limit(retryAfterSeconds?: number): AssistantMessage {
	return assistant({
		stopReason: "error",
		errorMessage: LIMIT,
		diagnostics: [
			{
				type: "provider_limit",
				timestamp: Date.now(),
				details:
					retryAfterSeconds === undefined
						? { code: "smarty_limit" }
						: { code: "smarty_limit", retryAfterSeconds, waitMessage: LIMIT },
			},
		],
	});
}

const ok = () => assistant({ content: [{ type: "text", text: "OK" }] });
const serverError = () => assistant({ stopReason: "error", errorMessage: "500 internal server error" });

describe("AgentSession throttled limit wait", () => {
	let session: AgentSession | undefined;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-throttle-wait-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		sleepState.delays = [];
		sleepState.hold = false;
		sleepState.onHold = undefined;
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	/** A session whose model answers each request with the next reply; generic retry enabled with 3 retries. */
	async function createSession(replies: Array<() => AssistantMessage>) {
		const requests = { count: 0 };
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				const reply = replies[Math.min(requests.count, replies.length - 1)]();
				requests.count++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: reply });
					if (reply.stopReason === "error") stream.push({ type: "error", reason: "error", error: reply });
					else stream.push({ type: "done", reason: "stop", message: reply });
				});
				return stream;
			},
		});
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(await createModelRegistry(authStorage, tempDir)),
			resourceLoader: createTestResourceLoader(),
		});
		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`wait:${event.delayMs}:${event.waitMessage}`);
			if (event.type === "auto_retry_end") events.push(`end:${event.success}`);
		});
		return { session, requests, events };
	}

	function last(s: AgentSession): AssistantMessage {
		return s.state.messages[s.state.messages.length - 1] as AssistantMessage;
	}

	it("throttled with Retry-After 10: waits 10 s, sends a second request and shows its answer", async () => {
		const { session, requests, events } = await createSession([() => limit(10), ok]);
		await session.prompt("Reply with only OK.");
		expect(requests.count).toBe(2);
		expect(sleepState.delays).toEqual([10_000]);
		expect(events).toEqual([`wait:10000:${LIMIT}`, "end:true"]);
		expect(last(session).content).toEqual([{ type: "text", text: "OK" }]);
	});

	it("throttled with Retry-After 10 twice: exactly 2 requests and the second limit message is final", async () => {
		const { session, requests } = await createSession([() => limit(10), () => limit(10), ok]);
		await session.prompt("Reply with only OK.");
		expect(requests.count).toBe(2);
		expect(last(session)).toMatchObject({ stopReason: "error", errorMessage: LIMIT });
	});

	it("any error on the retry is final, with no generic retry", async () => {
		const { session, requests } = await createSession([() => limit(10), serverError, ok]);
		await session.prompt("Reply with only OK.");
		expect(requests.count).toBe(2);
		expect(last(session)).toMatchObject({ stopReason: "error", errorMessage: "500 internal server error" });
	});

	it("a limit without a wait (throttled:false, Retry-After missing or over 30 s) is final after 1 request", async () => {
		const { session, requests, events } = await createSession([() => limit(), ok]);
		await session.prompt("Reply with only OK.");
		expect(requests.count).toBe(1);
		expect(events).toEqual([]);
		expect(last(session)).toMatchObject({ stopReason: "error", errorMessage: LIMIT });
	});

	it("waits again for a later throttle after a successful answer", async () => {
		const { session, requests } = await createSession([() => limit(10), ok, () => limit(5), ok]);
		await session.prompt("one");
		await session.prompt("two");
		expect(requests.count).toBe(4);
		expect(sleepState.delays).toEqual([10_000, 5_000]);
		expect(last(session).content).toEqual([{ type: "text", text: "OK" }]);
	});

	it("abort during the wait sends no second request and settles aborted", async () => {
		const { session, requests, events } = await createSession([() => limit(10), ok]);
		sleepState.hold = true;
		const waiting = new Promise<void>((resolve) => {
			sleepState.onHold = resolve;
		});
		const outcomes: string[] = [];
		session.subscribe((event) => {
			if (event.type === "agent_settled") outcomes.push(event.outcome);
		});
		const prompt = session.prompt("Reply with only OK.");
		await waiting;
		await session.abort();
		await prompt;
		expect(requests.count).toBe(1);
		expect(events).toEqual([`wait:10000:${LIMIT}`, "end:false"]);
		expect(outcomes).toEqual(["aborted"]);
	});
});
