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
import { createHash } from "node:crypto";
import fs, { readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { basename, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	Agent,
	type AgentContext,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type AgentToolCall,
	type AgentToolCallOutcome,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	type PrepareNextTurnContext,
	runToolCall,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	contentText,
	createAssistantStreamObservation,
	discardPartialReasoning,
	getCurrentSystemMessage,
	hasAssistantOutput,
	isPrematureStreamError,
	isRetryableCodexStreamDisconnect,
	observeAssistantMessage,
	observeAssistantStreamEvent,
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
	type ExecuteToolOptions,
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
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolExposure,
	type ToolInfo,
	type ToolLoadout,
	type TreePreparation,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { type BeforeAgentStartTrigger, emitSessionShutdownEvent } from "./extensions/runner.ts";
import { HOST_CAPABILITIES } from "./host-capabilities.ts";
import { InputAdmissionError } from "./input-admission.ts";
import { createToolNameMatcher, isMcpToolName } from "./mcp-servers.ts";
import { type BashExecutionMessage, type CustomMessage, convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { NestedToolCallRunner } from "./nested-tool-calls.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import { bindReceivedInputSession, getInputReceipt, type ReceivedInput, receiveInput } from "./received-input.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { exportSessionToJsonl } from "./session-export.ts";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	type ContextEditEntry,
	freezeDetached,
	getLatestCompactionEntry,
	type SessionEntry,
	SessionManager,
	type SessionProjection,
} from "./session-manager.ts";
import { appendReceivedCustomMessage, appendReceivedMessage } from "./session-turn-appender.ts";
import {
	applyToolModifiers,
	type CacheWarmingMode,
	DEFAULT_TOOL_NAMES,
	type SettingsManager,
} from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { BUILTIN_PATH_PREFIX, createSyntheticSourceInfo, isSyntheticPath, type SourceInfo } from "./source-info.ts";
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
import {
	captureTerminalTurnReceipt,
	receiptRecord,
	restoreTerminalTurnReceipt,
	type TurnReceipt,
	withoutAttribution,
} from "./turn-receipts.ts";
import {
	getUnsentInputTransfer,
	linkUnsentInputTransfer,
	readUnsentInput,
	UNSENT_INPUT_TYPE,
	type UnsentInput,
} from "./unsent-input.ts";
import { addUsageToTotals, combineUsage, createUsageTotals } from "./usage-totals.ts";
import {
	bindExtensionMetadataSender,
	getUserMessageMetadataSource,
	type SendUserMessageOptions,
	type SendUserMessageResult,
	snapshotUserMessageMetadata,
	type UserMessageMetadata,
	type UserMessageMetadataSource,
} from "./user-message-metadata.ts";
import {
	findLatestResponse,
	getBranchSelection,
	getVirtualModelState,
	isVirtualModel,
	VIRTUAL_MODEL_STATE_ENTRY,
	type VirtualModelStateData,
} from "./virtual-models.ts";

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

/** Tool execution events of calls a tool made through `ctx.executeTool()` carry `parentToolCallId`. */
type WithParentToolCallId<E> = E extends {
	type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
}
	? E & { parentToolCallId?: string }
	: E;

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| WithParentToolCallId<Exclude<AgentEvent, { type: "agent_end" }>>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled"; outcome: AgentActivityOutcome; aborted: boolean }
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
			/** Set for the bounded, one-shot wait on a throttled provider limit. */
			waitMessage?: string;
	  }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
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

/** User content as blocks, so string and text-block representations compare equally. */
function userContentBlocks(content: string | readonly (TextContent | ImageContent)[]): unknown {
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/** Check and persist the same frozen plain-data copy; no live getters survive the boundary. */
function detachedMessage(message: AgentMessage): AgentMessage {
	return freezeDetached(JSON.parse(JSON.stringify(message)) as AgentMessage);
}

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
	/**
	 * Whether the initial tools come from the `defaultTools` setting. When true, a resumed session
	 * replaces them with the loadout its transcript records, with `defaultToolModifiers` applied, and
	 * reload activates tools newly added to the setting. Tools removed from it stay active.
	 */
	usesDefaultTools?: boolean;
	/**
	 * `+name`/`-name` entries applied on top of the `defaultTools` setting, from `--tools`. Reload
	 * applies them to the reloaded setting too, so a removed tool stays removed.
	 */
	defaultToolModifiers?: string[];
	/**
	 * Optional allowlist of tool names or patterns (`*` matches any characters). When provided, only
	 * matching tools are exposed. A non-empty list without `mcp__` entries also keeps MCP tools
	 * registered for codemode and tool_search; only tool_search can declare them. An empty list
	 * exposes no tools.
	 */
	allowedToolNames?: string[];
	/** Optional denylist of tool names or patterns. When provided, matching tools are not exposed. */
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
	/** Submitted mode input still awaiting native handoff. Snapshot without consuming. */
	getPendingInputs?: () => ReadonlyArray<{ input: ReceivedInput; mode: "steer" | "followUp" }>;
	/** Called only after the complete operator-exit snapshot has been saved. */
	clearPendingInputs?: () => void;
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export type QueuedInputDisposition = "handled" | "queued";
export type PromptDisposition = QueuedInputDisposition | "started";

/** Operator exit refused before writing or clearing input the outbox reader cannot replay. */
export class UnsupportedUnsentInputError extends InputAdmissionError {
	readonly role: AgentMessage["role"];
	readonly mode: UnsentInput["mode"];

	constructor(role: AgentMessage["role"], mode: UnsentInput["mode"]) {
		super(
			"INPUT_ADMISSION_BUSY",
			`queued ${role} message (${mode}) cannot be saved for replay; input was not discarded`,
		);
		this.name = "UnsupportedUnsentInputError";
		this.role = role;
		this.mode = mode;
	}
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
	/** Internal RPC hook: accepted prompt disposition; not called when preflight rejects. */
	preflightResult?: (disposition: PromptDisposition) => void;
	/** Internal TUI handoff: input was consumed, queued, or handed to the original agent. */
	onInputTransferred?: () => void;
}

/** Options for model/thinking mutations. */
export interface ModelMutationOptions {
	/** Persist the new value to global defaults. Defaults to session-only. */
	persist?: boolean;
	/** Caller cancellation; checked after auth and before commit. */
	signal?: AbortSignal;
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

const COMPACTION_TIMEOUT_MS = 20 * 60_000;
const COMPACTION_RETRY_POLICY: RetryPolicy = { enabled: true, maxRetries: 1, baseDelayMs: 2000 };
type CompactionOutcome = boolean | "failed" | "aborted";

interface UserMessageSubmission {
	readonly metadata: UserMessageMetadata;
	readonly metadataSource: UserMessageMetadataSource;
	message?: AgentMessage;
	resolve(result: SendUserMessageResult): void;
	reject(error: unknown): void;
}

interface QueuedUserMessageDisplay {
	readonly message: AgentMessage;
	readonly text: string;
	occurrenceId?: number;
}

interface InputFenceScope {
	fence: object;
	active: boolean;
}

interface InputAdmission {
	/** Recoverable content until actual queue/run transfer or handling. */
	input?: UnsentInput;
	receipt?: TurnReceipt;
	controller: AbortController;
	signal: AbortSignal;
	parent: AbortSignal | undefined;
	fenceScope: InputFenceScope | undefined;
	release(): void;
}

function startCompactionDeadline(controller: AbortController): ReturnType<typeof setTimeout> {
	return setTimeout(() => {
		controller.abort(new DOMException("Compaction exceeded its 20-minute deadline", "TimeoutError"));
	}, COMPACTION_TIMEOUT_MS);
}

function isCompactionCancelled(signal: AbortSignal): boolean {
	return signal.aborted && !(signal.reason instanceof DOMException && signal.reason.name === "TimeoutError");
}

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly #originalAgent: Agent;
	readonly sessionManager: SessionManager;
	#contextUsageCache: { revision: number; contextWindow: number; usage: ContextUsage } | undefined;
	readonly settingsManager: SettingsManager;
	#pendingModeInput?: () => boolean;
	#getPendingModeInputs?: ExtensionBindings["getPendingInputs"];
	#clearPendingModeInputs?: () => void;
	private readonly _unpersistedInputs = new Map<AgentMessage, UnsentInput>();
	private readonly _preparedInputReceipts = new WeakMap<AgentMessage, TurnReceipt>();
	private readonly _sessionQueueTransfers = new WeakSet<AgentMessage>();
	/** Native occurrences remain recoverable until durable message_end publication. */
	private readonly _nativeQueuedInputs = new Map<
		number,
		{
			input: UnsentInput;
			receipt?: TurnReceipt;
			attested?: unknown;
			submission?: UserMessageSubmission;
			order: number;
		}
	>();
	private readonly _unpersistedInputOrder = new WeakMap<AgentMessage, number>();
	private _nextInputOrder = 0;
	private readonly _persistedInputReceipts = new WeakSet<TurnReceipt>();
	/** A downgrade changes attribution, not the mode-to-session handoff occurrence. */
	private readonly _inputReceiptSources = new WeakMap<TurnReceipt, TurnReceipt>();
	private readonly _replayedInputs = new WeakMap<AgentMessage, UnsentInput>();
	/** Keep successful prefix saves idempotent if a later append fails, including raw inputs without receipts. */
	private readonly _savedUnsentInputIds = new Map<object | number, string>();
	private _hasResumedInputs = false;
	private readonly _unsentInputDrafts: AgentMessage[] = [];
	private _queuedInputRevision = 0;
	private _queueDrainError?: UnsupportedUnsentInputError;
	private _operatorExitPrepared = false;
	readonly capabilities = HOST_CAPABILITIES;
	private readonly _inputAdmissions = new Set<InputAdmission>();
	private readonly _inputAdmissionScope = new AsyncLocalStorage<InputAdmission>();
	private readonly _dispatchCancellationScope = new AsyncLocalStorage<AbortSignal | undefined>();
	private _inputFence: object | undefined;
	private readonly _inputFenceScope = new AsyncLocalStorage<InputFenceScope | undefined>();
	private readonly _shutdownCancellation = new AbortController();
	private readonly _disposalCancellation = new AbortController();
	private _settlementCancellation = new AbortController();
	private _settlementCompletion?: Promise<void>;
	private _inputsDisposed = false;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private readonly _promptPreflights = new Set<object>();
	private _inputQueuedBehindPreflight = false;
	private readonly _triggeredBehindPreflight: Array<{ message: CustomMessage; deliverAs?: "steer" | "followUp" }> = [];
	private _agentRunAbortRequested = false;
	private _inputPublicationFailed = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: QueuedUserMessageDisplay[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: QueuedUserMessageDisplay[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Context-only custom messages queued during a run, flushed once the current turn's tool results are in. */
	private _pendingCustomMessages: CustomMessage[] = [];
	readonly #receivedMessageReceipts = new WeakMap<AgentMessage, TurnReceipt>();
	readonly #attestedUserContent = new WeakMap<AgentMessage, unknown>();
	private readonly _userMessageSubmissions = new WeakMap<AgentMessage, UserMessageSubmission>();
	private readonly _pendingUserMessageSubmissions = new Set<UserMessageSubmission>();

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	/** Public completion callbacks still belong to the encompassing compaction turn. */
	private _completingCompaction?: AbortController;
	private _overflowRecoveryAttempted = false;
	private _stopAfterCompactionFailure = false;
	private _compactionStopOutcome: AgentActivityOutcome | undefined;
	private _modelSwitchCompactionPending = false;
	private _modelSwitchAdmissionWait: Promise<void> = Promise.resolve();
	private _resolveModelSwitchAdmissionWait: (() => void) | undefined;
	private readonly _modelSwitchDispatches = new Map<CustomMessage, { deliverAs?: "steer" | "followUp" }>();
	private readonly _compactionHookScope = new AsyncLocalStorage<boolean>();
	private readonly _compactionHooks = new Set<AbortController>();

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	private _codexStreamDisconnectRetryUsed = false;
	private _assistantToolExecutionStarted = false;
	private _assistantOutputObserved = false;
	private _assistantStreamObserved = createAssistantStreamObservation();
	private _heldReasoningUpdates: AgentEvent[] = [];
	private _throttleWaitUsed = false;
	/**
	 * Failed response that the next request repeats, set by auto-retry and overflow recovery. The
	 * retry is routed with it as `failed`, since the context no longer contains it.
	 */
	private _failedResponse: AssistantMessage | undefined;

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
	private readonly _agentSettledScope = new AsyncLocalStorage<{ active: boolean }>();
	private readonly _deferredSettledActions: Array<() => Promise<void>> = [];
	private readonly _settlementActionScope = new AsyncLocalStorage<{ active: boolean }>();

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	/**
	 * Tools of the restored or reloaded loadout that are not registered yet, such as tools of MCP
	 * servers that are still connecting. They are activated when they are registered, and dropped when
	 * `setActiveToolsByName()` deactivates a tool or the next agent run starts.
	 */
	private _pendingToolNames = new Set<string>();
	private _usesDefaultTools: boolean;
	private _defaultToolModifiers: string[];
	/** Matches the `--tools` entries: tool names or patterns. */
	private _allowedTools?: (name: string) => boolean;
	/**
	 * Whether the allowlist filters MCP tools: it is empty (`--no-tools`) or names an MCP tool
	 * (`mcp__*`). Otherwise it keeps MCP tools registered for codemode and tool_search.
	 */
	private _allowlistFiltersMcp = false;
	private _excludedTools?: (name: string) => boolean;
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
	/** Created on the first `ctx.executeTool()` call. */
	private _nestedToolCalls: NestedToolCallRunner | undefined;
	private readonly _nestedToolParents = new WeakMap<AgentToolCall, string>();
	/** Declared tools whose declarations requests leave out, from `prepareLoadout` hooks. */
	private _hiddenDeclarations: ReadonlySet<string> = new Set();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	private _baseSystemPromptOptions!: NormalizedBuildSystemPromptOptions;
	/** Prompt options after before_agent_start mutations for the active run. */
	private _runSystemPromptOptions?: NormalizedBuildSystemPromptOptions;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.#originalAgent = this.agent;
		this.sessionManager = config.sessionManager;
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
		this._usesDefaultTools = config.usesDefaultTools ?? false;
		this._defaultToolModifiers = config.defaultToolModifiers ?? [];
		if (config.allowedToolNames) {
			this._allowedTools = createToolNameMatcher(config.allowedToolNames);
			this._allowlistFiltersMcp =
				config.allowedToolNames.length === 0 || config.allowedToolNames.some((entry) => entry.startsWith("mcp__"));
		}
		this._excludedTools = config.excludedToolNames ? createToolNameMatcher(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		bindReceivedInputSession(this, {
			prompt: (input, options) => this._promptReceived(input, options),
			steer: (input, source) =>
				this._queueUserInput(input.text, input.images, "steer", source ?? "interactive", getInputReceipt(input)),
			followUp: (input, source) =>
				this._queueUserInput(input.text, input.images, "followUp", source ?? "interactive", getInputReceipt(input)),
		});

		for (const { id, message, mode } of this.agent.getQueuedMessageOccurrences()) {
			if (message.role === "user" || message.role === "custom")
				this._nativeQueuedInputs.set(id, { input: { message, mode }, order: ++this._nextInputOrder });
		}

		// Raw SDK queues bypass admission/display bookkeeping. Capture each native insertion
		// before its callback can reenter quit or throw; a prepared alias is a separate occurrence.
		for (const method of [
			"steer",
			"followUp",
			"clearSteeringQueue",
			"clearFollowUpQueue",
			"removeQueuedMessages",
		] as const) {
			const original = this.agent[method].bind(this.agent);
			Object.defineProperty(this.agent, method, {
				configurable: true,
				writable: true,
				value: (...args: unknown[]) => {
					this._queuedInputRevision++;
					if (method === "steer" || method === "followUp") {
						const message = args[0] as AgentMessage;
						const onEnqueued = args[1] as ((id: number) => void) | undefined;
						const transfer = this._sessionQueueTransfers.delete(message);
						args[1] = (id: number) => {
							const input = transfer ? this._unpersistedInputs.get(message) : undefined;
							const submission = input ? this._userMessageSubmissions.get(message) : undefined;
							if (message.role === "user" || message.role === "custom")
								this._nativeQueuedInputs.set(id, {
									input: input
										? {
												...input,
												...(submission
													? { metadata: submission.metadata, metadataSource: submission.metadataSource }
													: {}),
											}
										: { message, mode: method },
									receipt: input ? this._preparedInputReceipts.get(message) : undefined,
									attested: input ? this.#attestedUserContent.get(message) : undefined,
									submission,
									order:
										(input ? this._unpersistedInputOrder.get(message) : undefined) ?? ++this._nextInputOrder,
								});
							if (input) {
								this._unpersistedInputs.delete(message);
								this._unpersistedInputOrder.delete(message);
							}
							onEnqueued?.(id);
						};
					} else if (method === "removeQueuedMessages") {
						const predicate = args[0] as (message: AgentMessage, occurrenceId: number) => boolean;
						args[0] = (message: AgentMessage, occurrenceId: number) => {
							const remove = predicate(message, occurrenceId);
							if (remove) this._nativeQueuedInputs.delete(occurrenceId);
							return remove;
						};
					} else {
						const mode = method === "clearSteeringQueue" ? "steer" : "followUp";
						for (const entry of this.agent.getQueuedMessageOccurrences()) {
							if (entry.mode === mode) this._nativeQueuedInputs.delete(entry.id);
						}
					}
					return Reflect.apply(original, this.agent, args);
				},
			});
		}

		const previousValidateQueuedMessages = this.agent.validateQueuedMessages;
		this.agent.validateQueuedMessages = (messages, mode) => {
			if (this._inputsDisposed) {
				previousValidateQueuedMessages?.(messages, mode);
				return;
			}
			// Raw Agent listeners run before session observation and can throw after native dequeue.
			// Refuse an unreplayable batch before reservation, not in a message_start listener.
			for (const message of messages) {
				if (!readUnsentInput({ message, mode })) {
					const error = new UnsupportedUnsentInputError(message.role, mode);
					this._queueDrainError = error;
					throw error;
				}
			}
			previousValidateQueuedMessages?.(messages, mode);
		};

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();
		this._installAgentBoundaryHooks();
		this._installHiddenDeclarationsProjection();
		this._installAgentForcedPromptProjection();
		this._installAgentRequestProjection();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		if (this._usesDefaultTools) this._restoreToolsFromTranscript(this._defaultToolModifiers);
		this._restoreUnsentInputs();
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
		selectedModel: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
		thinkingLevel: ThinkingLevel;
	}> {
		// Route a virtual model first: summaries size their input and output from the model they get.
		const { model, thinkingLevel } = isVirtualModel(selectedModel)
			? await this._modelRuntime.resolveModel(selectedModel, convertToLlm(this.messages), {
					reason: "direct",
					thinkingLevel: this.thinkingLevel,
					signal,
				})
			: { model: selectedModel, thinkingLevel: this.thinkingLevel };
		if (this.agent.streamFunction === streamSimple) {
			return { ...(await this._getRequiredRequestAuth(model, signal)), thinkingLevel };
		}

		try {
			const result = await this._modelRuntime.getAuth(model, { signal });
			if (!result) return { model, thinkingLevel };
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
				thinkingLevel,
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			return { model, thinkingLevel };
		}
	}

	/**
	 * The model whose limits apply to `message`, or undefined when the message came from another
	 * model. Under a virtual selection, that is the physical model that produced it.
	 */
	private _modelForMessage(message: AssistantMessage): Model<any> | undefined {
		const model = this.model;
		if (model && isVirtualModel(model)) return this._modelRuntime.getPhysicalModel(message.provider, message.model);
		return model?.provider === message.provider && model.id === message.model ? model : undefined;
	}

	/**
	 * Record the selection on the current branch when the branch implies another one, so a resume
	 * restores it. Tree navigation can leave the latest `model_change` on another branch; responses
	 * cannot record a virtual selection because they name physical models. Responses do record a
	 * physical selection unless the branch holds a virtual one; checking a physical selection against
	 * responses would record it on every prompt while `prepareRequest` redirects to another model.
	 */
	private _recordSelection(): void {
		const model = this.model;
		if (!model) return;
		const getModel = (provider: string, modelId: string) => this._modelRuntime.getModel(provider, modelId);
		const recorded = getBranchSelection(this.sessionManager.getBranch(), getModel);
		if (!recorded || (recorded.provider === model.provider && recorded.modelId === model.id)) return;
		const recordedModel = getModel(recorded.provider, recorded.modelId);
		if (!isVirtualModel(model) && !(recordedModel && isVirtualModel(recordedModel))) return;
		this.sessionManager.appendModelChange(model.provider, model.id);
	}

	/** The model whose limits apply to the conversation. */
	private _limitsModel(): Model<any> | undefined {
		return this.routedModel?.model ?? this.model;
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
		this.agent.beforeToolCall = (context) =>
			this._beforeToolCall(context, this._nestedToolParents.get(context.toolCall));
		this.agent.afterToolCall = (context) =>
			this._afterToolCall(context, this._nestedToolParents.get(context.toolCall));
		this.agent.transformToolUpdate = async (toolCall, args, partialResult, signal) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_partial_result")) return undefined;
			const parentToolCallId = this._nestedToolParents.get(toolCall);
			const result = await runner.emitToolPartialResult(
				{
					type: "tool_partial_result",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args,
					partialResult,
					...(parentToolCallId ? { parentToolCallId } : {}),
				},
				signal ? AbortSignal.any([signal, this._shutdownCancellation.signal]) : this._shutdownCancellation.signal,
			);
			return result.partialResult;
		};
	}

	/** `tool_call` handlers. `parentToolCallId` is set for calls another tool made. */
	private async _beforeToolCall(
		{ toolCall, args }: BeforeToolCallContext,
		parentToolCallId?: string,
	): Promise<BeforeToolCallResult | undefined> {
		const runner = this._extensionRunner;
		if (!runner.hasHandlers("tool_call")) {
			return undefined;
		}

		try {
			const shutdown = this._shutdownCancellation.signal;
			return await raceWithAbortSignal(
				runner.emitToolCall(
					{
						type: "tool_call",
						toolName: toolCall.name,
						toolCallId: toolCall.id,
						...(parentToolCallId ? { parentToolCallId } : {}),
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
	}

	/** `tool_result` handlers and image normalization. `parentToolCallId` is set for calls another tool made. */
	private async _afterToolCall(
		{ toolCall, args, result, isError }: AfterToolCallContext,
		parentToolCallId?: string,
	): Promise<AfterToolCallResult | undefined> {
		const runner = this._extensionRunner;
		const shutdown = this._shutdownCancellation.signal;
		const hookResult = runner.hasHandlers("tool_result")
			? await raceWithAbortSignal(
					runner.emitToolResult(
						{
							type: "tool_result",
							toolName: toolCall.name,
							toolCallId: toolCall.id,
							...(parentToolCallId ? { parentToolCallId } : {}),
							input: args as Record<string, unknown>,
							content: result.content,
							details: result.details,
							...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
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
		const resizeOptions = this._limitsModel()?.inputLimits?.images?.resize;
		const normalizedContent = await normalizeToolResultImages(content, {
			autoResizeImages: this.settingsManager.getImageAutoResize(),
			...(resizeOptions ? { resizeOptions } : {}),
		});

		if (!hookResult && normalizedContent === content) {
			return undefined;
		}

		// The hook result already dropped structured content that replaced content no longer matches.
		return {
			content: normalizedContent,
			details: hookResult?.details,
			structuredContent: hookResult ? hookResult.structuredContent : result.structuredContent,
			isError: hookResult?.isError ?? isError,
			usage: hookResult?.usage,
		};
	}

	/**
	 * Run a call that the tool call `parentToolCallId` made through `ctx.executeTool()`. It goes
	 * through the agent's tool pipeline with the session's hooks, against the callable tools.
	 */
	private async _executeNestedToolCall(
		parentToolCallId: string,
		name: string,
		args: unknown,
		options: ExecuteToolOptions,
	): Promise<AgentToolCallOutcome> {
		this._nestedToolCalls ??= new NestedToolCallRunner({
			getTools: () => this._getCallableTools(),
			isSequential: () => this.agent.toolExecution === "sequential",
			runToolCall: (toolCall, parentId, signal, onUpdate) => {
				const assistantMessage = this._findLastAssistantMessage();
				if (!assistantMessage) {
					return Promise.resolve({
						toolCall,
						result: { content: [{ type: "text", text: "No assistant message issued this call" }], details: {} },
						isError: true,
					});
				}
				this._nestedToolParents.set(toolCall, parentId);
				return runToolCall(toolCall, {
					tools: this._getCallableTools(),
					assistantMessage,
					context: { messages: this.agent.state.messages, tools: this.agent.state.tools },
					beforeToolCall: this.agent.beforeToolCall,
					afterToolCall: this.agent.afterToolCall,
					transformToolUpdate: this.agent.transformToolUpdate,
					signal,
					onUpdate,
				});
			},
			emit: async (event) => {
				await this._extensionRunner.emit(event);
				this._emit(event);
			},
		});
		return this._nestedToolCalls.execute(parentToolCallId, name, args, options);
	}

	/** Whether `projection`, the current session projection, exceeds the compaction threshold of `model`. */
	private _exceedsCompactionThreshold(model: Model<any>, projection: SessionProjection): boolean {
		if (model.contextWindow <= 0) return false;
		return shouldCompact(
			estimateProjectedContextTokens(projection, this.sessionManager.getBranch()).tokens,
			model.contextWindow,
			this.settingsManager.getCompactionSettings(this.model),
		);
	}

	private async _compactBeforeNextAssistantResponse(context: AgentContext): Promise<AgentContext> {
		const projection = this.sessionManager.buildSessionProjection();
		// A virtual selection is checked in prepareRequest, against the model the request is routed to.
		const model = this.model;
		if (!model || isVirtualModel(model) || !this._exceedsCompactionThreshold(model, projection)) {
			return { ...context, messages: projection.messages };
		}
		const overflow =
			estimateProjectedContextTokens(projection, this.sessionManager.getBranch()).tokens > model.contextWindow;
		const outcome = await this._runAutoCompaction("threshold", false);
		if (outcome === "failed" || outcome === "aborted") {
			this._stopAfterCompactionFailure = true;
			this._compactionStopOutcome = outcome === "aborted" ? "aborted" : "error";
			this.agent.abort();
			throw new Error(
				`${overflow ? "Context exceeds window: " : ""}Compaction ${outcome} before the next assistant turn`,
			);
		}
		return { ...context, messages: this.sessionManager.buildSessionProjection().messages };
	}

	private _installAgentRequestProjection(): void {
		let requestModel = this.agent.state.model;
		let canReproject = true;
		let canonicalMessagesDigest: string | undefined;
		const previousConvertToLlm = this.agent.convertToLlm;
		this.agent.convertToLlm = async (messages) => {
			let converted = await previousConvertToLlm(messages);
			try {
				assertContextFitsWindow(converted, requestModel);
			} catch (error) {
				if (
					!canReproject ||
					previousConvertToLlm !== convertToLlm ||
					canonicalMessagesDigest === undefined ||
					canonicalMessagesDigest !== snapshotMessages(messages) ||
					!this.settingsManager.getCompactionSettings(requestModel).enabled
				)
					throw error;
				const revision = this.sessionManager.revision();
				const outcome = await this._runAutoCompaction("overflow", false);
				if (outcome === "failed" || outcome === "aborted") {
					this._stopAfterCompactionFailure = true;
					this._compactionStopOutcome = outcome === "aborted" ? "aborted" : "error";
					this.agent.abort();
					throw new Error(`Context exceeds window: Compaction ${outcome} before the next assistant turn`);
				}
				if (this.sessionManager.revision() === revision) throw error;
				converted = convertToLlm(this.sessionManager.buildSessionProjection().messages);
				assertContextFitsWindow(converted, requestModel);
			}
			return converted;
		};
		const previousPrepareRequest = this.agent.prepareRequest;
		const snapshotMessages = (messages: AgentMessage[]): string | undefined => {
			try {
				const hash = createHash("sha256");
				for (const message of messages) {
					hash.update(JSON.stringify(message));
					hash.update("\0");
				}
				return hash.digest("base64");
			} catch {
				return undefined;
			}
		};
		this.agent.prepareRequest = async (request, signal) => {
			const failed = this._failedResponse;
			this._failedResponse = undefined;
			const prepare = async () => {
				const projection = this.sessionManager.buildSessionProjection();
				const canonicalContext = {
					...request.context,
					messages: projection.messages.map((message) => {
						if (!Object.isFrozen(message)) return message;
						try {
							return structuredClone(message);
						} catch {
							return message;
						}
					}),
					// Messages declare the provider-visible loadout; context.tools keeps executable implementations.
					tools: this.agent.state.tools.slice(),
				};
				canonicalMessagesDigest = snapshotMessages(canonicalContext.messages);
				const previous = await previousPrepareRequest?.(
					{
						...request,
						context: canonicalContext,
						model: this.agent.state.model,
						thinkingLevel: this.agent.state.thinkingLevel,
					},
					signal,
				);
				canReproject =
					(previous?.context === undefined || previous.context === canonicalContext) &&
					canonicalMessagesDigest !== undefined &&
					canonicalMessagesDigest === snapshotMessages(canonicalContext.messages);
				return { previous, context: previous?.context ?? canonicalContext, projection };
			};
			const prepared = await prepare();
			const { previous, projection } = prepared;
			let context = prepared.context;
			const model = previous?.model ?? this.agent.state.model;
			const thinkingLevel = previous?.thinkingLevel ?? this.agent.state.thinkingLevel;
			requestModel = model;
			if (!isVirtualModel(model)) return { ...previous, context, model, thinkingLevel };

			// The selection stays in agent state; only this request uses the routed model. A routing
			// failure rejects, which ends the run with an error response. Only messages the user wrote
			// start a turn; extension messages can follow them, e.g. from before_agent_start.
			const lastResponse = context.messages.findLastIndex((message) => message.role === "assistant");
			const userTurn = context.messages.slice(lastResponse + 1).some((message) => message.role === "user");
			const state = getVirtualModelState(this.sessionManager.getBranch(), model.provider, model.id);
			const route = await this._modelRuntime.resolveModel(model, convertToLlm(context.messages), {
				reason: failed ? "retry" : userTurn ? "user" : "continuation",
				thinkingLevel,
				signal,
				failed,
				state,
			});
			if (route.state !== undefined && route.state !== state) {
				const data: VirtualModelStateData = { provider: model.provider, modelId: model.id, state: route.state };
				const entry = this.sessionManager.getEntry(
					this.sessionManager.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, data),
				);
				if (entry) this._emit({ type: "entry_appended", entry });
			}
			// The route stands: the router already decided this request. The state entry does not change
			// the projection.
			if (this._exceedsCompactionThreshold(route.model, projection)) {
				const outcome = await this._runAutoCompaction("threshold", false);
				if (outcome === "failed" || outcome === "aborted") {
					this._stopAfterCompactionFailure = true;
					this._compactionStopOutcome = outcome === "aborted" ? "aborted" : "error";
					this.agent.abort();
					throw new Error(`Compaction ${outcome} before the routed assistant turn`);
				}
				if (canReproject) {
					const messages = this.sessionManager.buildSessionProjection().messages;
					canonicalMessagesDigest = snapshotMessages(messages);
					context = { ...context, messages };
				}
			}
			requestModel = route.model;
			return { ...previous, context, model: route.model, thinkingLevel: route.thinkingLevel };
		};
	}

	private async _dispatchTurnEndBoundary(
		message: AssistantMessage,
		toolResults: ToolResultMessage[],
	): Promise<boolean> {
		this._lastActivityOutcome =
			message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";
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
			if (this._shutdownCancellation.signal.aborted) return { action: "end" };
			const previousDecision = await previousFinishTurn?.(turn, signal);
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
			const context = await this._compactBeforeNextAssistantResponse(turn.context);
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
		let firstListenerError: { error: unknown } | undefined;
		for (const l of this._eventListeners) {
			try {
				l(event);
			} catch (error) {
				firstListenerError ??= { error };
			}
		}
		if (firstListenerError) throw firstListenerError.error;
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: this._steeringMessages.map((entry) => entry.text),
			followUp: this._followUpMessages.map((entry) => entry.text),
		});
	}

	private async _emitCompactionHook(
		event: SessionBeforeCompactEvent | SessionCompactEvent | SessionCompactFailedEvent,
		signal?: AbortSignal,
		beforeDispatch?: () => void,
	): Promise<SessionBeforeCompactResult | undefined> {
		const hook = new AbortController();
		const inherited = this._dispatchCancellationScope.getStore();
		const ancestry = AbortSignal.any(
			[signal, inherited, hook.signal].filter((item): item is AbortSignal => item !== undefined),
		);
		const dispatchSignal = signal?.aborted
			? AbortSignal.any([hook.signal, ...(inherited ? [inherited] : [])])
			: ancestry;
		this._compactionHooks.add(hook);
		let dispatched = false;
		try {
			beforeDispatch?.();
			const dispatch = this._compactionHookScope.run(true, () =>
				this._dispatchCancellationScope.run(ancestry, () => this._extensionRunner.emit(event, dispatchSignal)),
			);
			dispatched = true;
			void dispatch.then(
				() => this._compactionHooks.delete(hook),
				() => this._compactionHooks.delete(hook),
			);
			return await raceWithAbortSignal(dispatch, ancestry);
		} catch (error) {
			if (event.type === "session_compact_failed" && hook.signal.aborted && error === hook.signal.reason) return;
			throw error;
		} finally {
			if (!dispatched) this._compactionHooks.delete(hook);
		}
	}

	private async _emitSessionCompactFailed(
		event: Omit<SessionCompactFailedEvent, "type">,
		signal?: AbortSignal,
		preserveDistinctFailure = false,
		beforeNotification?: () => void,
	): Promise<void> {
		if (this._extensionRunner.hasHandlers("session_compact_failed")) {
			let notified = !beforeNotification;
			try {
				await this._emitCompactionHook({ type: "session_compact_failed", ...event }, signal, () => {
					beforeNotification?.();
					notified = true;
				});
			} catch (error) {
				if (!notified || !signal?.aborted || (preserveDistinctFailure && error !== signal.reason)) throw error;
			}
		} else beforeNotification?.();
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
		this._isEmittingAgentSettled = true;
		const scope = { active: true };
		const cancellation = this._settlementCancellation;
		const inheritedCancellation = this._dispatchCancellationScope.getStore();
		const signal = inheritedCancellation
			? AbortSignal.any([inheritedCancellation, cancellation.signal])
			: cancellation.signal;
		let completed!: () => void;
		this._settlementCompletion = new Promise<void>((resolve) => {
			completed = resolve;
		});
		const failures: unknown[] = [];
		const aborted = outcome === "aborted";
		try {
			try {
				await raceWithAbortSignal(
					this._dispatchCancellationScope.run(signal, () =>
						this._agentSettledScope.run(scope, () =>
							this._extensionRunner.emit({ type: "agent_settled", outcome, aborted }, signal),
						),
					),
					signal,
				);
			} catch (error) {
				if (!signal.aborted) throw error;
			}
			this._dispatchCancellationScope.run(signal, () =>
				this._agentSettledScope.run(scope, () => this._emit({ type: "agent_settled", outcome, aborted })),
			);
		} finally {
			scope.active = false;
			this._isEmittingAgentSettled = false;
			try {
				for (const action of this._deferredSettledActions.splice(0)) {
					const actionScope = { active: true };
					try {
						await this._settlementActionScope.run(actionScope, action);
					} catch (error) {
						if (!this._shutdownCancellation.signal.aborted) failures.push(error);
					} finally {
						actionScope.active = false;
					}
				}
			} finally {
				this._resolveIdleWaitIfIdle();
				completed();
			}
		}
		if (failures.length > 0) throw failures[0];
	}

	#attachUserMessageReceipt(message: AgentMessage, receipt: TurnReceipt): void {
		this.#receivedMessageReceipts.set(message, receipt);
		if (message.role === "user" && receiptRecord(receipt).channel === "keyboard") {
			this.#attestedUserContent.set(message, structuredClone(userContentBlocks(message.content)));
		} else this.#attestedUserContent.delete(message);
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (event.type === "message_start" || event.type === "message_end") {
			const id = this.agent.queuedMessageOccurrenceId;
			const queued = id === undefined ? undefined : this._nativeQueuedInputs.get(id);
			if (queued) {
				// The first harness observation belongs to this occurrence, never another raw alias.
				queued.receipt ??= captureTerminalTurnReceipt();
				const saved = id === undefined ? undefined : this._savedUnsentInputIds.get(id);
				if (saved) linkUnsentInputTransfer(queued.receipt, saved);
				this.#receivedMessageReceipts.set(event.message, queued.receipt);
			}
		}
		if (
			(event.type === "message_start" || event.type === "message_end") &&
			(event.message.role === "user" || event.message.role === "custom") &&
			!this.#receivedMessageReceipts.has(event.message)
		) {
			this.#receivedMessageReceipts.set(
				event.message,
				(this.agent.queuedMessageOccurrenceId === undefined
					? this._preparedInputReceipts.get(event.message)
					: undefined) ?? captureTerminalTurnReceipt(),
			);
		}
		if (event.type === "message_start" && (event.message.role === "user" || event.message.role === "custom"))
			this._queuedInputRevision++;
		if (event.type === "turn_start") {
			this._assistantOutputObserved = false;
			this._assistantStreamObserved = createAssistantStreamObservation();
			this._heldReasoningUpdates = [];
			this._assistantToolExecutionStarted = false;
		} else if (event.type === "tool_execution_start") this._assistantToolExecutionStarted = true;
		if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "assistant") {
			this._assistantOutputObserved ||= hasAssistantOutput(event.message);
			observeAssistantMessage(this._assistantStreamObserved, event.message);
		} else if (event.type === "message_update" && event.message.role === "assistant") {
			const update = event.assistantMessageEvent;
			const streamed =
				("delta" in update && update.delta.length > 0) || ("content" in update && update.content.length > 0);
			this._assistantOutputObserved ||=
				hasAssistantOutput(event.message) || update.type.startsWith("toolcall_") || streamed;
			observeAssistantStreamEvent(this._assistantStreamObserved, update);
			if (
				!this._assistantStreamObserved.answer &&
				(this._heldReasoningUpdates.length > 0 || update.type.startsWith("thinking_")) &&
				this._getRetrySettings(event.message).enabled
			) {
				this._heldReasoningUpdates.push(event);
				return;
			}
		}
		const held = this._heldReasoningUpdates.splice(0);
		if (
			event.type === "message_end" &&
			event.message.role === "assistant" &&
			event.message.stopReason === "error" &&
			this._willRetryAssistantMessage(event.message)
		) {
			this._replaceMessageInPlace(event.message, discardPartialReasoning(event.message));
		} else for (const update of held) await this._dispatchAgentEvent(update);
		// An abort requested while the run was starting, e.g. during before_agent_start, stops it
		// here. agent_start is awaited before the first request.
		if (event.type === "agent_start" && this._agentRunAbortRequested) this.agent.abort();
		// Record the calls a tool made through ctx.executeTool() and their usage on its result message.
		if (this._nestedToolCalls) {
			if (event.type === "message_start" && event.message.role === "toolResult") {
				const message = event.message;
				const summary = this._nestedToolCalls.takeRecord(message.toolCallId);
				if (summary?.calls) message.nestedCalls = summary.calls;
				if (summary?.usage) {
					message.usage = message.usage ? combineUsage(message.usage, summary.usage) : summary.usage;
				}
			} else if (event.type === "agent_end") {
				this._nestedToolCalls.clear();
			}
		}
		let removedDisplay:
			| { queue: QueuedUserMessageDisplay[]; index: number; entry: QueuedUserMessageDisplay }
			| undefined;
		try {
			// Preserve queue_update before message_start, but native custody lasts until message_end.
			if (event.type === "message_start" && event.message.role === "user") {
				this._overflowRecoveryAttempted = false;
				this._codexStreamDisconnectRetryUsed = false;
				const occurrenceId = this.agent.queuedMessageOccurrenceId;
				for (const queue of [this._steeringMessages, this._followUpMessages]) {
					const index = queue.findIndex(
						(entry) => occurrenceId !== undefined && entry.occurrenceId === occurrenceId,
					);
					if (index < 0) continue;
					const [entry] = queue.splice(index, 1);
					removedDisplay = { queue, index, entry };
					this._emitQueueUpdate();
					break;
				}
			}
			await this._dispatchAgentEvent(event);
		} catch (error) {
			if (removedDisplay) {
				const { queue, index, entry } = removedDisplay;
				// A clear replaces the display arrays; withdrawal removes native custody. Neither
				// may resurrect this occurrence, even if another input has identical text.
				if (
					(queue === this._steeringMessages || queue === this._followUpMessages) &&
					this.agent.getQueuedMessageOccurrences().some((item) => item.id === entry.occurrenceId)
				) {
					queue.splice(index, 0, entry);
					try {
						this._emitQueueUpdate();
					} catch {
						// Keep the original subscriber failure after restoring display state.
					}
				}
			}
			if (event.type === "message_start" || event.type === "message_end") {
				const id = this.agent.queuedMessageOccurrenceId;
				const submission =
					id === undefined
						? this._userMessageSubmissions.get(event.message)
						: this._nativeQueuedInputs.get(id)?.submission;
				submission?.reject(error);
				if (event.message.role === "user" || event.message.role === "custom") this._inputPublicationFailed = true;
			}
			throw error;
		}
	};

	private async _dispatchAgentEvent(event: AgentEvent): Promise<void> {
		const committedMessage =
			event.type === "message_end" &&
			(event.message.role === "user" || event.message.role === "custom" || event.message.role === "toolResult");
		if (!this._shutdownCancellation.signal.aborted) {
			try {
				await raceWithAbortSignal(this._emitExtensionEvent(event), this._shutdownCancellation.signal);
			} catch (error) {
				if (!this._shutdownCancellation.signal.aborted) throw error;
			}
		}
		// Cancellation releases extension waits, not final publication and persistence.
		let listenerError: { error: unknown } | undefined;
		try {
			this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);
		} catch (error) {
			if (!committedMessage) throw error;
			listenerError = { error };
		}
		// A public listener cannot discard a committed user input or finalized tool result.
		// Persist after listener mutations, and keep storage failures authoritative.
		await this._persistAgentEvent(event);
		if (listenerError) throw listenerError.error;
	}

	private async _persistAgentEvent(event: AgentEvent): Promise<void> {
		// Handle session persistence
		if (event.type === "message_end") {
			let entryId: string | undefined;
			const occurrenceId = this.agent.queuedMessageOccurrenceId;
			const queued = occurrenceId === undefined ? undefined : this._nativeQueuedInputs.get(occurrenceId);
			const inputReceipt =
				queued?.receipt ??
				(occurrenceId === undefined
					? (this._preparedInputReceipts.get(event.message) ?? this.#receivedMessageReceipts.get(event.message))
					: undefined);
			// Preserve narrower hook downgrades, while retaining the occurrence's outbox transfer.
			let receipt = this.#receivedMessageReceipts.get(event.message) ?? inputReceipt;
			const attested = occurrenceId === undefined ? this.#attestedUserContent.get(event.message) : queued?.attested;
			const submission =
				occurrenceId === undefined ? this._userMessageSubmissions.get(event.message) : queued?.submission;
			const replay = occurrenceId === undefined ? this._replayedInputs.get(event.message) : queued?.input;
			// Detach before reading role: a getter must not answer differently to the check and write.
			const persisted =
				receipt !== undefined || attested !== undefined || submission !== undefined
					? detachedMessage(event.message)
					: event.message;
			if (
				receipt &&
				!(
					persisted.role === "user" &&
					attested !== undefined &&
					isDeepStrictEqual(userContentBlocks(persisted.content), attested)
				)
			)
				receipt = withoutAttribution(receipt);
			if (submission && persisted.role !== "user")
				submission.reject(new Error("User message was replaced without persisting a user entry"));
			const transfer =
				getUnsentInputTransfer(inputReceipt) ??
				this._savedUnsentInputIds.get(occurrenceId ?? inputReceipt ?? event.message);
			if (receipt && transfer) linkUnsentInputTransfer(receipt, transfer);
			const metadata = persisted.role === "user" ? (submission?.metadata ?? replay?.metadata) : undefined;
			const metadataSource =
				metadata === undefined ? undefined : (submission?.metadataSource ?? replay?.metadataSource);
			if (persisted.role === "custom") {
				entryId = appendReceivedCustomMessage(
					this.sessionManager,
					persisted.customType,
					persisted.content,
					persisted.display,
					persisted.details,
					receipt,
				);
			} else if (
				persisted.role === "system" ||
				persisted.role === "user" ||
				persisted.role === "assistant" ||
				persisted.role === "toolResult"
			) {
				try {
					entryId = appendReceivedMessage(this.sessionManager, persisted, receipt, metadata, metadataSource);
				} catch (error) {
					submission?.reject(error);
					throw error;
				}
				if (submission && persisted.role === "user") {
					submission.resolve({
						status: "turnStarted",
						entryId,
						metadata: submission.metadata,
						metadataSource: submission.metadataSource,
					});
					this._userMessageSubmissions.delete(event.message);
				}
			}
			this.#receivedMessageReceipts.delete(event.message);
			this.#attestedUserContent.delete(event.message);
			if (entryId) {
				this._entryIdsByMessage.set(event.message, entryId);
				// No fallible public callback between durable append and retention bookkeeping.
				if (occurrenceId !== undefined) this._nativeQueuedInputs.delete(occurrenceId);
				if ((occurrenceId === undefined && this._unpersistedInputs.delete(event.message)) || receipt)
					this._queuedInputRevision++;
				if (inputReceipt) {
					this._persistedInputReceipts.add(inputReceipt);
					const source = this._inputReceiptSources.get(inputReceipt);
					if (source) this._persistedInputReceipts.add(source);
				}
				if (receipt) this._persistedInputReceipts.add(receipt);
				if (!this._unpersistedInputs.has(event.message)) this._preparedInputReceipts.delete(event.message);
			}
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
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted")
					this._codexStreamDisconnectRetryUsed = false;
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
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
			this._flushPendingCustomMessages();
		}
	}

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const message = [...event.messages].reverse().find((m) => m.role === "assistant") as AssistantMessage | undefined;
		return message !== undefined && this._willRetryAssistantMessage(message);
	}

	private _willRetryAssistantMessage(message: AssistantMessage): boolean {
		if (this._agentRunAbortRequested || this._throttleWaitUsed) return false;
		if (!this._assistantOutputObserved && !hasAssistantOutput(message) && throttledLimitWait(message)) return true;
		const settings = this._getRetrySettings(message);
		if (!settings.enabled || !this._isRetryableError(message)) return false;
		if (isRetryableCodexStreamDisconnect(message)) return settings.maxRetries > 0;
		return this._retryAttempt < settings.maxRetries;
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
				const receipt = this.#receivedMessageReceipts.get(event.message);
				if (
					receipt &&
					event.message.role === "user" &&
					(normalized.role !== "user" ||
						!isDeepStrictEqual(userContentBlocks(event.message.content), userContentBlocks(normalized.content)))
				) {
					this.#receivedMessageReceipts.set(event.message, withoutAttribution(receipt));
				}
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
				...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
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
		if (this._inputsDisposed) return;
		this._assertInputsDrained();
		if (!this.isIdle || this.isSettling)
			throw new InputAdmissionError("INPUT_ADMISSION_BUSY", "abort and settle the active operation before disposal");
		this._inputsDisposed = true;
		this._rejectPendingUserMessageSubmissions(
			new InputAdmissionError("INPUT_ADMISSION_DISPOSED", "user message was not persisted"),
		);
		this._disposalCancellation.abort(
			new InputAdmissionError("INPUT_ADMISSION_DISPOSED", "auxiliary operation cancelled by disposal"),
		);
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

	/** Under a virtual selection, the physical model and thinking level of the latest successful response. */
	get routedModel(): { model: Model<any>; thinkingLevel?: ThinkingLevel } | undefined {
		if (!this.model || !isVirtualModel(this.model)) return undefined;
		const latest = findLatestResponse(this.agent.state.messages);
		const model = latest && this._modelRuntime.getPhysicalModel(latest.provider, latest.model);
		return model && { model, thinkingLevel: latest?.thinkingLevel };
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, compaction, branch summary, retry, or queued continuation. */
	get isIdle(): boolean {
		return (
			this._inputAdmissions.size === 0 &&
			!this._isAgentRunActive &&
			!this.isCompacting &&
			!this._modelSwitchCompactionPending &&
			this._modelSwitchDispatches.size === 0 &&
			this._triggeredBehindPreflight.length === 0
		);
	}

	get isSettling(): boolean {
		return this._isEmittingAgentSettled;
	}

	get isPromptPending(): boolean {
		return this._inputAdmissions.size > 0 || this._promptPreflights.size > 0;
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
	 * Get the names of currently active tools, which are the tools declared to the model.
	 * Tools with `codemode` or `deferred` exposure are callable from other tools without being active.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/** Get the names of the tools that tools can call through `ctx.executeTool()`. */
	getCallableToolNames(): string[] {
		return this._getCallableTools().map((t) => t.name);
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
			exposure: this._getToolExposure(definition.name),
			...(definition.namespace ? { namespace: definition.namespace } : {}),
			...(definition.annotations ? { annotations: { ...definition.annotations } } : {}),
			...(definition.reachesTools ? { reachesTools: definition.reachesTools } : {}),
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown and hidden tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		this._inheritedCancellation();
		const previous = this.getActiveToolNames();
		this._setActiveTools(toolNames);
		// A loadout that deactivates a tool replaces the restored one, whose pending tools are dropped.
		// One that only adds tools, like activating tool_search, keeps them.
		const active = new Set(this.getActiveToolNames());
		if (previous.some((name) => !active.has(name))) this._pendingToolNames.clear();
	}

	private _setActiveTools(toolNames: string[]): void {
		const tools = this._applyToolLoadout(toolNames);
		for (const tool of tools) this._pendingToolNames.delete(tool.name);
		this._rebuildSystemPrompt(tools.map((tool) => tool.name));
	}

	/**
	 * Whether `--tools` and `--exclude-tools` keep the tool registered. MCP tools stay registered
	 * unless the allowlist filters them (see `_allowlistFiltersMcp`).
	 */
	private _isAllowedTool(name: string): boolean {
		if (this._excludedTools?.(name)) return false;
		if (!this._allowedTools || this._allowedTools(name)) return true;
		return !this._allowlistFiltersMcp && isMcpToolName(name);
	}

	/**
	 * Whether the tool may be active, which declares it to the model. MCP tools the allowlist keeps
	 * without matching them are only for codemode and tool_search: they may be declared only when
	 * tool_search can load them (non-`direct` exposure and tool_search registered). This also applies
	 * to tools restored from the transcript or set by extensions.
	 */
	private _isActivatable(name: string): boolean {
		if (!this._allowedTools || this._allowedTools(name) || !isMcpToolName(name)) return true;
		return this._getToolExposure(name) !== "direct" && this._toolRegistry.has("tool_search");
	}

	private _getToolExposure(name: string): ToolExposure {
		return this._toolDefinitions.get(name)?.definition.exposure ?? "direct";
	}

	/**
	 * Tools callable through `ctx.executeTool()`: the active `direct` tools and every registered
	 * `codemode` or `deferred` tool.
	 */
	private _getCallableTools(active: ReadonlySet<string> = new Set(this.getActiveToolNames())): AgentTool[] {
		return [...this._toolRegistry.values()].filter((tool) => {
			const exposure = this._getToolExposure(tool.name);
			return exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active.has(tool.name));
		});
	}

	/**
	 * Set the agent's tools for the given active tool names and return them. The active tools are
	 * the registered, non-hidden ones; they are declared to the model. Active tools with a
	 * `prepareLoadout` hook can change the declared descriptions and hide declarations from
	 * requests (see {@link _installHiddenDeclarationsProjection}).
	 */
	private _applyToolLoadout(toolNames: string[]): AgentTool[] {
		const tools = [...new Set(toolNames)].flatMap((name) => {
			const tool = this._toolRegistry.get(name);
			return tool && this._getToolExposure(name) !== "hidden" && this._isActivatable(name) ? [tool] : [];
		});
		const hooks = tools.flatMap((tool) => {
			const entry = this._toolDefinitions.get(tool.name);
			return entry?.definition.prepareLoadout ? [entry] : [];
		});
		const hidden = new Set<string>();
		let declared = tools;
		if (hooks.length > 0) {
			const loadout: ToolLoadout = {
				declared: tools,
				callable: this._getCallableTools(new Set(tools.map((tool) => tool.name))),
				registered: [...this._toolRegistry.values()],
				getExposure: (name) => this._getToolExposure(name),
				getNamespace: (name) => this._toolDefinitions.get(name)?.definition.namespace,
				getPromptGuidelines: (name) => this._toolPromptGuidelines.get(name) ?? [],
			};
			const descriptions = new Map<string, string>();
			for (const { definition, sourceInfo } of hooks) {
				try {
					const changes = definition.prepareLoadout?.(loadout);
					for (const [name, description] of Object.entries(changes?.descriptions ?? {})) {
						descriptions.set(name, description);
					}
					for (const name of changes?.hiddenDeclarations ?? []) hidden.add(name);
				} catch (error) {
					this._extensionRunner.emitError({
						extensionPath: sourceInfo.path,
						event: "prepare_loadout",
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
				}
			}
			declared = tools.map((tool) => {
				const description = descriptions.get(tool.name);
				return description === undefined ? tool : { ...tool, description };
			});
		}
		this._hiddenDeclarations = hidden;
		this.agent.state.tools = declared;
		return declared;
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
			// Tools without a snippet are not listed.
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
			hiddenTools: [...this._hiddenDeclarations],
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
		options.selectedTools = this._applyToolLoadout(options.selectedTools).map((tool) => tool.name);
		// The tool list and rules must match the declarations the request carries.
		options.hiddenTools = [...this._hiddenDeclarations];
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
	/**
	 * Remove the declarations that `prepareLoadout` hooks hide from every request. The whole
	 * transcript is filtered with the current set, so the projected declarations stay consistent
	 * across requests and only change when the loadout does.
	 */
	private _installHiddenDeclarationsProjection(): void {
		const previousTransformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
			const hidden = this._hiddenDeclarations;
			if (hidden.size === 0) return transformed;
			return transformed.map((message) => {
				if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved)) return message;
				const { toolsAdded, toolsRemoved, ...rest } = message;
				const added = toolsAdded?.filter((tool) => !hidden.has(tool.name)) ?? [];
				const removed = toolsRemoved?.filter((tool) => !hidden.has(tool.name)) ?? [];
				return {
					...rest,
					...(added.length > 0 ? { toolsAdded: added } : {}),
					...(removed.length > 0 ? { toolsRemoved: removed } : {}),
				};
			});
		};
	}

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

	/**
	 * Restore the active tool loadout declared by the session transcript, if it declares one.
	 * Tools reachable only from other tools are never declared, but they do not depend on the active
	 * set, so the transcript's declarations are the whole loadout.
	 * @param modifiers `+name`/`-name` entries applied to the restored loadout.
	 */
	private _restoreToolsFromTranscript(modifiers: readonly string[] = []): void {
		this._pendingToolNames.clear();
		const current = getCurrentSystemMessage(this.sessionManager.buildSessionContext().messages);
		if (!current) return;
		const names = applyToolModifiers(
			(current.toolsAdded ?? []).map((tool) => tool.name),
			modifiers,
		);
		this._pendingToolNames = new Set(names.filter((name) => this._isAllowedTool(name)));
		this._setActiveTools(names);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * Start a run from a user or custom message. The session counts as busy from here on, so
	 * messages sent while before_agent_start handlers run are queued into this run instead of
	 * starting another, and an abort requested meanwhile aborts the run as soon as it exists.
	 * @param onStarted Called once the run's messages are prepared, before the first request.
	 */
	private async _startRun(
		trigger: BeforeAgentStartTrigger,
		options: {
			admission?: InputAdmission;
			receipt?: TurnReceipt;
			submission?: UserMessageSubmission;
			streamingBehavior?: "steer" | "followUp";
			additionalMessages?: CustomMessage[];
			beforeDispatch?: () => void;
			onInputTransferred?: () => void;
		} = {},
	): Promise<void> {
		// A nested custom dispatch never transfers the user admission it inherited.
		if (trigger.messageType === "custom" && !options.admission) {
			const admission = this._admitInput();
			return this._withInputAdmission(admission, () => this._startRun(trigger, { ...options, admission }));
		}
		this._checkInputAdmission();
		if (trigger.messageType === "custom") this._isAgentRunActive = true;
		this._agentRunAbortRequested = false;
		let runOwned = false;
		try {
			const messages = await this._prepareRun(
				trigger,
				options.receipt,
				options.submission,
				options.admission,
				options.streamingBehavior,
			);
			if (trigger.messageType === "custom" && options.additionalMessages?.length) {
				const start = messages.indexOf(trigger.message);
				messages.splice(start + 1, 0, ...options.additionalMessages);
			}
			this._checkInputAdmission();
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();
			this._checkInputAdmission();
			options.beforeDispatch?.();
			await this._runAgentPrompt(messages, options.onInputTransferred, options.admission, () => {
				runOwned = true;
			});
		} catch (error) {
			if (!runOwned) {
				this._isAgentRunActive = false;
				this._runSystemPromptOptions = undefined;
				this._flushPendingBashMessages();
				this._flushPendingCustomMessages();
				this._resolveIdleWaitIfIdle();
			}
			throw error;
		}
	}

	private async _runAgentPrompt(
		messages: AgentMessage | AgentMessage[] | undefined,
		onInputTransferred?: () => void,
		transferringAdmission?: InputAdmission,
		prepared?: () => void,
	): Promise<void> {
		while (this._modelSwitchCompactionPending) await this._awaitInput(this._modelSwitchAdmissionWait);
		const agent = this.#originalAgent;
		if (this.agent !== agent) throw new Error("OWNER_RUNTIME_AGENT_CHANGED");
		const dispatch = async (continuation = false) => {
			if (!continuation) this._checkInputAdmission();
			if (this.agent !== agent) throw new Error("OWNER_RUNTIME_AGENT_CHANGED");
			// No await or external callback may separate this check from dispatch.
			if (originalAgentSignal.call(agent)) throw new Error("OWNER_AGENT_BUSY_BEFORE_TRANSFER");
			if (!continuation) {
				transferringAdmission?.signal.throwIfAborted();
				transferringAdmission?.release();
			}
			const run = continuation || !messages ? agent.continue() : agent.prompt(messages);
			try {
				if (!continuation) onInputTransferred?.();
				if (this.agent !== agent) throw new Error("OWNER_RUNTIME_AGENT_CHANGED");
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
		this._queueDrainError = undefined;
		this._inputPublicationFailed = false;
		if (!prepared) this._agentRunAbortRequested = false;
		this._failedResponse = undefined;
		this._recordSelection();
		this._pendingToolNames.clear();
		this._abortDuringBeforeSettle = false;
		this._lastActivityOutcome = "completed";
		this._inputQueuedBehindPreflight = false;
		this._isAgentRunActive = true;
		this._codexStreamDisconnectRetryUsed = false;
		let runFailed = false;
		try {
			prepared?.();
			await dispatch();
			while (!this._agentRunAbortRequested && !this._stopAfterCompactionFailure && !this._inputPublicationFailed) {
				const continueAfterRun = await this._handlePostAgentRun();
				if (this._agentRunAbortRequested || this._stopAfterCompactionFailure || this._inputPublicationFailed) break;
				if (!continueAfterRun && !(await this._runBeforeSettleBoundary())) break;
				if (this._agentRunAbortRequested || this._stopAfterCompactionFailure) break;
				await dispatch(true);
			}
		} catch (error) {
			runFailed = true;
			throw error;
		} finally {
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			this._failedResponse = undefined;
			this._runSystemPromptOptions = undefined;
			let persistenceFailure: { cause: unknown } | undefined;
			try {
				this._flushPendingBashMessages();
				this._flushPendingCustomMessages();
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
					// biome-ignore lint/correctness/noUnsafeFinally: Preserve persistence and notification failures.
					throw new AggregateError([persistenceFailure.cause, notificationFailure], "OWNER_SETTLEMENT_FAILED", {
						cause: persistenceFailure.cause,
					});
				// biome-ignore lint/correctness/noUnsafeFinally: Settlement notification failures must reject.
				throw notificationFailure;
			}
			// biome-ignore lint/correctness/noUnsafeFinally: Persistence failure must reject after notification.
			if (persistenceFailure) throw persistenceFailure.cause;
		}
	}

	/**
	 * Prepare a run and return its starting messages: compact first when needed, emit
	 * before_agent_start, apply the run's prompt options and tool loadout, and build the starting
	 * message followed by pending nextTurn messages (consumed here) and handler messages, with a
	 * system patch first when the prompt changed.
	 */
	private async _prepareRun(
		trigger: BeforeAgentStartTrigger,
		receipt?: TurnReceipt,
		submission?: UserMessageSubmission,
		admission?: InputAdmission,
		streamingBehavior?: "steer" | "followUp",
	): Promise<AgentMessage[]> {
		// User compaction stays in _prompt so its input-retention contract is unchanged.
		const lastAssistant = this._findLastAssistantMessage();
		if (trigger.messageType === "custom" && lastAssistant) {
			const outcome = await this._awaitInput(this._checkCompaction(lastAssistant, false));
			if (outcome === "failed" || outcome === "aborted") {
				this._enqueueSessionInput(trigger.message, "steer");
				throw new Error(`Custom run not sent: compaction ${outcome}; input retained in the steer queue.`);
			}
		}

		const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools;
		const result = await this._awaitInput(
			this._extensionRunner.emitBeforeAgentStart(
				trigger,
				this._baseSystemPromptOptions,
				this._inheritedCancellation(),
			),
		);
		// Handlers may edit event.systemPromptOptions.selectedTools or call setActiveTools(),
		// which updates the live loadout instead. An explicit edit wins; otherwise the live
		// loadout is authoritative, so a setActiveTools() call is not undone here.
		const handlerEditedTools =
			result.systemPromptOptions.selectedTools.length !== selectedToolsBefore.length ||
			result.systemPromptOptions.selectedTools.some((name, index) => name !== selectedToolsBefore[index]);
		if (!handlerEditedTools) result.systemPromptOptions.selectedTools = this.getActiveToolNames();

		const messages: AgentMessage[] = [];
		if (trigger.messageType === "custom") {
			messages.push(trigger.message);
		} else {
			// Normalize images after before_agent_start so extension-driven model selection
			// determines the resize profile used for the request and history.
			const normalized = await this._awaitInput(this._normalizePromptImages(trigger.images));
			const text =
				normalized.hints.length > 0 ? `${trigger.prompt}\n\n${normalized.hints.join("\n")}` : trigger.prompt;
			const message: AgentMessage = {
				role: "user",
				content: [{ type: "text", text }, ...normalized.images],
				timestamp: Date.now(),
			};
			const preparedReceipt = receipt ?? captureTerminalTurnReceipt();
			this.#attachUserMessageReceipt(message, preparedReceipt);
			this._preparedInputReceipts.set(message, preparedReceipt);
			this._unpersistedInputOrder.set(message, ++this._nextInputOrder);
			this._unpersistedInputs.set(message, { message, mode: streamingBehavior ?? "steer" });
			if (admission) admission.input = undefined;
			if (submission) {
				submission.message = message;
				this._userMessageSubmissions.set(message, submission);
			}
			messages.push(message);
		}
		while (this._modelSwitchCompactionPending) await this._awaitInput(this._modelSwitchAdmissionWait);
		this._checkInputAdmission();
		// nextTurn context belongs to the next user prompt, not a custom-triggered run.
		if (trigger.messageType === "user") {
			messages.push(...this._pendingNextTurnMessages);
			this._pendingNextTurnMessages = [];
		}
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
			this._preparedInputReceipts.set(message, result.messageReceipts[index]);
			this._unpersistedInputOrder.set(message, ++this._nextInputOrder);
			this._unpersistedInputs.set(message, { message, mode: "context" });
			messages.push(message);
		}
		const updateMessage = this._preparePromptAndToolLoadout(result.systemPromptOptions);
		this._runSystemPromptOptions = result.systemPromptOptions;
		if (updateMessage) messages.unshift(updateMessage);
		return messages;
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		// Agent publishes loop failures as assistant errors. Preserve this typed refusal and
		// do not automatically retry the same retained batch forever.
		if (this._queueDrainError) throw this._queueDrainError;
		const message = this._lastAssistantMessage;
		const toolResults = this._lastAssistantToolResults;
		this._lastAssistantMessage = undefined;
		this._lastAssistantToolResults = [];
		if (this._agentRunAbortRequested) {
			this._finishCancelledRetry();
			return false;
		}
		if (!message) return this.agent.hasQueuedMessages();

		if (this._stopAfterCompactionFailure) return false;
		const throttleWaitUsed = this._throttleWaitUsed;
		this._throttleWaitUsed = false;
		const throttleWait =
			throttleWaitUsed || this._assistantOutputObserved || hasAssistantOutput(message)
				? undefined
				: throttledLimitWait(message);
		let retrying: boolean;
		if (throttleWait) {
			this._retryAttempt++;
			retrying = await this._waitAndRetry(
				message,
				throttleWait.delayMs,
				this._retryAttempt,
				throttleWait.waitMessage,
			);
			this._throttleWaitUsed = retrying;
		} else retrying = !throttleWaitUsed && this._isRetryableError(message) && (await this._prepareRetry(message));
		if (retrying) {
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			this._failedResponse = message;
			return !this._agentRunAbortRequested;
		}
		if (this._agentRunAbortRequested) {
			this._finishCancelledRetry();
			return false;
		}

		if (message.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: message.errorMessage,
			});
			this._retryAttempt = 0;
		}

		const compaction =
			(throttleWaitUsed && message.stopReason === "error") || isRetryableCodexStreamDisconnect(message)
				? false
				: await this._checkCompaction(message, true, toolResults);
		if (compaction === "failed" || compaction === "aborted") {
			this._stopAfterCompactionFailure = true;
			this._compactionStopOutcome = compaction === "aborted" ? "aborted" : "error";
			return false;
		}
		if (compaction) return !this._agentRunAbortRequested;

		// A native listener can fail before this session observes a queued start. Retained
		// occurrences must not immediately spin through the same failing publication again.
		if (message.stopReason === "error") {
			this._inputPublicationFailed = this.agent.hasQueuedMessages();
			return false;
		}
		// The low-level loop drains both queues before agent_end. Messages queued by
		// agent_end handlers require a fresh run before pre-settlement handlers fire.
		return !this._agentRunAbortRequested && this.agent.hasQueuedMessages();
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

	/** Inputs awaiting native handoff, including every extension input handler. */
	get inputAdmissionCount(): number {
		return this._inputAdmissions.size;
	}

	get isDisposed(): boolean {
		return this._inputsDisposed;
	}

	get inputsFenced(): boolean {
		return this._inputFence !== undefined || this._inputsDisposed;
	}

	private _assertInputsOpen(): void {
		if (this._inputsDisposed) throw new InputAdmissionError("INPUT_ADMISSION_DISPOSED", "input was not accepted");
		const scope = this._inputFenceScope.getStore();
		if ((scope && !scope.active) || (this._inputFence && !(scope?.active && scope.fence === this._inputFence)))
			throw new InputAdmissionError(
				"INPUT_ADMISSION_FENCED",
				"input was not accepted; retry against the current session",
			);
	}

	private _assertInputsDrained(): void {
		if (
			this._inputAdmissions.size > 0 ||
			this.isSettling ||
			this.#pendingModeInput?.() ||
			this.agent.hasQueuedMessages() ||
			this._steeringMessages.length > 0 ||
			this._followUpMessages.length > 0 ||
			this._triggeredBehindPreflight.length > 0 ||
			this._modelSwitchDispatches.size > 0 ||
			this._deferredSettledActions.length > 0 ||
			this._pendingNextTurnMessages.length > 0 ||
			this._pendingCustomMessages.length > 0
		)
			throw new InputAdmissionError(
				"INPUT_ADMISSION_BUSY",
				"settle admitted input or recover queued input before replacement/disposal",
			);
	}

	private _restoreUnsentInputs(): void {
		const branch = this.sessionManager.getBranch();
		const consumed = new Set(branch.flatMap((entry) => (entry.unsentInputId ? [entry.unsentInputId] : [])));
		for (const entry of branch) {
			if (entry.type !== "custom" || entry.customType !== UNSENT_INPUT_TYPE || consumed.has(entry.id)) continue;
			const input = readUnsentInput(entry.data);
			if (!input) throw new Error(`Invalid unsent input entry ${entry.id}`);
			const message = structuredClone(input.message);
			// Historical/imported/foreign outboxes are editable drafts, never restored identity or metadata.
			if (
				input.origin?.sessionId !== this.sessionManager.getSessionId() ||
				input.origin.host !== hostname() ||
				input.origin.uid !== userInfo().uid
			) {
				if (message.role === "user" || message.role === "custom")
					this._unsentInputDrafts.push({ role: "user", content: message.content, timestamp: message.timestamp });
				continue;
			}
			// Stored keyboard provenance is not a fresh attestation: retain terminal identity only.
			const provenance = input.provenance;
			const receipt = provenance
				? restoreTerminalTurnReceipt(
						provenance.channel === "keyboard"
							? {
									v: provenance.v,
									channel: "terminal",
									turnId: provenance.turnId,
									receivedAt: provenance.receivedAt,
									...(provenance.submissionToken === undefined
										? {}
										: { submissionToken: provenance.submissionToken }),
								}
							: provenance,
					)
				: captureTerminalTurnReceipt();
			linkUnsentInputTransfer(receipt, entry.id);
			this.#attachUserMessageReceipt(message, receipt);
			this._replayedInputs.set(message, input);
			this._preparedInputReceipts.set(message, receipt);
			this._unpersistedInputOrder.set(message, ++this._nextInputOrder);
			this._unpersistedInputs.set(message, { ...input, message });
			if (message.role === "custom" && input.mode === "nextTurn") this._pendingNextTurnMessages.push(message);
			else if (message.role === "custom" && input.mode === "context") this._pendingCustomMessages.push(message);
			else {
				this._enqueueSessionInput(message, input.mode === "followUp" ? "followUp" : "steer", (id) => {
					if (message.role !== "user") return;
					const display = { message, text: contentText(message.content, ""), occurrenceId: id };
					if (input.mode === "followUp") this._followUpMessages.push(display);
					else this._steeringMessages.push(display);
				});
			}
			this._hasResumedInputs = true;
			this._queuedInputRevision++;
		}
	}

	/** Take foreign outbox content for the editor, once per live instance; never submit it. */
	takeUnsentInputDrafts(): AgentMessage[] {
		return this._unsentInputDrafts.splice(0);
	}

	/** Monotonic input occurrence revision; reading it never mutates queue state. */
	get queuedInputRevision(): number {
		return this._queuedInputRevision;
	}

	/** Replay operator-exit input after the host has bound extensions and published the session. */
	async resumeUnsentInputs(): Promise<void> {
		if (!this._hasResumedInputs) return;
		this._checkInputAdmission();
		if (!this.isIdle || this.isSettling)
			throw new InputAdmissionError("INPUT_ADMISSION_BUSY", "resume requires an idle session");
		this._hasResumedInputs = false;
		this._flushPendingCustomMessages();
		const first = this.agent.getQueuedMessageOccurrences()[0];
		let firstMessage: AgentMessage | undefined;
		if (first) {
			const queued = this._nativeQueuedInputs.get(first.id);
			// Move exactly one native occurrence into prepared custody. Never remove every
			// same-object occurrence, or overwrite a separate prepared alias of that object.
			firstMessage = this._unpersistedInputs.has(first.message) ? structuredClone(first.message) : first.message;
			const input = { ...(queued?.input ?? { mode: first.mode }), message: firstMessage };
			const receipt = queued?.receipt ?? captureTerminalTurnReceipt();
			this._unpersistedInputs.set(firstMessage, input);
			this._unpersistedInputOrder.set(firstMessage, queued?.order ?? ++this._nextInputOrder);
			this._preparedInputReceipts.set(firstMessage, receipt);
			this.#receivedMessageReceipts.set(firstMessage, receipt);
			this._replayedInputs.set(firstMessage, input);
			if (queued?.attested !== undefined) this.#attestedUserContent.set(firstMessage, queued.attested);
			this.agent.removeQueuedMessages((_message, id) => id === first.id);
			for (const queue of [this._steeringMessages, this._followUpMessages]) {
				const index = queue.findIndex((entry) => entry.occurrenceId === first.id);
				if (index >= 0) queue.splice(index, 1);
			}
			this._emitQueueUpdate();
		}
		const messages = [...(firstMessage ? [firstMessage] : []), ...this._pendingNextTurnMessages.splice(0)];
		if (messages.length) await this._runAgentPrompt(messages);
	}

	/**
	 * Explicit operator exit only: fence and save every unsent occurrence before cancellation.
	 * A save failure leaves the input and active operation owned by this session.
	 */
	prepareOperatorExit(options?: {
		discardUnsent?: boolean;
		/** TUI owner retains this block synchronously and prints it after terminal restoration. */
		bufferUnsentInput?: (block: string) => void;
	}): () => void {
		if (this._inputsDisposed)
			throw new InputAdmissionError("INPUT_ADMISSION_DISPOSED", "operator exit session is disposed");
		const release = this.gateInputs();
		try {
			if (this.#pendingModeInput?.() && !this.#getPendingModeInputs)
				throw new InputAdmissionError("INPUT_ADMISSION_BUSY", "mode-owned input requires an exit snapshot");
			const pending: Array<{ input: UnsentInput; receipt?: TurnReceipt; order: number; identity: object | number }> =
				[];
			const seen = new Set<object | number>();
			const retain = (input: UnsentInput, receipt?: TurnReceipt, occurrenceId?: number, order?: number) => {
				const identity = occurrenceId ?? receipt ?? input.message;
				const source = receipt ? (this._inputReceiptSources.get(receipt) ?? receipt) : undefined;
				if (
					seen.has(identity) ||
					(occurrenceId === undefined && source && seen.has(source)) ||
					(receipt && this._persistedInputReceipts.has(receipt)) ||
					(source && this._persistedInputReceipts.has(source))
				)
					return;
				seen.add(identity);
				if (source) seen.add(source);
				pending.push({
					input: { ...input, ...(receipt ? { provenance: receiptRecord(receipt) } : {}) },
					receipt,
					identity,
					order: order ?? this._unpersistedInputOrder.get(input.message) ?? ++this._nextInputOrder,
				});
			};
			for (const input of this._unpersistedInputs.values()) {
				const submission = this._userMessageSubmissions.get(input.message);
				retain(
					{
						...input,
						...(submission ? { metadata: submission.metadata, metadataSource: submission.metadataSource } : {}),
					},
					this._preparedInputReceipts.get(input.message),
				);
			}
			for (const [id, { input, receipt, order }] of this._nativeQueuedInputs) retain(input, receipt, id, order);
			// Inspect actual queues too: Agent accepts unsupported roles and preattached occurrences.
			for (const { id, message, mode } of this.agent.getQueuedMessageOccurrences())
				retain({ message, mode }, undefined, id);
			for (const admission of this._inputAdmissions) if (admission.input) retain(admission.input, admission.receipt);
			for (const { input, mode } of this.#getPendingModeInputs?.() ?? [])
				retain(
					{
						message: {
							role: "user",
							content: [{ type: "text", text: input.text }, ...(input.images ?? [])],
							timestamp: Date.now(),
						},
						mode,
					},
					getInputReceipt(input),
				);
			// Detach and validate the COMPLETE snapshot before the first append, print or clear.
			for (const item of pending) {
				item.input = structuredClone(item.input);
				if (!readUnsentInput(item.input))
					throw new UnsupportedUnsentInputError(item.input.message.role, item.input.mode);
			}
			if (pending.length && !this.sessionManager.isPersisted() && !options?.discardUnsent)
				throw new InputAdmissionError(
					"INPUT_ADMISSION_BUSY",
					`${pending.length} queued messages are not saved (no session file). /quit again to discard them and exit.`,
				);
			pending.sort((left, right) => left.order - right.order);
			if (pending.length && !this.sessionManager.isPersisted()) {
				try {
					const text = pending.map(({ input: { message } }) =>
						message.role === "user" || message.role === "custom"
							? contentText(message.content, "\n") || JSON.stringify(message)
							: JSON.stringify(message),
					);
					const block = `Unsent input (not saved; --no-session):\n${text.join("\n")}\n`;
					if (options?.bufferUnsentInput) options.bufferUnsentInput(block);
					else fs.writeFileSync(process.stderr.fd, block);
				} catch (cause) {
					throw new InputAdmissionError(
						"INPUT_ADMISSION_BUSY",
						"unsent input could not be printed to stderr; input was not discarded",
						{ cause },
					);
				}
			}
			for (const { input, receipt, identity } of this.sessionManager.isPersisted() ? pending : []) {
				if (getUnsentInputTransfer(receipt) || this._savedUnsentInputIds.has(identity)) continue;
				const origin = { sessionId: this.sessionManager.getSessionId(), host: hostname(), uid: userInfo().uid };
				const id = this.sessionManager.appendCustomEntry(UNSENT_INPUT_TYPE, { ...input, origin });
				this._savedUnsentInputIds.set(identity, id);
				if (receipt) linkUnsentInputTransfer(receipt, id);
			}
			this._operatorExitPrepared = true;
			this.#clearPendingModeInputs?.();
			this._pendingNextTurnMessages = [];
			this._pendingCustomMessages = [];
			this._unpersistedInputs.clear();
			this._nativeQueuedInputs.clear();
			this.clearQueue();
			return release;
		} catch (error) {
			release();
			throw error;
		}
	}

	/** Close admission synchronously; the caller owns the fence until lifecycle completion. */
	async fenceInputs(options?: { rejectQueuedInput?: (messages: AgentMessage[]) => void }): Promise<() => void> {
		if (!options?.rejectQueuedInput) this._shutdownCancellation.signal.throwIfAborted();
		this._assertInputsOpen();
		const fence = {};
		this._inputFence = fence;
		try {
			if (options?.rejectQueuedInput) {
				this._settlementCancellation.abort(
					new InputAdmissionError("INPUT_ADMISSION_ABORTED", "settlement cancelled for shutdown"),
				);
				this.abortBash();
				await this.abort();
				await this._settlementCompletion;
				const messages = this.agent.getQueuedMessages();
				if (messages.length > 0) {
					options.rejectQueuedInput(messages);
					this.clearQueue();
				}
			}
			this._assertInputsDrained();
		} catch (error) {
			this._inputFence = undefined;
			if (
				this._settlementCancellation.signal.aborted &&
				!this.isSettling &&
				!this._shutdownCancellation.signal.aborted
			)
				this._settlementCancellation = new AbortController();
			throw error;
		}
		return this.#inputFenceRelease(fence);
	}

	/** Gate direct admission on a receiving session whose drain fence refused. */
	gateInputs(): () => void {
		if (this._inputFence) return () => {};
		const fence = {};
		this._inputFence = fence;
		return this.#inputFenceRelease(fence);
	}

	#inputFenceRelease(fence: object): () => void {
		return () => {
			if (this._inputFence === fence) {
				this._inputFence = undefined;
				if (
					!this._inputsDisposed &&
					this._settlementCancellation.signal.aborted &&
					!this.isSettling &&
					!this._shutdownCancellation.signal.aborted
				)
					this._settlementCancellation = new AbortController();
			}
		};
	}

	async withFencedInput<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const fence = this._inputFence;
		if (!fence) return operation();
		const scope = { fence, active: true };
		try {
			return await raceWithAbortSignal(this._inputFenceScope.run(scope, operation), signal);
		} finally {
			scope.active = false;
		}
	}

	private _admitInput(): InputAdmission {
		this._checkInputAdmission();
		this._shutdownCancellation.signal.throwIfAborted();
		const controller = new AbortController();
		const cancellation = this._dispatchCancellationScope.getStore();
		const admission: InputAdmission = {
			controller,
			signal: cancellation ? AbortSignal.any([controller.signal, cancellation]) : controller.signal,
			parent: cancellation,
			fenceScope: this._inputFenceScope.getStore(),
			release: () => {
				if (!this._inputAdmissions.delete(admission)) return;
				this._queuedInputRevision++;
				this._inputAdmissionScope.exit(() => this._runInputQueuedBehindPreflight());
				this._resolveIdleWaitIfIdle();
			},
		};
		this._inputAdmissions.add(admission);
		this._queuedInputRevision++;
		return admission;
	}

	private async _withInputAdmission<T>(admission: InputAdmission, operation: () => Promise<T>): Promise<T> {
		try {
			return await this._dispatchCancellationScope.run(admission.signal, () =>
				this._inputFenceScope.run(admission.fenceScope, () => this._inputAdmissionScope.run(admission, operation)),
			);
		} finally {
			admission.release();
		}
	}

	private _checkInputAdmission(): void {
		this._dispatchCancellationScope.getStore()?.throwIfAborted();
		this._inputAdmissionScope.getStore()?.signal.throwIfAborted();
		this._assertInputsOpen();
	}

	private _inheritedCancellation(): AbortSignal | undefined {
		const signals = [this._dispatchCancellationScope.getStore(), this._inputAdmissionScope.getStore()?.signal].filter(
			(signal): signal is AbortSignal => signal !== undefined,
		);
		for (const signal of signals) signal.throwIfAborted();
		return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
	}

	private async _awaitInput<T>(operation: Promise<T>): Promise<T> {
		const admission = this._inputAdmissionScope.getStore();
		const result = await raceWithAbortSignal(
			operation,
			this._dispatchCancellationScope.getStore() ?? admission?.signal,
		);
		if (!admission || this._inputAdmissions.has(admission)) this._checkInputAdmission();
		return result;
	}

	private async _runInputHandlers(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<{ text: string; images: ImageContent[] | undefined; transformed?: true } | undefined> {
		if (!this._extensionRunner.hasHandlers("input")) {
			return { text, images };
		}

		const inputResult = await this._awaitInput(
			this._extensionRunner.emitInput(
				text,
				images,
				source,
				streamingBehavior,
				this._inputAdmissionScope.getStore()?.signal,
			),
		);
		if (inputResult.action === "handled") {
			return undefined;
		}
		if (inputResult.action === "transform") {
			return { text: inputResult.text, images: inputResult.images ?? images, transformed: true };
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
				resizeOptions: this._limitsModel()?.inputLimits?.images?.resize,
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
		const admission = this._admitInput();
		admission.input = {
			message: {
				role: "user",
				content: [{ type: "text", text }, ...(options?.images ?? [])],
				timestamp: Date.now(),
			},
			mode: options?.streamingBehavior ?? "steer",
		};
		admission.receipt = receipt;
		await this._withInputAdmission(admission, () => this._promptInAdmission(text, options, admission, receipt));
	}

	private async _promptInAdmission(
		text: string,
		options: PromptOptions | undefined,
		admission: InputAdmission,
		receipt: TurnReceipt,
		submission?: UserMessageSubmission,
	): Promise<void> {
		this._shutdownCancellation.signal.throwIfAborted();
		this._checkInputAdmission();
		const originalTransfer = options?.onInputTransferred;
		options = {
			...options,
			onInputTransferred: () => {
				if (this._inputAdmissions.has(admission)) this._checkInputAdmission();
				admission.release();
				originalTransfer?.();
			},
		};
		if (this._isEmittingAgentSettled) {
			if (this._agentSettledScope.getStore()?.active) {
				throw new InputAdmissionError(
					"INPUT_ADMISSION_BUSY",
					"SDK input cannot await its own agent_settled handler; submit after settlement",
				);
			}
			await this._awaitInput(
				new Promise<void>((resolve, reject) => {
					this._deferredSettledActions.push(async () => {
						try {
							await this._withInputAdmission(admission, () =>
								this._promptInAdmission(text, options, admission, receipt, submission),
							);
							resolve();
						} catch (error) {
							reject(error);
						}
					});
				}),
			);
			return;
		}
		return this._prompt(text, options, admission, receipt, submission);
	}

	private async _prompt(
		text: string,
		options: PromptOptions | undefined,
		admission: InputAdmission,
		receipt: TurnReceipt,
		submission?: UserMessageSubmission,
	): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		const onInputTransferred = options?.onInputTransferred;
		const preflightToken = {};
		try {
			if (expandPromptTemplates && text.startsWith("/")) {
				if (await this._tryExecuteExtensionCommand(text)) {
					submission?.resolve({
						status: "handled",
						entryId: null,
						metadata: submission.metadata,
						metadataSource: submission.metadataSource,
					});
					onInputTransferred?.();
					preflightResult?.("handled");
					return;
				}
			}
			if (this._modelSwitchCompactionPending && !options?.streamingBehavior)
				throw new Error("Model switch compaction is in progress; wait before submitting input.");
			if (
				this._compactionAbortController !== undefined ||
				(this._autoCompactionAbortController !== undefined && !this.isStreaming)
			)
				throw new Error(
					"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
				);
			this._promptPreflights.add(preflightToken);
			const mustQueue = () =>
				this.isStreaming ||
				this._modelSwitchCompactionPending ||
				(options?.streamingBehavior !== undefined &&
					this._promptPreflights.values().next().value !== preflightToken);
			const processedInput = await this._runInputHandlers(
				text,
				options?.images,
				options?.source ?? "interactive",
				mustQueue() ? options?.streamingBehavior : undefined,
			);
			if (!processedInput) {
				submission?.resolve({
					status: "handled",
					entryId: null,
					metadata: submission.metadata,
					metadataSource: submission.metadataSource,
				});
				onInputTransferred?.();
				preflightResult?.("handled");
				return;
			}
			const { text: currentText, images: currentImages } = processedInput;
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}
			if (processedInput.transformed || expandedText !== text) {
				const originalReceipt = receipt;
				receipt = withoutAttribution(receipt);
				if (receipt !== originalReceipt) this._inputReceiptSources.set(receipt, originalReceipt);
			}
			if (admission.input) {
				admission.receipt = receipt;
				admission.input.message = {
					role: "user",
					content: [{ type: "text", text: expandedText }, ...(currentImages ?? [])],
					timestamp: Date.now(),
				};
			}
			while (this._modelSwitchCompactionPending) await this._awaitInput(this._modelSwitchAdmissionWait);
			if (mustQueue()) {
				if (!options?.streamingBehavior)
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				if (options.streamingBehavior === "followUp")
					await this._queueFollowUp(expandedText, currentImages, receipt, submission);
				else await this._queueSteer(expandedText, currentImages, receipt, submission);
				if (!this.isStreaming) this._inputQueuedBehindPreflight = true;
				onInputTransferred?.();
				preflightResult?.("queued");
				return;
			}
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();
			if (!this.model) throw new Error(formatNoModelSelectedMessage());
			const hasConfiguredAuth =
				this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
				(await this._awaitInput(this._modelRuntime.checkAuth(this.model.provider))) !== undefined;
			if (!hasConfiguredAuth) {
				if (this._modelRuntime.isUsingOAuth(this.model.provider))
					throw new Error(
						`Authentication failed for "${this.model.provider}". Credentials may have expired or network is unavailable. Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				const outcome = await this._awaitInput(this._checkCompaction(lastAssistant, false));
				if (outcome === "failed" || outcome === "aborted") {
					const behavior = options?.streamingBehavior ?? "steer";
					if (behavior === "followUp") await this._queueFollowUp(expandedText, currentImages, receipt, submission);
					else await this._queueSteer(expandedText, currentImages, receipt, submission);
					this._inputQueuedBehindPreflight = false;
					this._queueTriggeredBehindPreflight();
					onInputTransferred?.();
					throw new Error(
						`Prompt not sent: compaction ${outcome === "aborted" ? "was cancelled" : "failed"}. Input is retained in the ${behavior} queue. Compact successfully or recover the queued input before resubmitting.`,
					);
				}
			}
			await this._startRun(
				{ messageType: "user", prompt: expandedText, images: currentImages },
				{
					admission,
					receipt,
					submission,
					streamingBehavior: options?.streamingBehavior,
					beforeDispatch: () => {
						this._checkInputAdmission();
						this._queueTriggeredBehindPreflight();
						this._promptPreflights.delete(preflightToken);
					},
					onInputTransferred: () => {
						onInputTransferred?.();
						preflightResult?.("started");
					},
				},
			);
		} finally {
			this._promptPreflights.delete(preflightToken);
			this._runTriggeredBehindPreflight();
			this._runInputQueuedBehindPreflight();
		}
	}

	private _queueTriggeredBehindPreflight(): void {
		for (const { message, deliverAs } of this._triggeredBehindPreflight.splice(0))
			this._enqueueSessionInput(message, deliverAs === "followUp" ? "followUp" : "steer");
	}

	private _runTriggeredBehindPreflight(): void {
		if (this._shutdownCancellation.signal.aborted || this._operatorExitPrepared) return;
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
		if (this.isStreaming || this.isCompacting) {
			this._queueTriggeredBehindPreflight();
			return;
		}
		const [first, ...rest] = this._triggeredBehindPreflight.splice(0);
		void this._startRun(
			{ messageType: "custom", message: first.message },
			{ additionalMessages: rest.map(({ message }) => message) },
		).catch((error: unknown) => {
			this._extensionRunner.emitError({
				extensionPath: "<queue>",
				event: "sendMessage",
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	private _runInputQueuedBehindPreflight(): void {
		if (this._shutdownCancellation.signal.aborted || this._operatorExitPrepared) return;
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

		this._checkInputAdmission();
		this._inputAdmissionScope.getStore()?.release();
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
	): Promise<QueuedInputDisposition> {
		const admission = this._admitInput();
		admission.input = {
			message: { role: "user", content: [{ type: "text", text }, ...(images ?? [])], timestamp: Date.now() },
			mode: behavior,
		};
		admission.receipt = receipt;
		return this._withInputAdmission(admission, () =>
			this._prepareQueuedInput(text, images, behavior, source, receipt),
		);
	}

	private async _prepareQueuedInput(
		text: string,
		images: ImageContent[] | undefined,
		behavior: "steer" | "followUp",
		source: InputSource,
		receipt: TurnReceipt,
	): Promise<QueuedInputDisposition> {
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		const processedInput = await this._runInputHandlers(
			text,
			images,
			source,
			this.isStreaming ? behavior : undefined,
		);
		if (!processedInput) return "handled";

		let expandedText = this._expandSkillCommand(processedInput.text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
		if (processedInput.transformed || expandedText !== text) {
			const originalReceipt = receipt;
			receipt = withoutAttribution(receipt);
			if (receipt !== originalReceipt) this._inputReceiptSources.set(receipt, originalReceipt);
		}

		if (behavior === "steer") {
			await this._queueSteer(expandedText, processedInput.images, receipt);
		} else {
			await this._queueFollowUp(expandedText, processedInput.images, receipt);
		}
		return "queued";
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
	async steer(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<QueuedInputDisposition> {
		return this._queueUserInput(
			text,
			images,
			"steer",
			options?.source ?? "interactive",
			captureTerminalTurnReceipt(),
		);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 * @throws Error if text is an extension command
	 */
	async followUp(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<QueuedInputDisposition> {
		return this._queueUserInput(
			text,
			images,
			"followUp",
			options?.source ?? "interactive",
			captureTerminalTurnReceipt(),
		);
	}

	/** Transfer one session-owned input; raw SDK calls never acquire this authority. */
	private _enqueueSessionInput(
		message: AgentMessage,
		mode: "steer" | "followUp",
		onEnqueued?: (id: number) => void,
	): void {
		this._sessionQueueTransfers.add(message);
		try {
			this.agent[mode](message, onEnqueued);
		} finally {
			this._sessionQueueTransfers.delete(message);
		}
	}

	/** Internal: Queue an already expanded steering message. */
	private async _queueSteer(
		text: string,
		images: ImageContent[] | undefined,
		receipt: TurnReceipt,
		submission?: UserMessageSubmission,
	): Promise<void> {
		this._checkInputAdmission();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }, ...(images ?? [])];
		const message: AgentMessage = { role: "user", content, timestamp: Date.now() };
		const display: QueuedUserMessageDisplay = { message, text };
		this.#attachUserMessageReceipt(message, receipt);
		if (submission) {
			submission.message = message;
			this._userMessageSubmissions.set(message, submission);
		}
		this._unpersistedInputOrder.set(message, ++this._nextInputOrder);
		this._unpersistedInputs.set(message, { message, mode: "steer" });
		this._preparedInputReceipts.set(message, receipt);
		const admission = this._inputAdmissionScope.getStore();
		if (admission) admission.input = undefined;
		this._enqueueSessionInput(message, "steer", (id) => {
			display.occurrenceId = id;
			this._steeringMessages.push(display);
			admission?.release();
		});
		this._emitQueueUpdate();
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(
		text: string,
		images: ImageContent[] | undefined,
		receipt: TurnReceipt,
		submission?: UserMessageSubmission,
	): Promise<void> {
		this._checkInputAdmission();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }, ...(images ?? [])];
		const message: AgentMessage = { role: "user", content, timestamp: Date.now() };
		const display: QueuedUserMessageDisplay = { message, text };
		this.#attachUserMessageReceipt(message, receipt);
		if (submission) {
			submission.message = message;
			this._userMessageSubmissions.set(message, submission);
		}
		this._unpersistedInputOrder.set(message, ++this._nextInputOrder);
		this._unpersistedInputs.set(message, { message, mode: "followUp" });
		this._preparedInputReceipts.set(message, receipt);
		const admission = this._inputAdmissionScope.getStore();
		if (admission) admission.input = undefined;
		this._enqueueSessionInput(message, "followUp", (id) => {
			display.occurrenceId = id;
			this._followUpMessages.push(display);
			admission?.release();
		});
		this._emitQueueUpdate();
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
		this._checkInputAdmission();
		this._shutdownCancellation.signal.throwIfAborted();
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
		this._preparedInputReceipts.set(appMessage, receipt);
		this._unpersistedInputOrder.set(appMessage, ++this._nextInputOrder);
		this._unpersistedInputs.set(appMessage, {
			message: appMessage,
			mode:
				options?.deliverAs === "nextTurn"
					? "nextTurn"
					: options?.triggerTurn === false
						? "context"
						: (options?.deliverAs ?? (options?.triggerTurn ? "steer" : "context")),
		});
		this._queuedInputRevision++;
		try {
			await this._deliverCustomMessage(appMessage, options);
		} catch (error) {
			if (!this._operatorExitPrepared && this._unpersistedInputs.delete(appMessage)) this._queuedInputRevision++;
			throw error;
		}
		// Publication failure after insertion cannot orphan the queued input.
		if (options?.deliverAs === "nextTurn") this._emitQueueUpdate();
	}

	private async _deliverCustomMessage(
		appMessage: CustomMessage,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const fenceScope = this._inputFenceScope.getStore();
		const inheritedAdmission = this._inputAdmissionScope.getStore();
		const cancellation = this._dispatchCancellationScope.getStore();
		cancellation?.throwIfAborted();
		inheritedAdmission?.signal.throwIfAborted();
		this._assertInputsOpen();
		this._shutdownCancellation.signal.throwIfAborted();
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming && options?.triggerTurn !== false) {
			this._enqueueSessionInput(appMessage, options?.deliverAs === "followUp" ? "followUp" : "steer");
		} else if (options?.triggerTurn) {
			if (this._modelSwitchCompactionPending) {
				if (this._compactionHookScope.getStore() || this._agentSettledScope.getStore()?.active) {
					this._triggeredBehindPreflight.push({ message: appMessage, deliverAs: options.deliverAs });
					return;
				}
				const ticket = { deliverAs: options.deliverAs };
				this._modelSwitchDispatches.set(appMessage, ticket);
				try {
					while (this._modelSwitchCompactionPending) await this._awaitInput(this._modelSwitchAdmissionWait);
					const dispatch = async () => {
						if (this._modelSwitchDispatches.get(appMessage) !== ticket) return;
						this._modelSwitchDispatches.delete(appMessage);
						await this._dispatchCancellationScope.run(cancellation, () =>
							this._inputFenceScope.run(fenceScope, () => {
								const deliver = () => this._deliverCustomMessage(appMessage, options);
								return inheritedAdmission
									? this._inputAdmissionScope.run(inheritedAdmission, deliver)
									: this._inputAdmissionScope.exit(deliver);
							}),
						);
					};
					if (this._isEmittingAgentSettled) {
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
				const dispatch = () =>
					this._dispatchCancellationScope.run(cancellation, () =>
						this._inputFenceScope.run(fenceScope, () => {
							const deliver = () => this._deliverCustomMessage(appMessage, options);
							return inheritedAdmission
								? this._inputAdmissionScope.run(inheritedAdmission, deliver)
								: this._inputAdmissionScope.exit(deliver);
						}),
					);
				if (this._agentSettledScope.getStore()?.active) {
					this._deferredSettledActions.push(dispatch);
					return;
				}
				await this._awaitInput(
					raceWithAbortSignal(
						new Promise<void>((resolve, reject) => {
							this._deferredSettledActions.push(async () => {
								try {
									await dispatch();
									resolve();
								} catch (error) {
									reject(error);
								}
							});
						}),
						this._shutdownCancellation.signal,
					),
				);
				return;
			}
			if (this._promptPreflights.size > 0) {
				this._triggeredBehindPreflight.push({ message: appMessage, deliverAs: options.deliverAs });
				return;
			}
			await this._startRun({ messageType: "custom", message: appMessage });
		} else if (this.isStreaming) {
			// Appending now would put the message between an assistant tool call and its
			// result, which providers that validate message order reject on replay. Defer
			// to the end of the turn. Nothing is emitted yet: message events must not
			// describe messages the session tree does not contain.
			this._pendingCustomMessages.push(appMessage);
		} else {
			this._appendCustomMessage(appMessage);
		}
	}

	private _appendCustomMessage(appMessage: CustomMessage, beforePublication?: () => void): void {
		const entryId = appendReceivedCustomMessage(
			this.sessionManager,
			appMessage.customType,
			appMessage.content,
			appMessage.display,
			appMessage.details,
			this.#receivedMessageReceipts.get(appMessage),
		);
		const receipt = this.#receivedMessageReceipts.get(appMessage);
		if (receipt) {
			this._persistedInputReceipts.add(receipt);
			const source = this._inputReceiptSources.get(receipt);
			if (source) this._persistedInputReceipts.add(source);
		}
		if (this._unpersistedInputs.delete(appMessage)) this._preparedInputReceipts.delete(appMessage);
		this._queuedInputRevision++;
		this.#receivedMessageReceipts.delete(appMessage);
		this._entryIdsByMessage.set(appMessage, entryId);
		beforePublication?.();
		this._refreshFinalizedContext();
		this._emit({ type: "message_start", message: appMessage });
		this._emit({ type: "message_end", message: appMessage });
	}

	/**
	 * Append custom messages queued while the agent was running.
	 * Called once the current turn's tool results are in agent state and session history.
	 */
	private _flushPendingCustomMessages(): void {
		if (this._pendingCustomMessages.length === 0) return;

		// Commit each head before publication; retain the failed append and its suffix.
		while (this._pendingCustomMessages.length > 0) {
			this._appendCustomMessage(this._pendingCustomMessages[0], () => this._pendingCustomMessages.shift());
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
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options: SendUserMessageOptions & { metadata: UserMessageMetadata },
	): Promise<SendUserMessageResult>;
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: Omit<SendUserMessageOptions, "metadata"> & { metadata?: undefined },
	): Promise<void>;
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options: SendUserMessageOptions,
		// biome-ignore lint/suspicious/noConfusingVoidType: Optional metadata selects either contract.
	): Promise<void | SendUserMessageResult>;
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: SendUserMessageOptions,
		// biome-ignore lint/suspicious/noConfusingVoidType: Legacy sends retain Promise<void>.
	): Promise<void | SendUserMessageResult> {
		return this._sendUserMessage(content, options);
	}

	private async _sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options: SendUserMessageOptions | undefined,
		// biome-ignore lint/suspicious/noConfusingVoidType: Legacy sends retain Promise<void>.
	): Promise<void | SendUserMessageResult> {
		// Capture once, before choosing a receipt route, admission, or extension hooks.
		const requestedMetadata = options?.metadata;
		const metadata = requestedMetadata === undefined ? undefined : snapshotUserMessageMetadata(requestedMetadata);
		const metadataSource = getUserMessageMetadataSource(options);
		const receipt = captureTerminalTurnReceipt();
		const admission = this._admitInput();
		let submission: UserMessageSubmission | undefined;
		const result =
			metadata === undefined
				? undefined
				: new Promise<SendUserMessageResult>((resolve, reject) => {
						const context: UserMessageSubmission = {
							metadata,
							metadataSource,
							resolve: (value) => {
								if (!this._pendingUserMessageSubmissions.delete(context)) return;
								resolve(value);
							},
							reject: (error) => {
								if (!this._pendingUserMessageSubmissions.delete(context)) return;
								// Queues survive abort/reload; metadata stays occurrence-local until persistence or clear.
								reject(error);
							},
						};
						submission = context;
						this._pendingUserMessageSubmissions.add(context);
					});
		const operation = this._withInputAdmission(admission, async () => {
			let text: string;
			let images: ImageContent[] | undefined;
			if (typeof content === "string") text = content;
			else {
				const textParts: string[] = [];
				images = [];
				for (const part of content) {
					if (part.type === "text") textParts.push(part.text);
					else images.push(part);
				}
				text = textParts.join("\n");
				if (images.length === 0) images = undefined;
			}
			const input = receiveInput(text, images, receipt);
			admission.input = {
				message: { role: "user", content: [{ type: "text", text }, ...(images ?? [])], timestamp: Date.now() },
				mode: options?.deliverAs ?? "steer",
				...(metadata ? { metadata, metadataSource } : {}),
			};
			admission.receipt = receipt;
			await this._promptInAdmission(
				input.text,
				{
					expandPromptTemplates: options?.expandPromptTemplates ?? false,
					streamingBehavior: options?.deliverAs,
					images: input.images,
					source: "extension",
				},
				admission,
				getInputReceipt(input),
				submission,
			);
		});
		if (!result) return await operation;
		void operation.catch((error: unknown) => {
			if (!submission?.message || !this.agent.getQueuedMessages().includes(submission.message))
				submission?.reject(error);
		});
		return result;
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = this._steeringMessages.map((entry) => entry.text);
		const followUp = this._followUpMessages.map((entry) => entry.text);
		this._steeringMessages = [];
		this._followUpMessages = [];
		for (const message of [
			...this._triggeredBehindPreflight.map(({ message }) => message),
			...this._modelSwitchDispatches.keys(),
		])
			this._unpersistedInputs.delete(message);
		this._triggeredBehindPreflight.splice(0);
		this._modelSwitchDispatches.clear();
		for (const message of this.agent.getQueuedMessages()) {
			this._userMessageSubmissions
				.get(message)
				?.reject(new InputAdmissionError("INPUT_ADMISSION_ABORTED", "queued user message was cleared"));
			this._userMessageSubmissions.delete(message);
		}
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		this._resolveIdleWaitIfIdle();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._inputAdmissions.size + this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages.map((entry) => entry.text);
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages.map((entry) => entry.text);
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	cancelForShutdown(): void {
		this._shutdownCancellation.abort(
			new InputAdmissionError("INPUT_ADMISSION_SHUTDOWN", "operation cancelled for shutdown"),
		);
		this._settlementCancellation.abort(
			new InputAdmissionError("INPUT_ADMISSION_ABORTED", "settlement cancelled for shutdown"),
		);
		this.abortBash();
	}

	get shutdownSignal(): AbortSignal {
		return this._shutdownCancellation.signal;
	}

	private _rejectPendingUserMessageSubmissions(error: InputAdmissionError): void {
		for (const submission of this._pendingUserMessageSubmissions) submission.reject(error);
	}

	async abort(): Promise<void> {
		this._rejectPendingUserMessageSubmissions(
			new InputAdmissionError("INPUT_ADMISSION_ABORTED", "user message was not persisted before abort"),
		);
		for (const admission of this._inputAdmissions) {
			admission.controller.abort(new InputAdmissionError("INPUT_ADMISSION_ABORTED", "input was not transferred"));
		}
		if (this._isAgentRunActive) this._agentRunAbortRequested = true;
		this._retainModelSwitchDispatches();
		this._queueTriggeredBehindPreflight();
		this.abortRetry();
		this.abortCompaction();
		this.abortBranchSummary();
		if (this._isBeforeSettle) this._abortDuringBeforeSettle = true;
		this.#originalAgent.abort();
		this._resolveIdleWaitIfIdle();
		await this.waitForIdle();
		if (this._shutdownCancellation.signal.aborted && !this._settlementActionScope.getStore()?.active)
			await this._settlementCompletion;
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
		for (const [message, { deliverAs }] of this._modelSwitchDispatches)
			this._enqueueSessionInput(message, deliverAs === "followUp" ? "followUp" : "steer");
		this._modelSwitchDispatches.clear();
	}

	private async _compactForModelSwitch(model: Model<any>, guardedCommit: () => void): Promise<void> {
		this._inheritedCancellation();
		const commit = () => {
			this._inheritedCancellation();
			guardedCommit();
		};
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
			commit();
			committed = true;
		} catch (error) {
			throw new Error(
				`${refusal} ${error instanceof Error ? error.message : String(error)} Current model unchanged.`,
				{ cause: error },
			);
		} finally {
			this._modelSwitchCompactionPending = false;
			if (!committed) {
				this._retainModelSwitchDispatches();
				this._queueTriggeredBehindPreflight();
			}
			this._resolveModelSwitchAdmissionWait?.();
			this._resolveModelSwitchAdmissionWait = undefined;
			this._resolveIdleWaitIfIdle();
		}
	}

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
		const inherited = this._inheritedCancellation();
		const signals = [inherited, options.signal].filter((item): item is AbortSignal => item !== undefined);
		const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
		const assertLive = () => {
			signal?.throwIfAborted();
			if (this._inputsDisposed) throw new InputAdmissionError("INPUT_ADMISSION_DISPOSED", "model was not changed");
		};
		assertLive();
		const auth = this._modelRuntime.checkAuth(model.provider);
		if (!(await (signal ? raceWithAbortSignal(auth, signal) : auth)))
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		assertLive();
		const previousModel = this.model;
		await this._compactForModelSwitch(model, () => {
			assertLive();
			const thinkingLevel = this._getThinkingLevelForModelSwitch(model);
			this.agent.state.model = model;
			this.sessionManager.appendModelChange(model.provider, model.id);
			if (options.persist) {
				this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
				this._addPersistedDefaultToNonEmptyScope(model);
			}
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
		this._inheritedCancellation();
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
	private async _runDefaultCompaction(
		preparation: CompactionPreparation,
		model: Model<any>,
		customInstructions: string | undefined,
		signal: AbortSignal,
		reason: "manual" | "threshold" | "overflow",
	): Promise<CompactionResult> {
		const request = await raceWithAbortSignal(this._getSummarizationRequestAuth(model, signal), signal);
		const callbacks = this._summarizationRetryCallbacks({ source: "compaction", reason });
		try {
			return await raceWithAbortSignal(
				compact(
					preparation,
					request.model,
					request.apiKey,
					request.headers,
					customInstructions,
					signal,
					request.thinkingLevel,
					this.agent.streamFunction,
					request.env,
					COMPACTION_RETRY_POLICY,
					callbacks,
					undefined,
				),
				signal,
			);
		} finally {
			await callbacks.onRetryFinished?.(false, 0);
		}
	}

	private _clearManualCompactionState(controller: AbortController): void {
		if (this._compactionAbortController === controller) this._compactionAbortController = undefined;
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
		const admission = this._inputAdmissionScope.getStore();
		const ownsHeldAdmission = admission !== undefined && this._inputAdmissions.has(admission);
		const inherited = this._inheritedCancellation();
		const dispatch = this._dispatchCancellationScope.getStore();
		this._assertInputsOpen();
		await this.abort();
		const revocation = ownsHeldAdmission ? (dispatch === admission.signal ? admission.parent : dispatch) : inherited;
		revocation?.throwIfAborted();
		if (this._inputsDisposed) throw new InputAdmissionError("INPUT_ADMISSION_DISPOSED", "compaction was not started");
		this._shutdownCancellation.signal.throwIfAborted();
		this._assertInputsOpen();
		if (!ownsHeldAdmission) return this.#compactSession(customInstructions, revocation);
		return this._inputAdmissionScope.exit(() =>
			this._dispatchCancellationScope.run(revocation, () => this.#compactSession(customInstructions, revocation)),
		);
	}

	async #compactSession(customInstructions?: string, inherited?: AbortSignal): Promise<CompactionResult> {
		const controller = new AbortController();
		this._compactionAbortController = controller;
		const signal = inherited ? AbortSignal.any([controller.signal, inherited]) : controller.signal;
		const timeout = startCompactionDeadline(controller);
		let fromExtension = false;
		let cancelledByExtension = false;
		try {
			this._emit({ type: "compaction_start", reason: "manual" });
			const model = this.model;
			if (!model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const settings = this.settingsManager.getCompactionSettings(model);
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

			let extensionCompaction: CompactionResult | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = await this._emitCompactionHook(
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
				);

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
				const result = await this._runDefaultCompaction(preparation, model, customInstructions, signal, "manual");
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				usage = result.usage;
				details = result.details;
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

			const savedCompactionEntry = this.sessionManager.getEntry(compactionId) as CompactionEntry | undefined;
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
			// compaction_end listeners may submit queued prompts, so expose idle state before notifying them.
			clearTimeout(timeout);
			this._completingCompaction = controller;
			this._clearManualCompactionState(controller);
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = cancelledByExtension || isCompactionCancelled(signal);
			const errorMessage = aborted ? undefined : `Compaction failed: ${message}`;
			await this._emitSessionCompactFailed(
				{ reason: "manual", errorMessage, aborted, willRetry: false, fromExtension },
				signal,
				false,
				() => {
					this._clearManualCompactionState(controller);
					this._emit({
						type: "compaction_end",
						reason: "manual",
						result: undefined,
						aborted,
						willRetry: false,
						errorMessage,
					});
				},
			);
			throw aborted ? new Error("Compaction cancelled", { cause: error }) : error;
		} finally {
			clearTimeout(timeout);
			this._clearManualCompactionState(controller);
			if (this._completingCompaction === controller) this._completingCompaction = undefined;
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		const active =
			this._compactionAbortController ||
			this._autoCompactionAbortController ||
			this._completingCompaction ||
			this._compactionHooks.size > 0;
		if (active && this._isAgentRunActive) {
			this._agentRunAbortRequested = true;
			this._compactionStopOutcome = "aborted";
			this.#originalAgent.abort();
		}
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
		this._completingCompaction?.abort();
		for (const hook of this._compactionHooks) hook.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort(
			new InputAdmissionError("INPUT_ADMISSION_ABORTED", "tree navigation cancelled"),
		);
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
	 * @returns Whether the post-run loop should call `agent.continue()` for overflow recovery or queued messages
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

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model. Under a virtual selection, the
		// physical model that produced the message supplies the limits.
		const messageModel = this._modelForMessage(assistantMessage);
		const sameModel = messageModel !== undefined;
		const contextWindow = (messageModel ?? this.model)?.contextWindow ?? 0;

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
			sameModel && assistantIsProjected && isRecoverableLength(assistantMessage, messageModel.maxTokens);
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
				await this._emitSessionCompactFailed(
					{ reason: "overflow", errorMessage, aborted: false, willRetry: false, fromExtension: false },
					undefined,
					false,
					() =>
						this._emit({
							type: "compaction_end",
							reason: "overflow",
							result: undefined,
							aborted: false,
							willRetry: false,
							errorMessage,
						}),
				);
				return "failed";
			}

			// Persistently omit the selected final attempt before post-run recovery compaction.
			this._overflowRecoveryAttempted = true;
			this._omitRecoveryAttempt(assistantMessage, toolResults);
			const retry = await this._runAutoCompaction("overflow", willRetry);
			if (retry === true) this._failedResponse = assistantMessage;
			return retry;
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
	 * @returns Whether the post-run loop should call `agent.continue()`
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<CompactionOutcome> {
		const model = this.model;
		const settings = this.settingsManager.getCompactionSettings(model);
		if (this.isCompacting) return "failed";
		const abortController = new AbortController();
		this._autoCompactionAbortController = abortController;
		const signal = abortController.signal;
		const timeout = startCompactionDeadline(abortController);
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
			abortController.signal.throwIfAborted();

			let extensionCompaction: CompactionResult | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = await this._emitCompactionHook(
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
				);

				if (extensionResult?.cancel) {
					cancelledByExtension = true;
					throw new Error("Compaction cancelled");
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}
			abortController.signal.throwIfAborted();

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
				const compactResult = await this._runDefaultCompaction(
					preparation,
					model,
					undefined,
					abortController.signal,
					reason,
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}
			abortController.signal.throwIfAborted();

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

			const savedCompactionEntry = this.sessionManager.getEntry(compactionId) as CompactionEntry | undefined;
			if (this._extensionRunner && savedCompactionEntry) {
				await this._emitCompactionHook(
					{ type: "session_compact", compactionEntry: savedCompactionEntry, fromExtension, reason, willRetry },
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
			this._completingCompaction = abortController;
			if (this._autoCompactionAbortController === abortController) this._autoCompactionAbortController = undefined;
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });
			if (signal.aborted) return "aborted";

			if (willRetry) return true;

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const message = error instanceof Error ? error.message : "compaction failed";
			const aborted = cancelledByExtension || isCompactionCancelled(signal);
			if (started || signal.aborted) {
				const errorMessage = aborted
					? undefined
					: reason === "overflow"
						? `Context overflow recovery failed: ${message}`
						: `Auto-compaction failed: ${message}`;
				await this._emitSessionCompactFailed(
					{ reason, errorMessage, aborted, willRetry: false, fromExtension },
					signal,
					false,
					() =>
						this._emit({
							type: "compaction_end",
							reason,
							result: undefined,
							aborted,
							willRetry: false,
							errorMessage,
						}),
				);
			}
			return aborted ? "aborted" : "failed";
		} finally {
			clearTimeout(timeout);
			if (this._autoCompactionAbortController === abortController) {
				this._autoCompactionAbortController = undefined;
			}
			if (this._completingCompaction === abortController) this._completingCompaction = undefined;
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

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		this._shutdownCancellation.signal.throwIfAborted();
		if (bindings.hasPendingInput !== undefined) this.#pendingModeInput = bindings.hasPendingInput;
		if (bindings.getPendingInputs !== undefined) this.#getPendingModeInputs = bindings.getPendingInputs;
		if (bindings.clearPendingInputs !== undefined) this.#clearPendingModeInputs = bindings.clearPendingInputs;
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
		this._extensionRunner.reportUnhandledMcpServers();
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
			const baseDir = isSyntheticPath(entry.extensionPath) ? undefined : dirname(entry.extensionPath);
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
		if (isSyntheticPath(extensionPath)) {
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
					const reportError = (err: unknown) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					};
					// Detach scheduling, but preserve cancellation and the loader-owned source identity.
					if (options?.metadata !== undefined) {
						const metadataOptions = options as SendUserMessageOptions & { metadata: UserMessageMetadata };
						const result = this._agentSettledScope.exit(() => this.sendUserMessage(content, metadataOptions));
						void result.catch(reportError);
						return result;
					}
					void this._agentSettledScope
						.exit(() =>
							this.sendUserMessage(content, {
								deliverAs: options?.deliverAs,
								expandPromptTemplates: options?.expandPromptTemplates,
							}),
						)
						.catch(reportError);
				},
				appendEntry: (customType, data) => {
					this._inheritedCancellation();
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
					this._inheritedCancellation();
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				getSettings: () => this.settingsManager.getSettings(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				inheritedCancellation: () => this._inheritedCancellation(),
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
				executeTool: (callerId, name, args, options) => this._executeNestedToolCall(callerId, name, args, options),
				getCallableTools: () => this._getCallableTools(),
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
				registerVirtualModel: (definition) => {
					this._modelRuntime.registerVirtualModel(definition);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterVirtualModel: (provider, id) => {
					this._modelRuntime.unregisterVirtualModel(provider, id);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		// Tools that were already activated on registration. A tool whose exposure changes to
		// `direct` or `model-only` (for example from `hidden`) is activated like a new tool.
		const previousActivatedOnRegistration = new Set(
			[...this._toolRegistry.keys()].filter((name) => this._isActivatedOnRegistration(name)),
		);
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedTools = this._allowedTools;

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => this._isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => this._isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${name}`, { source: "builtin" }),
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
				.filter((definition) => this._isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${definition.name}`, {
						source: "builtin",
					}),
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
		).filter((name) => this._isAllowedTool(name));

		if (allowedTools) {
			for (const toolName of this._toolRegistry.keys()) {
				// Naming or matching a tool activates it even when it is not active by default. MCP tools
				// kept registered without being named stay inactive.
				if (allowedTools(toolName) && this._isDeclarable(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				if (this._isActivatedOnRegistration(tool.name)) nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousActivatedOnRegistration.has(toolName) && this._isActivatedOnRegistration(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}
		// Pending tools that are registered now become active.
		nextActiveToolNames.push(...this._pendingToolNames);

		this._setActiveTools([...new Set(nextActiveToolNames)]);
	}

	/** Whether activating the tool declares it to the model. */
	private _isDeclarable(name: string): boolean {
		const exposure = this._getToolExposure(name);
		return exposure === "direct" || exposure === "model-only";
	}

	/** Whether registering the tool activates it, which declares it to the model. */
	private _isActivatedOnRegistration(name: string): boolean {
		return this._isDeclarable(name) && this._toolDefinitions.get(name)?.definition.defaultActive !== false;
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
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
		const oldRunner = this._extensionRunner;
		const previousFlagValues = oldRunner.getFlagValues();
		const rejection = new InputAdmissionError(
			"INPUT_ADMISSION_ABORTED",
			"user message was not persisted before reload",
		);
		this._rejectPendingUserMessageSubmissions(rejection);
		await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		this._rejectPendingUserMessageSubmissions(rejection);
		oldRunner.invalidate();
		const getDefaultTools = () =>
			this._usesDefaultTools
				? applyToolModifiers(
						this.settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES,
						this._defaultToolModifiers,
					)
				: [];
		const previousDefaultTools = new Set(getDefaultTools());
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		this._shutdownCancellation.signal.throwIfAborted();
		this._extensionRunner.invalidate();
		// Activate tools newly added to defaultTools. Removed ones stay active, and tools disabled
		// during the session stay disabled unless the setting newly adds them.
		const addedDefaultTools = getDefaultTools().filter((name) => !previousDefaultTools.has(name));
		// Tools the new extensions register later, such as MCP tools, are pending until then.
		for (const name of this.getActiveToolNames()) this._pendingToolNames.add(name);
		this._buildRuntime({
			activeToolNames: [...this.getActiveToolNames(), ...addedDefaultTools],
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			this._extensionRunner.reportUnhandledMcpServers();
			await this.extendResourcesFromExtensions("reload");
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
		if (isRetryableCodexStreamDisconnect(message))
			return !this._assistantToolExecutionStarted && !this._codexStreamDisconnectRetryUsed;
		const observed = this._assistantStreamObserved;
		if (observed.answer || (this._assistantOutputObserved && !isPrematureStreamError(message))) return false;
		if (isContextOverflow(message, (this._modelForMessage(message) ?? this.model)?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message, observed);
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
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
		if (this._retryAttempt === 0) return;
		const attempt = this._retryAttempt;
		this._retryAttempt = 0;
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
		if (!settings.enabled) return false;
		if (isRetryableCodexStreamDisconnect(message)) {
			if (settings.maxRetries <= 0 || this._assistantToolExecutionStarted || this._codexStreamDisconnectRetryUsed)
				return false;
			this._codexStreamDisconnectRetryUsed = true;
			this._retryAttempt++;
			return this._waitAndRetry(message, retryDelayMs(settings, 1), this._retryAttempt);
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		return this._waitAndRetry(message, retryDelayMs(settings, this._retryAttempt), settings.maxRetries);
	}

	private _getRetrySettings(message: AssistantMessage): RetryPolicy {
		const settings = this.settingsManager.getRetrySettings();
		return isPrematureStreamError(message) ? { ...settings, maxRetries: Math.min(2, settings.maxRetries) } : settings;
	}

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
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			this._finishCancelledRetry();
			return false;
		} finally {
			this._retryAbortController = undefined;
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
		const inherited = this._inheritedCancellation();
		this._assertInputsOpen();
		this._shutdownCancellation.signal.throwIfAborted();
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);
		const signal = inherited ? AbortSignal.any([abortController.signal, inherited]) : abortController.signal;

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
					signal,
				},
			);

			options?.beforeRecord?.();
			// Already-started work keeps its cancelled receipt after in-flight revocation.
			this._appendBashResult(command, result, options);
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
		this._inheritedCancellation();
		this._appendBashResult(command, result, options);
	}

	private _appendBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		if (this._inputsDisposed)
			throw new InputAdmissionError("INPUT_ADMISSION_DISPOSED", "bash result was not recorded");
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			fullOutputTruncation: result.fullOutputTruncation,
			fullOutputError: result.fullOutputError,
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
		this._inheritedCancellation();
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
		const inherited = this._inheritedCancellation();
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
			...(inherited ? [inherited] : []),
		]);
		const emitTreeHook = (event: Parameters<ExtensionRunner["emit"]>[0]) =>
			this._dispatchCancellationScope.run(navigationSignal, () =>
				this._extensionRunner.emit(event, navigationSignal),
			);

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await emitTreeHook({
					type: "session_before_tree",
					preparation,
					signal: navigationSignal,
				})) as SessionBeforeTreeResult | undefined;

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
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					...(await raceWithAbortSignal(
						this._getSummarizationRequestAuth(this.model!, navigationSignal),
						navigationSignal,
					)),
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

			// Navigation committed; cancel its observer without claiming rollback.
			try {
				await emitTreeHook({
					type: "session_tree",
					newLeafId: this.sessionManager.getLeafId(),
					oldLeafId,
					summaryEntry,
					fromExtension: summaryText ? fromExtension : undefined,
				});
			} catch (cause) {
				if (!navigationSignal.aborted || cause !== navigationSignal.reason) throw cause;
			}

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
		const model = this._limitsModel();
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

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
		const themeName = [options.themeName, this.settingsManager.getTheme()].find(
			(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
		);

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolRenderers: (name) =>
				this._extensionRunner.resolveToolRenderers(name, () => this.getToolDefinition(name)),
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
		return exportSessionToJsonl(this.sessionManager, outputPath);
	}

	/**
	 * Ask the current model to describe what went wrong in this session for a bug report.
	 * Used when the user declines to share the transcript itself.
	 */
	async summarizeForBugReport(options: { hint?: string; signal: AbortSignal }): Promise<string> {
		const inherited = this._inheritedCancellation();
		this._disposalCancellation.signal.throwIfAborted();
		const signal = AbortSignal.any(
			[options.signal, this._shutdownCancellation.signal, this._disposalCancellation.signal, inherited].filter(
				(item): item is AbortSignal => item !== undefined,
			),
		);
		signal.throwIfAborted();
		const model = this.model;
		if (!model) {
			throw new Error("No model selected");
		}
		const auth = await raceWithAbortSignal(this._getSummarizationRequestAuth(model, signal), signal);
		signal.throwIfAborted();
		return generateBugReportSummary({
			...auth,
			messages: this.messages,
			hint: options.hint,
			signal,
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
		context.sendUserMessage = bindExtensionMetadataSender(this.sendUserMessage.bind(this));
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
