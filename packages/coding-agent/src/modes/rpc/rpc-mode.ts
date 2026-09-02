/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { toJsonEvent } from "../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcFatalErrorResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.ts";

// ponytail: 256 commands and 16 MiB cover normal startup while bounding untrusted pre-bind input.
const MAX_QUEUED_STARTUP_COMMANDS = 256;
const MAX_STARTUP_INPUT_BYTES = 16 * 1024 * 1024;
// Preserve a bounded response path when buffered commands fill the queue.
const MAX_STARTUP_UI_RESPONSE_BYTES = 1024 * 1024;
// Match Pi's default five-minute idle window while keeping every RPC dialog finite.
const MAX_RPC_EXTENSION_UI_WAIT_MS = 5 * 60_000;
const MAX_BUFFERED_STARTUP_BYTES = MAX_STARTUP_INPUT_BYTES - MAX_STARTUP_UI_RESPONSE_BYTES;
// Keep branch pages well below the gateway's 64 MiB JSONL record limit.
const BRANCH_PAGE_SERIALIZED_RESPONSE_TARGET_BYTES = 32 * 1024 * 1024;
const MAX_ISSUED_BRANCH_PAGE_LEAVES = 32;

// Brent's algorithm detects parent cycles across page boundaries with constant state.
type BranchPageTraversalState = {
	tortoiseId: string;
	power: number;
	steps: number;
};

type IssuedBranchPageCursor = {
	cursor: string;
	nextEntryId: string;
	traversal: BranchPageTraversalState;
};

