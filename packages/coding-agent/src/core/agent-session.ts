/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
	Agent,
	type AgentContext,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type PrepareNextTurnContext,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	contentText,
	getCurrentSystemMessage,
	hasAssistantOutput,
	isPrematureStreamError,
	type RetryPolicy,
	retryDelayMs,
} from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	AuthResult,
	ImageContent,
	Model,
	ProviderHeaders,
	SystemMessage,
	TextContent,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRecoverableLength,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
	throttledLimitWait,
} from "@earendil-works/pi-ai/compat";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { processImage } from "../utils/image-process.ts";
import { sleep } from "../utils/sleep.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import { generateBugReportSummary } from "./bug-report.ts";
import type { CacheWarmer, CacheWarmingStatus } from "./cache-warmer.ts";
import {
	assertContextFitsWindow,
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateProjectedContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "./defaults.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type AgentActivityOutcome,
	type BoundaryContextPreview,
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactEvent,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionBoundaryDraft,
	type SessionCompactEvent,
	type SessionCompactFailedEvent,
	type SessionStartEvent,
	type ShutdownHandler,
	type SubmitUserMessageOptions,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnStartEvent,
	type UserMessageReceipt,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { type BashExecutionMessage, type CustomMessage, convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { OriginalAutomaticEnrollment } from "./ordinary-automatic-hold.ts";
import { assertOriginalCompactionAttempt, type OriginalCompactionAttempt } from "./ordinary-compaction.ts";
import { assertOrdinaryRuntime, type OrdinaryOwnerContext, ordinaryOwnerOf } from "./ordinary-owner-context.ts";
import { createOrdinaryToolDefinitions } from "./ordinary-tools.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import { bindReceivedInputSession, getInputReceipt, type ReceivedInput, receiveInput } from "./received-input.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { exportSessionToJsonl } from "./session-export.ts";
import {
	appendOwnedTerminalCustomMessage,
	appendOwnedTerminalMessage,
	type BranchSummaryEntry,
	type CompactionEntry,
	type ContextEditEntry,
	getLatestCompactionEntry,
	type SessionEntry,
	SessionManager,
} from "./session-manager.ts";
import { appendReceivedCustomMessage, appendReceivedMessage } from "./session-turn-appender.ts";
import type { CacheWarmingMode, SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	diffSystemPromptSections,
	type NormalizedBuildSystemPromptOptions,
	normalizeBuildSystemPromptOptions,
} from "./system-prompt.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { captureTerminalTurnReceipt, type TurnReceipt } from "./turn-receipts.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";
import { type UserMessageAdmission, UserMessageIngress } from "./user-message-ingress.ts";

const appendOriginalCompaction = SessionManager.prototype.appendCompaction;
const originalCompactionSessions = new WeakMap<
	AgentSession,
	{
		attempt: OriginalCompactionAttempt;
		check(): void;
		afterAppend(): void;
	}
>();
export let runOriginalSessionCompaction: (
	session: AgentSession,
	attempt: OriginalCompactionAttempt,
) => Promise<CompactionResult>;
export function checkOriginalSessionCompaction(session: AgentSession, attempt: OriginalCompactionAttempt): void {
	const state = originalCompactionSessions.get(session);
	if (!state) return;
	if (state.attempt !== attempt) throw new Error("OPS_COMPACTION_ORIGINAL_ATTEMPT_REQUIRED");
	state.check();
}
export function clearOriginalSessionCompaction(session: AgentSession, attempt: OriginalCompactionAttempt): void {
	const state = originalCompactionSessions.get(session);
	if (!state) return;
	if (state.attempt !== attempt) throw new Error("OPS_COMPACTION_ORIGINAL_ATTEMPT_REQUIRED");
	originalCompactionSessions.delete(session);
}

// Read the original active-run boundary, not a replaceable instance accessor or mutable state flag.
const originalAgentSignal = Object.getOwnPropertyDescriptor(Agent.prototype, "signal")!.get! as (
	this: Agent,
) => AbortSignal | undefined;

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled"; outcome: AgentActivityOutcome }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			/** Set for the one-shot wait on a throttled provider limit: show `Waiting Ns: <waitMessage>`. */
			waitMessage?: string;
	  }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "auto_retry_fallback"; fromModel: string; toModel: string; attempt: number; errorMessage: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; delta: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime: ModelRuntime;
	/** Keeps the prompt cache entry of the last session request warm. */
	cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
}

export interface ExtensionBindings {
	/** Mode-owned submitted input awaiting transfer, not unsent editor drafts. */
	hasPendingInput?: () => boolean;
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to dispatch extension commands and expand skill commands and prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
	/** Internal TUI handoff: input was consumed, queued, or handed to the original agent.
	 * Unlike preflight acceptance, this remains true if the operation later fails. */
	onInputTransferred?: () => void;
}

/** Options for model/thinking mutations. */
export interface ModelMutationOptions {
	/** Persist the new value to global defaults. Defaults to session-only. */
	persist?: boolean;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

// A split compaction has two serial summaries. Allow two existing 10-minute
// SDK request windows in total, including retries and backoff, not per attempt.
const COMPACTION_TIMEOUT_MS = 20 * 60_000;
const COMPACTION_RETRY_POLICY: RetryPolicy = { enabled: true, maxRetries: 1, baseDelayMs: 2000 };

// Boolean values retain the continuation decision; failures must not look like
// a skipped check or successful compaction with nothing queued.
type CompactionOutcome = boolean | "failed" | "aborted";

function startCompactionDeadline(controller: AbortController): ReturnType<typeof setTimeout> {
	return setTimeout(() => {
		controller.abort(new DOMException("Compaction exceeded its 20-minute deadline", "TimeoutError"));
	}, COMPACTION_TIMEOUT_MS);
}

/** Explicit cancellation aborts the signal. Deadline expiry and error text alone are failures. */
function isCompactionCancelled(signal: AbortSignal): boolean {
	return signal.aborted && !(signal.reason instanceof DOMException && signal.reason.name === "TimeoutError");
}

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	static {
		runOriginalSessionCompaction = (session, attempt) => session.#compactOriginal(attempt);
	}
	readonly agent: Agent;
	readonly #originalAgent: Agent;
	readonly sessionManager: SessionManager;
	#contextUsageCache: { revision: number; contextWindow: number; usage: ContextUsage } | undefined;
	readonly settingsManager: SettingsManager;
	readonly #ordinaryOwner?: OrdinaryOwnerContext;
	#ordinaryPreflights = 0;
	#pendingModeInput?: () => boolean;
	private readonly _shutdownCancellation = new AbortController();
	private readonly _userMessageIngress = new UserMessageIngress(this._shutdownCancellation.signal);
	private readonly _userMessageAdmissions = new WeakMap<PromptOptions, UserMessageAdmission>();
	private readonly _ingressQueuedMessages = new Map<AgentMessage, { text: string; displayIndex: number }>();
	private _settlementCompletion?: Promise<void>;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	/** Prompt preflights that may still start a run, oldest first. */
	private readonly _promptPreflights = new Set<object>();
	/** Input was queued behind a prompt preflight, not behind an active run. */
	private _inputQueuedBehindPreflight = false;
	/** Triggered custom messages held behind prompt preflight or switch completion hooks, oldest first. */
	private readonly _triggeredBehindPreflight: Array<{ message: CustomMessage; deliverAs?: "steer" | "followUp" }> = [];
	private _agentRunAbortRequested = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Context-only custom messages queued during a run, flushed once the current turn's tool results are in. */
	private _pendingCustomMessages: CustomMessage[] = [];
	/** FIFO entry IDs keyed by live message objects for the active capture epoch. */
	private _messageEntryIds: WeakMap<AgentMessage, string[]> | undefined;
	/** Receipt associations last only until this publication succeeds. */
	readonly #receivedMessageReceipts = new WeakMap<AgentMessage, TurnReceipt>();

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _stopAfterCompactionFailure = false;
	/** Settlement outcome of the compaction that stopped the run; a later synthetic turn_end cannot replace it. */
	private _compactionStopOutcome: AgentActivityOutcome | undefined;
	private _overflowRecoveryAttempted = false;
	private _modelSwitchCompactionPending = false;
	/** Admission waiters must wake before accepted triggers finish, unlike true-idle waiters. */
	private _modelSwitchAdmissionWait: Promise<void> = Promise.resolve();
	private _resolveModelSwitchAdmissionWait: (() => void) | undefined;
	/** External admission waiters remain pending until dispatch or explicit retention takes ownership. */
	private readonly _modelSwitchDispatches = new Map<CustomMessage, { deliverAs?: "steer" | "followUp" }>();
	/** Compaction hooks may await message acceptance, but must not await their enclosing switch. */
	private readonly _compactionHookScope = new AsyncLocalStorage<boolean>();

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	private _retryFallbackUsed = false;
	/** Only the first alternate request in the current recovery episode is one-shot. */
	private _retryFallbackInFlight = false;
	// Sticky per assistant request: providers may discard partial content on error.
	private _assistantOutputObserved = false;
	/** A throttled-limit wait was used since the last successful assistant message; the next error is final. */
	private _throttleWaitUsed = false;

	// Bash execution state
	private readonly _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;
	private readonly _entryIdsByMessage = new WeakMap<object, string>();
	private readonly _boundaryDispatchedMessages = new WeakSet<object>();
	private _lastAssistantMessage: AssistantMessage | undefined;
	private _lastAssistantToolResults: AgentMessage[] = [];
	private _lastActivityOutcome: AgentActivityOutcome = "completed";
	private _isBeforeSettle = false;
	private _abortDuringBeforeSettle = false;
	private _isEmittingAgentSettled = false;
	/** Settlement descendants await acceptance, never delivery that requires their handler to return. */
	private readonly _agentSettledScope = new AsyncLocalStorage<{ active: boolean }>();
	private readonly _deferredSettledActions: Array<() => Promise<void>> = [];
	private readonly _settlementActionScope = new AsyncLocalStorage<{ active: boolean }>();

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	private _modelRuntime: ModelRuntime;
	private _cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	private _baseSystemPromptOptions!: NormalizedBuildSystemPromptOptions;
	/** Prompt options after before_agent_start mutations for the active run. */
	private _runSystemPromptOptions?: NormalizedBuildSystemPromptOptions;

	constructor(config: AgentSessionConfig) {
		const owner = ordinaryOwnerOf(config);
		const sessionManager = config.sessionManager;
		assertOrdinaryRuntime(sessionManager, owner);
		if (owner && (config.baseToolsOverride || config.customTools?.length || config.scopedModels?.length)) {
			throw new Error("OWNER_RUNTIME_SCOPE");
		}
		this.#ordinaryOwner = owner;
		this.agent = config.agent;
		this.#originalAgent = this.agent;
		this.sessionManager = sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._cacheWarmer = config.cacheWarmer;
		if (this._cacheWarmer) {
			this._cacheWarmer.onWarmed = (entry) => this._emit({ type: "entry_appended", entry });
		}
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		bindReceivedInputSession(this, {
			prompt: (input, options) => this._promptReceived(input, options),
			steer: (input, source) =>
				this._queueUserInput(input.text, input.images, "steer", source ?? "interactive", getInputReceipt(input)),
			followUp: (input, source) =>
				this._queueUserInput(input.text, input.images, "followUp", source ?? "interactive", getInputReceipt(input)),
		});

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();
		this._installAgentBoundaryHooks();
		this._installAgentForcedPromptProjection();
		this._installAgentRequestProjection();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		if (this._initialActiveToolNames === undefined) this._restoreToolsFromTranscript();
		this.#ordinaryOwner?.bindSessionAdmission(this, (recheck, enroll) => this.#requestOrdinaryWake(recheck, enroll));
		this.#auditState("session_attached");
	}

	get userMessageSessionGeneration(): string {
		return this._userMessageIngress.generation;
	}

	/** @internal Fence pending ingress before replacement/reload can await extension hooks. */
	beginUserMessageSessionReplacement(): void {
		try {
			this._userMessageIngress.suspend();
			this._cancelIngressQueuedMessages();
		} catch (error) {
			// Begin acquired its suspension before cancellation publication could throw.
			// Callers own only a successfully returned begin; failed entry stays closed.
			this._userMessageIngress.setRuntimeAvailable(false);
			this._userMessageIngress.resume();
			throw error;
		}
	}

	/** @internal A cancelled replacement leaves this session usable with a fresh generation. */
	endUserMessageSessionReplacement(failed = false): void {
		if (failed) this._userMessageIngress.setRuntimeAvailable(false);
		this._userMessageIngress.resume();
	}

	private _cancelIngressQueuedMessages(): void {
		if (this._ingressQueuedMessages.size === 0) return;
		const messages = new Set(this._ingressQueuedMessages.keys());
		const positions = [...this._ingressQueuedMessages.values()]
			.map(({ displayIndex }) => displayIndex)
			.sort((a, b) => b - a);
		for (const index of positions) this._removeFollowUpDisplay(index);
		this._ingressQueuedMessages.clear();
		// Commit display/tag cancellation before native lifecycle publication can reenter or throw.
		this.#originalAgent.removeQueuedMessages((message) => messages.has(message));
		this._emitQueueUpdate();
	}

