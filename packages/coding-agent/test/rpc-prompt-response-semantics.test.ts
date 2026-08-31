import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
	onOutputLine: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
		rpcIo.onOutputLine?.(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
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

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
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

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	failFirstResponse?: boolean;
	retry?: boolean;
	extensionFactories?: ExtensionFactory[];
}): Promise<{
	runtimeHost: AgentSessionRuntime;
	session: AgentSession;
	sessionManager: SessionManager;
	rebind: () => Promise<void>;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `pi-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	let streamCount = 0;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			const shouldFail = options.failFirstResponse === true && streamCount === 0;
			streamCount++;
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					if (shouldFail) {
						const message = createAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
						stream.push({ type: "error", reason: "error", error: message });
					} else {
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
					}
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	if (options.retry) {
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
	}
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	if (options.withAuth) {
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	}
	const resourceLoader = createTestResourceLoader(
		options.extensionFactories
			? { extensionsResult: await createTestExtensionsResult(options.extensionFactories, tempDir) }
			: undefined,
	);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader,
	});

	let rebindSession: (() => Promise<void>) | undefined;
	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: (callback: () => Promise<void>) => {
			rebindSession = callback;
		},
	} as unknown as AgentSessionRuntime;

	return {
		session,
		sessionManager,
		runtimeHost,
		rebind: async () => {
			if (!rebindSession) {
				throw new Error("RPC rebind callback was not registered");
			}
			await rebindSession();
		},
		cleanup: async () => {
			try {
				if (session.isStreaming) {
					await session.abort();
				}
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	failFirstResponse?: boolean;
	retry?: boolean;
	extensionFactories?: ExtensionFactory[];
}): Promise<{
	lineHandler: (line: string) => void;
	session: AgentSession;
	sessionManager: SessionManager;
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, session, sessionManager, cleanup } = await createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, runtimeHost, session, sessionManager, cleanup };
}

describe("RPC prompt response semantics", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		rpcIo.onOutputLine = undefined;
	});

	it("emits one failure response when prompt preflight rejects", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: false,
					error: expect.stringContaining(
						"No API key found for fake-provider.\n\nUse /login to log into a provider via OAuth or API key. See:",
					),
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt preflight succeeds", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits each live message_end after persistence with its history entry ID", async () => {
		const { lineHandler, session, sessionManager, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
		});
		const observedEntryIds: Array<{ entryId: unknown; historyId: string | undefined }> = [];
		rpcIo.onOutputLine = (line) => {
			const event = JSON.parse(line) as Record<string, unknown>;
			if (event.type !== "message_end") return;

			const entryId = event.entryId;
			const entry = typeof entryId === "string" ? sessionManager.getEntry(entryId) : undefined;
			const customMessage =
				typeof event.message === "object" && event.message !== null
					? (event.message as Record<string, unknown>)
					: undefined;
			const matchingEntry =
				(entry?.type === "message" && JSON.stringify(entry.message) === JSON.stringify(event.message)) ||
				(entry?.type === "custom_message" &&
					customMessage?.role === "custom" &&
					entry.customType === customMessage.customType &&
					entry.display === customMessage.display &&
					JSON.stringify(entry.content) === JSON.stringify(customMessage.content));
			observedEntryIds.push({ entryId, historyId: matchingEntry && entry ? entry.id : undefined });
		};

		try {
			lineHandler(JSON.stringify({ id: "entry-id", type: "prompt", message: "Check message entry IDs" }));
			await vi.waitFor(() => expect(observedEntryIds).toHaveLength(2));
			await vi.waitFor(() => expect(session.isStreaming).toBe(false));
			await session.sendCustomMessage({ customType: "test", content: "Custom message", display: true });
			await vi.waitFor(() => expect(observedEntryIds).toHaveLength(3));

			for (const { entryId, historyId } of observedEntryIds) {
				expect(typeof entryId).toBe("string");
				expect(entryId).toBe(historyId);
			}
		} finally {
			await cleanup();
		}
	});

	it("does not expose persisted message IDs outside RPC capture", async () => {
		const { session, sessionManager, cleanup } = await createRuntimeHost({ withAuth: true, responseDelayMs: 0 });
		const messages: AgentMessage[] = [];
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "message_end") {
				messages.push(event.message);
			}
		});

		try {
			await session.prompt("Persist without RPC capture");

			expect(messages).toHaveLength(2);
			expect(sessionManager.getEntries()).toHaveLength(2);
			expect(messages.map((message) => session.takeMessageEntryId(message))).toEqual([undefined, undefined]);
		} finally {
			unsubscribe();
			await cleanup();
		}
	});

	it("does not let a session_start message poison a later RPC ID", async () => {
		const sessionStartMessages: AgentMessage[] = [];
		const { runtimeHost, session, sessionManager, cleanup } = await createRuntimeHost({
			withAuth: true,
			responseDelayMs: 50,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async () => {
						pi.sendMessage({
							customType: "session-start-reused",
							content: "Session start message",
							display: true,
						});
						await Promise.resolve();
					});
				},
			],
		});
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "custom") {
				if (event.message.customType === "session-start-reused") {
					sessionStartMessages.push(event.message);
				}
			}
		});

		try {
			void runRpcMode(runtimeHost);
			await vi.waitFor(() => {
				expect(rpcIo.lineHandler).toBeDefined();
				expect(sessionStartMessages).toHaveLength(1);
			});

			const sessionStartMessage = sessionStartMessages[0];
			if (!sessionStartMessage || sessionStartMessage.role !== "custom") {
				throw new Error("Expected the session_start custom message");
			}
			const sessionStartEntry = sessionManager
				.getEntries()
				.find((entry) => entry.type === "custom_message" && entry.customType === "session-start-reused");
			if (!sessionStartEntry) {
				throw new Error("Expected the persisted session_start message");
			}

			rpcIo.outputLines = [];
			rpcIo.lineHandler!(JSON.stringify({ id: "reuse-session-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => expect(session.isStreaming).toBe(true));
			session.agent.steer(sessionStartMessage);
			await vi.waitFor(() => {
				const customEvents = parseOutputLines(rpcIo.outputLines).filter((event) => {
					const message = event.message as Record<string, unknown> | undefined;
					return event.type === "message_end" && message?.customType === "session-start-reused";
				});
				expect(customEvents).toHaveLength(1);
			});

			const customEvent = parseOutputLines(rpcIo.outputLines).find((event) => {
				const message = event.message as Record<string, unknown> | undefined;
				return event.type === "message_end" && message?.customType === "session-start-reused";
			});
			if (!customEvent) {
				throw new Error("Expected the rerouted custom message event");
			}
			const matchingEntries = sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "session-start-reused");

			expect(matchingEntries).toHaveLength(2);
			expect(customEvent.entryId).toBe(matchingEntries[1]!.id);
			expect(customEvent.entryId).not.toBe(sessionStartEntry.id);
		} finally {
			unsubscribe();
			await cleanup();
		}
	});

	it("clears prior capture state when rebinding to a new RPC session", async () => {
		const first = await createRuntimeHost({ withAuth: true, responseDelayMs: 0 });
		const second = await createRuntimeHost({ withAuth: true, responseDelayMs: 0 });
		let staleMessage: AgentMessage | undefined;
		const unsubscribe = second.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "custom") {
				if (event.message.customType === "prior-rebind") {
					staleMessage = event.message;
				}
			}
		});

		try {
			second.session.startMessageEntryIdCapture();
			await second.session.sendCustomMessage({
				customType: "prior-rebind",
				content: "Captured before rebind",
				display: true,
			});
			if (!staleMessage) {
				throw new Error("Expected the pre-rebind custom message");
			}

			void runRpcMode(first.runtimeHost);
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			(first.runtimeHost as unknown as { session: AgentSession }).session = second.session;
			await first.rebind();

			expect(second.session.takeMessageEntryId(staleMessage)).toBeUndefined();
		} finally {
			unsubscribe();
			await second.cleanup();
			await first.cleanup();
		}
	});

	it("does not scan long session history for live message entry IDs", async () => {
		const { lineHandler, sessionManager, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
		});
		for (let index = 0; index < 4096; index++) {
			sessionManager.appendMessage({ role: "user", content: `history ${index}`, timestamp: index });
		}
		const getEntries = vi.spyOn(sessionManager, "getEntries");

		try {
			lineHandler(JSON.stringify({ id: "long-history", type: "prompt", message: "Live message IDs" }));
			await vi.waitFor(() => {
				const messageEnds = parseOutputLines(rpcIo.outputLines).filter((event) => event.type === "message_end");
				expect(messageEnds).toHaveLength(2);
			});
			expect(getEntries).not.toHaveBeenCalled();
		} finally {
			getEntries.mockRestore();
			await cleanup();
		}
	});

	it("emits a persisted ID for a custom message queued during streaming", async () => {
		const { lineHandler, session, sessionManager, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 50,
		});
		const customEvents: Record<string, unknown>[] = [];
		rpcIo.onOutputLine = (line) => {
			const event = JSON.parse(line) as Record<string, unknown>;
			if (
				event.type === "message_end" &&
				typeof event.message === "object" &&
				event.message !== null &&
				(event.message as Record<string, unknown>).role === "custom"
			) {
				customEvents.push(event);
			}
		};

		try {
			lineHandler(JSON.stringify({ id: "stream-custom", type: "prompt", message: "Start" }));
			await vi.waitFor(() => expect(session.isStreaming).toBe(true));
			await session.sendCustomMessage({ customType: "queued", content: "Queued custom message", display: true });
			await vi.waitFor(() => expect(customEvents).toHaveLength(1));

			const entryId = customEvents[0]!.entryId;
			if (typeof entryId !== "string") {
				throw new Error("Expected the custom message_end event to include an entryId");
			}
			expect(sessionManager.getEntry(entryId)).toMatchObject({
				type: "custom_message",
				customType: "queued",
				content: "Queued custom message",
			});
		} finally {
			await cleanup();
		}
	});

	it("keeps a successful retry's persisted assistant message_end before auto_retry_end", async () => {
		const { lineHandler, sessionManager, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			failFirstResponse: true,
			retry: true,
		});

		try {
			lineHandler(JSON.stringify({ id: "retry-order", type: "prompt", message: "Retry" }));
			await vi.waitFor(() => {
				expect(
					parseOutputLines(rpcIo.outputLines).some(
						(event) => event.type === "auto_retry_end" && event.success === true,
					),
				).toBe(true);
			});

			const events = parseOutputLines(rpcIo.outputLines);
			const assistantMessageEndIndex = events.findIndex((event) => {
				if (event.type !== "message_end") return false;
				const message = event.message as Record<string, unknown> | undefined;
				return (
					message?.role === "assistant" && JSON.stringify(message.content) === '[{"type":"text","text":"done"}]'
				);
			});
			if (assistantMessageEndIndex === -1) {
				throw new Error("Expected the successful assistant message_end event");
			}
			const autoRetryEndIndex = events.findIndex(
				(event) => event.type === "auto_retry_end" && event.success === true,
			);
			expect(autoRetryEndIndex).toBeGreaterThan(assistantMessageEndIndex);

			const entryId = events[assistantMessageEndIndex]!.entryId;
			if (typeof entryId !== "string") {
				throw new Error("Expected the successful assistant message_end event to include an entryId");
			}
			expect(sessionManager.getEntry(entryId)).toMatchObject({
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "done" }] },
			});
		} finally {
			await cleanup();
		}
	});

	it("maps identical queued custom message_end events to distinct entries", async () => {
		const { lineHandler, session, sessionManager, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 50,
		});
		const customMessage = { customType: "duplicate", content: "Queued custom message", display: true };

		try {
			lineHandler(JSON.stringify({ id: "duplicate-custom", type: "prompt", message: "Start" }));
			await vi.waitFor(() => expect(session.isStreaming).toBe(true));
			await session.sendCustomMessage(customMessage, { triggerTurn: false });
			await session.sendCustomMessage(customMessage, { triggerTurn: false });
			await vi.waitFor(() => {
				const customEvents = parseOutputLines(rpcIo.outputLines).filter((event) => {
					const message = event.message as Record<string, unknown> | undefined;
					return event.type === "message_end" && message?.role === "custom" && message.customType === "duplicate";
				});
				expect(customEvents).toHaveLength(2);
			});

			const customEvents = parseOutputLines(rpcIo.outputLines).filter((event) => {
				const message = event.message as Record<string, unknown> | undefined;
				return event.type === "message_end" && message?.role === "custom" && message.customType === "duplicate";
			});
			const entryIds = customEvents.map((event) => event.entryId);
			for (const entryId of entryIds) {
				expect(typeof entryId).toBe("string");
			}
			expect(new Set(entryIds)).toHaveLength(2);

			const matchingEntries = sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === customMessage.customType &&
						entry.content === customMessage.content &&
						entry.display === customMessage.display,
				);
			expect(entryIds).toEqual(matchingEntries.map((entry) => entry.id));
		} finally {
			await cleanup();
		}
	});
	it("maps two emissions of the same agent-routed custom object to distinct entries", async () => {
		const { lineHandler, session, sessionManager, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 50,
		});
		const customMessage = {
			role: "custom" as const,
			customType: "agent-routed-duplicate",
			content: "Same custom message",
			display: true,
			timestamp: Date.now(),
		};

		try {
			lineHandler(JSON.stringify({ id: "agent-routed-duplicate", type: "prompt", message: "Start" }));
			await vi.waitFor(() => expect(session.isStreaming).toBe(true));
			session.agent.steer(customMessage);
			session.agent.steer(customMessage);
			await vi.waitFor(() => {
				const customEvents = parseOutputLines(rpcIo.outputLines).filter((event) => {
					const message = event.message as Record<string, unknown> | undefined;
					return (
						event.type === "message_end" &&
						message?.role === "custom" &&
						message.customType === customMessage.customType
					);
				});
				expect(customEvents).toHaveLength(2);
			});

			const customEvents = parseOutputLines(rpcIo.outputLines).filter((event) => {
				const message = event.message as Record<string, unknown> | undefined;
				return (
					event.type === "message_end" &&
					message?.role === "custom" &&
					message.customType === customMessage.customType
				);
			});
			const entryIds = customEvents.map((event) => event.entryId);
			const matchingEntries = sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === customMessage.customType &&
						entry.content === customMessage.content &&
						entry.display === customMessage.display,
				);
			expect(entryIds).toEqual(matchingEntries.map((entry) => entry.id));
			expect(new Set(entryIds)).toHaveLength(2);
		} finally {
			await cleanup();
		}
	});

	it("writes sendMessage message_end before a following UI notification", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			extensionFactories: [
				(pi) => {
					pi.registerCommand("send-and-notify", {
						description: "Send a custom message and notify",
						handler: async (_args, ctx) => {
							pi.sendMessage({
								customType: "send-before-notify",
								content: "Custom message",
								display: true,
							});
							ctx.ui.notify("After custom message");
						},
					});
				},
			],
		});

		try {
			lineHandler(JSON.stringify({ id: "send-and-notify", type: "prompt", message: "/send-and-notify" }));
			await vi.waitFor(() => {
				const records = parseOutputLines(rpcIo.outputLines);
				const messageEndIndex = records.findIndex((record) => {
					const message = record.message as Record<string, unknown> | undefined;
					return (
						record.type === "message_end" &&
						message?.role === "custom" &&
						message.customType === "send-before-notify"
					);
				});
				const notifyIndex = records.findIndex(
					(record) =>
						record.type === "extension_ui_request" &&
						record.method === "notify" &&
						record.message === "After custom message",
				);
				expect(messageEndIndex).toBeGreaterThanOrEqual(0);
				expect(notifyIndex).toBeGreaterThan(messageEndIndex);
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "b3-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "b3-start")).toHaveLength(1);
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
				});
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});

	it("returns and clears queued steering and follow-up messages", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 500 });

		try {
			lineHandler(JSON.stringify({ id: "clear-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-start")).toHaveLength(1);
			});

			lineHandler(
				JSON.stringify({
					id: "clear-steering",
					type: "prompt",
					message: "Change direction",
					streamingBehavior: "steer",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-steering")).toHaveLength(1);
			});

			lineHandler(
				JSON.stringify({
					id: "clear-follow-up",
					type: "prompt",
					message: "Summarize when finished",
					streamingBehavior: "followUp",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-follow-up")).toHaveLength(1);
			});

			lineHandler(JSON.stringify({ id: "clear", type: "clear_queue" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "clear",
					type: "response",
					command: "clear_queue",
					success: true,
					data: {
						steering: ["Change direction"],
						followUp: ["Summarize when finished"],
					},
				});
			});

			await sleep(600);
			expect(parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_start")).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});
});