function advanceBranchPageTraversal(
	state: BranchPageTraversalState | undefined,
	entryId: string,
): BranchPageTraversalState | undefined {
	if (!state) {
		return { tortoiseId: entryId, power: 1, steps: 0 };
	}

	const steps = state.steps + 1;
	if (entryId === state.tortoiseId) {
		return undefined;
	}
	if (steps === state.power) {
		return {
			tortoiseId: entryId,
			power: Math.min(state.power * 2, Number.MAX_SAFE_INTEGER),
			steps: 0,
		};
	}
	return { ...state, steps };
}

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.ts";

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;

	const pendingOutputWrites: Array<() => void> = [];
	let outputFlushScheduled = false;
	let flushingOutput = false;

	const flushPendingOutputWrites = () => {
		flushingOutput = true;
		try {
			for (let index = 0; index < pendingOutputWrites.length; index++) {
				pendingOutputWrites[index]!();
			}
		} finally {
			pendingOutputWrites.length = 0;
			flushingOutput = false;
			outputFlushScheduled = false;
		}
	};

	const queueOutput = (write: () => void) => {
		if (flushingOutput || pendingOutputWrites.length > 0) {
			pendingOutputWrites.push(write);
		} else {
			write();
		}
	};

	const deferOutput = (write: () => void) => {
		pendingOutputWrites.push(write);
		if (!outputFlushScheduled && !flushingOutput) {
			outputFlushScheduled = true;
			queueMicrotask(flushPendingOutputWrites);
		}
	};

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		queueOutput(() => {
			writeRawStdout(serializeJsonLine(obj));
		});
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (response: RpcExtensionUIResponse) => void; cancel: () => void }
	>();
	let inputEnded = false;
	const issuedBranchPageCursors = new Map<string, IssuedBranchPageCursor>();

	// Shutdown request flag
	let shutdownRequested = false;
	let shutdownPromise: Promise<never> | undefined;
	const signalCleanupHandlers: Array<() => void> = [];

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (inputEnded || opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const configuredTimeout = opts?.timeout;
		const timeout =
			typeof configuredTimeout === "number" && Number.isFinite(configuredTimeout) && configuredTimeout > 0
				? Math.min(configuredTimeout, MAX_RPC_EXTENSION_UI_WAIT_MS)
				: MAX_RPC_EXTENSION_UI_WAIT_MS;
		const id = crypto.randomUUID();
		return new Promise<T>((resolve) => {
			let timeoutId: NodeJS.Timeout | undefined;
			let settled = false;

			const cleanup = () => {
				clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const resolveDefault = (notifyClient: boolean, timedOut = false) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (notifyClient && !inputEnded) {
					output({
						type: "extension_ui_request",
						id: crypto.randomUUID(),
						method: "cancel",
						targetId: id,
						...(timedOut ? { timedOut: true } : {}),
					} as RpcExtensionUIRequest);
				}
				resolve(defaultValue);
			};
			const onAbort = () => {
				resolveDefault(true);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			timeoutId = setTimeout(() => resolveDefault(true, true), timeout);

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					if (settled) return;
					settled = true;
					cleanup();
					resolve(parseResponse(response));
				},
				cancel: () => resolveDefault(false),
			});
			output({ type: "extension_ui_request", id, ...request, timeout } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setWorkingVisible(_visible: boolean): void {
			// Working visibility not supported in RPC mode - requires TUI loader access
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Working indicator customization not supported in RPC mode - requires TUI loader access
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		editor: (title, prefill) =>
			createDialogPromise<string | undefined>(
				undefined,
				undefined,
				{ method: "editor", title, prefill },
				(response) =>
					"cancelled" in response && response.cancelled
						? undefined
						: "value" in response
							? response.value
							: undefined,
			),

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		getEditorComponent() {
			// Custom editor components not supported in RPC mode
			return undefined;
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session.stopMessageEntryIdCapture();
		unsubscribe?.();
		unsubscribe = undefined;
		unsubscribeBackpressure?.();
		unsubscribeBackpressure = undefined;

		session = runtimeHost.session;
		session.stopMessageEntryIdCapture();
		issuedBranchPageCursors.clear();
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => runtimeHost.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return runtimeHost.switchSession(sessionPath, options);
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err) => {
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});

		session.startMessageEntryIdCapture();
		unsubscribe = session.subscribe((event) => {
			const eventSession = session;
			const writeEvent = (entryId?: string) => {
				writeRawStdout(
					serializeJsonLine(entryId !== undefined ? { ...toJsonEvent(event), entryId } : toJsonEvent(event)),
				);
				if (event.type === "agent_settled") {
					void checkShutdownRequested();
				}
			};
			const emitEvent = (entryId?: string) => {
				queueOutput(() => writeEvent(entryId));
			};

			if (event.type !== "message_end") {
				emitEvent();
				return;
			}

			if (event.message.role === "custom") {
				const entryId = eventSession.takeMessageEntryId(event.message);
				if (entryId !== undefined) {
					emitEvent(entryId);
					return;
				}
			}

			const message = event.message;
			deferOutput(() => writeEvent(eventSession.takeMessageEntryId(message)));
			return;
		});
		unsubscribeBackpressure = session.agent.subscribe(async () => {
			await waitForRawStdoutBackpressure();
		});
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Start prompt handling immediately, but emit the authoritative response only after
				// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
				let preflightSucceeded = false;
				void session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								output(success(id, "prompt"));
							}
						},
					})
					.catch((e: unknown) => {
						if (!preflightSucceeded) {
							output(error(id, "prompt", e instanceof Error ? e.message : String(e)));
						}
					})
					.finally(() => {
						void checkShutdownRequested();
					});
				return undefined;
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "clear_queue": {
				return success(id, "clear_queue", session.clearQueue());
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "new_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
				};
				return success(id, "get_state", state);
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = session.modelRuntime.getAvailableSnapshot();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = session.modelRuntime.getAvailableSnapshot();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			case "get_available_thinking_levels": {
				const levels = session.getAvailableThinkingLevels();
				return success(id, "get_available_thinking_levels", { levels });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const eventResult = await session.extensionRunner.emitUserBash({
					type: "user_bash",
					command: command.command,
					excludeFromContext: command.excludeFromContext ?? false,
					cwd: session.sessionManager.getCwd(),
				});

				if (eventResult?.result) {
					session.recordBashResult(command.command, eventResult.result, {
						excludeFromContext: command.excludeFromContext,
					});
					return success(id, "bash", eventResult.result);
				}

				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
					id,
					operations: eventResult?.operations,
				});
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "switch_session", result);
			}

			case "fork": {
				const result = await runtimeHost.fork(command.entryId);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await runtimeHost.fork(leafId, { position: "at" });
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "clone", { cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_entries": {
				const sessionManager = session.sessionManager;
				let entries = sessionManager.getEntries();
				if (command.since !== undefined) {
					const sinceIndex = entries.findIndex((e) => e.id === command.since);
					if (sinceIndex === -1) {
						return error(id, "get_entries", `Entry not found: ${command.since}`);
					}
					entries = entries.slice(sinceIndex + 1);
				}
				return success(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
			}

			case "get_branch_entries_page": {
				if (!Number.isSafeInteger(command.limit) || command.limit < 1 || command.limit > 256) {
					return error(id, "get_branch_entries_page", "limit must be a safe integer between 1 and 256");
				}

				const sessionManager = session.sessionManager;
				const leafId = command.leafId ?? sessionManager.getLeafId();
				if (leafId === null) {
					if (command.before !== undefined) {
						return error(id, "get_branch_entries_page", `Cursor not found in branch: ${command.before}`);
					}
					return success(id, "get_branch_entries_page", { entries: [], leafId, complete: true });
				}

				const leaf = sessionManager.getEntry(leafId);
				if (!leaf) {
					return error(id, "get_branch_entries_page", `Leaf not found: ${leafId}`);
				}

				let current: typeof leaf | undefined = leaf;
				let traversal: BranchPageTraversalState | undefined;
				let currentWasPrevisited = false;
				if (command.before !== undefined) {
					const cursor = sessionManager.getEntry(command.before);
					if (!cursor) {
						return error(id, "get_branch_entries_page", `Cursor not found in branch: ${command.before}`);
					}

					const issuedCursor = issuedBranchPageCursors.get(leafId);
					if (issuedCursor?.cursor === command.before && issuedCursor.nextEntryId === cursor.parentId) {
						issuedBranchPageCursors.delete(leafId);
						issuedBranchPageCursors.set(leafId, issuedCursor);
						traversal = issuedCursor.traversal;
						currentWasPrevisited = true;
					} else {
						const visitedAncestorIds = new Set<string>();
						let ancestor = leaf;
						while (true) {
							if (ancestor.parentId === ancestor.id || !visitedAncestorIds.add(ancestor.id)) {
								return error(id, "get_branch_entries_page", "Session branch contains a parent cycle");
							}
							traversal = advanceBranchPageTraversal(traversal, ancestor.id);
							if (!traversal) {
								return error(id, "get_branch_entries_page", "Session branch contains a parent cycle");
							}
							if (ancestor.id === cursor.id) {
								break;
							}
							if (!ancestor.parentId) {
								return error(id, "get_branch_entries_page", `Cursor not found in branch: ${command.before}`);
							}
							const parent = sessionManager.getEntry(ancestor.parentId);
							if (!parent) {
								return error(id, "get_branch_entries_page", `Cursor not found in branch: ${command.before}`);
							}
							if (visitedAncestorIds.has(parent.id)) {
								return error(id, "get_branch_entries_page", "Session branch contains a parent cycle");
							}
							ancestor = parent;
						}
					}

					current = cursor.parentId ? sessionManager.getEntry(cursor.parentId) : undefined;
				}

				const completeResponseEnvelopeBytes = Buffer.byteLength(
					serializeJsonLine(success(id, "get_branch_entries_page", { entries: [], leafId, complete: true })),
				);
				const incompleteResponseEnvelopeBytes = Buffer.byteLength(
					serializeJsonLine(
						success(id, "get_branch_entries_page", {
							entries: [],
							leafId,
							nextCursor: "",
							complete: false,
						}),
					),
				);
				const entries: (typeof leaf)[] = [];
				const visitedEntryIds = new Set<string>();
				let serializedEntriesBytes = 0;
				while (current && entries.length < command.limit) {
					if (current.parentId === current.id || !visitedEntryIds.add(current.id)) {
						return error(id, "get_branch_entries_page", "Session branch contains a parent cycle");
					}
					const serializedEntry = JSON.stringify(current);
					if (serializedEntry === undefined) {
						return error(id, "get_branch_entries_page", "Branch entry could not be serialized");
					}
					const entryBytes = Buffer.byteLength(serializedEntry);
					const atRoot = current.parentId === null;
					const responseEnvelopeBytes = atRoot
						? completeResponseEnvelopeBytes
						: incompleteResponseEnvelopeBytes + Buffer.byteLength(JSON.stringify(current.id)) - 2;
					const candidateEntriesBytes = serializedEntriesBytes + (entries.length > 0 ? 1 : 0) + entryBytes;
					if (responseEnvelopeBytes + candidateEntriesBytes > BRANCH_PAGE_SERIALIZED_RESPONSE_TARGET_BYTES) {
						if (entries.length === 0) {
							return error(
								id,
								"get_branch_entries_page",
								"Branch entry exceeds the 32 MiB serialized response target",
							);
						}
						break;
					}

					if (!currentWasPrevisited) {
						traversal = advanceBranchPageTraversal(traversal, current.id);
						if (!traversal) {
							return error(id, "get_branch_entries_page", "Session branch contains a parent cycle");
						}
					}
					currentWasPrevisited = false;
					entries.push(current);
					serializedEntriesBytes = candidateEntriesBytes;
					if (current.parentId !== null && visitedEntryIds.has(current.parentId)) {
						return error(id, "get_branch_entries_page", "Session branch contains a parent cycle");
					}
					if (current.parentId === null) {
						current = undefined;
					} else if (entries.length < command.limit) {
						current = sessionManager.getEntry(current.parentId);
					}
				}
				const complete = current === undefined;
				entries.reverse();
				const nextCursorEntry = complete ? undefined : entries[0];
				const nextCursor = nextCursorEntry?.id;
				if (complete) {
					issuedBranchPageCursors.delete(leafId);
				} else if (nextCursorEntry && nextCursorEntry.parentId !== null && traversal) {
					const nextTraversal = advanceBranchPageTraversal(traversal, nextCursorEntry.parentId);
					if (!nextTraversal) {
						return error(id, "get_branch_entries_page", "Session branch contains a parent cycle");
					}
					issuedBranchPageCursors.delete(leafId);
					issuedBranchPageCursors.set(leafId, {
						cursor: nextCursorEntry.id,
						nextEntryId: nextCursorEntry.parentId,
						traversal: nextTraversal,
					});
					if (issuedBranchPageCursors.size > MAX_ISSUED_BRANCH_PAGE_LEAVES) {
						const oldestLeafId = issuedBranchPageCursors.keys().next().value;
						if (oldestLeafId !== undefined) {
							issuedBranchPageCursors.delete(oldestLeafId);
						}
					}
				}
				return success(id, "get_branch_entries_page", {
					entries,
					leafId,
					...(nextCursor !== undefined ? { nextCursor } : {}),
					complete,
				});
			}

			case "get_tree": {
				const sessionManager = session.sessionManager;
				return success(id, "get_tree", { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const command of session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return success(id, "get_commands", { commands });
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	let detachInput = () => {};

	// Read input before session_start handlers can await extension UI. Ordinary
	// commands wait for the initial bind, while UI responses resolve immediately.
	let extensionBindingsComplete = false;
	let drainingStartupCommands = false;
	let startupDrainComplete = false;
	let startupFatal = false;
	let startupInputCount = 0;
	let startupInputBytes = 0;
	let startupCommands: RpcCommand[] = [];
	const startupCommandWork: Promise<void>[] = [];

	const cancelPendingExtensionRequests = () => {
		for (const pending of [...pendingExtensionRequests.values()]) {
			pending.cancel();
		}
	};

	const failStartupOverflow = () => {
		if (startupFatal) return;
		startupFatal = true;
		inputEnded = true;
		output({
			type: "response",
			command: "parse",
			success: false,
			error: "RPC startup command queue limit exceeded",
		} satisfies RpcFatalErrorResponse);
		startupCommands = [];
		startupInputCount = 0;
		startupInputBytes = 0;
		detachInput();
		process.stdin.pause();
		cancelPendingExtensionRequests();
	};

	function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		if (shutdownPromise) return shutdownPromise;
		shutdownPromise = (async (): Promise<never> => {
			for (const cleanup of signalCleanupHandlers) {
				cleanup();
			}
			session.stopMessageEntryIdCapture();
			unsubscribe?.();
			unsubscribeBackpressure?.();
			await runtimeHost.dispose();
			detachInput();
			process.stdin.pause();
			if (signal !== "SIGTERM") {
				await flushRawStdout();
			}
			return process.exit(exitCode);
		})();
		return shutdownPromise;
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested || session.isStreaming) return;
		await shutdown();
	}

	const handleCommandInput = async (command: RpcCommand): Promise<void> => {
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
				await waitForRawStdoutBackpressure();
			}
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
			await waitForRawStdoutBackpressure();
		}
	};

	const handleInputLine = async (line: string, rawFramedByteLength?: number) => {
		if (startupFatal) return;

		const isStartupInput = !extensionBindingsComplete || drainingStartupCommands;
		let inputBytes = 0;
		let usesStartupResponseReserve = false;
		if (isStartupInput) {
			// Reserve raw frame bytes before parsing; invalid UTF-8 can expand when decoded.
			inputBytes = rawFramedByteLength ?? Buffer.byteLength(line);
			if (
				startupInputCount < MAX_QUEUED_STARTUP_COMMANDS &&
				startupInputBytes + inputBytes <= MAX_BUFFERED_STARTUP_BYTES
			) {
				startupInputCount++;
				startupInputBytes += inputBytes;
			} else if (pendingExtensionRequests.size > 0 && inputBytes <= MAX_STARTUP_UI_RESPONSE_BYTES) {
				usesStartupResponseReserve = true;
			} else {
				failStartupOverflow();
				return;
			}
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			if (usesStartupResponseReserve) {
				failStartupOverflow();
				return;
			}
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			await waitForRawStdoutBackpressure();
			return;
		}

		// UI responses must not wait for session_start to finish binding extensions.
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				if (isStartupInput && !usesStartupResponseReserve) {
					startupInputCount--;
					startupInputBytes -= inputBytes;
				}
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			} else if (usesStartupResponseReserve) {
				failStartupOverflow();
			}
			return;
		}

		if (usesStartupResponseReserve) {
			failStartupOverflow();
			return;
		}

		const command = parsed as RpcCommand;

		if (isStartupInput) {
			startupCommands.push(command);
			return;
		}

		await handleCommandInput(command);
	};

	const onInputEnd = () => {
		inputEnded = true;
		cancelPendingExtensionRequests();
		if (startupDrainComplete) {
			void Promise.allSettled(startupCommandWork).then(() => shutdown());
		}
	};

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(
			process.stdin,
			(line, rawFramedByteLength) => {
				void handleInputLine(line, rawFramedByteLength);
			},
			{
				getMaxBufferedBytes: () =>
					!extensionBindingsComplete || drainingStartupCommands
						? MAX_STARTUP_INPUT_BYTES - startupInputBytes
						: undefined,
				onBufferOverflow: failStartupOverflow,
			},
		);
		process.stdin.on("end", onInputEnd);
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	registerSignalHandlers();
	await rebindSession();
	if (startupFatal) return shutdown(1);

	extensionBindingsComplete = true;
	drainingStartupCommands = true;
	while (!startupFatal) {
		while (!startupFatal && startupCommands.length > 0) {
			const commands = startupCommands;
			startupCommands = [];
			for (const command of commands) {
				if (startupFatal) break;
				startupCommandWork.push(handleCommandInput(command));
			}
			await Promise.resolve();
		}
		await Promise.allSettled(startupCommandWork);
		if (startupCommands.length === 0) break;
	}
	if (startupFatal) return shutdown(1);
	drainingStartupCommands = false;
	startupDrainComplete = true;
	startupInputCount = 0;
	startupInputBytes = 0;
	if (inputEnded) {
		void shutdown();
	}

	// Keep process alive forever
	return new Promise(() => {});
}
