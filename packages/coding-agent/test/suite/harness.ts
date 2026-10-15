import { createInMemoryModelRegistry, createModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
/**
 * Local test harness for the new coding-agent test suite.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type {
	FauxModelDefinition,
	FauxProviderRegistration,
	FauxResponseStep,
	Model,
	ToolResultMessage,
} from "@earendil-works/pi-ai/compat";
import { registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionRunner, ExtensionUIContext, SessionStartEvent } from "../../src/core/extensions/index.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { InlineExtension, ResourceLoader } from "../../src/index.ts";
import { theme } from "../../src/modes/interactive/theme/theme.ts";
import {
	type CreateTestExtensionsResultInput,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "../utilities.ts";

// smarty-dev#12837: join every cancelled turn before the next test, including unawaited cleanup calls.
const pendingCleanups = new Set<Promise<void>>();
afterEach(async () => {
	const pending = [...pendingCleanups];
	pendingCleanups.clear();
	const results = await Promise.allSettled(pending);
	const failure = results.find((result) => result.status === "rejected");
	if (failure?.status === "rejected") throw failure.reason;
});

type MessageTextPart = { type: "text"; text: string };

export function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) {
		return "";
	}
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is MessageTextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function getUserTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "user")
		.map((message) => getMessageText(message));
}

export function getAssistantTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => getMessageText(message));
}

/** The latest result of `toolName` in the session transcript. */
export function getToolResult(harness: Harness, toolName: string): ToolResultMessage {
	const result = harness.session.messages.findLast(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
	);
	if (!result) throw new Error(`No ${toolName} tool result`);
	return result;
}

/** An extension UI context that does nothing, with `overrides` applied. */
export function createTestUiContext(overrides: Partial<ExtensionUIContext> = {}): ExtensionUIContext {
	return {
		holdState: () => undefined,
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
		...overrides,
	};
}

export interface HarnessOptions {
	persistSession?: boolean;
	/** Runtime replacement tests supply the destination cwd and lifecycle metadata. */
	cwd?: string;
	sessionStartEvent?: SessionStartEvent;
	models?: FauxModelDefinition[];
	settings?: Partial<Settings>;
	tools?: AgentTool[];
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	resourceLoader?: ResourceLoader;
	extensionFactories?: Array<InlineExtension | CreateTestExtensionsResultInput>;
	withConfiguredAuth?: boolean;
	modelsJson?: Record<string, unknown>;
	/** Session to continue, for example to test a resume. Default: a new in-memory session. */
	sessionManager?: SessionManager;
	prepareRequest?: Agent["prepareRequest"];
}

export interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	authStorage: AuthStorage;
	modelRuntime: ModelRuntime;
	resourceLoader: ResourceLoader;
	faux: FauxProviderRegistration;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	events: AgentSessionEvent[];
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
	tempDir: string;
	cleanup: () => Promise<void>;
}

function createTempDir(): string {
	const tempDir = join(tmpdir(), `pi-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = createTempDir();
	const fauxProvider: FauxProviderRegistration = registerFauxProvider({
		models: options.models,
	});
	fauxProvider.setResponses([]);
	const model = fauxProvider.getModel();
	const toolMap = options.tools ? Object.fromEntries(options.tools.map((tool) => [tool.name, tool])) : undefined;
	const withConfiguredAuth = options.withConfiguredAuth ?? true;
	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	const cwd = options.cwd ?? tempDir;
	const sessionManager =
		options.sessionManager ??
		(options.persistSession ? SessionManager.create(cwd, tempDir) : SessionManager.inMemory());
	const settingsManager = SettingsManager.inMemory(options.settings);

	const authStorage = AuthStorage.inMemory();
	if (withConfiguredAuth) {
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	}
	const modelsPath = options.modelsJson === undefined ? undefined : join(tempDir, "models.json");
	if (modelsPath) writeFileSync(modelsPath, JSON.stringify(options.modelsJson));
	const modelRegistry = modelsPath
		? await createModelRegistry(authStorage, modelsPath)
		: await createInMemoryModelRegistry(authStorage);
	if (withConfiguredAuth) {
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: fauxProvider.api,
			models: fauxProvider.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				inputLimits: registeredModel.inputLimits,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
	}

	const agent = new Agent({
		getApiKey: () => (withConfiguredAuth ? "faux-key" : undefined),
		streamFn: streamSimple,
		initialState: {
			model,
			systemPrompt: "",
			tools: [],
		},
		convertToLlm,
		prepareRequest: options.prepareRequest,
		onPayload: async (payload) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({ type: "after_provider_response", status: response.status });
		},
		transformContext: async (messages: AgentMessage[]) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
	});
	const extensionsResult = options.extensionFactories
		? await createTestExtensionsResult(options.extensionFactories, cwd)
		: undefined;
	const resourceLoader =
		options.resourceLoader ?? createTestResourceLoader(extensionsResult ? { extensionsResult } : undefined);

	const modelRuntime = getModelRuntime(modelRegistry);
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		modelRuntime,
		sessionStartEvent: options.sessionStartEvent,
		resourceLoader,
		baseToolsOverride: toolMap,
		initialActiveToolNames: options.initialActiveToolNames,
		allowedToolNames: options.allowedToolNames,
		excludedToolNames: options.excludedToolNames,
		extensionRunnerRef,
	});

	let cleanupPromise: Promise<void> | undefined;
	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});

	const harness: Harness = {
		session,
		sessionManager,
		settingsManager,
		authStorage,
		modelRuntime,
		resourceLoader,
		faux: fauxProvider,
		models: fauxProvider.models,
		getModel: fauxProvider.getModel,
		setResponses: fauxProvider.setResponses,
		appendResponses: fauxProvider.appendResponses,
		getPendingResponseCount: fauxProvider.getPendingResponseCount,
		events,
		eventsOfType<T extends AgentSessionEvent["type"]>(type: T) {
			return events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
		},
		tempDir,
		cleanup() {
			if (cleanupPromise) return cleanupPromise;
			cleanupPromise = (async () => {
				// SDK converter tests may replace the initial session; settle the current owner.
				const currentSession = harness.session;
				// Fence before cancellation can yield to a hook; keep it closed through terminal disposal.
				const release = currentSession.gateInputs();
				try {
					currentSession.cancelForShutdown();
					await currentSession.abort();
					// smarty-dev#3048: test teardown deliberately recovers undelivered input.
					currentSession.clearQueue();
					try {
						currentSession.dispose();
					} finally {
						fauxProvider.unregister();
						if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
					}
				} finally {
					release();
				}
			})();
			pendingCleanups.add(cleanupPromise);
			// The shared afterEach observes failures, even when a caller does not await cleanup itself.
			void cleanupPromise.catch(() => {});
			return cleanupPromise;
		},
	};
	return harness;
}