	private _removeFollowUpDisplay(index: number): void {
		this._followUpMessages.splice(index, 1);
		for (const entry of this._ingressQueuedMessages.values()) {
			if (entry.displayIndex > index) entry.displayIndex--;
		}
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	private async _getRequiredRequestAuth(
		model: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model, { signal });
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		}

		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getSummarizationRequestAuth(
		model: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		if (this.agent.streamFunction === streamSimple) {
			return this._getRequiredRequestAuth(model, signal);
		}

		try {
			const result = await this._modelRuntime.getAuth(model, { signal });
			if (!result) return { model };
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			return { model };
		}
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				// Terminal shutdown stops waiting on a held handler; the abandoned dispatch is
				// observed, skips remaining handlers, and its late result is discarded.
				const shutdown = this._shutdownCancellation.signal;
				return await raceWithAbortSignal(
					runner.emitToolCall(
						{
							type: "tool_call",
							toolName: toolCall.name,
							toolCallId: toolCall.id,
							input: args as Record<string, unknown>,
						},
						shutdown,
					),
					shutdown,
				);
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			const shutdown = this._shutdownCancellation.signal;
			// Terminal shutdown rejects here; the loop finalizes an error tool result instead.
			const hookResult = runner.hasHandlers("tool_result")
				? await raceWithAbortSignal(
						runner.emitToolResult(
							{
								type: "tool_result",
								toolName: toolCall.name,
								toolCallId: toolCall.id,
								input: args as Record<string, unknown>,
								content: result.content,
								details: result.details,
								isError,
								usage: result.usage,
							},
							shutdown,
						),
						shutdown,
					)
				: undefined;

			const content = hookResult?.content ?? result.content ?? [];
			// Runs after the extension hook so images injected or replaced by extensions are normalized too.
			this.#ordinaryOwner?.assertActive();
			const resizeOptions = this.model?.inputLimits?.images?.resize;
			const normalizedContent = this.#ordinaryOwner
				? content
				: await normalizeToolResultImages(content, {
						autoResizeImages: this.settingsManager.getImageAutoResize(),
						...(resizeOptions ? { resizeOptions } : {}),
					});

			if (!hookResult && normalizedContent === content) {
				return undefined;
			}

			return {
				content: normalizedContent,
				details: hookResult?.details,
				isError: hookResult?.isError ?? isError,
				usage: hookResult?.usage,
			};
		};
	}

	private async _compactBeforeNextAssistantResponse(context: AgentContext): Promise<AgentContext> {
		this.#ordinaryOwner?.assertNativeTokenReservation();
		const model = this.model;
		const settings = this.settingsManager.getCompactionSettings(model);
		const projection = this.sessionManager.buildSessionProjection();
		if (!model || model.contextWindow <= 0) return { ...context, messages: projection.messages };
		const tokens = estimateProjectedContextTokens(projection, this.sessionManager.getBranch()).tokens;
		const overflow = tokens > model.contextWindow;
		if (!shouldCompact(tokens, model.contextWindow, settings)) {
			return { ...context, messages: projection.messages };
		}

		const outcome = await this._runAutoCompaction("threshold", false);
		if (outcome === "failed" || outcome === "aborted") {
			// Stop this run rather than sending unchanged oversized context or
			// turning a compaction timeout into an ordinary agent retry.
			this._stopAfterCompactionFailure = true;
			this._compactionStopOutcome = outcome === "aborted" ? "aborted" : "error";
			this.agent.abort();
			throw new Error(
				`${overflow ? "Context exceeds window: " : ""}Compaction ${outcome} before the next assistant turn`,
			);
		}
		// Raw projection estimates drive proactive compaction, not hard admission:
		// request preparation, context transforms and conversion can deliberately omit it.
		return { ...context, messages: this.sessionManager.buildSessionProjection().messages };
	}

	private _installAgentRequestProjection(): void {
		let requestModel = this.agent.state.model;
		let canReproject = true;
		let canonicalMessages: string | undefined;
		const previousConvertToLlm = this.agent.convertToLlm;
		this.agent.convertToLlm = async (messages) => {
			let converted = await previousConvertToLlm(messages);
			// Admission is after model selection, context transforms and conversion. Raw
			// transcript size (including !! output) is not the provider-visible input.
			try {
				assertContextFitsWindow(converted, requestModel);
			} catch (error) {
				// Only the known stateless converter and unchanged canonical input can be
				// rebuilt safely. Context hooks and SDK converters may consume one-shot
				// input; replaying them after compaction can silently lose that input.
				if (
					!canReproject ||
					previousConvertToLlm !== convertToLlm ||
					canonicalMessages === undefined ||
					canonicalMessages !== snapshotMessages(messages) ||
					!this.settingsManager.getCompactionSettings(requestModel).enabled
				)
					throw error;
				this.#ordinaryOwner?.assertNativeTokenReservation();
				const revision = this.sessionManager.revision();
				const outcome = await this._runAutoCompaction("overflow", false);
				if (outcome === "failed" || outcome === "aborted") {
					this._stopAfterCompactionFailure = true;
					this._compactionStopOutcome = outcome === "aborted" ? "aborted" : "error";
					this.agent.abort();
					throw new Error(`Context exceeds window: Compaction ${outcome} before the next assistant turn`);
				}
				if (this.sessionManager.revision() === revision) throw error;
				const compacted = this.sessionManager.buildSessionProjection().messages;
				// Do not rerun request hooks. The admitted input was canonical and the
				// built-in converter is stateless, so convert the new projection directly.
				converted = convertToLlm(compacted);
				assertContextFitsWindow(converted, requestModel);
			}
			return converted;
		};
		const previousPrepareRequest = this.agent.prepareRequest;
		const snapshotMessages = (messages: AgentMessage[]): string | undefined => {
			try {
				return JSON.stringify(messages);
			} catch {
				// SDK-only metadata may not serialize. It must not block a fitting request.
				return undefined;
			}
		};
		this.agent.prepareRequest = async (request, signal) => {
			const canonicalContext = {
				...request.context,
				messages: this.sessionManager.buildSessionProjection().messages,
				// Messages declare the provider-visible loadout; context.tools keeps executable implementations.
				tools: this.agent.state.tools.slice(),
			};
			canonicalMessages = snapshotMessages(canonicalContext.messages);
			const previous = await previousPrepareRequest?.(
				{
					...request,
					context: canonicalContext,
					model: this.agent.state.model,
					thinkingLevel: this.agent.state.thinkingLevel,
				},
				signal,
			);
			requestModel = previous?.model ?? this.agent.state.model;
			// Snapshot before preparation and context transforms. Identity alone misses
			// in-place edits, and opaque input is safe only when the final request fits.
			canReproject =
				(previous?.context === undefined || previous.context === canonicalContext) &&
				canonicalMessages !== undefined &&
				canonicalMessages === snapshotMessages(canonicalContext.messages);
			return {
				...previous,
				context: previous?.context ?? canonicalContext,
				model: requestModel,
				thinkingLevel: previous?.thinkingLevel ?? this.agent.state.thinkingLevel,
			};
		};
	}

	private async _dispatchTurnEndBoundary(
		message: AssistantMessage,
		toolResults: ToolResultMessage[],
	): Promise<boolean> {
		this._lastActivityOutcome =
			message.stopReason === "aborted"
				? "aborted"
				: message.stopReason === "error" ||
						(this._retryFallbackInFlight && message.stopReason !== "stop" && message.stopReason !== "toolUse")
					? "error"
					: "completed";
		const messageEntryId = this._findPersistedMessageEntryId(message);
		if (!this._extensionRunner.hasHandlers("turn_end")) return false;
		if (!messageEntryId) {
			this._extensionRunner.emitError({
				extensionPath: "<boundary>",
				event: "turn_end",
				error: "turn_end could not resolve the persisted assistant entry ID",
			});
			return false;
		}
		const toolResultEntryIds = toolResults.flatMap((result) => {
			const entryId = this._findPersistedMessageEntryId(result);
			return entryId ? [entryId] : [];
		});
		const revision = this.sessionManager.revision();
		let boundary: Awaited<ReturnType<ExtensionRunner["emitBoundary"]>>;
		try {
			boundary = await this._extensionRunner.emitBoundary(
				{
					type: "turn_end",
					turnIndex: this._turnIndex,
					message,
					toolResults,
					messageEntryId,
					toolResultEntryIds,
					outcome: this._lastActivityOutcome,
				},
				(entries, receipts) => this._buildBoundaryContext(entries, "turn_end", receipts),
				() => this._getPendingBoundaryMessages(),
				this._shutdownCancellation.signal,
			);
		} catch (error) {
			if (this._shutdownCancellation.signal.aborted) return false;
			throw error;
		}
		if (this._shutdownCancellation.signal.aborted) return false;
		if (boundary.entries.length > 0) this._commitBoundaryDrafts(boundary.entries, boundary.entryReceipts);
		// Carry captured-manager changes into agent state even if continuation is requested later.
		else if (this.sessionManager.revision() !== revision) this._refreshFinalizedContext();
		if (boundary.continue && !this._buildBoundaryContext([], "turn_end").canContinue) {
			this._reportInvalidBoundaryContinuation("turn_end");
			return false;
		}
		return boundary.continue;
	}

	private _installAgentBoundaryHooks(): void {
		const previousFinishTurn = this.agent.finishTurn;
		this.agent.finishTurn = async (turn, signal) => {
			this._boundaryDispatchedMessages.add(turn.message);
			const extensionContinue = await this._dispatchTurnEndBoundary(turn.message, turn.toolResults);
			// Terminal cancellation ends the low-level loop before it can drain undelivered queues.
			if (this._shutdownCancellation.signal.aborted) return { action: "end" };
			const previousDecision = await previousFinishTurn?.(turn, signal);
			// End an unsuccessful one-shot alternate before truncated tools or queued input
			// can select a natural next turn. Successful toolUse clears this flag at message_end.
			if (this._retryFallbackInFlight) return { action: "end" };
			if (previousDecision?.action === "end") return previousDecision;
			if (extensionContinue || previousDecision?.action === "continue") return { action: "continue" };
			return undefined;
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const context = await this._compactBeforeNextAssistantResponse({
				...turn.context,
				messages: this.sessionManager.buildSessionProjection().messages,
			});
			const previousSnapshot = await previousPrepareNextTurnWithContext?.({ ...turn, context }, signal);
			const nextContext = previousSnapshot?.context ?? context;
			const runOptions = this._runSystemPromptOptions ?? this._baseSystemPromptOptions;
			const options = normalizeBuildSystemPromptOptions({
				...runOptions,
				selectedTools: this.getActiveToolNames(),
				toolSnippets: { ...this._baseSystemPromptOptions.toolSnippets, ...runOptions.toolSnippets },
				toolGuidelines: { ...this._baseSystemPromptOptions.toolGuidelines, ...runOptions.toolGuidelines },
			});
			const updateMessage = this._preparePromptAndToolLoadout(options, nextContext.messages);
			// Keep session.systemPrompt and ctx.getSystemPrompt() in step with what the provider sees.
			this._runSystemPromptOptions = options;

			return {
				...previousSnapshot,
				context: {
					...nextContext,
					tools: this.agent.state.tools.slice(),
				},
				messages: updateMessage
					? [...(previousSnapshot?.messages ?? []), updateMessage]
					: previousSnapshot?.messages,
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	#auditState(kind: string, attempt: number | null = null): void {
		this.#ordinaryOwner?.operationalAudit.session(kind, {
			activeRun: this._isAgentRunActive,
			preflights: this.#ordinaryPreflights,
			compacting: this.isCompacting,
			retrying: this.isRetrying,
			steering: this._steeringMessages.length,
			followUp: this._followUpMessages.length,
			attempt,
		});
	}

	private _refreshFinalizedContext(): void {
		const projection = this.sessionManager.buildSessionProjection();
		for (const entry of projection.entries) {
			for (const message of entry.messages) this._entryIdsByMessage.set(message, entry.sourceEntry.id);
		}
		this.agent.state.messages = projection.messages;
	}

	private _applyBoundaryDrafts(
		manager: SessionManager,
		drafts: SessionBoundaryDraft[],
		receipts?: (TurnReceipt | undefined)[],
	): SessionEntry[] {
		const appended: SessionEntry[] = [];
		for (let index = 0, length = drafts.length; index < length; index++) {
			const draft = drafts[index];
			let entryId: string;
			switch (draft.type) {
				case "custom":
					entryId = manager.appendCustomEntry(draft.customType, draft.data);
					break;
				case "custom_message":
					entryId = appendReceivedCustomMessage(
						manager,
						draft.customType,
						draft.content,
						draft.display,
						draft.details,
						receipts?.[index],
					);
					break;
				case "context_edit":
					entryId = manager.appendContextEdit(draft.targetId, draft.replacement);
					break;
				case "compaction": {
					const tokensBefore = estimateProjectedContextTokens(
						manager.buildSessionProjection(),
						manager.getBranch(),
					).tokens;
					entryId = manager.appendCompaction(
						draft.summary,
						draft.firstKeptEntryId,
						tokensBefore,
						draft.details,
						true,
						draft.usage,
					);
					break;
				}
			}
			const entry = manager.getEntry(entryId);
			if (entry) appended.push(entry);
		}
		return appended;
	}

	private _createBoundaryPreviewManager(
		drafts: SessionBoundaryDraft[],
		receipts?: (TurnReceipt | undefined)[],
	): SessionManager {
		const header = this.sessionManager.getHeader();
		if (!header) throw new Error("Session header is missing");
		const manager = SessionManager.inMemory(this._cwd, undefined, [header, ...this.sessionManager.getBranch()]);
		this._applyBoundaryDrafts(manager, drafts, receipts);
		return manager;
	}

	private _getPendingBoundaryMessages(): AgentMessage[] {
		return [...this.agent.peekQueuedMessages(), ...this._pendingCustomMessages];
	}

	private _buildBoundaryContext(
		drafts: SessionBoundaryDraft[],
		boundary: "turn_end" | "agent_before_settle",
		receipts?: (TurnReceipt | undefined)[],
	): BoundaryContextPreview {
		const projection =
			drafts.length === 0
				? this.sessionManager.buildSessionProjection()
				: this._createBoundaryPreviewManager(drafts, receipts).buildSessionProjection();
		const pendingMessages = this._getPendingBoundaryMessages();
		const llmMessages = convertToLlm(projection.messages);
		const finalRole = llmMessages[llmMessages.length - 1]?.role;
		const hasNonSystemContext = llmMessages.some((message) => message.role !== "system");
		const contextCanContinue = hasNonSystemContext && finalRole !== "assistant";
		const pendingCustomContext = this._pendingCustomMessages.length > 0;
		return {
			contextEntries: projection.entries,
			contextMessages: projection.messages,
			llmMessages,
			pendingMessages,
			canContinue:
				contextCanContinue ||
				pendingCustomContext ||
				(boundary === "turn_end"
					? this.agent.hasQueuedMessages()
					: finalRole === "assistant" && this.agent.hasQueuedMessages()),
		};
	}

	private _commitBoundaryDrafts(drafts: SessionBoundaryDraft[], receipts: (TurnReceipt | undefined)[]): void {
		const appended = this._applyBoundaryDrafts(this.sessionManager, drafts, receipts);
		this._refreshFinalizedContext();
		for (const entry of appended) this._emit({ type: "entry_appended", entry });
	}

	private _reportInvalidBoundaryContinuation(event: "turn_end" | "agent_before_settle"): void {
		this._extensionRunner.emitError({
			extensionPath: "<boundary>",
			event,
			error: `${event} requested continuation without runnable model context`,
		});
	}

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		if (
			event.type === "queue_update" ||
			event.type === "compaction_start" ||
			event.type === "compaction_end" ||
			event.type === "auto_retry_start" ||
			event.type === "auto_retry_end" ||
			event.type === "summarization_retry_scheduled" ||
			event.type === "summarization_retry_attempt_start" ||
			event.type === "summarization_retry_finished"
		) {
			this.#auditState(event.type, "attempt" in event ? event.attempt : null);
		}
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	private async _emitCompactionHook(
		event: SessionBeforeCompactEvent | SessionCompactEvent | SessionCompactFailedEvent,
		signal?: AbortSignal,
	): Promise<SessionBeforeCompactResult | undefined> {
		// Scope follows the handler's async calls, not unrelated SDK dispatch while a hook is awaiting.
		return this._compactionHookScope.run(true, () => raceWithAbortSignal(this._extensionRunner.emit(event), signal));
	}

	private async _emitSessionCompactFailed(
		event: Omit<SessionCompactFailedEvent, "type">,
		signal?: AbortSignal,
		preserveDistinctFailure = false,
	): Promise<void> {
		if (this._extensionRunner.hasHandlers("session_compact_failed")) {
			try {
				await this._emitCompactionHook({ type: "session_compact_failed", ...event }, signal);
			} catch (error) {
				// A terminal notification cannot extend an expired compaction or
				// replace its failed/aborted outcome. Its promise stays observed.
				if (!signal?.aborted || (preserveDistinctFailure && error !== signal.reason)) throw error;
			}
		}
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (!this.isIdle || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(outcome: AgentActivityOutcome): Promise<void> {
		this._cacheWarmer?.onAgentSettled();
		this._isAgentRunActive = false;
		this.#auditState("session_run_settled");
		this._isEmittingAgentSettled = true;
		const scope = { active: true };
		let completed!: () => void;
		this._settlementCompletion = new Promise<void>((resolve) => {
			completed = resolve;
		});
		try {
			try {
				await this._agentSettledScope.run(scope, () =>
					this._extensionRunner.emit({ type: "agent_settled", outcome }),
				);
			} catch (error) {
				if (!this._shutdownCancellation.signal.aborted) throw error;
			}
			this._agentSettledScope.run(scope, () => this._emit({ type: "agent_settled", outcome }));
		} finally {
			scope.active = false;
			this._isEmittingAgentSettled = false;
			try {
				for (const action of this._deferredSettledActions.splice(0)) {
					const actionScope = { active: true };
					try {
						await this._settlementActionScope.run(actionScope, action).catch((error: unknown) => {
							if (!this._shutdownCancellation.signal.aborted) throw error;
						});
					} finally {
						actionScope.active = false;
					}
				}
			} finally {
				this._resolveIdleWaitIfIdle();
				completed();
			}
		}
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (
			(event.type === "message_start" || event.type === "message_end") &&
			(event.message.role === "user" || event.message.role === "custom") &&
			!this.#receivedMessageReceipts.has(event.message)
		) {
			// Raw Agent APIs have no admission callback: this is FIRST HARNESS OBSERVATION,
			// not raw enqueue time, and never derives from the caller's timestamp (#2867).
			this.#receivedMessageReceipts.set(event.message, captureTerminalTurnReceipt());
		}
		// Synthetic run failures publish another message_start, but not a new turn_start.
		if (event.type === "turn_start") this._assistantOutputObserved = false;
		if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "assistant") {
			this._assistantOutputObserved ||= hasAssistantOutput(event.message);
		} else if (event.type === "message_update" && event.message.role === "assistant") {
			const update = event.assistantMessageEvent;
			this._assistantOutputObserved ||=
				hasAssistantOutput(event.message) ||
				update.type.startsWith("toolcall_") ||
				("delta" in update && update.delta.length > 0) ||
				("content" in update && update.content.length > 0);
		}

		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			const ingress = this._ingressQueuedMessages.get(event.message);
			this._ingressQueuedMessages.delete(event.message);
			this._overflowRecoveryAttempted = false;
			const messageText = contentText(event.message.content, "");
			if (messageText || ingress) {
				// Check steering queue first
				const steeringIndex = ingress ? -1 : this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const ingressPositions = new Set(
						[...this._ingressQueuedMessages.values()].map(({ displayIndex }) => displayIndex),
					);
					const followUpIndex =
						ingress?.displayIndex ??
						this._followUpMessages.findIndex(
							(text, index) => text === messageText && !ingressPositions.has(index),
						);
					if (followUpIndex !== -1) {
						this._removeFollowUpDisplay(followUpIndex);
						this._emitQueueUpdate();
					}
				}
			}
		}

		// Terminal cancellation releases extension waits, not final event publication/persistence.
		if (!this._shutdownCancellation.signal.aborted) {
			try {
				await this._emitExtensionEvent(event);
			} catch (error) {
				if (!this._shutdownCancellation.signal.aborted) throw error;
			}
		}
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);

		if (this.#ordinaryOwner) await this.#ordinaryOwner.owner.terminal(() => this._persistAgentEvent(event));
		else await this._persistAgentEvent(event);
	};

	private async _persistAgentEvent(event: AgentEvent): Promise<void> {
		// Handle session persistence
		if (event.type === "message_end") {
			let entryId: string | undefined;
			const receipt = this.#receivedMessageReceipts.get(event.message);
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				entryId = this.#ordinaryOwner
					? await appendOwnedTerminalCustomMessage(
							this.sessionManager,
							event.message.customType,
							event.message.content,
							event.message.display,
							event.message.details,
							receipt,
						)
					: appendReceivedCustomMessage(
							this.sessionManager,
							event.message.customType,
							event.message.content,
							event.message.display,
							event.message.details,
							receipt,
						);
				this.#receivedMessageReceipts.delete(event.message);
				try {
					this._recordMessageEntryId(event.message, entryId);
				} catch (error) {
					this._retainTerminalPublicationFailure(error);
				}
			} else if (
				event.message.role === "system" ||
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				entryId = this.#ordinaryOwner
					? await appendOwnedTerminalMessage(this.sessionManager, event.message, receipt)
					: appendReceivedMessage(this.sessionManager, event.message, receipt);
				this.#receivedMessageReceipts.delete(event.message);
				try {
					this._recordMessageEntryId(event.message, entryId);
				} catch (error) {
					this._retainTerminalPublicationFailure(error);
				}
			}
			if (entryId) this._entryIdsByMessage.set(event.message, entryId);
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			if (event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				this._lastAssistantMessage = assistantMsg;
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error") this._throttleWaitUsed = false;
				const fallbackSucceeded =
					this._retryFallbackInFlight &&
					(assistantMsg.stopReason === "stop" || assistantMsg.stopReason === "toolUse");
				if (
					fallbackSucceeded ||
					(assistantMsg.stopReason !== "error" && this._retryAttempt > 0 && !this._retryFallbackInFlight)
				) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
					this._retryFallbackInFlight = false;
				}
			}
		}

		// A turn ends after its assistant message and every tool result has been appended,
		// so this is the first point in the run where a context-only custom message can be
		// inserted without landing between a tool call and its result. Flushing after the
		// extension and listener dispatch above also picks up messages that turn_end
		// handlers queued.
		if (event.type === "turn_end") {
			this._lastAssistantToolResults = event.toolResults;
			if (this.#ordinaryOwner) await this._flushPendingCustomMessagesOwnedTerminal();
			else this._flushPendingCustomMessages();
		}
	}

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		if (this._agentRunAbortRequested) return false;
		const message = [...event.messages].reverse().find((m) => m.role === "assistant") as AssistantMessage | undefined;
		if (!message || this._throttleWaitUsed || this._retryFallbackInFlight) return false;
		if (this._assistantOutputObserved || hasAssistantOutput(message)) return false;
		if (throttledLimitWait(message)) return true;
		const settings = this._getRetrySettings(message);
		if (!settings.enabled || !this._isRetryableError(message)) return false;
		return this._retryAttempt < settings.maxRetries || this._getRetryFallbackModel() !== undefined;
	}

	private _findPersistedMessageEntryId(message: AgentMessage): string | undefined {
		const mapped = this._entryIdsByMessage.get(message);
		if (mapped) return mapped;
		for (const entry of [...this.sessionManager.getBranch()].reverse()) {
			if (entry.type === "message" && entry.message === message) return entry.id;
		}

		const messageIndex = this.agent.state.messages.indexOf(message);
		if (messageIndex < 0) return undefined;
		const projection = this.sessionManager.buildSessionProjection();
		let projectedIndex = 0;
		for (const entry of projection.entries) {
			for (let i = 0; i < entry.messages.length; i++) {
				if (projectedIndex === messageIndex) {
					this._entryIdsByMessage.set(message, entry.sourceEntry.id);
					return entry.sourceEntry.id;
				}
				projectedIndex++;
			}
		}
		return undefined;
	}

	private _omitRecoveryAttempt(message: AssistantMessage, toolResults: AgentMessage[] = []): void {
		const targets = [message, ...toolResults];
		const targetIds = targets.map((target) => this._findPersistedMessageEntryId(target));
		const unresolvedProjectedTarget = targets.some(
			(target, index) => targetIds[index] === undefined && this.agent.state.messages.includes(target),
		);
		if (unresolvedProjectedTarget) {
			throw new Error("Cannot persist recovery omission because a projected message has no source entry");
		}
		for (const targetId of targetIds) {
			if (!targetId) continue;
			const editId = this.sessionManager.appendContextEdit(targetId, null);
			const entry = this.sessionManager.getEntry(editId);
			if (entry) this._emit({ type: "entry_appended", entry });
		}
		this._refreshFinalizedContext();
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			if (event.message.role === "assistant" && !this._boundaryDispatchedMessages.delete(event.message)) {
				await this._dispatchTurnEndBoundary(event.message, event.toolResults);
			}
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** Disconnect from agent events during disposal. */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		this._userMessageIngress.invalidate("no_session", true);
		try {
			this._cancelIngressQueuedMessages();
		} finally {
			// Cancellation observers must not skip the existing terminal cleanup.
			this.#ordinaryOwner?.interruptAutomaticCapture(new Error("OWNER_REQUEST_CAPTURE_DISPOSED"));
			try {
				this.abortRetry();
				this.abortCompaction();
				this.abortBranchSummary();
				this.abortBash();
				this.#originalAgent.abort();
			} catch {
				// Dispose must succeed even if an abort hook throws.
			}

			this._extensionRunner.invalidate(
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
			);
			this._disconnectFromAgent();
			this._eventListeners = [];
			if (this._cacheWarmer) {
				this._cacheWarmer.onWarmed = undefined;
				this._cacheWarmer.cancel();
			}
			cleanupSessionResources(this.sessionId);
		}
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Refresh the public finalized transcript from the canonical session projection. */
	refreshContext(): void {
		this._refreshFinalizedContext();
	}

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current cache-warming state and the policy inputs that produced it. */
	get cacheWarmingStatus(): CacheWarmingStatus | undefined {
		return this._cacheWarmer?.status;
	}

	/** Persist the cache-warming mode and immediately reconcile active warming. */
	setCacheWarmingMode(mode: CacheWarmingMode): void {
		this.settingsManager.setCacheWarmingMode(mode);
		this._cacheWarmer?.onModeChanged();
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, compaction, branch summary, retry, or queued continuation. */
	get isIdle(): boolean {
		return (
			!this._isAgentRunActive &&
			!this.isCompacting &&
			!this._modelSwitchCompactionPending &&
			this._modelSwitchDispatches.size === 0 &&
			this._triggeredBehindPreflight.length === 0
		);
	}

	/**
	 * Whether `agent_settled` handlers are running. Exactly then, `prompt()` and a triggered custom message are
	 * deferred until the remaining handlers finish.
	 */
	get isSettling(): boolean {
		return this._isEmittingAgentSettled;
	}

	/** Whether a prompt is in preflight (input handlers, `before_agent_start`) and its run has not started. */
	get isPromptPending(): boolean {
		return this._promptPreflights.size > 0;
	}

	/** Current effective system prompt, including changes not yet sent to the model. */
	get systemPrompt(): string {
		return buildSystemPrompt(this._runSystemPromptOptions ?? this._baseSystemPromptOptions);
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;
		this._rebuildSystemPrompt(validToolNames);
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Starts a new capture epoch for live persisted message entry IDs. */
	startMessageEntryIdCapture(): void {
		this._messageEntryIds = new WeakMap<AgentMessage, string[]>();
	}

	/** Stops capture and discards all entry IDs from the active epoch. */
	stopMessageEntryIdCapture(): void {
		this._messageEntryIds = undefined;
	}

	/** Takes the next persisted entry ID for a live message emission. */
	takeMessageEntryId(message: AgentMessage): string | undefined {
		const capture = this._messageEntryIds;
		if (!capture) return undefined;
		const entryIds = capture.get(message);
		if (!entryIds) return undefined;

		const entryId = entryIds.shift();
		if (entryIds.length === 0) {
			capture.delete(message);
		}
		return entryId;
	}

	private _retainTerminalPublicationFailure(error: unknown): never {
		if (!this.#ordinaryOwner) throw error;
		try {
			this.#ordinaryOwner.owner.quarantine();
		} catch (cleanup) {
			throw new AggregateError([error, cleanup], "OWNER_TERMINAL_PUBLICATION_UNKNOWN", { cause: error });
		}
		throw error;
	}

	private _recordMessageEntryId(message: AgentMessage, entryId: string): void {
		const capture = this._messageEntryIds;
		if (!capture) return;

		const entryIds = capture.get(message);
		if (entryIds) {
			entryIds.push(entryId);
		} else {
			capture.set(message, [entryId]);
		}
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): void {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		for (const name of this._toolRegistry.keys()) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) toolSnippets[name] = snippet;
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt = loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : "";
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = normalizeBuildSystemPromptOptions({
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			toolGuidelines: Object.fromEntries(this._toolPromptGuidelines),
		});
	}

	/**
	 * Apply a prompt and tool loadout for the next request. Sets the executable tools and
	 * returns a system message patching the prompt sections the model currently has (replayed
	 * from `messages`), or undefined when the prompt is unchanged. Tool changes are declared by
	 * the agent loop before the request.
	 *
	 * A forced prompt does not affect the transcript: the structured sections are still diffed
	 * and persisted, and the forced text is projected onto the request by
	 * {@link _installAgentForcedPromptProjection}.
	 */
	private _preparePromptAndToolLoadout(
		options: NormalizedBuildSystemPromptOptions,
		messages: AgentMessage[] = this.agent.state.messages,
	): SystemMessage | undefined {
		options.selectedTools = [...new Set(options.selectedTools)].filter((name) => this._toolRegistry.has(name));
		this.agent.state.tools = options.selectedTools.flatMap((name) => {
			const tool = this._toolRegistry.get(name);
			return tool ? [tool] : [];
		});
		const sections = diffSystemPromptSections(
			getCurrentSystemMessage(messages)?.sections ?? {},
			buildSystemPromptSections(options),
		);
		return sections ? { role: "system", content: "", sections, timestamp: Date.now() } : undefined;
	}

	/**
	 * Send a forced prompt as the provider's leading system prompt without recording it.
	 *
	 * A `before_agent_start` handler that returns `systemPrompt` needs that exact text at the
	 * head of the request; a mid-conversation system message would leave the original prompt
	 * in place. The forced text is a rendering of the current prompt, so the transcript keeps
	 * its structured sections and the request is projected instead: the system messages
	 * collapse into one head holding the forced text and the current tools. Runs after the
	 * `context` extension handlers.
	 */
	private _installAgentForcedPromptProjection(): void {
		const previousTransformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
			const forced = this._runSystemPromptOptions?.forceSystemPrompt;
			if (forced === undefined) return transformed;
			const current = getCurrentSystemMessage(transformed);
			const head: SystemMessage = {
				role: "system",
				content: forced,
				...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
				timestamp: current?.timestamp ?? Date.now(),
			};
			return [head, ...transformed.filter((message) => message.role !== "system")];
		};
	}

	/** Restore the active tool loadout declared by the session transcript, if it declares one. */
	private _restoreToolsFromTranscript(): void {
		const current = getCurrentSystemMessage(this.sessionManager.buildSessionContext().messages);
		if (!current) return;
		const toolNames = (current.toolsAdded ?? [])
			.map((tool) => tool.name)
			.filter((name) => this._toolRegistry.has(name));
		this.agent.state.tools = toolNames.flatMap((name) => {
			const registered = this._toolRegistry.get(name);
			return registered ? [registered] : [];
		});
		this._rebuildSystemPrompt(toolNames);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _runAgentPrompt(
		messages: AgentMessage | AgentMessage[] | undefined,
		promptToken?: object,
		automaticEnrollment?: OriginalAutomaticEnrollment,
		onInputTransferred?: () => void,
		admission?: UserMessageAdmission,
	): Promise<void> {
		admission?.check();
		this.#ordinaryOwner?.assertSubmission();
		// A prompt admitted before the switch may still be finishing async input hooks.
		while (this._modelSwitchCompactionPending) await this._modelSwitchAdmissionWait;
		const agent = this.#originalAgent;
		if (this.agent !== agent) throw new Error("OWNER_RUNTIME_AGENT_CHANGED");
		const dispatch = async (continuation = false, fromQueuedMessages = false) => {
			this.#ordinaryOwner?.assertCompactionIdle();
			this.#ordinaryOwner?.assertSubmission();
			this.#ordinaryOwner?.assertSessionStart(this);
			if (this.agent !== agent) throw new Error("OWNER_RUNTIME_AGENT_CHANGED");
			// No await or external callback may separate this check from dispatch.
			if (!continuation) admission?.check();
			if (originalAgentSignal.call(agent)) throw new Error("OWNER_AGENT_BUSY_BEFORE_TRANSFER");
			// Without messages, the run starts from queued input.
			const run =
				continuation || !messages
					? agent.continue({ fromQueuedMessages })
					: admission
						? agent.prompt(messages, undefined, () => admission.accept("accepted"))
						: agent.prompt(messages);
			try {
				if (!continuation) onInputTransferred?.();
			} catch (cause) {
				// A failing observer must not detach the already-started original run.
				try {
					await run;
				} catch (error) {
					throw new AggregateError([cause, error], "INPUT_TRANSFER_OBSERVER_FAILED", { cause });
				}
				throw cause;
			}
			await run;
		};
		this._stopAfterCompactionFailure = false;
		this._compactionStopOutcome = undefined;
		this._agentRunAbortRequested = false;
		this._abortDuringBeforeSettle = false;
		this._lastActivityOutcome = "completed";
		this._inputQueuedBehindPreflight = false;
		this._isAgentRunActive = true;
		this._retryFallbackUsed = false;
		this._retryFallbackInFlight = false;
		this.#auditState("session_run_start");
		let runFailed = false;
		try {
			if (automaticEnrollment) await automaticEnrollment(() => dispatch());
			else if (this.#ordinaryOwner)
				await this.#ordinaryOwner.requestProvenance.run(promptToken, () => dispatch(), messages);
			else await dispatch();
			while (!this._agentRunAbortRequested && !this._stopAfterCompactionFailure) {
				const continueAfterRun = await this._handlePostAgentRun();
				if (this._agentRunAbortRequested || this._stopAfterCompactionFailure) break;
				if (!continueAfterRun && !(await this._runBeforeSettleBoundary())) break;
				if (this._agentRunAbortRequested || this._stopAfterCompactionFailure) break;
				const fromQueuedMessages = continueAfterRun === "queuedInput";
				if (this.#ordinaryOwner)
					await this.#ordinaryOwner.requestProvenance.run(promptToken, () => dispatch(true, fromQueuedMessages));
				else await dispatch(true, fromQueuedMessages);
			}
		} catch (error) {
			runFailed = true;
			throw error;
		} finally {
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			this._runSystemPromptOptions = undefined;
			const persist = async () => {
				if (this.#ordinaryOwner) {
					await this._flushPendingBashMessagesOwnedTerminal();
					await this._flushPendingCustomMessagesOwnedTerminal();
				} else {
					this._flushPendingBashMessages();
					this._flushPendingCustomMessages();
				}
			};
			let persistenceFailure: { cause: unknown } | undefined;
			try {
				if (this.#ordinaryOwner) await this.#ordinaryOwner.owner.terminal(persist);
				else await persist();
			} catch (error) {
				persistenceFailure = { cause: error };
			}
			try {
				await this._emitAgentSettled(
					this._agentRunAbortRequested || this._abortDuringBeforeSettle
						? "aborted"
						: runFailed
							? "error"
							: (this._compactionStopOutcome ?? this._lastActivityOutcome),
				);
			} catch (notificationFailure) {
				if (persistenceFailure)
					// biome-ignore lint/correctness/noUnsafeFinally: Settlement persistence and notification failures must both reject; persistence stays the first cause.
					throw new AggregateError([persistenceFailure.cause, notificationFailure], "OWNER_SETTLEMENT_FAILED", {
						cause: persistenceFailure.cause,
					});
				// biome-ignore lint/correctness/noUnsafeFinally: A settlement notification failure must reject the run.
				throw notificationFailure;
			}
			// biome-ignore lint/correctness/noUnsafeFinally: A terminal persistence failure must reject after settlement notification.
			if (persistenceFailure) throw persistenceFailure.cause;
		}
	}

	private async _handlePostAgentRun(): Promise<boolean | "queuedInput"> {
		const message = this._lastAssistantMessage;
		const toolResults = this._lastAssistantToolResults;
		this._lastAssistantMessage = undefined;
		this._lastAssistantToolResults = [];
		if (this._stopAfterCompactionFailure) return false;
		if (this._agentRunAbortRequested) {
			this._finishCancelledRetry();
			return false;
		}
		if (!message) return this.agent.hasQueuedMessages();

		// A throttled provider limit waits and retries once, outside settings.retry; the retry's error is final.
		const throttleWaitUsed = this._throttleWaitUsed;
		const fallbackAttempt = this._retryFallbackInFlight;
		this._throttleWaitUsed = false;
		const throttleWait =
			fallbackAttempt || throttleWaitUsed || this._assistantOutputObserved || hasAssistantOutput(message)
				? undefined
				: throttledLimitWait(message);
		let retrying: boolean;
		if (throttleWait) {
			this._retryAttempt++;
			const { delayMs, waitMessage } = throttleWait;
			retrying = await this._waitAndRetry(message, delayMs, this._retryAttempt, waitMessage);
			this._throttleWaitUsed = retrying;
		} else {
			retrying = !throttleWaitUsed && this._isRetryableError(message) && (await this._prepareRetry(message));
		}
		if (retrying) {
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			return !this._agentRunAbortRequested;
		}
		if (this._agentRunAbortRequested) {
			this._finishCancelledRetry();
			return false;
		}

		if ((message.stopReason === "error" && this._retryAttempt > 0) || fallbackAttempt) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: message.errorMessage,
			});
			this._retryAttempt = 0;
			this._retryFallbackInFlight = false;
		}

		// The one-shot alternate and failed throttle retry cannot recover through compaction either.
		const compaction =
			fallbackAttempt || (throttleWaitUsed && message.stopReason === "error")
				? false
				: await this._checkCompaction(message, true, toolResults);
		if (compaction === "failed" || compaction === "aborted") {
			this._stopAfterCompactionFailure = true;
			this._compactionStopOutcome = compaction === "aborted" ? "aborted" : "error";
			return false;
		}
		if (compaction) return !this._agentRunAbortRequested;

		// The low-level loop drains both queues before agent_end. Messages queued by
		// agent_end handlers require a fresh run before pre-settlement handlers fire.
		const queued = !this._agentRunAbortRequested && this.agent.hasQueuedMessages();
		// A failed alternate's synthetic tool results are terminal. Retained input
		// must be selected before another request, rather than resuming that tool turn.
		return fallbackAttempt && queued ? "queuedInput" : queued;
	}

	private async _runBeforeSettleBoundary(): Promise<boolean> {
		if (!this._extensionRunner.hasHandlers("agent_before_settle")) return this.agent.hasQueuedMessages();
		this._isBeforeSettle = true;
		this._abortDuringBeforeSettle = false;
		try {
			const revision = this.sessionManager.revision();
			const result = await this._extensionRunner.emitBoundary(
				{ type: "agent_before_settle", outcome: this._lastActivityOutcome },
				(entries, receipts) => this._buildBoundaryContext(entries, "agent_before_settle", receipts),
				() => this._getPendingBoundaryMessages(),
				this._shutdownCancellation.signal,
			);
			if (this._shutdownCancellation.signal.aborted) return false;
			if (result.entries.length > 0) this._commitBoundaryDrafts(result.entries, result.entryReceipts);
			// Captured SDK managers can append context without proposing any drafts.
			// Agent.continue() checks agent state before request preparation can refresh it.
			else if (this.sessionManager.revision() !== revision) this._refreshFinalizedContext();
			this._flushPendingCustomMessages();
			const finalContext = this._buildBoundaryContext([], "agent_before_settle");
			if (this._abortDuringBeforeSettle) return false;
			const shouldContinue = result.continue || this.agent.hasQueuedMessages();
			if (shouldContinue && !finalContext.canContinue) {
				if (result.continue) this._reportInvalidBoundaryContinuation("agent_before_settle");
				return false;
			}
			return shouldContinue;
		} catch (error) {
			if (this._shutdownCancellation.signal.aborted) return false;
			throw error;
		} finally {
			this._isBeforeSettle = false;
		}
	}

	private async _runInputHandlers(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
		signal?: AbortSignal,
	): Promise<{ text: string; images: ImageContent[] | undefined } | undefined> {
		if (!this._extensionRunner.hasHandlers("input")) {
			return { text, images };
		}

		const inputResult = await this._extensionRunner.emitInput(text, images, source, streamingBehavior, signal);
		if (inputResult.action === "handled") {
			return undefined;
		}
		if (inputResult.action === "transform") {
			return { text: inputResult.text, images: inputResult.images ?? images };
		}
		return { text, images };
	}

	private async _normalizePromptImages(
		images: ImageContent[] | undefined,
	): Promise<{ images: ImageContent[]; hints: string[] }> {
		if (!images) return { images: [], hints: [] };

		const normalizedImages: ImageContent[] = [];
		const hints: string[] = [];
		for (const image of images) {
			const processed = await processImage(Buffer.from(image.data, "base64"), image.mimeType, {
				autoResizeImages: this.settingsManager.getImageAutoResize(),
				resizeOptions: this.model?.inputLimits?.images?.resize,
			});
			if (!processed.ok) {
				hints.push(processed.message);
				continue;
			}
			normalizedImages.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
			hints.push(...processed.hints);
		}
		return { images: normalizedImages, hints };
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		return this._promptAdmitted(text, options, captureTerminalTurnReceipt());
	}

	private _promptReceived(input: ReceivedInput, options?: PromptOptions): Promise<void> {
		return this._promptAdmitted(input.text, { ...options, images: input.images }, getInputReceipt(input));
	}

	private async _promptAdmitted(
		text: string,
		options: PromptOptions | undefined,
		receipt: TurnReceipt,
	): Promise<void> {
		this._shutdownCancellation.signal.throwIfAborted();
		if (this._isEmittingAgentSettled && !(options && this._userMessageAdmissions.has(options))) {
			const completion = new Promise<void>((resolve, reject) => {
				this._deferredSettledActions.push(async () => {
					try {
						await this._promptAdmitted(text, options, receipt);
						resolve();
					} catch (error) {
						reject(error);
					}
				});
			});
			// A settlement handler can await acceptance, not its own deferred delivery.
			if (this._agentSettledScope.getStore()?.active) {
				void completion.catch((error: unknown) => {
					this._extensionRunner.emitError({
						extensionPath: "<settlement>",
						event: "prompt",
						error: error instanceof Error ? error.message : String(error),
					});
				});
				return;
			}
			return completion;
		}
		if (!this.#ordinaryOwner) return this._prompt(text, options, undefined, undefined, receipt);
		this.#ordinaryOwner.assertSessionStart(this);
		this.#ordinaryOwner.assertCompactionIdle();
		this.#ordinaryPreflights++;
		this.#auditState("preflight_start");
		let pending = true;
		const release = () => {
			if (pending) {
				pending = false;
				this.#ordinaryPreflights--;
				this.#auditState("preflight_settled");
			}
		};
		try {
			await this.#ordinaryOwner.requestProvenance.prompt((token) =>
				this._prompt(text, options, release, token, receipt),
			);
		} finally {
			release();
		}
	}

	private async _prompt(
		text: string,
		options?: PromptOptions,
		releasePreflight?: () => void,
		promptToken?: object,
		receipt = captureTerminalTurnReceipt(),
	): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		const onInputTransferred = options?.onInputTransferred;
		const admission = options ? this._userMessageAdmissions.get(options) : undefined;
		const preflightToken = {};
		let messages: AgentMessage[] | undefined;

		try {
			admission?.check();
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via pi.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					onInputTransferred?.();
					preflightResult?.(true);
					return;
				}
			}

			if (this._modelSwitchCompactionPending && !options?.streamingBehavior) {
				throw new Error("Model switch compaction is in progress; wait before submitting input.");
			}
			if (
				this._compactionAbortController !== undefined ||
				(this._autoCompactionAbortController !== undefined && !this.isStreaming)
			) {
				throw new Error(
					"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
				);
			}

			// An earlier prompt can still be in preflight, for example in pre-prompt compaction whose
			// compaction_end flushes input queued during compaction. Queue behind it instead of
			// racing it into the agent and failing with "Agent is already processing a prompt".
			this._promptPreflights.add(preflightToken);
			const mustQueue = () =>
				this.isStreaming ||
				(admission !== undefined && this._isEmittingAgentSettled) ||
				this._modelSwitchCompactionPending ||
				(options?.streamingBehavior !== undefined &&
					this._promptPreflights.values().next().value !== preflightToken);

			// Emit input event for extension interception (before skill/template expansion)
			const processedInput = await raceWithAbortSignal(
				this._runInputHandlers(
					text,
					options?.images,
					options?.source ?? "interactive",
					mustQueue() ? options?.streamingBehavior : undefined,
					admission?.signal,
				),
				admission?.signal,
			);
			admission?.check();
			if (!processedInput) {
				admission?.refuse("admission_refused");
				onInputTransferred?.();
				preflightResult?.(true);
				return;
			}
			const { text: currentText, images: currentImages } = processedInput;

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// Preserve an already-admitted prompt if a switch began while its input hook ran.
			while (this._modelSwitchCompactionPending) {
				await raceWithAbortSignal(this._modelSwitchAdmissionWait, admission?.signal);
			}
			admission?.check();
			// If streaming or behind another prompt, queue via steer() or followUp() based on option
			if (mustQueue()) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages, receipt, admission);
				} else {
					await this._queueSteer(expandedText, currentImages, receipt);
				}
				if (!this.isStreaming) this._inputQueuedBehindPreflight = true;
				onInputTransferred?.();
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash and custom messages before the new prompt.
			if (this.#ordinaryOwner) {
				await this._flushPendingBashMessagesOwnedTerminal();
				await this._flushPendingCustomMessagesOwnedTerminal();
			} else {
				this._flushPendingBashMessages();
				this._flushPendingCustomMessages();
			}

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const hasConfiguredAuth =
				this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
				(await raceWithAbortSignal(this._modelRuntime.checkAuth(this.model.provider), admission?.signal)) !==
					undefined;
			admission?.check();
			if (!hasConfiguredAuth) {
				const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// Check if we need to compact before sending (catches aborted responses).
			// The user's new prompt is sent below, so do not call agent.continue() here.
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				const outcome = await this._checkCompaction(lastAssistant, false);
				admission?.check();
				if (outcome === "failed" || outcome === "aborted") {
					// Refused receipt ingress cannot leave runnable input behind. Ordinary
					// prompt callers still retain their input in the existing queue below.
					if (admission) throw new Error(`Prompt not admitted: compaction ${outcome}`);
					// Input handlers and expansion already ran. Retain that exact input
					// in the existing queue, including attachments, without starting a run.
					const behavior = options?.streamingBehavior ?? "steer";
					if (behavior === "followUp") await this._queueFollowUp(expandedText, currentImages, receipt, admission);
					else await this._queueSteer(expandedText, currentImages, receipt);
					// Input already queued behind this prompt is retained with it, and so are
					// triggered messages held during this preflight: the stop holds for them too.
					this._inputQueuedBehindPreflight = false;
					this._queueTriggeredBehindPreflight();
					onInputTransferred?.();
					throw new Error(
						`Prompt not sent: compaction ${outcome === "aborted" ? "was cancelled" : "failed"}. ` +
							`Input is retained in the ${behavior} queue. ` +
							"Compact successfully or recover the queued input before resubmitting.",
					);
				}
			}

			// Emit before_agent_start before normalizing images so extension-driven model
			// selection determines the resize profile used for the request and history.
			const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools;
			const result = await raceWithAbortSignal(
				this._extensionRunner.emitBeforeAgentStart(
					expandedText,
					currentImages,
					this._baseSystemPromptOptions,
					admission?.signal,
				),
				admission?.signal,
			);
			admission?.check();
			// Handlers may edit event.systemPromptOptions.selectedTools or call setActiveTools(),
			// which updates the live loadout instead. An explicit edit wins; otherwise the live
			// loadout is authoritative, so a setActiveTools() call is not undone here.
			const handlerEditedTools =
				result.systemPromptOptions.selectedTools.length !== selectedToolsBefore.length ||
				result.systemPromptOptions.selectedTools.some((name, index) => name !== selectedToolsBefore[index]);
			if (!handlerEditedTools) result.systemPromptOptions.selectedTools = this.getActiveToolNames();

			const normalized = await this._normalizePromptImages(currentImages);
			admission?.check();
			const userText =
				normalized.hints.length > 0 ? `${expandedText}\n\n${normalized.hints.join("\n")}` : expandedText;

			// Build messages only after hooks and image normalization have completed.
			messages = [];
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: userText }];
			userContent.push(...normalized.images);
			const userMessage: AgentMessage = { role: "user", content: userContent, timestamp: Date.now() };
			this.#receivedMessageReceipts.set(userMessage, receipt);
			messages.push(userMessage);

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			for (const [index, msg] of result.messages.entries()) {
				const message: CustomMessage = {
					role: "custom",
					customType: msg.customType,
					// Untyped extensions can pass null/missing content; normalize at ingestion.
					content: msg.content ?? [],
					display: msg.display,
					details: msg.details,
					timestamp: Date.now(),
				};
				this.#receivedMessageReceipts.set(message, result.messageReceipts[index]);
				messages.push(message);
			}
			const updateMessage = this._preparePromptAndToolLoadout(result.systemPromptOptions);
			this._runSystemPromptOptions = result.systemPromptOptions;
			if (updateMessage) messages.unshift(updateMessage);
		} catch (error) {
			this._promptPreflights.delete(preflightToken);
			preflightResult?.(false);
			throw error;
		} finally {
			if (!messages) {
				this._promptPreflights.delete(preflightToken);
				this._runTriggeredBehindPreflight();
				this._runInputQueuedBehindPreflight();
			}
		}

		if (!messages) {
			return;
		}

		// A switch can also begin during before_agent_start or image normalization.
		// Keep this prompt's admission token until its run can start, so triggered
		// messages still queue behind it instead of acquiring a competing run.
		try {
			while (this._modelSwitchCompactionPending) {
				await raceWithAbortSignal(this._modelSwitchAdmissionWait, admission?.signal);
			}
			admission?.check();
		} catch (error) {
			this._promptPreflights.delete(preflightToken);
			preflightResult?.(false);
			this._runTriggeredBehindPreflight();
			this._runInputQueuedBehindPreflight();
			throw error;
		}
		preflightResult?.(true);
		// Triggered messages held during this preflight join its run, in the queue they asked for.
		this._queueTriggeredBehindPreflight();
		// This preflight ends here, before dispatch can reach an agent_start handler: that handler
		// must see this prompt as started (isPromptPending), not pending. _runAgentPrompt marks the
		// run active synchronously, so later prompts still queue through isStreaming.
		this._promptPreflights.delete(preflightToken);
		const run = this._runAgentPrompt(messages, promptToken, undefined, onInputTransferred, admission);
		releasePreflight?.();
		await run;
	}

	private _queueTriggeredBehindPreflight(): void {
		for (const { message, deliverAs } of this._triggeredBehindPreflight.splice(0)) {
			if (deliverAs === "followUp") this.agent.followUp(message);
			else this.agent.steer(message);
		}
	}

	/**
	 * When the last preflight ends without a run (its input was consumed, or it failed), start the
	 * run that the held triggered messages asked for. Unlike queued input, this needs no earlier
	 * assistant message: the messages are the run's input, as they would have been without the wait.
	 */
	private _runTriggeredBehindPreflight(): void {
		if (this._shutdownCancellation.signal.aborted) return;
		// Keep ownership here while a switch is pending: its compaction caller discards
		// the usual continuation decision, so moving these into agent queues would strand them.
		if (
			this._modelSwitchCompactionPending ||
			this._promptPreflights.size > 0 ||
			this._triggeredBehindPreflight.length === 0
		)
			return;
		if (this._isEmittingAgentSettled) {
			this._deferredSettledActions.push(async () => this._runTriggeredBehindPreflight());
			return;
		}
		// Held triggers themselves make the session non-idle; only an existing operation owns them.
		if (this.isStreaming || this.isCompacting) {
			this._queueTriggeredBehindPreflight();
			return;
		}
		const messages = this._triggeredBehindPreflight.splice(0).map(({ message }) => message);
		void this._runAgentPrompt(messages).catch((error: unknown) => {
			this._extensionRunner.emitError({
				extensionPath: "<queue>",
				event: "sendMessage",
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	/**
	 * Start a run for input queued behind a prompt preflight when the last preflight ends
	 * without a run, for example because it failed. Otherwise that input waits for the
	 * next prompt.
	 */
	private _runInputQueuedBehindPreflight(): void {
		if (this._shutdownCancellation.signal.aborted) return;
		if (
			this._modelSwitchCompactionPending ||
			!this._inputQueuedBehindPreflight ||
			this._promptPreflights.size > 0 ||
			!this.isIdle
		)
			return;
		if (this._isEmittingAgentSettled) {
			this._deferredSettledActions.push(async () => this._runInputQueuedBehindPreflight());
			return;
		}
		this._inputQueuedBehindPreflight = false;
		// ponytail: Agent.continue() starts queued input only after an assistant message. Upstream
		// rejects a queued continuation without transcript, so a failed first prompt still leaves its
		// queued input for the next prompt. That failure is usually a missing model or auth, which the
		// queued input would also hit. Revisit if another first-prompt failure strands input.
		if (!this.agent.hasQueuedMessages() || this.agent.state.messages.at(-1)?.role !== "assistant") return;
		void this._runAgentPrompt(undefined).catch((error: unknown) => {
			this._extensionRunner.emitError({
				extensionPath: "<queue>",
				event: "prompt",
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			this._shutdownCancellation.signal.throwIfAborted();
			await raceWithAbortSignal(Promise.resolve(command.handler(args, ctx)), this._shutdownCancellation.signal);
			this._shutdownCancellation.signal.throwIfAborted();
			return true;
		} catch (err) {
			this._shutdownCancellation.signal.throwIfAborted();
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	private async _queueUserInput(
		text: string,
		images: ImageContent[] | undefined,
		behavior: "steer" | "followUp",
		source: InputSource,
		receipt: TurnReceipt,
	): Promise<void> {
		this.#ordinaryOwner?.assertSessionStart(this);
		this.#ordinaryOwner?.assertCompactionIdle();
		if (this.#ordinaryOwner) {
			this.#ordinaryPreflights++;
			this.#auditState("queued_preflight_start");
		}
		try {
			await this._prepareQueuedInput(text, images, behavior, source, receipt);
		} finally {
			if (this.#ordinaryOwner) {
				this.#ordinaryPreflights--;
				this.#auditState("queued_preflight_settled");
			}
		}
	}

	private async _prepareQueuedInput(
		text: string,
		images: ImageContent[] | undefined,
		behavior: "steer" | "followUp",
		source: InputSource,
		receipt: TurnReceipt,
	): Promise<void> {
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		const processedInput = await this._runInputHandlers(
			text,
			images,
			source,
			this.isStreaming ? behavior : undefined,
		);
		if (!processedInput) return;

		let expandedText = this._expandSkillCommand(processedInput.text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		if (behavior === "steer") {
			await this._queueSteer(expandedText, processedInput.images, receipt);
		} else {
			await this._queueFollowUp(expandedText, processedInput.images, receipt);
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[], options?: { source?: InputSource }): Promise<void> {
		const receipt = captureTerminalTurnReceipt();
		await this._queueUserInput(text, images, "steer", options?.source ?? "interactive", receipt);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[], options?: { source?: InputSource }): Promise<void> {
		const receipt = captureTerminalTurnReceipt();
		await this._queueUserInput(text, images, "followUp", options?.source ?? "interactive", receipt);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images: ImageContent[] | undefined, receipt: TurnReceipt): Promise<void> {
		this.#ordinaryOwner?.assertCompactionIdle();
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		const message: AgentMessage = { role: "user", content, timestamp: Date.now() };
		this.#receivedMessageReceipts.set(message, receipt);
		this.agent.steer(message);
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(
		text: string,
		images: ImageContent[] | undefined,
		receipt: TurnReceipt,
		admission?: UserMessageAdmission,
	): Promise<void> {
		admission?.check();
		this.#ordinaryOwner?.assertCompactionIdle();
		if (!admission) {
			this._followUpMessages.push(text);
			this._emitQueueUpdate();
		}
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		admission?.check();
		const message: AgentMessage = { role: "user", content, timestamp: Date.now() };
		this.#receivedMessageReceipts.set(message, receipt);
		if (admission) {
			this.agent.followUp(message, () => {
				// Native insertion owns the message now. Commit tracking and receipt before
				// a lifecycle observer can throw, reload, or cancel the admitted queue.
				this._ingressQueuedMessages.set(message, { text, displayIndex: this._followUpMessages.length });
				this._followUpMessages.push(text);
				admission.accept("queued");
			});
			this._emitQueueUpdate();
		} else this.agent.followUp(message);
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles four cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Streaming + triggerTurn false: appended to state/session once the current turn ends
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + triggerTurn during a prompt's preflight: queued behind that prompt (see HOST_CAPABILITIES)
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const receipt = captureTerminalTurnReceipt();
		this._shutdownCancellation.signal.throwIfAborted();
		this.#ordinaryOwner?.assertCompactionIdle();
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		this.#receivedMessageReceipts.set(appMessage, receipt);
		return this._deliverCustomMessage(appMessage, options);
	}

	private async _deliverCustomMessage(
		appMessage: CustomMessage,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		this._shutdownCancellation.signal.throwIfAborted();
		this.#ordinaryOwner?.assertCompactionIdle();
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming && options?.triggerTurn !== false) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			// Waiting releases admission. Re-enter delivery of this same occurrence so a prompt or
			// earlier triggered message that acquired the run owns settlement; preserve
			// this message's requested queue rather than starting another run owner.
			if (this._modelSwitchCompactionPending) {
				if (this._compactionHookScope.getStore() || this._agentSettledScope.getStore()?.active) {
					// A compaction or enclosing settlement handler must not await dispatch
					// that needs that handler to return. Accept into the existing held queue:
					// success drains after settlement; refusal/abort retains without a run.
					this._triggeredBehindPreflight.push({ message: appMessage, deliverAs: options.deliverAs });
					return;
				}
				const ticket = { deliverAs: options.deliverAs };
				this._modelSwitchDispatches.set(appMessage, ticket);
				try {
					while (this._modelSwitchCompactionPending) await this._modelSwitchAdmissionWait;
					const dispatch = async () => {
						// Abort, refusal or clearQueue already disposed of this dispatch ticket.
						if (this._modelSwitchDispatches.get(appMessage) !== ticket) return;
						// Remove only this ticket before re-entry can acquire another switch ticket.
						this._modelSwitchDispatches.delete(appMessage);
						await this._deliverCustomMessage(appMessage, options);
					};
					if (this._isEmittingAgentSettled) {
						// External callers can await delivery; unlike hooks, they do not own this settlement.
						await new Promise<void>((resolve, reject) => {
							this._deferredSettledActions.push(async () => {
								try {
									await dispatch();
									resolve();
								} catch (error) {
									reject(error);
									throw error;
								}
							});
						});
					} else await dispatch();
				} finally {
					if (this._modelSwitchDispatches.get(appMessage) === ticket)
						this._modelSwitchDispatches.delete(appMessage);
					this._resolveIdleWaitIfIdle();
				}
				return;
			}
			if (this._isEmittingAgentSettled) {
				this._deferredSettledActions.push(async () => await this._deliverCustomMessage(appMessage, options));
				return;
			}
			if (this._promptPreflights.size > 0) {
				// A prompt is in preflight (input handlers, before_agent_start). The session still
				// reports idle, but a run started now makes that prompt fail with "Agent is already
				// processing". Hold the message: the prompt's run takes it, or, when the last
				// preflight ends without a run, the message starts its own run as it would have.
				this._triggeredBehindPreflight.push({ message: appMessage, deliverAs: options.deliverAs });
				return;
			}
			await this._runAgentPrompt(appMessage);
		} else if (this.isStreaming) {
			// Appending now would put the message between an assistant tool call and its
			// result, which providers that validate message order reject on replay. Defer
			// to the end of the turn. Nothing is emitted yet: message events must not
			// describe messages the session tree does not contain.
			this._pendingCustomMessages.push(appMessage);
		} else if (this.#ordinaryOwner) {
			this._pendingCustomMessages.push(appMessage);
			await this.#ordinaryOwner.owner.terminal(() => this._flushPendingCustomMessagesOwnedTerminal());
		} else {
			this._appendCustomMessage(appMessage);
		}
	}

	private _appendCustomMessage(appMessage: CustomMessage): void {
		const entryId = appendReceivedCustomMessage(
			this.sessionManager,
			appMessage.customType,
			appMessage.content,
			appMessage.display,
			appMessage.details,
			this.#receivedMessageReceipts.get(appMessage),
		);
		this.#receivedMessageReceipts.delete(appMessage);
		this._recordMessageEntryId(appMessage, entryId);
		this._entryIdsByMessage.set(appMessage, entryId);
		this._refreshFinalizedContext();
		this._emit({ type: "message_start", message: appMessage });
		this._emit({ type: "message_end", message: appMessage });
	}

	#pendingFlushTail: Promise<void> = Promise.resolve();

	#queuePendingFlush(flush: () => Promise<void>): Promise<void> {
		// Share ordering across bash/custom flush callers; retain rejection so a
		// failed or uncertain append cannot be attempted again by run-finally.
		const run = this.#pendingFlushTail.then(flush);
		this.#pendingFlushTail = run;
		void run.catch(() => {});
		return run;
	}

	private _flushPendingCustomMessagesOwnedTerminal(): Promise<void> {
		return this.#queuePendingFlush(async () => {
			while (this._pendingCustomMessages.length) {
				const message = this._pendingCustomMessages[0];
				const id = await appendOwnedTerminalCustomMessage(
					this.sessionManager,
					message.customType,
					message.content,
					message.display,
					message.details,
					this.#receivedMessageReceipts.get(message),
				);
				this.#receivedMessageReceipts.delete(message);
				// Leave the failed message and suffix retained if persistence fails.
				try {
					this._pendingCustomMessages.shift();
					this.agent.state.messages.push(message);
					this._recordMessageEntryId(message, id);
					this._emit({ type: "message_start", message });
					this._emit({ type: "message_end", message });
				} catch (error) {
					this._retainTerminalPublicationFailure(error);
				}
			}
		});
	}

	private _flushPendingBashMessagesOwnedTerminal(): Promise<void> {
		return this.#queuePendingFlush(async () => {
			while (this._pendingBashMessages.length) {
				const message = this._pendingBashMessages[0];
				await appendOwnedTerminalMessage(this.sessionManager, message);
				try {
					this._pendingBashMessages.shift();
					this.agent.state.messages.push(message);
				} catch (error) {
					this._retainTerminalPublicationFailure(error);
				}
			}
		});
	}

	/** Flush the non-owned queue without changing its synchronous behavior. */
	private _flushPendingCustomMessages(): void {
		if (this._pendingCustomMessages.length === 0) return;

		const pending = this._pendingCustomMessages;
		this._pendingCustomMessages = [];
		for (const appMessage of pending) {
			this._appendCustomMessage(appMessage);
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 * @param options.expandPromptTemplates Whether to dispatch extension commands and expand skill commands and prompt templates. Default: false.
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void> {
		const receipt = captureTerminalTurnReceipt();
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		await this._promptReceived(receiveInput(text, images, receipt), {
			expandPromptTemplates: options?.expandPromptTemplates ?? false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/** Submit literal input with a session-bound at-most-once admission receipt. */
	submitUserMessage(request: SubmitUserMessageOptions): Promise<UserMessageReceipt> {
		return this._userMessageIngress.submit(request, async (input, admission) => {
			const options: PromptOptions = {
				expandPromptTemplates: false,
				streamingBehavior: "followUp",
				source: "extension",
			};
			this._userMessageAdmissions.set(options, admission);
			try {
				await this.prompt(input.text, options);
			} finally {
				this._userMessageAdmissions.delete(options);
			}
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this._triggeredBehindPreflight.splice(0);
		this._modelSwitchDispatches.clear();
		this._ingressQueuedMessages.clear();
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		this._resolveIdleWaitIfIdle();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/** @internal Permanently stop extension dispatch waits before a terminal shutdown join. */
	cancelForShutdown(): void {
		this._userMessageIngress.invalidate("shutting_down", true);
		try {
			this._cancelIngressQueuedMessages();
		} finally {
			// Cancellation observers must not leave terminal dispatch or bash waits live.
			this._shutdownCancellation.abort(new DOMException("Operation cancelled for terminal shutdown", "AbortError"));
			this.abortBash();
		}
	}

	/** @internal Shared terminal signal for provider and extension dispatch. */
	get shutdownSignal(): AbortSignal {
		return this._shutdownCancellation.signal;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this.#ordinaryOwner?.interruptAutomaticCapture(new Error("OWNER_REQUEST_CAPTURE_ABORTED"));
		this.#ordinaryOwner?.stopAutomatic();
		if (this._isAgentRunActive) this._agentRunAbortRequested = true;
		this._retainModelSwitchDispatches();
		// Accepted hook/settlement input is retained too, even if the switch already committed.
		this._queueTriggeredBehindPreflight();
		this.abortRetry();
		this.abortCompaction();
		this.abortBranchSummary();
		if (this._isBeforeSettle) this._abortDuringBeforeSettle = true;
		this.#originalAgent.abort();
		this._resolveIdleWaitIfIdle();
		await this.waitForIdle();
		// Deferred work must not join the settlement whose completion it owns.
		// The external terminal join still waits until every deferred action returns.
		if (this._shutdownCancellation.signal.aborted && !this._settlementActionScope.getStore()?.active) {
			await this._settlementCompletion;
		}
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	private _retainModelSwitchDispatches(): void {
		for (const [message, { deliverAs }] of this._modelSwitchDispatches) {
			if (deliverAs === "followUp") this.agent.followUp(message);
			else this.agent.steer(message);
		}
		this._modelSwitchDispatches.clear();
	}

	private async _compactForModelSwitch(model: Model<any>, commit: () => void): Promise<void> {
		if (this._modelSwitchCompactionPending)
			throw new Error("Model switch refused: another model switch compaction is in progress.");
		if (
			(modelsAreEqual(this.model, model) && this.model?.contextWindow === model.contextWindow) ||
			model.contextWindow <= 0
		) {
			commit();
			return;
		}
		const tokens = estimateProjectedContextTokens(
			this.sessionManager.buildSessionProjection(),
			this.sessionManager.getBranch(),
		).tokens;
		if (tokens <= 0.8 * model.contextWindow) {
			commit();
			return;
		}
		const refusal = `Model switch refused: estimated context ${tokens} tokens exceeds 80% of ${model.provider}/${model.id}'s ${model.contextWindow}-token window.`;
		if (this.isStreaming || this.isCompacting)
			throw new Error(`${refusal} Wait for the current operation, then compact and retry.`);
		if (!this.autoCompactionEnabled)
			throw new Error(`${refusal} Auto-compaction is disabled; compact with the current model first.`);

		// ponytail: summarize with the old model while its larger window still fits;
		// do not persist a target that cannot safely accept the compacted context.
		this._modelSwitchCompactionPending = true;
		this._modelSwitchAdmissionWait = new Promise((resolve) => {
			this._resolveModelSwitchAdmissionWait = resolve;
		});
		let committed = false;
		try {
			const outcome = await this._runAutoCompaction("threshold", false);
			if (outcome === "failed" || outcome === "aborted") throw new Error(`Compaction ${outcome}.`);
			const remaining = estimateProjectedContextTokens(
				this.sessionManager.buildSessionProjection(),
				this.sessionManager.getBranch(),
			).tokens;
			if (remaining > 0.8 * model.contextWindow)
				throw new Error("Compaction could not reduce context below 80% of the target window.");
			// No await between the final admission check and model/transcript commit.
			commit();
			committed = true;
		} catch (error) {
			throw new Error(
				`${refusal} ${error instanceof Error ? error.message : String(error)} Current model unchanged.`,
				{ cause: error },
			);
		} finally {
			this._modelSwitchCompactionPending = false;
			// A refused/cancelled switch retains input without starting a continuation.
			// Transfer even while a preflight is pending: its later cleanup must not launch these.
			if (!committed) {
				this._retainModelSwitchDispatches();
				this._queueTriggeredBehindPreflight();
			}
			this._resolveModelSwitchAdmissionWait?.();
			this._resolveModelSwitchAdmissionWait = undefined;
			this._resolveIdleWaitIfIdle();
		}
	}

	/** Successful switches drain only after any enclosing settlement notifications finish. */
	private _drainPreflightQueuesAfterModelSwitch(): void {
		if (this._isEmittingAgentSettled) {
			this._deferredSettledActions.push(async () => this._drainPreflightQueuesAfterModelSwitch());
			return;
		}
		this._runTriggeredBehindPreflight();
		this._runInputQueuedBehindPreflight();
	}

	/**
	 * Set model directly.
	 * Compacts above 80% of the target window before committing the switch.
	 * Validates that auth is configured and saves to the session transcript.
	 * Persists to global defaults only when options.persist is true.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>, options: ModelMutationOptions = {}): Promise<void> {
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		await this._compactForModelSwitch(model, () => {
			const thinkingLevel = this._getThinkingLevelForModelSwitch(model);
			this.agent.state.model = model;
			this.sessionManager.appendModelChange(model.provider, model.id);
			if (options.persist) {
				this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
				this._addPersistedDefaultToNonEmptyScope(model);
			}

			// Model persistence does not implicitly rewrite the global thinking default.
			this.setThinkingLevel(thinkingLevel);
		});

		await this._emitModelSelect(model, previousModel, "set");
		this._drainPreflightQueuesAfterModelSwitch();
	}

	private _addPersistedDefaultToNonEmptyScope(model: Model<any>): void {
		if (this._scopedModels.length === 0) return;
		if (this._scopedModels.some((scoped) => modelsAreEqual(scoped.model, model))) return;

		this._scopedModels = [...this._scopedModels, { model }];

		const enabledModels = this.settingsManager.getEnabledModels();
		if (!enabledModels?.length) return;

		const modelReference = `${model.provider}/${model.id}`;
		if (enabledModels.some((pattern) => pattern.toLowerCase() === modelReference.toLowerCase())) return;
		this.settingsManager.setEnabledModels([...enabledModels, modelReference]);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(
		direction: "forward" | "backward" = "forward",
		options: ModelMutationOptions = {},
	): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction, options);
		}
		return this._cycleAvailableModel(direction, options);
	}

	private async _cycleScopedModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableIds = new Set(
			this._modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
		);
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableIds.has(`${scoped.model.provider}\0${scoped.model.id}`),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.model, next.thinkingLevel);

		await this._compactForModelSwitch(next.model, () => {
			this.agent.state.model = next.model;
			this.sessionManager.appendModelChange(next.model.provider, next.model.id);
			if (options.persist) {
				this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);
				this._addPersistedDefaultToNonEmptyScope(next.model);
			}

			// Scoped/per-model thinking overrides are clamped without changing global defaults.
			this.setThinkingLevel(thinkingLevel);
		});

		await this._emitModelSelect(next.model, currentModel, "cycle");
		this._drainPreflightQueuesAfterModelSwitch();

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = this._modelRuntime.getAvailableSnapshot();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch(nextModel);
		await this._compactForModelSwitch(nextModel, () => {
			this.agent.state.model = nextModel;
			this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
			if (options.persist) {
				this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
				this._addPersistedDefaultToNonEmptyScope(nextModel);
			}

			// Model persistence does not implicitly rewrite the global thinking default.
			this.setThinkingLevel(thinkingLevel);
		});

		await this._emitModelSelect(nextModel, currentModel, "cycle");
		this._drainPreflightQueuesAfterModelSwitch();

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves the clamped level to the session transcript only if the level actually changes.
	 * Persists the requested level to global defaults only when options.persist is true.
	 */
	setThinkingLevel(level: ThinkingLevel, options: ModelMutationOptions = {}): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (options.persist) {
			this.settingsManager.setDefaultThinkingLevel(level);
		}

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(options: ModelMutationOptions = {}): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel, options);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return [...THINKING_LEVEL_OPTIONS];
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(targetModel?: Model<any>, explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		// Per-model default takes priority when switching to a model that has one
		if (targetModel) {
			const perModel = this.settingsManager.getModelThinkingLevel(targetModel.provider, targetModel.id);
			if (perModel !== undefined) {
				return perModel;
			}
		}
		return this.settingsManager.getDefaultThinkingLevel() ?? this.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/** Generate Pi's built-in compaction summary for manual and automatic compaction. */
	async #runDefaultCompaction(
		preparation: CompactionPreparation,
		requestModel: Model<any>,
		apiKey: string | undefined,
		headers: Record<string, string> | undefined,
		customInstructions: string | undefined,
		signal: AbortSignal,
		env: Record<string, string> | undefined,
		reason: "manual" | "threshold" | "overflow",
		attempt?: OriginalCompactionAttempt,
	): Promise<CompactionResult> {
		this.#ordinaryOwner?.requestProvenance.interrupt(new Error("OWNER_REQUEST_CAPTURE_AUXILIARY"));
		const callbacks = this._summarizationRetryCallbacks({ source: "compaction", reason });
		const stream = this.agent.streamFunction;
		const summaryStream: typeof stream = attempt ? (...args) => attempt.request(() => stream(...args)) : stream;
		let originalFailure: { cause: unknown } | undefined;
		try {
			return await raceWithAbortSignal(
				compact(
					preparation,
					requestModel,
					apiKey,
					headers,
					customInstructions,
					signal,
					this.thinkingLevel,
					summaryStream,
					env,
					COMPACTION_RETRY_POLICY,
					callbacks,
					undefined, // sessionId
				),
				signal,
			);
		} catch (cause) {
			originalFailure = { cause };
			throw cause;
		} finally {
			// Also clear a retry indicator when abort wins over an uncooperative
			// provider. The callback is idempotent and does not restart work.
			try {
				await callbacks.onRetryFinished?.(false, 0);
			} catch (cleanup) {
				if (attempt && originalFailure)
					// biome-ignore lint/correctness/noUnsafeFinally: Cleanup failure must reject; the original failure is retained as the first cause.
					throw new AggregateError([originalFailure.cause, cleanup], "OPS_COMPACTION_RETRY_CLEANUP_FAILED", {
						cause: originalFailure.cause,
					});
				// biome-ignore lint/correctness/noUnsafeFinally: A retry-indicator cleanup failure must reject.
				throw cleanup;
			}
		}
	}

	private _clearManualCompactionState(controller: AbortController): void {
		if (this._compactionAbortController === controller) this._compactionAbortController = undefined;
		this.#auditState("manual_compaction_settled");
		this._resolveIdleWaitIfIdle();
	}

	/**
	 * Manually compact the session context.
	 *
	 * This is the manual entry point used by `/compact`, RPC, and extensions. It is
	 * separate from automatic threshold/overflow compaction, which enters through
	 * `_checkCompaction()` and `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * Aborts the current agent operation first. Manual compaction never retries or
	 * continues the interrupted agent turn.
	 *
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		await this.abort();
		this.#ordinaryOwner?.assertCompactionIdle();
		return this.#compactSession(customInstructions);
	}

	/** Same session implementation; manual cancellation stays in its entry wrapper. */
	async #compactSession(customInstructions?: string, attempt?: OriginalCompactionAttempt): Promise<CompactionResult> {
		const controller = new AbortController();
		this._compactionAbortController = controller;
		const signal = attempt ? AbortSignal.any([controller.signal, attempt.signal]) : controller.signal;
		const timeout = startCompactionDeadline(controller);
		let fromExtension = false;
		let cancelledByExtension = false;
		let originalStateCleared = false;
		const clearManualState = () => {
			if (attempt && originalStateCleared) return;
			if (attempt) originalStateCleared = true; // A failed audit/idle notification is not safe to repeat.
			this._clearManualCompactionState(controller);
		};

		try {
			this._emit({ type: "compaction_start", reason: "manual" });
			const model = this.model;
			if (!model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const settings = this.settingsManager.getCompactionSettings(model);
			const {
				model: requestModel,
				apiKey,
				headers,
				env,
			} = await raceWithAbortSignal(this._getSummarizationRequestAuth(model, signal), signal);

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			attempt?.check();
			attempt?.prepare(preparation);
			let extensionCompaction: CompactionResult | undefined;

			if (!attempt && this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._emitCompactionHook(
					{
						type: "session_before_compact",
						preparation,
						branchEntries: pathEntries,
						customInstructions,
						reason: "manual",
						willRetry: false,
						signal,
					},
					signal,
				)) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					cancelledByExtension = true;
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Shared default summary generator, also used by automatic compaction.
				const result = await this.#runDefaultCompaction(
					preparation,
					requestModel,
					apiKey,
					headers,
					customInstructions,
					signal,
					env,
					"manual",
					attempt,
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				usage = result.usage;
				details = result.details;
			}

			signal.throwIfAborted();

			if (attempt) await attempt.settle();
			signal.throwIfAborted();
			attempt?.check();
			let compactionId: string;
			if (attempt) {
				const ticket = attempt.beginAppend(
					{ summary, firstKeptEntryId, tokensBefore, details, usage },
					this.sessionManager.getLeafId(),
				);
				try {
					compactionId = appendOriginalCompaction.call(
						this.sessionManager,
						summary,
						firstKeptEntryId,
						tokensBefore,
						details,
						false,
						usage,
					);
					attempt.appended(ticket, compactionId);
					const state = originalCompactionSessions.get(this);
					if (!state || state.attempt !== attempt) throw new Error("OPS_COMPACTION_ORIGINAL_ATTEMPT_REQUIRED");
					state.afterAppend(); // The actual ID is already retained if branch readback fails.
					attempt.finishAppend(ticket);
				} catch (cause) {
					attempt.failAppend(cause);
				}
			} else {
				compactionId = this.sessionManager.appendCompaction(
					summary,
					firstKeptEntryId,
					tokensBefore,
					details,
					fromExtension,
					usage,
				);
			}
			const newEntries = this.sessionManager.getEntries();
			this._refreshFinalizedContext();
			const estimatedTokensAfter = estimateMessagesTokens(this.sessionManager.buildSessionProjection().messages);

			// Match the actual append, even when an earlier entry has the same summary.
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.id === compactionId) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._emitCompactionHook(
					{
						type: "session_compact",
						compactionEntry: savedCompactionEntry,
						fromExtension,
						reason: "manual",
						willRetry: false,
					},
					signal,
				);
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			attempt?.check();
			// Manual listeners may submit queued prompts. The selected operation's
			// separate owner fence remains active through all completion hooks.
			clearTimeout(timeout);
			clearManualState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			if (attempt) {
				const errors: unknown[] = [error];
				let aborted = false;
				let errorMessage: string | undefined;
				try {
					const message = error instanceof Error ? error.message : String(error);
					aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
					errorMessage = aborted ? undefined : `Compaction failed: ${message}`;
				} catch (cleanup) {
					errors.push(cleanup);
				}
				try {
					clearManualState();
				} catch (cleanup) {
					errors.push(cleanup);
				}
				try {
					this._emit({
						type: "compaction_end",
						reason: "manual",
						result: undefined,
						aborted,
						willRetry: false,
						errorMessage,
					});
				} catch (cleanup) {
					errors.push(cleanup);
				}
				try {
					await this._emitSessionCompactFailed(
						{ reason: "manual", errorMessage, aborted, willRetry: false, fromExtension },
						signal,
						true,
					);
				} catch (cleanup) {
					errors.push(cleanup);
				}
				if (errors.length > 1)
					throw new AggregateError(errors, "OPS_COMPACTION_SESSION_CLEANUP_FAILED", { cause: error });
				throw error; // Preserve the original cancellation or undefined cause, not a replacement Error.
			}
			const message = error instanceof Error ? error.message : String(error);
			const aborted = cancelledByExtension || isCompactionCancelled(signal);
			const errorMessage = aborted ? undefined : `Compaction failed: ${message}`;
			clearManualState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage,
			});
			await this._emitSessionCompactFailed(
				{ reason: "manual", errorMessage, aborted, willRetry: false, fromExtension },
				signal,
			);
			throw aborted ? new Error("Compaction cancelled", { cause: error }) : error;
		} finally {
			clearTimeout(timeout);
			clearManualState();
		}
	}

	/** Private captured constructor closure; no public AgentSession method or abort. */
	async #compactOriginal(attempt: OriginalCompactionAttempt): Promise<CompactionResult> {
		const owner = this.#ordinaryOwner;
		if (!owner) throw new Error("OPS_COMPACTION_ORIGINAL_OWNER_REQUIRED");
		assertOriginalCompactionAttempt(attempt, owner, this);
		owner.assertSessionStart(this);
		if (
			this.#ordinaryPreflights ||
			!this.isIdle ||
			this.isRetrying ||
			this.isBashRunning ||
			originalAgentSignal.call(this.#originalAgent) ||
			this.#originalAgent.hasQueuedMessages() ||
			this.pendingMessageCount ||
			(this._extensionMode === "tui" && !this.#pendingModeInput) ||
			this.#pendingModeInput?.()
		)
			throw new Error("OPS_COMPACTION_SESSION_NOT_IDLE");
		owner.assertSessionStart(this);
		const model = this.model;
		const stream = this.agent.streamFunction;
		const branchIdentity = () =>
			JSON.stringify(
				this.sessionManager
					.getBranch()
					.filter(
						(entry) =>
							!(
								entry.type === "custom" &&
								[
									"smarty-sense:count-reservation-v1",
									"smarty-sense:count-qualification-v1",
									"smarty-sense:provider-reservation-v1",
									"smarty-sense:provider-usage-v1",
								].includes(entry.customType)
							),
					),
			);
		let branch = branchIdentity();
		const checkState = () => {
			owner.assertSessionStart(this);
			this._compactionAbortController?.signal.throwIfAborted();
			if (
				this.model !== model ||
				this.agent.streamFunction !== stream ||
				this.#ordinaryPreflights ||
				this._isAgentRunActive ||
				this.isRetrying ||
				this.isBashRunning ||
				this.#originalAgent.hasQueuedMessages() ||
				this.pendingMessageCount ||
				this.#pendingModeInput?.() ||
				branchIdentity() !== branch
			)
				throw new Error("OPS_COMPACTION_SESSION_CHANGED");
		};
		if (originalCompactionSessions.has(this)) throw new Error("OPS_COMPACTION_SESSION_FENCE_ONCE");
		originalCompactionSessions.set(this, {
			attempt,
			check: checkState,
			afterAppend: () => {
				branch = branchIdentity();
			},
		});
		attempt.check();
		return this.#compactSession(undefined, attempt);
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Dispatch automatic compaction after `agent_end` or before prompt submission.
	 * Manual compaction does not call this method; it enters through `compact()`.
	 *
	 * Automatic cases:
	 * 1. Overflow with retry: a context-overflow error or recoverable length stop;
	 *    remove the failed assistant message, compact, and retry the turn once.
	 * 2. Overflow without retry: a successful response exceeded the configured
	 *    context window; compact but preserve the completed response.
	 * 3. Threshold without retry: valid or estimated context usage crossed the
	 *    configured threshold; compact without retrying the completed response.
	 *
	 * Each case calls `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, that method calls the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 * @returns A continuation decision, or an explicit failed/aborted outcome that blocks a pending prompt.
	 */
	private async _checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		toolResults: AgentMessage[] = [],
	): Promise<CompactionOutcome> {
		const settings = this.settingsManager.getCompactionSettings(this.model);
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Automatic cases 1 and 2: context overflow.
		// A length stop is recoverable when output ended below the model's original desired limit,
		// independent of the configured context size or any context-clamped provider request limit.
		const currentProjection = this.sessionManager.buildSessionProjection();
		const assistantEntryId = this._findPersistedMessageEntryId(assistantMessage);
		const assistantIsProjected =
			assistantEntryId === undefined ||
			currentProjection.entries.some(
				(entry) =>
					entry.sourceEntry.id === assistantEntryId &&
					entry.messages.some((message) => message.role === "assistant"),
			);
		const branch = this.sessionManager.getBranch();
		const assistantIndex = assistantEntryId ? branch.findIndex((entry) => entry.id === assistantEntryId) : -1;
		const entriesAfterAssistant = assistantIndex >= 0 ? branch.slice(assistantIndex + 1) : [];
		const hasPostAssistantContextEdit = entriesAfterAssistant.some((entry) => entry.type === "context_edit");
		const latestAssistantEdit = entriesAfterAssistant
			.filter(
				(entry): entry is ContextEditEntry => entry.type === "context_edit" && entry.targetId === assistantEntryId,
			)
			.at(-1);
		const assistantRetainedForExplicitRecovery =
			assistantEntryId === undefined ||
			(!entriesAfterAssistant.some((entry) => entry.type === "compaction") &&
				latestAssistantEdit?.replacement !== null);
		const assistantUsageMatchesProjection = assistantIsProjected && !hasPostAssistantContextEdit;
		const explicitOverflow = assistantMessage.stopReason === "error" && isContextOverflow(assistantMessage);
		const contextOverflow =
			sameModel &&
			((explicitOverflow && assistantRetainedForExplicitRecovery) ||
				(assistantUsageMatchesProjection && isContextOverflow(assistantMessage, contextWindow)));
		const recoverableLength =
			sameModel && assistantIsProjected && isRecoverableLength(assistantMessage, this.model?.maxTokens ?? 0);
		if (contextOverflow || recoverableLength) {
			const willRetry = assistantMessage.stopReason !== "stop";

			// Case 2: the response completed successfully. Compact, but do not retry because
			// agent.continue() cannot continue from a completed assistant response.
			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false);
			}

			if (this._overflowRecoveryAttempted) {
				const errorMessage = contextOverflow
					? "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
					: "Truncated response recovery failed after one compact-and-retry attempt.";
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage,
				});
				await this._emitSessionCompactFailed({
					reason: "overflow",
					errorMessage,
					aborted: false,
					willRetry: false,
					fromExtension: false,
				});
				return "failed";
			}

			// Persistently omit the selected final attempt before post-run recovery compaction.
			this._overflowRecoveryAttempted = true;
			this._omitRecoveryAttempt(assistantMessage, toolResults);
			return await this._runAutoCompaction("overflow", willRetry);
		}

		// Case 3: threshold compaction without retry.
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		let contextTokens: number;
		const projection = currentProjection;
		const hasContextEdits = projection.entries.some((entry) => entry.sourceEntry.type === "context_edit");
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (hasContextEdits) {
			contextTokens = estimateProjectedContextTokens(projection, branch).tokens;
		} else if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			// Without provider usage, estimate.tokens is the pure message-size estimate.
			// Only usage-backed estimates need the stale pre-compaction check.
			if (estimate.lastUsageIndex !== null) {
				// Verify the usage source is post-compaction. Kept pre-compaction messages
				// have stale usage reflecting the old (larger) context and would falsely
				// trigger compaction right after one just finished.
				const usageMsg = messages[estimate.lastUsageIndex];
				if (
					compactionEntry &&
					usageMsg.role === "assistant" &&
					(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
				) {
					return false;
				}
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * Execute threshold or overflow compaction. Manual compaction uses
	 * `AgentSession.compact()` instead. Both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts` after preparation and extension
	 * interception.
	 *
	 * @param reason Automatic trigger selected by `_checkCompaction()`
	 * @param willRetry Whether to continue the interrupted turn after overflow compaction
	 * @returns A continuation decision, or an explicit failed/aborted outcome.
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<CompactionOutcome> {
		const model = this.model;
		const settings = this.settingsManager.getCompactionSettings(model);
		if (this.isCompacting) return "failed";
		const controller = new AbortController();
		this._autoCompactionAbortController = controller;
		this.#auditState("auto_compaction_preparing");
		const signal = controller.signal;
		const timeout = startCompactionDeadline(controller);
		let started = false;
		let fromExtension = false;
		let cancelledByExtension = false;

		try {
			if (!model) {
				return false;
			}

			const pathEntries = this.sessionManager.getBranch();
			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				return false;
			}

			signal.throwIfAborted();
			started = true;
			this._emit({ type: "compaction_start", reason });
			signal.throwIfAborted();

			const {
				model: requestModel,
				apiKey,
				headers,
				env,
			} = await raceWithAbortSignal(this._getSummarizationRequestAuth(model, signal), signal);
			signal.throwIfAborted();

			let extensionCompaction: CompactionResult | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._emitCompactionHook(
					{
						type: "session_before_compact",
						preparation,
						branchEntries: pathEntries,
						customInstructions: undefined,
						reason,
						willRetry,
						signal,
					},
					signal,
				)) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					cancelledByExtension = true;
					throw new Error("Compaction cancelled");
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}
			signal.throwIfAborted();

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Shared default summary generator, also used by manual compaction.
				const compactResult = await this.#runDefaultCompaction(
					preparation,
					requestModel,
					apiKey,
					headers,
					undefined,
					signal,
					env,
					reason,
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}

			signal.throwIfAborted();

			const compactionId = this.sessionManager.appendCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				usage,
			);
			this._refreshFinalizedContext();
			const estimatedTokensAfter = estimateMessagesTokens(this.sessionManager.buildSessionProjection().messages);

			// Match the actual append by id: matching by summary would read every older summary from disk.
			const savedCompactionEntry = this.sessionManager.getEntry(compactionId) as CompactionEntry | undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._emitCompactionHook(
					{
						type: "session_compact",
						compactionEntry: savedCompactionEntry,
						fromExtension,
						reason,
						willRetry,
					},
					signal,
				);
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			clearTimeout(timeout);
			if (this._autoCompactionAbortController === controller) this._autoCompactionAbortController = undefined;
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) return true;

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const message = error instanceof Error ? error.message : "compaction failed";
			const aborted = cancelledByExtension || isCompactionCancelled(signal);
			const errorMessage = aborted
				? undefined
				: reason === "overflow"
					? `Context overflow recovery failed: ${message}`
					: `Auto-compaction failed: ${message}`;
			if (started || signal.aborted) {
				this._emit({ type: "compaction_end", reason, result: undefined, aborted, willRetry: false, errorMessage });
				await this._emitSessionCompactFailed(
					{ reason, errorMessage, aborted, willRetry: false, fromExtension },
					signal,
				);
			}
			return aborted ? "aborted" : "failed";
		} finally {
			clearTimeout(timeout);
			if (this._autoCompactionAbortController === controller) this._autoCompactionAbortController = undefined;
			this.#auditState("auto_compaction_settled");
			this._resolveIdleWaitIfIdle();
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async #requestOrdinaryWake(
		recheck: () => boolean,
		enroll?: OriginalAutomaticEnrollment,
	): Promise<"started" | "suppressed"> {
		const owner = this.#ordinaryOwner;
		if (!owner) return "suppressed";
		const ready = () => {
			try {
				owner.assertCompactionIdle();
			} catch {
				return false;
			}
			owner.assertSessionStart(this);
			if ((this._extensionMode === "tui" && !this.#pendingModeInput) || this.#pendingModeInput?.()) return false;
			owner.assertSessionStart(this);
			return (
				owner.canSubmitNative() &&
				this.#ordinaryPreflights === 0 &&
				this.isIdle &&
				!this.#originalAgent.state.isStreaming &&
				!this.isRetrying &&
				!this.isBashRunning &&
				!this.#originalAgent.hasQueuedMessages() &&
				this.pendingMessageCount === 0
			);
		};
		if (!ready() || !recheck() || !ready()) return "suppressed";
		if (!owner.spendAutomatic()) return "suppressed";
		const completion = this._runAgentPrompt([], undefined, enroll).catch((error: unknown) => {
			try {
				owner.stopAutomatic();
			} catch (cleanup) {
				error = new AggregateError([error, cleanup], "OWNER_AUTOMATIC_STOP_FAILED", { cause: error });
			}
			this._extensionRunner.emitError({
				extensionPath: "<ordinary-owner>",
				event: "sense_wake",
				error: error instanceof Error ? error.message : String(error),
			});
			if (enroll) throw error;
		});
		if (enroll) await completion;
		return "started";
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		this._shutdownCancellation.signal.throwIfAborted();
		this.#ordinaryOwner?.assertSessionStart(this);
		if (bindings.hasPendingInput !== undefined) this.#pendingModeInput = bindings.hasPendingInput;
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await raceWithAbortSignal(this._extensionRunner.emit(this._sessionStartEvent), this._shutdownCancellation.signal);
		await raceWithAbortSignal(
			this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup"),
			this._shutdownCancellation.signal,
		);
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		this._shutdownCancellation.signal.throwIfAborted();
		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._rebuildSystemPrompt(this.getActiveToolNames());
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				submitUserMessage: (request) => this.submitUserMessage(request),
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getUserMessageSessionGeneration: () => this.userMessageSessionGeneration,
				getModel: () => this.model,
				getScopedModels: () => this._scopedModels,
				isIdle: () => this.isIdle,
				isSettling: () => this.isSettling,
				isPromptPending: () => this.isPromptPending,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const isAllowedTool = (name: string): boolean =>
			(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this.#ordinaryOwner
			? createOrdinaryToolDefinitions(this.#ordinaryOwner, autoResizeImages)
			: this._baseToolsOverride
				? Object.fromEntries(
						Object.entries(this._baseToolsOverride).map(([name, tool]) => [
							name,
							createToolDefinitionFromAgentTool(tool),
						]),
					)
				: createAllToolDefinitions(this._cwd, {
						read: { autoResizeImages },
						bash: { commandPrefix: shellCommandPrefix, shellPath },
					});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
			this._shutdownCancellation.signal,
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		if (this.#ordinaryOwner) throw new Error("OWNER_FRESH_ALLOCATION_REQUIRED: reload requires separate receiving");
		let suspended = false;
		try {
			this.beginUserMessageSessionReplacement();
			suspended = true;
			this._userMessageIngress.setRuntimeAvailable(false);
			const oldRunner = this._extensionRunner;
			const previousFlagValues = oldRunner.getFlagValues();
			await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
			oldRunner.invalidate();
			await this.settingsManager.reload();
			this.syncQueueModesFromSettings();
			resetApiProviders();
			await this._resourceLoader.reload();
			this._shutdownCancellation.signal.throwIfAborted();
			this._userMessageIngress.assertOpen();
			// A concurrent reload may have installed a runner while this loader was awaiting.
			this._extensionRunner.invalidate();
			this._buildRuntime({
				activeToolNames: this.getActiveToolNames(),
				flagValues: previousFlagValues,
				includeAllExtensionTools: true,
			});

			// Preserve admission from session_start, but release only this reload's suspension.
			this._userMessageIngress.setRuntimeAvailable(true);
			this.endUserMessageSessionReplacement();
			suspended = false;
			const hasBindings =
				this._extensionUIContext ||
				this._extensionCommandContextActions ||
				this._extensionShutdownHandler ||
				this._extensionErrorListener;
			if (hasBindings) {
				await options?.beforeSessionStart?.();
				await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
				await this.extendResourcesFromExtensions("reload");
			}
		} catch (error) {
			// A retry may recover, but neither the old nor a partially bound runtime can admit input.
			this._userMessageIngress.setRuntimeAvailable(false);
			this._userMessageIngress.invalidate("session_changed");
			this._extensionRunner.invalidate();
			this._cancelIngressQueuedMessages();
			throw error;
		} finally {
			if (suspended) this.endUserMessageSessionReplacement();
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Never restart a request once output or a tool call has been streamed.
		if (this._assistantOutputObserved) return false;
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * Retry notifications shared by compaction and branch summaries. Their policies
	 * are separate: compaction has an operation-wide retry allowance, while branch
	 * summaries retain settings.retry. `source` selects the TUI indicator.
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		let retrying = false;
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				retrying = true;
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				if (!retrying) return;
				retrying = false;
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	private _finishCancelledRetry(): void {
		if (this._retryAttempt === 0 && !this._retryFallbackInFlight) return;
		const attempt = this._retryAttempt;
		this._retryAttempt = 0;
		this._retryFallbackInFlight = false;
		this._emit({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: "Retry cancelled",
		});
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this._getRetrySettings(message);
		if (!settings.enabled || this._retryFallbackInFlight) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			try {
				return await this._prepareRetryFallback(message);
			} catch (error) {
				this._emit({
					type: "auto_retry_end",
					success: false,
					attempt: this._retryAttempt,
					finalError: error instanceof Error ? error.message : String(error),
				});
				this._retryAttempt = 0;
				throw error;
			}
		}

		return this._waitAndRetry(message, retryDelayMs(settings, this._retryAttempt), settings.maxRetries);
	}

	private _getRetrySettings(message: AssistantMessage): RetryPolicy {
		const settings = this.settingsManager.getRetrySettings();
		// A dropped stream gets at most two retries, even with a larger ordinary retry budget.
		return isPrematureStreamError(message) ? { ...settings, maxRetries: Math.min(2, settings.maxRetries) } : settings;
	}

	private _getRetryFallbackModel(): Model<string> | undefined {
		const reference = this.settingsManager.getRetryFallbackModel();
		// Sealed owner runtimes authorize one provider identity; alternates require fresh receiving.
		if (!reference || this._retryFallbackUsed || this.#ordinaryOwner) return undefined;
		const slash = reference.indexOf("/");
		if (slash <= 0) return undefined;
		const model = this._modelRuntime.getModel(reference.slice(0, slash), reference.slice(slash + 1));
		if (!model || modelsAreEqual(model, this.model) || !this._modelRuntime.hasConfiguredAuth(model.provider))
			return undefined;
		return model;
	}

	private async _prepareRetryFallback(message: AssistantMessage): Promise<boolean> {
		if (this.#ordinaryOwner && this.settingsManager.getRetryFallbackModel()) {
			throw new Error(
				"Retry fallback refused: owned runtime pins provider identity; a fresh owner allocation is required.",
			);
		}
		const model = this._getRetryFallbackModel();
		const previousModel = this.model;
		if (!model || !previousModel || this._agentRunAbortRequested) return false;
		const event = {
			type: "auto_retry_fallback",
			fromModel: `${previousModel.provider}/${previousModel.id}`,
			toModel: `${model.provider}/${model.id}`,
			attempt: this._retryAttempt,
			errorMessage: message.errorMessage || "Unknown error",
		} as const;
		// Reuse context admission and thinking-level clamping, but do not change global defaults
		// or drain queued input during this post-run recovery. Oversized targets are refused.
		await this._compactForModelSwitch(model, () => {
			if (this._agentRunAbortRequested) return;
			this._omitRecoveryAttempt(message);
			this.agent.state.model = model;
			this.sessionManager.appendModelChange(model.provider, model.id);
			this.setThinkingLevel(this._getThinkingLevelForModelSwitch(model));
			this._retryFallbackUsed = true;
			this._retryFallbackInFlight = true;
			const entryId = this.sessionManager.appendCustomEntry(event.type, event);
			const entry = this.sessionManager.getEntry(entryId);
			if (entry) this._emit({ type: "entry_appended", entry });
			this._emit(event);
		});
		if (!this._retryFallbackUsed) return false;
		await this._emitModelSelect(model, previousModel, "set");
		// Retain the count for this episode's terminal notice, not as a later-request retry bound.
		return !this._agentRunAbortRequested;
	}

	/**
	 * Announce the retry, omit the failed attempt from model context and wait (abortable).
	 * @returns true if the caller should continue the agent, false if the wait was cancelled
	 */
	private async _waitAndRetry(
		message: AssistantMessage,
		delayMs: number,
		maxAttempts: number,
		waitMessage?: string,
	): Promise<boolean> {
		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
			...(waitMessage !== undefined ? { waitMessage } : {}),
		});

		// Keep the failed attempt in raw history while durably omitting it from model projection.
		this._omitRecoveryAttempt(message);

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		this.#auditState("retry_wait_start", this._retryAttempt);
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			this._finishCancelledRetry();
			return false;
		} finally {
			this._retryAbortController = undefined;
			this.#auditState("retry_wait_settled", this._retryAttempt);
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.id Optional identifier included in bash execution update events
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: {
			excludeFromContext?: boolean;
			id?: string;
			operations?: BashOperations;
			/** @internal Revalidate the host command lifetime before persisting an async result. */
			beforeRecord?: () => void;
		},
	): Promise<BashResult> {
		if (this.#ordinaryOwner) throw new Error("OWNER_PROCESS_SCOPE_REQUIRED");
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						onChunk?.(delta);
						this._emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					signal: abortController.signal,
				},
			);

			options?.beforeRecord?.();
			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			this.sessionManager.appendMessage(bashMessage);
			this._refreshFinalizedContext();
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of [...this._bashAbortControllers]) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			this.sessionManager.appendMessage(bashMessage);
		}
		this._pendingBashMessages = [];
		this._refreshFinalizedContext();
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this.#ordinaryOwner) throw new Error("OWNER_FRESH_ALLOCATION_REQUIRED: tree requires separate receiving");
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}
		if (this.isCompacting) {
			throw new Error(
				"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
			);
		}

		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();
		const navigationSignal = AbortSignal.any([
			this._branchSummaryAbortController.signal,
			this._shutdownCancellation.signal,
		]);

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit(
					{
						type: "session_before_tree",
						preparation,
						signal: navigationSignal,
					},
					navigationSignal,
				)) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model: requestModel,
					apiKey,
					headers,
					env,
					signal: navigationSignal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFunction,
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Cancellation can release a held hook without authorizing its branch or label changes.
			navigationSignal.throwIfAborted();

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update finalized context from the canonical session projection.
			this._refreshFinalizedContext();
			this._restoreToolsFromTranscript();

			// Navigation is already committed. Cancel its observer without claiming rollback.
			try {
				await this._extensionRunner.emit(
					{
						type: "session_tree",
						newLeafId: this.sessionManager.getLeafId(),
						oldLeafId,
						summaryEntry,
						fromExtension: summaryText ? fromExtension : undefined,
					},
					navigationSignal,
				);
			} catch (cause) {
				if (!navigationSignal.aborted || cause !== navigationSignal.reason) throw cause;
			}

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} catch (cause) {
			if (navigationSignal.aborted && cause === navigationSignal.reason) {
				return { cancelled: true, aborted: true };
			}
			throw cause;
		} finally {
			this._branchSummaryAbortController = undefined;
			this._resolveIdleWaitIfIdle();
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();

		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) {
					addUsageToTotals(usageTotals, message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// The footer calls this on every frame, and the computation walks the whole session.
		// The result depends only on the session state and the context window.
		const revision = this.sessionManager.revision();
		const cached = this.#contextUsageCache;
		if (cached?.revision === revision && cached.contextWindow === contextWindow) return { ...cached.usage };
		const usage = this.#computeContextUsage(contextWindow);
		this.#contextUsageCache = { revision, contextWindow, usage };
		return { ...usage };
	}

	#computeContextUsage(contextWindow: number): ContextUsage {
		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const projection = this.sessionManager.buildSessionProjection();
		const branch = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branch);

		if (latestCompaction) {
			const projectedAssistants = new Set(
				projection.entries.flatMap((entry) =>
					entry.messages.some(
						(message) =>
							message.role === "assistant" &&
							message.stopReason !== "aborted" &&
							message.stopReason !== "error" &&
							calculateContextTokens(message.usage) > 0,
					)
						? [entry.sourceEntry.id]
						: [],
				),
			);
			const compactionIndex = branch.findIndex((entry) => entry.id === latestCompaction.id);
			const hasPostCompactionUsage = branch
				.slice(compactionIndex + 1)
				.some((entry) => projectedAssistants.has(entry.id));
			if (!hasPostCompactionUsage) return { tokens: null, contextWindow, percent: null };
		}

		const estimate = estimateProjectedContextTokens(projection, branch);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @param options Optional export presentation settings
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string, options: { themeName?: string } = {}): Promise<string> {
		if (this.#ordinaryOwner) throw new Error("OWNER_EXPORT_SCOPE_REQUIRED");
		const themeName = [options.themeName, this.settingsManager.getTheme()].find(
			(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
		);

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		if (this.#ordinaryOwner) throw new Error("OWNER_EXPORT_SCOPE_REQUIRED");
		return exportSessionToJsonl(this.sessionManager, outputPath);
	}

	/**
	 * Ask the current model to describe what went wrong in this session for a bug report.
	 * Used when the user declines to share the transcript itself.
	 */
	async summarizeForBugReport(options: { hint?: string; signal: AbortSignal }): Promise<string> {
		const model = this.model;
		if (!model) {
			throw new Error("No model selected");
		}
		const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
		return generateBugReportSummary({
			messages: this.messages,
			hint: options.hint,
			model: requestModel,
			apiKey,
			headers,
			env,
			signal: options.signal,
			thinkingLevel: this.thinkingLevel,
			streamFn: this.agent.streamFunction,
			retry: this.settingsManager.getRetrySettings(),
			sessionId: this.sessionId,
		});
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
