/**
 * Extension runner - executes extensions and manages their lifecycle.
 */

import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	getCurrentSystemMessage,
	type ImageContent,
	type Model,
	type Provider,
	type ProviderHeaders,
} from "@earendil-works/pi-ai";
import type { KeyId } from "@earendil-works/pi-tui";
import { type Theme, theme } from "../../modes/interactive/theme/theme.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import type { CacheWarmingAction } from "../cache-warmer.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { KeybindingsConfig } from "../keybindings.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ScopedModel } from "../model-resolver.ts";
import { detachedSessionView, type SessionManager } from "../session-manager.ts";
import {
	type BuildSystemPromptOptions,
	buildSystemPrompt,
	type NormalizedBuildSystemPromptOptions,
	normalizeBuildSystemPromptOptions,
} from "../system-prompt.ts";
import type {
	AgentBeforeSettleEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	BoundaryContextPreview,
	BoundaryResult,
	CacheWarmingDecisionEvent,
	CacheWarmingDecisionEventResult,
	CompactOptions,
	ContextEvent,
	ContextEventResult,
	ContextUsage,
	ContextWithSystemEvent,
	EntryRenderer,
	Extension,
	ExtensionActions,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFlag,
	ExtensionMode,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	InputEvent,
	InputEventResult,
	InputSource,
	LoadExtensionsResult,
	MarkdownTransformer,
	MessageEndEvent,
	MessageEndEventResult,
	MessageRenderer,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventResult,
	ProviderConfig,
	RegisteredCommand,
	RegisteredTool,
	ReplacedSessionContext,
	ResolvedCommand,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionBeforeCompactResult,
	SessionBeforeForkResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionBoundaryDraft,
	SessionShutdownEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	TurnEndEvent,
	UIPromptKind,
	UserBashEvent,
	UserBashEventResult,
} from "./types.ts";

// Extension shortcuts compete with canonical keybinding ids from keybindings.json.
// Only editor-global shortcuts are reserved here. Picker-specific bindings are not.
const RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = [
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.thinking.cycle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.editor.external",
	"app.message.copy",
	"app.message.followUp",
	"tui.input.submit",
	"tui.select.confirm",
	"tui.select.cancel",
	"tui.input.copy",
	"tui.editor.deleteToLineEnd",
] as const;

type BuiltInKeyBindings = Partial<Record<KeyId, { keybinding: string; restrictOverride: boolean }>>;

const buildBuiltinKeybindings = (resolvedKeybindings: KeybindingsConfig): BuiltInKeyBindings => {
	const builtinKeybindings = {} as BuiltInKeyBindings;
	for (const [keybinding, keys] of Object.entries(resolvedKeybindings)) {
		if (keys === undefined) continue;
		const keyList = Array.isArray(keys) ? keys : [keys];
		const restrictOverride = (RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS as readonly string[]).includes(keybinding);
		for (const key of keyList) {
			const normalizedKey = key.toLowerCase() as KeyId;
			// If multiple actions bind the same key, the reserved action wins so extensions
			// remain blocked by reserved shortcuts regardless of iteration order.
			const existing = builtinKeybindings[normalizedKey];
			if (existing?.restrictOverride && !restrictOverride) continue;
			builtinKeybindings[normalizedKey] = {
				keybinding,
				restrictOverride,
			};
		}
	}
	return builtinKeybindings;
};

function isUserBashEventResult(value: unknown): value is UserBashEventResult {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	const hasOperations = candidate.operations !== undefined;
	const hasResult = candidate.result !== undefined;
	if (hasOperations === hasResult) return false;

	if (hasOperations) {
		const operations = candidate.operations;
		if (typeof operations !== "object" || operations === null) return false;
		return typeof (operations as Record<string, unknown>).exec === "function";
	}

	const result = candidate.result;
	if (typeof result !== "object" || result === null) return false;
	const resultRecord = result as Record<string, unknown>;
	return (
		typeof resultRecord.output === "string" &&
		"exitCode" in resultRecord &&
		(resultRecord.exitCode === undefined || typeof resultRecord.exitCode === "number") &&
		typeof resultRecord.cancelled === "boolean" &&
		typeof resultRecord.truncated === "boolean" &&
		(resultRecord.fullOutputPath === undefined || typeof resultRecord.fullOutputPath === "string")
	);
}

/** Combined result from all before_agent_start handlers. */
interface BeforeAgentStartCombinedResult {
	messages: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPromptOptions: NormalizedBuildSystemPromptOptions;
}

/**
 * Events handled by the generic emit() method.
 * Events with dedicated emitXxx() methods are excluded for stronger type safety.
 */
type RunnerEmitEvent = Exclude<
	ExtensionEvent,
	| ToolCallEvent
	| ProjectTrustEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| ContextWithSystemEvent
	| CacheWarmingDecisionEvent
	| BeforeProviderRequestEvent
	| BeforeProviderHeadersEvent
	| BeforeAgentStartEvent
	| MessageEndEvent
	| ResourcesDiscoverEvent
	| InputEvent
	| TurnEndEvent
	| AgentBeforeSettleEvent
>;

type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{ type: "session_before_switch" | "session_before_fork" | "session_before_compact" | "session_before_tree" }
>;

type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeForkResult
	| SessionBeforeCompactResult
	| SessionBeforeTreeResult;

type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_fork" }
		? SessionBeforeForkResult | undefined
		: TEvent extends { type: "session_before_compact" }
			? SessionBeforeCompactResult | undefined
			: TEvent extends { type: "session_before_tree" }
				? SessionBeforeTreeResult | undefined
				: undefined;

export type ExtensionErrorListener = (error: ExtensionError) => void;

type BoundaryBaseEvent =
	| Omit<TurnEndEvent, "entries" | "continue" | "context">
	| Omit<AgentBeforeSettleEvent, "entries" | "continue" | "context">;

interface BoundaryDispatchResult {
	entries: SessionBoundaryDraft[];
	continue: boolean;
	context: BoundaryContextPreview;
	valid: boolean;
}

export type NewSessionHandler = (options?: {
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

export type ForkHandler = (
	entryId: string,
	options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

export type NavigateTreeHandler = (
	targetId: string,
	options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
) => Promise<{ cancelled: boolean }>;

export type SwitchSessionHandler = (
	sessionPath: string,
	options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

export type ReloadHandler = () => Promise<void>;

export type ShutdownHandler = () => void;

/**
 * Helper function to emit session_shutdown event to extensions.
 * Returns true if the event was emitted, false if there were no handlers.
 */
export async function emitSessionShutdownEvent(
	extensionRunner: ExtensionRunner,
	event: SessionShutdownEvent,
	signal?: AbortSignal,
): Promise<boolean> {
	if (extensionRunner.hasHandlers("session_shutdown")) {
		await extensionRunner.emit(event, signal);
		return true;
	}
	return false;
}

function snapshotEventHandlers(extensions: Extension[], event: ExtensionEvent["type"]) {
	return extensions.map((ext) => ({ ext, handlers: ext.handlers.get(event)?.slice() ?? [] }));
}

function sameMessages(left: AgentMessage[], right: AgentMessage[]): boolean {
	return left.length === right.length && left.every((message, index) => message === right[index]);
}

/**
 * Re-attach the prompt and tool state after a `context` handler. Handlers only see the
 * conversation; the system messages belong to Pi. An unchanged conversation keeps every
 * system message in place, so models with mid-conversation support keep their cached
 * prefix. A changed one gets the replayed prompt sections and tool declarations as one
 * leading system message, so pruning, windowing, or slicing from a compaction summary
 * cannot drop them.
 */
function restoreSystemMessages(
	current: AgentMessage[],
	visible: AgentMessage[],
	returned: AgentMessage[],
): AgentMessage[] {
	if (sameMessages(returned, visible)) return current;
	const head = getCurrentSystemMessage(current);
	return head ? [head, ...returned] : returned;
}

export async function emitProjectTrustEvent(
	extensionsResult: LoadExtensionsResult,
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
): Promise<{ result?: ProjectTrustEventResult; errors: ExtensionError[] }> {
	const errors: ExtensionError[] = [];
	for (const { ext, handlers } of snapshotEventHandlers(extensionsResult.extensions, "project_trust")) {
		// A single extension may register multiple handlers for the same event.
		// The first project_trust handler that returns yes/no wins; undecided falls through.
		for (const handler of handlers) {
			try {
				const handlerResult = (await handler(event, ctx)) as ProjectTrustEventResult;
				if (handlerResult.trusted === "undecided") {
					continue;
				}
				return { result: handlerResult, errors };
			} catch (error) {
				errors.push({
					extensionPath: ext.path,
					event: event.type,
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
	}
	return { errors };
}

const noOpUIContext: ExtensionUIContext = {
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
	custom: async () => undefined as never,
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
	setTheme: (_theme: string | Theme) => ({ success: false, error: "UI not available" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

export class ExtensionRunner {
	private extensions: Extension[];
	private runtime: ExtensionRuntime;
	private uiContext: ExtensionUIContext;
	private mode: ExtensionMode = "print";
	private cwd: string;
	private sessionManager: SessionManager;
	private modelRegistry: ModelRegistry;
	private errorListeners: Set<ExtensionErrorListener> = new Set();
	private getModel: () => Model<any> | undefined = () => undefined;
	private getScopedModels: () => readonly ScopedModel[] = () => [];
	private isIdleFn: () => boolean = () => true;
	private isSettlingFn: () => boolean = () => false;
	private isPromptPendingFn: () => boolean = () => false;
	private isProjectTrustedFn: () => boolean = () => true;
	private getSignalFn: () => AbortSignal | undefined = () => undefined;
	private waitForIdleFn: () => Promise<void> = async () => {};
	private abortFn: () => void = () => {};
	private hasPendingMessagesFn: () => boolean = () => false;
	private getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	private compactFn: (options?: CompactOptions) => void = () => {};
	private getSystemPromptFn: () => string = () => "";
	private getSystemPromptOptionsFn: () => BuildSystemPromptOptions = () =>
		normalizeBuildSystemPromptOptions({ cwd: this.cwd });
	private newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	private forkHandler: ForkHandler = async () => ({ cancelled: false });
	private navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	private switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
	private reloadHandler: ReloadHandler = async () => {};
	private shutdownHandler: ShutdownHandler = () => {};
	private shortcutDiagnostics: ResourceDiagnostic[] = [];
	private commandDiagnostics: ResourceDiagnostic[] = [];
	private staleMessage: string | undefined;
	private shutdownSignal: AbortSignal | undefined;
	private uiPromptDepth = 0;
	private activeUIPrompt: { kind: UIPromptKind; title?: string } | undefined;

	constructor(
		extensions: Extension[],
		runtime: ExtensionRuntime,
		cwd: string,
		sessionManager: SessionManager,
		modelRegistry: ModelRegistry,
		shutdownSignal?: AbortSignal,
	) {
		this.extensions = extensions;
		this.runtime = runtime;
		this.uiContext = noOpUIContext;
		this.cwd = cwd;
		this.sessionManager = sessionManager;
		this.modelRegistry = modelRegistry;
		this.shutdownSignal = shutdownSignal;
	}

	bindCore(
		actions: ExtensionActions,
		contextActions: ExtensionContextActions,
		providerActions?: {
			registerProvider?: (name: string, config: ProviderConfig) => void;
			registerNativeProvider?: (provider: Provider) => void;
			unregisterProvider?: (name: string) => void;
		},
	): void {
		// Copy actions into the shared runtime (all extension APIs reference this)
		this.runtime.sendMessage = actions.sendMessage;
		this.runtime.sendUserMessage = actions.sendUserMessage;
		this.runtime.appendEntry = actions.appendEntry;
		this.runtime.setSessionName = actions.setSessionName;
		this.runtime.getSessionName = actions.getSessionName;
		this.runtime.setLabel = actions.setLabel;
		this.runtime.getActiveTools = actions.getActiveTools;
		this.runtime.getAllTools = actions.getAllTools;
		this.runtime.setActiveTools = actions.setActiveTools;
		this.runtime.refreshTools = actions.refreshTools;
		this.runtime.inheritedCancellation = actions.inheritedCancellation;
		this.runtime.getCommands = actions.getCommands;
		this.runtime.setModel = actions.setModel;
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		this.runtime.setThinkingLevel = actions.setThinkingLevel;

		// Context actions (required)
		this.getModel = contextActions.getModel;
		this.getScopedModels = contextActions.getScopedModels;
		this.isIdleFn = contextActions.isIdle;
		this.isSettlingFn = contextActions.isSettling;
		this.isPromptPendingFn = contextActions.isPromptPending ?? (() => false);
		this.isProjectTrustedFn = contextActions.isProjectTrusted;
		this.getSignalFn = contextActions.getSignal;
		this.abortFn = contextActions.abort;
		this.hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.shutdownHandler = contextActions.shutdown;
		this.getContextUsageFn = contextActions.getContextUsage;
		this.compactFn = contextActions.compact;
		this.getSystemPromptFn = contextActions.getSystemPrompt;
		this.getSystemPromptOptionsFn =
			contextActions.getSystemPromptOptions ?? (() => normalizeBuildSystemPromptOptions({ cwd: this.cwd }));

		// Flush provider registrations queued during extension loading
		for (const { name, config, extensionPath } of this.runtime.pendingProviderRegistrations) {
			try {
				if (providerActions?.registerProvider) {
					providerActions.registerProvider(name, config);
				} else {
					this.modelRegistry.registerProvider(name, config);
				}
			} catch (err) {
				this.emitError({
					extensionPath,
					event: "register_provider",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		this.runtime.pendingProviderRegistrations = [];
		for (const { provider, extensionPath } of this.runtime.pendingNativeProviderRegistrations) {
			try {
				if (providerActions?.registerNativeProvider) {
					providerActions.registerNativeProvider(provider);
				} else {
					this.modelRegistry.registerProvider(provider);
				}
			} catch (err) {
				this.emitError({
					extensionPath,
					event: "register_provider",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		this.runtime.pendingNativeProviderRegistrations = [];

		// From this point on, provider registration/unregistration takes effect immediately
		// without requiring a /reload.
		this.runtime.registerProvider = (name, config) => {
			if (providerActions?.registerProvider) {
				providerActions.registerProvider(name, config);
				return;
			}
			this.modelRegistry.registerProvider(name, config);
		};
		this.runtime.registerNativeProvider = (provider) => {
			if (providerActions?.registerNativeProvider) {
				providerActions.registerNativeProvider(provider);
				return;
			}
			this.modelRegistry.registerProvider(provider);
		};
		this.runtime.unregisterProvider = (name) => {
			if (providerActions?.unregisterProvider) {
				providerActions.unregisterProvider(name);
				return;
			}
			this.modelRegistry.unregisterProvider(name);
		};
	}

	bindCommandContext(actions?: ExtensionCommandContextActions): void {
		if (actions) {
			this.waitForIdleFn = actions.waitForIdle;
			this.newSessionHandler = actions.newSession;
			this.forkHandler = actions.fork;
			this.navigateTreeHandler = actions.navigateTree;
			this.switchSessionHandler = actions.switchSession;
			this.reloadHandler = actions.reload;
			return;
		}

		this.waitForIdleFn = async () => {};
		this.newSessionHandler = async () => ({ cancelled: false });
		this.forkHandler = async () => ({ cancelled: false });
		this.navigateTreeHandler = async () => ({ cancelled: false });
		this.switchSessionHandler = async () => ({ cancelled: false });
		this.reloadHandler = async () => {};
	}

	setUIContext(uiContext?: ExtensionUIContext, mode: ExtensionMode = "print"): void {
		const wrapped = uiContext ? this.wrapUIPromptContext(uiContext) : noOpUIContext;
		// A caller may capture ui or an individual method before replacement. Check
		// lifetime at invocation too, not only when ctx.ui is first read.
		this.uiContext = uiContext
			? new Proxy(wrapped, {
					get: (target, key, receiver) => {
						this.assertActive();
						const value: unknown = Reflect.get(target, key, receiver);
						if (typeof value !== "function") return value;
						return (...args: unknown[]) => {
							this.assertActive();
							return Reflect.apply(value, target, args);
						};
					},
				})
			: noOpUIContext;
		this.mode = mode;
	}

	private wrapUIPromptContext(ui: ExtensionUIContext): ExtensionUIContext {
		return {
			...ui,
			select: (title, options, opts) => this.withUIPrompt("select", title, () => ui.select(title, options, opts)),
			confirm: (title, message, opts) => this.withUIPrompt("confirm", title, () => ui.confirm(title, message, opts)),
			input: (title, placeholder, opts) =>
				this.withUIPrompt("input", title, () => ui.input(title, placeholder, opts)),
			editor: (title, prefill) => this.withUIPrompt("editor", title, () => ui.editor(title, prefill)),
			custom: (factory, options) => this.withUIPrompt("custom", undefined, () => ui.custom(factory, options)),
		};
	}

	private withUIPrompt<T>(kind: UIPromptKind, title: string | undefined, run: () => Promise<T>): Promise<T> {
		const outerPrompt = this.uiPromptDepth++ === 0;
		if (outerPrompt) {
			this.activeUIPrompt = { kind, title };
			this.emitUIPromptEvent({ type: "ui_prompt_start", reason: "ui_prompt", kind, ...(title ? { title } : {}) });
		}

		const finish = () => {
			if (--this.uiPromptDepth > 0) return;
			this.uiPromptDepth = 0;

			const prompt = this.activeUIPrompt ?? { kind, title };
			this.activeUIPrompt = undefined;
			this.emitUIPromptEvent({
				type: "ui_prompt_end",
				reason: "ui_prompt",
				kind: prompt.kind,
				...(prompt.title ? { title: prompt.title } : {}),
			});
		};

		try {
			return run().finally(finish);
		} catch (err) {
			finish();
			throw err;
		}
	}

	private emitUIPromptEvent(event: Extract<RunnerEmitEvent, { type: "ui_prompt_start" | "ui_prompt_end" }>): void {
		queueMicrotask(() => {
			void this.emit(event);
		});
	}

	getUIContext(): ExtensionUIContext {
		return this.uiContext;
	}

	hasUI(): boolean {
		return this.uiContext !== noOpUIContext;
	}

	getExtensionPaths(): string[] {
		return this.extensions.map((e) => e.path);
	}

	/** Get all registered tools from all extensions (first registration per name wins). */
	getAllRegisteredTools(): RegisteredTool[] {
		const toolsByName = new Map<string, RegisteredTool>();
		for (const ext of this.extensions) {
			for (const tool of ext.tools.values()) {
				if (!toolsByName.has(tool.definition.name)) {
					toolsByName.set(tool.definition.name, tool);
				}
			}
		}
		return Array.from(toolsByName.values());
	}

	/** Get a tool definition by name. Returns undefined if not found. */
	getToolDefinition(toolName: string): RegisteredTool["definition"] | undefined {
		for (const ext of this.extensions) {
			const tool = ext.tools.get(toolName);
			if (tool) {
				return tool.definition;
			}
		}
		return undefined;
	}

	getFlags(): Map<string, ExtensionFlag> {
		const allFlags = new Map<string, ExtensionFlag>();
		for (const ext of this.extensions) {
			for (const [name, flag] of ext.flags) {
				if (!allFlags.has(name)) {
					allFlags.set(name, flag);
				}
			}
		}
		return allFlags;
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	getShortcuts(resolvedKeybindings: KeybindingsConfig): Map<KeyId, ExtensionShortcut> {
		this.shortcutDiagnostics = [];
		const builtinKeybindings = buildBuiltinKeybindings(resolvedKeybindings);
		const extensionShortcuts = new Map<KeyId, ExtensionShortcut>();

		const addDiagnostic = (message: string, extensionPath: string) => {
			this.shortcutDiagnostics.push({ type: "warning", message, path: extensionPath });
			if (!this.hasUI()) {
				console.warn(message);
			}
		};

		for (const ext of this.extensions) {
			for (const [key, shortcut] of ext.shortcuts) {
				const normalizedKey = key.toLowerCase() as KeyId;

				const builtInKeybinding = builtinKeybindings[normalizedKey];
				if (builtInKeybinding?.restrictOverride === true) {
					addDiagnostic(
						`Extension shortcut '${key}' from ${shortcut.extensionPath} conflicts with built-in shortcut. Skipping.`,
						shortcut.extensionPath,
					);
					continue;
				}

				if (builtInKeybinding?.restrictOverride === false) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' is built-in shortcut for ${builtInKeybinding.keybinding} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						shortcut.extensionPath,
					);
				}

				const existingExtensionShortcut = extensionShortcuts.get(normalizedKey);
				if (existingExtensionShortcut) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' registered by both ${existingExtensionShortcut.extensionPath} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						shortcut.extensionPath,
					);
				}
				extensionShortcuts.set(normalizedKey, shortcut);
			}
		}
		return extensionShortcuts;
	}

	getShortcutDiagnostics(): ResourceDiagnostic[] {
		return this.shortcutDiagnostics;
	}

	invalidate(
		message = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
	): void {
		if (!this.staleMessage) {
			this.staleMessage = message;
			this.runtime.invalidate(message);
		}
	}

	private assertActive(): void {
		if (this.staleMessage) {
			throw new Error(this.staleMessage);
		}
	}

	onError(listener: ExtensionErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	emitError(error: ExtensionError): void {
		for (const listener of this.errorListeners) {
			listener(error);
		}
	}

	hasHandlers(eventType: string): boolean {
		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	getMarkdownTransformers(): MarkdownTransformer[] {
		return this.extensions.flatMap((ext) => (ext.markdownTransformer ? [ext.markdownTransformer] : []));
	}

	getEntryRenderer(customType: string): EntryRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.entryRenderers?.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	private resolveRegisteredCommands(): ResolvedCommand[] {
		const commands: RegisteredCommand[] = [];
		const counts = new Map<string, number>();

		for (const ext of this.extensions) {
			for (const command of ext.commands.values()) {
				commands.push(command);
				counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
			}
		}

		const seen = new Map<string, number>();
		const takenInvocationNames = new Set<string>();

		return commands.map((command) => {
			const occurrence = (seen.get(command.name) ?? 0) + 1;
			seen.set(command.name, occurrence);

			let invocationName = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;

			if (takenInvocationNames.has(invocationName)) {
				let suffix = occurrence;
				do {
					suffix++;
					invocationName = `${command.name}:${suffix}`;
				} while (takenInvocationNames.has(invocationName));
			}

			takenInvocationNames.add(invocationName);
			return {
				...command,
				invocationName,
			};
		});
	}

	getModelRegistry(): ModelRegistry {
		return this.modelRegistry;
	}

	getRegisteredCommands(): ResolvedCommand[] {
		this.commandDiagnostics = [];
		return this.resolveRegisteredCommands();
	}

	getCommandDiagnostics(): ResourceDiagnostic[] {
		return this.commandDiagnostics;
	}

	getCommand(name: string): ResolvedCommand | undefined {
		return this.resolveRegisteredCommands().find((command) => command.invocationName === name);
	}

	/**
	 * Request a graceful shutdown. Called by extension tools and event handlers.
	 * The actual shutdown behavior is provided by the mode via bindExtensions().
	 */
	shutdown(): void {
		this.shutdownHandler();
	}

	getActiveTools(): string[] {
		this.assertActive();
		return this.runtime.getActiveTools();
	}

	/**
	 * Create an ExtensionContext for use in event handlers and tool execution.
	 * Context values are resolved at call time, so changes via bindCore/bindUI are reflected.
	 */
	createContext(): ExtensionContext {
		const runner = this;
		const getModel = this.getModel;
		const getScopedModels = this.getScopedModels;
		return {
			get ui() {
				runner.assertActive();
				return runner.uiContext;
			},
			get mode() {
				runner.assertActive();
				return runner.mode;
			},
			get hasUI() {
				runner.assertActive();
				return runner.hasUI();
			},
			get cwd() {
				runner.assertActive();
				return runner.cwd;
			},
			get sessionManager() {
				runner.assertActive();
				return detachedSessionView(runner.sessionManager);
			},
			get modelRegistry() {
				runner.assertActive();
				return runner.modelRegistry;
			},
			get model() {
				runner.assertActive();
				return getModel();
			},
			get scopedModels() {
				runner.assertActive();
				return getScopedModels();
			},
			get thinkingLevel() {
				runner.assertActive();
				return runner.runtime.getThinkingLevel();
			},
			isIdle: () => {
				runner.assertActive();
				return runner.isIdleFn();
			},
			isSettling: () => {
				runner.assertActive();
				return runner.isSettlingFn();
			},
			isPromptPending: () => {
				runner.assertActive();
				return runner.isPromptPendingFn();
			},
			isProjectTrusted: () => {
				runner.assertActive();
				return runner.isProjectTrustedFn();
			},
			get signal() {
				runner.assertActive();
				return runner.getSignalFn();
			},
			abort: () => {
				runner.assertActive();
				runner.abortFn();
			},
			hasPendingMessages: () => {
				runner.assertActive();
				return runner.hasPendingMessagesFn();
			},
			shutdown: () => {
				runner.assertActive();
				runner.shutdownHandler();
			},
			getContextUsage: () => {
				runner.assertActive();
				return runner.getContextUsageFn();
			},
			compact: (options) => {
				runner.assertActive();
				runner.compactFn(options);
			},
			getSystemPrompt: () => {
				runner.assertActive();
				return runner.getSystemPromptFn();
			},
		};
	}

	createCommandContext(): ExtensionCommandContext {
		// Use property descriptors instead of object spread so the guarded getters from
		// createContext() stay lazy. A spread would eagerly read them once and freeze the
		// old values into the returned object, bypassing stale-instance checks.
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this.createContext()),
		) as ExtensionCommandContext;
		context.getSystemPromptOptions = () => {
			this.assertActive();
			return this.getSystemPromptOptionsFn();
		};
		context.waitForIdle = () => {
			this.assertActive();
			return this.waitForIdleFn();
		};
		context.newSession = (options) => {
			this.assertActive();
			return this.newSessionHandler(options);
		};
		context.fork = (entryId, options) => {
			this.assertActive();
			return this.forkHandler(entryId, options);
		};
		context.navigateTree = (targetId, options) => {
			this.assertActive();
			return this.navigateTreeHandler(targetId, options);
		};
		context.switchSession = (sessionPath, options) => {
			this.assertActive();
			return this.switchSessionHandler(sessionPath, options);
		};
		context.reload = () => {
			this.assertActive();
			return this.reloadHandler();
		};
		return context;
	}

	/** All native handler waits share terminal cancellation; cleanup has its own deadline. */
	private dispatchSignal(event: ExtensionEvent["type"], signal?: AbortSignal): AbortSignal | undefined {
		const shutdownSignal = event === "session_shutdown" ? undefined : this.shutdownSignal;
		return signal && shutdownSignal && signal !== shutdownSignal
			? AbortSignal.any([signal, shutdownSignal])
			: (signal ?? shutdownSignal);
	}

	private async dispatchHandler(
		handler: (event: ExtensionEvent, ctx: ExtensionContext) => unknown,
		event: ExtensionEvent,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	): Promise<unknown> {
		signal?.throwIfAborted();
		const result = await raceWithAbortSignal(Promise.resolve(handler(event, ctx)), signal);
		// A settled promise can win its race just before abort. Never apply that result.
		signal?.throwIfAborted();
		return result;
	}

	async emitBoundary(
		baseEvent: BoundaryBaseEvent,
		buildContext: (entries: SessionBoundaryDraft[]) => BoundaryContextPreview | Promise<BoundaryContextPreview>,
		getPendingMessages?: () => AgentMessage[],
		signal?: AbortSignal,
	): Promise<BoundaryDispatchResult> {
		signal = this.dispatchSignal(baseEvent.type, signal);
		signal?.throwIfAborted();
		const ctx = this.createContext();
		let entries: SessionBoundaryDraft[] = [];
		let shouldContinue = false;
		// Record the state represented by the preview before the builder can yield.
		let previewRevision = this.sessionManager.revision();
		let previewPendingMessages = getPendingMessages?.().slice();
		let context = await raceWithAbortSignal(Promise.resolve(buildContext(entries)), signal);
		signal?.throwIfAborted();
		if (!this.hasHandlers(baseEvent.type)) return { entries, continue: false, context, valid: true };
		// One detached preview per build preserves observer sharing without exposing history.
		context = structuredClone(context);
		let contextSnapshot = structuredClone(context);
		let valid = true;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, baseEvent.type)) {
			for (const handler of handlers) {
				// A failed proposal remains visible so a later handler can replace it.
				const before = entries;
				const hadEntries = Array.isArray(entries) && entries.length > 0;
				let previousEntries: SessionBoundaryDraft[] | undefined;
				if (hadEntries) {
					try {
						previousEntries = structuredClone(entries);
					} catch {
						// Uncloneable extension data must still follow the usual preview validation.
					}
				}
				const event = {
					...structuredClone(baseEvent),
					entries: structuredClone(entries),
					continue: shouldContinue,
					context,
				} as TurnEndEvent | AgentBeforeSettleEvent;
				try {
					const handlerResult = (await this.dispatchHandler(handler, event, ctx, signal)) as
						| BoundaryResult
						| undefined;
					signal?.throwIfAborted();
					entries = structuredClone(handlerResult?.entries !== undefined ? handlerResult.entries : event.entries);
					if (handlerResult?.continue !== undefined) shouldContinue = handlerResult.continue;
				} catch (err) {
					signal?.throwIfAborted();
					try {
						entries = structuredClone(event.entries);
					} catch {
						// A poisoned in-place draft cannot be committed; keep the detached pre-handler proposal (#132 R4-10).
						entries = before;
					}
					this.emitError({
						extensionPath: ext.path,
						event: baseEvent.type,
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}

				try {
					if (!Array.isArray(entries)) throw new Error("Boundary entries must be an array");
					// Observers need no new preview. Preserve in-place draft edits, canonical appends
					// and queue changes, including mutations made before a handler throws.
					const unchangedEntries = previousEntries
						? isDeepStrictEqual(previousEntries, entries)
						: !hadEntries && entries.length === 0;
					const nextRevision = this.sessionManager.revision();
					const nextPendingMessages = getPendingMessages?.();
					if (
						valid &&
						unchangedEntries &&
						isDeepStrictEqual(context, contextSnapshot) &&
						previewRevision === nextRevision &&
						previewPendingMessages?.length === nextPendingMessages?.length &&
						(previewPendingMessages?.every((message, index) => message === nextPendingMessages?.[index]) ?? true)
					) {
						continue;
					}

					previewRevision = nextRevision;
					previewPendingMessages = nextPendingMessages?.slice();
					context = structuredClone(await raceWithAbortSignal(Promise.resolve(buildContext(entries)), signal));
					signal?.throwIfAborted();
					contextSnapshot = structuredClone(context);
					valid = true;
				} catch (err) {
					signal?.throwIfAborted();
					valid = false;
					this.emitError({
						extensionPath: ext.path,
						event: baseEvent.type,
						error: `Invalid boundary entries: ${err instanceof Error ? err.message : String(err)}`,
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			}
		}

		return valid
			? {
					entries: structuredClone(entries),
					continue: shouldContinue,
					context: structuredClone(context),
					valid: true,
				}
			: { entries: [], continue: false, context, valid: false };
	}

	private isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
		return (
			event.type === "session_before_switch" ||
			event.type === "session_before_fork" ||
			event.type === "session_before_compact" ||
			event.type === "session_before_tree"
		);
	}

	emit<TEvent extends RunnerEmitEvent>(event: TEvent, signal?: AbortSignal): Promise<RunnerEmitResult<TEvent>> {
		const dispatch = this.emitEvent(event, signal);
		// Observer-only emitters may be fire-and-forget. Still observe terminal rejection.
		void dispatch.catch(() => {});
		return dispatch;
	}

	private async emitEvent<TEvent extends RunnerEmitEvent>(
		event: TEvent,
		operationSignal?: AbortSignal,
	): Promise<RunnerEmitResult<TEvent>> {
		const signal = this.dispatchSignal(event.type, operationSignal ?? ("signal" in event ? event.signal : undefined));
		signal?.throwIfAborted();
		const ctx = this.createContext();
		let result: SessionBeforeEventResult | undefined;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, event.type)) {
			for (const handler of handlers) {
				try {
					// Observers never receive writable aliases to native state or finalized history.
					// Keep AbortSignal identity: structured cloning cannot preserve its behavior.
					const snapshot =
						"signal" in event
							? { ...structuredClone({ ...event, signal: undefined }), signal: event.signal }
							: structuredClone(event);
					const handlerResult = await this.dispatchHandler(handler, snapshot, ctx, signal);
					signal?.throwIfAborted();

					if (this.isSessionBeforeEvent(event) && handlerResult) {
						result = structuredClone(handlerResult) as SessionBeforeEventResult;
						if (result.cancel) {
							return result as RunnerEmitResult<TEvent>;
						}
					}
				} catch (err) {
					signal?.throwIfAborted();
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: event.type,
						error: message,
						stack,
					});
				}
			}
		}

		return result as RunnerEmitResult<TEvent>;
	}

	/** Returns the event's own action unless a handler overrides it; the last override wins. */
	async emitCacheWarmingDecision(event: CacheWarmingDecisionEvent): Promise<CacheWarmingAction> {
		const signal = this.dispatchSignal(event.type);
		signal?.throwIfAborted();
		const ctx = this.createContext();
		let action = event.action;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, event.type)) {
			for (const handler of handlers) {
				try {
					const result = (await this.dispatchHandler(handler, event, ctx, signal)) as
						| CacheWarmingDecisionEventResult
						| undefined;
					signal?.throwIfAborted();
					if (result?.action !== undefined) action = result.action;
				} catch (err) {
					signal?.throwIfAborted();
					this.emitError({
						extensionPath: ext.path,
						event: event.type,
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			}
		}

		return action;
	}

	async emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined> {
		const signal = this.dispatchSignal(event.type);
		signal?.throwIfAborted();
		const ctx = this.createContext();
		let currentMessage = event.message;
		let modified = false;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "message_end")) {
			for (const handler of handlers) {
				try {
					// A cancelled handler can outlive disposal. Neither its draft nor a
					// returned replacement may alias finalized state, including nested content.
					const draft = structuredClone(currentMessage);
					const currentEvent: MessageEndEvent = { ...event, message: draft };
					const handlerResult = (await this.dispatchHandler(handler, currentEvent, ctx, signal)) as
						| MessageEndEventResult
						| undefined;
					signal?.throwIfAborted();
					const candidate = handlerResult?.message ?? draft;
					if (candidate.role !== currentMessage.role) {
						this.emitError({
							extensionPath: ext.path,
							event: "message_end",
							error: "message_end handlers must return a message with the same role",
						});
						continue;
					}

					if (!isDeepStrictEqual(candidate, currentMessage)) {
						currentMessage = structuredClone(candidate);
						modified = true;
					}
				} catch (err) {
					signal?.throwIfAborted();
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "message_end",
						error: message,
						stack,
					});
				}
			}
		}

		return modified ? currentMessage : undefined;
	}

	async emitToolResult(event: ToolResultEvent, signal?: AbortSignal): Promise<ToolResultEventResult | undefined> {
		signal = this.dispatchSignal(event.type, signal);
		const ctx = this.createContext();
		const currentEvent: ToolResultEvent = structuredClone(event);
		let modified = false;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "tool_result")) {
			for (const handler of handlers) {
				signal?.throwIfAborted();
				try {
					const handlerResult = (await this.dispatchHandler(handler, currentEvent, ctx, signal)) as
						| ToolResultEventResult
						| undefined;
					signal?.throwIfAborted();
					if (!handlerResult) continue;

					if (handlerResult.content !== undefined) {
						currentEvent.content = handlerResult.content;
						modified = true;
					}
					if (handlerResult.details !== undefined) {
						currentEvent.details = handlerResult.details;
						modified = true;
					}
					if (handlerResult.isError !== undefined) {
						currentEvent.isError = handlerResult.isError;
						modified = true;
					}
					if (handlerResult.usage !== undefined) {
						currentEvent.usage = handlerResult.usage;
						modified = true;
					}
				} catch (err) {
					signal?.throwIfAborted();
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "tool_result",
						error: message,
						stack,
					});
				}
			}
		}

		if (!modified) {
			return undefined;
		}

		return structuredClone({
			content: currentEvent.content,
			details: currentEvent.details,
			isError: currentEvent.isError,
			usage: currentEvent.usage,
		});
	}

	async emitToolCall(event: ToolCallEvent, signal?: AbortSignal): Promise<ToolCallEventResult | undefined> {
		signal = this.dispatchSignal(event.type, signal);
		const ctx = this.createContext();
		let result: ToolCallEventResult | undefined;

		for (const { handlers } of snapshotEventHandlers(this.extensions, "tool_call")) {
			for (const handler of handlers) {
				signal?.throwIfAborted();
				const handlerResult = await this.dispatchHandler(handler, event, ctx, signal);
				signal?.throwIfAborted();

				if (handlerResult) {
					result = handlerResult as ToolCallEventResult;
					if (result.block) {
						return result;
					}
				}
			}
		}

		return result;
	}

	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		const signal = this.dispatchSignal(event.type);
		signal?.throwIfAborted();
		const ctx = this.createContext();

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "user_bash")) {
			for (const handler of handlers) {
				try {
					const handlerResult = await this.dispatchHandler(handler, event, ctx, signal);
					signal?.throwIfAborted();
					if (handlerResult === undefined) continue;
					if (!isUserBashEventResult(handlerResult)) {
						throw new Error(
							"Invalid user_bash handler result: return undefined for local execution or exactly one valid { operations } or { result } object",
						);
					}
					return handlerResult;
				} catch (err) {
					signal?.throwIfAborted();
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "user_bash",
						error: message,
						stack,
					});
					throw err;
				}
			}
		}

		return undefined;
	}

	/**
	 * Run the request-time transforms in two phases. `context` handlers see the conversation
	 * only and Pi restores the prompt and tool state after each; `context_with_system`
	 * handlers then see the full transcript and their output is used as returned.
	 */
	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		const signal = this.dispatchSignal("context");
		signal?.throwIfAborted();
		const ctx = this.createContext();
		let currentMessages = structuredClone(messages);

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "context")) {
			for (const handler of handlers) {
				try {
					const visibleMessages = currentMessages.filter((message) => message.role !== "system");
					const visibleSnapshot = visibleMessages.slice();
					const event: ContextEvent = { type: "context", messages: visibleMessages };
					const handlerResult = (await this.dispatchHandler(handler, event, ctx, signal)) as
						| ContextEventResult
						| undefined;
					signal?.throwIfAborted();

					// Handlers may return a new list or edit event.messages in place.
					const returned =
						handlerResult?.messages ??
						(sameMessages(visibleMessages, visibleSnapshot) ? undefined : visibleMessages);
					if (!returned) continue;
					currentMessages = restoreSystemMessages(currentMessages, visibleSnapshot, returned);
				} catch (err) {
					signal?.throwIfAborted();
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "context",
						error: message,
						stack,
					});
				}
			}
		}

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "context_with_system")) {
			for (const handler of handlers) {
				try {
					const hadLeadingSystemMessage = currentMessages[0]?.role === "system";
					const event: ContextWithSystemEvent = { type: "context_with_system", messages: currentMessages };
					const handlerResult = (await this.dispatchHandler(handler, event, ctx, signal)) as
						| ContextEventResult
						| undefined;
					signal?.throwIfAborted();
					currentMessages = handlerResult?.messages ?? currentMessages;
					// Providers read the prompt and initial tools from the leading system message.
					// Losing it is never intended; report it but honor the handler's output.
					if (hadLeadingSystemMessage && currentMessages[0]?.role !== "system") {
						this.emitError({
							extensionPath: ext.path,
							event: "context_with_system",
							error: "Handler removed the leading system message; the request has no prompt or initial tool declarations. Keep it at index 0 or replace a dropped prefix with getCurrentSystemMessage().",
						});
					}
				} catch (err) {
					signal?.throwIfAborted();
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "context_with_system",
						error: message,
						stack,
					});
				}
			}
		}

		return structuredClone(currentMessages);
	}

	async emitBeforeProviderRequest(payload: unknown): Promise<unknown> {
		const signal = this.dispatchSignal("before_provider_request");
		signal?.throwIfAborted();
		const ctx = this.createContext();
		let currentPayload = payload;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "before_provider_request")) {
			for (const handler of handlers) {
				try {
					const event: BeforeProviderRequestEvent = {
						type: "before_provider_request",
						payload: currentPayload,
					};
					const handlerResult = await this.dispatchHandler(handler, event, ctx, signal);
					signal?.throwIfAborted();
					if (handlerResult !== undefined) {
						currentPayload = handlerResult;
					}
				} catch (err) {
					signal?.throwIfAborted();
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_provider_request",
						error: message,
						stack,
					});
				}
			}
		}

		return currentPayload;
	}

	async emitBeforeProviderHeaders(headers: ProviderHeaders): Promise<ProviderHeaders> {
		const signal = this.dispatchSignal("before_provider_headers");
		signal?.throwIfAborted();
		const ctx = this.createContext();

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "before_provider_headers")) {
			for (const handler of handlers) {
				try {
					// Handlers mutate `headers` in place; the return value is ignored.
					const event: BeforeProviderHeadersEvent = {
						type: "before_provider_headers",
						headers,
					};
					await this.dispatchHandler(handler, event, ctx, signal);
					signal?.throwIfAborted();
				} catch (err) {
					signal?.throwIfAborted();
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_provider_headers",
						error: message,
						stack,
					});
				}
			}
		}

		return headers;
	}

	async emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPromptOptions: BuildSystemPromptOptions,
		cancellation?: AbortSignal,
	): Promise<BeforeAgentStartCombinedResult> {
		// The originating admission's revocation stops the loop, not only the caller's wait (#132 R4-12).
		const signal = this.dispatchSignal("before_agent_start", cancellation);
		signal?.throwIfAborted();
		const currentOptions = normalizeBuildSystemPromptOptions(systemPromptOptions);
		const renderCurrentSystemPrompt = (): string => buildSystemPrompt(currentOptions);
		const ctx = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this.createContext()),
		) as ExtensionContext;
		ctx.getSystemPrompt = () => {
			this.assertActive();
			return renderCurrentSystemPrompt();
		};
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "before_agent_start")) {
			for (const handler of handlers) {
				try {
					const event: BeforeAgentStartEvent = {
						type: "before_agent_start",
						prompt,
						images,
						get systemPrompt() {
							return renderCurrentSystemPrompt();
						},
						systemPromptOptions: currentOptions,
					};
					const handlerResult = await this.dispatchHandler(handler, event, ctx, signal);
					signal?.throwIfAborted();

					if (handlerResult) {
						const result = handlerResult as BeforeAgentStartEventResult;
						if (result.message) messages.push(result.message);
						if (result.systemPrompt !== undefined) {
							currentOptions.forceSystemPrompt = result.systemPrompt;
						}
					}
				} catch (err) {
					signal?.throwIfAborted();
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_agent_start",
						error: message,
						stack,
					});
				}
			}
		}

		return { messages, systemPromptOptions: currentOptions };
	}

	async emitResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverEvent["reason"],
	): Promise<{
		skillPaths: Array<{ path: string; extensionPath: string }>;
		promptPaths: Array<{ path: string; extensionPath: string }>;
		themePaths: Array<{ path: string; extensionPath: string }>;
	}> {
		const signal = this.dispatchSignal("resources_discover");
		signal?.throwIfAborted();
		const ctx = this.createContext();
		const skillPaths: Array<{ path: string; extensionPath: string }> = [];
		const promptPaths: Array<{ path: string; extensionPath: string }> = [];
		const themePaths: Array<{ path: string; extensionPath: string }> = [];

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "resources_discover")) {
			for (const handler of handlers) {
				try {
					const event: ResourcesDiscoverEvent = { type: "resources_discover", cwd, reason };
					const handlerResult = await this.dispatchHandler(handler, event, ctx, signal);
					signal?.throwIfAborted();
					const result = handlerResult as ResourcesDiscoverResult | undefined;

					if (result?.skillPaths?.length) {
						skillPaths.push(...result.skillPaths.map((path) => ({ path, extensionPath: ext.path })));
					}
					if (result?.promptPaths?.length) {
						promptPaths.push(...result.promptPaths.map((path) => ({ path, extensionPath: ext.path })));
					}
					if (result?.themePaths?.length) {
						themePaths.push(...result.themePaths.map((path) => ({ path, extensionPath: ext.path })));
					}
				} catch (err) {
					signal?.throwIfAborted();
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "resources_discover",
						error: message,
						stack,
					});
				}
			}
		}

		return { skillPaths, promptPaths, themePaths };
	}

	/** Emit input event. Transforms chain, "handled" short-circuits. */
	async emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
		signal?: AbortSignal,
	): Promise<InputEventResult> {
		signal = this.dispatchSignal("input", signal);
		const ctx = this.createContext();
		let currentText = text;
		let currentImages = images;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "input")) {
			for (const handler of handlers) {
				// Cancelled input stops dispatch; the caller already refused the submission.
				signal?.throwIfAborted();
				try {
					const event: InputEvent = {
						type: "input",
						text: currentText,
						// Handlers get detached images: a late in-place edit cannot change retained or recovered originals (#132 R4-6).
						images: currentImages?.map((image) => ({ ...image })),
						source,
						streamingBehavior,
					};
					const result = (await this.dispatchHandler(handler, event, ctx, signal)) as InputEventResult | undefined;
					signal?.throwIfAborted();
					if (result?.action === "handled") return result;
					if (result?.action === "transform") {
						currentText = result.text;
						currentImages = result.images?.map((image) => ({ ...image })) ?? currentImages;
					}
				} catch (err) {
					signal?.throwIfAborted();
					this.emitError({
						extensionPath: ext.path,
						event: "input",
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			}
		}
		return currentText !== text || currentImages !== images
			? { action: "transform", text: currentText, images: currentImages }
			: { action: "continue" };
	}
}
