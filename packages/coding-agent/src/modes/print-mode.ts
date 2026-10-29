/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import { type AssistantMessage, type ImageContent, ProviderRequestLimitError } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import type { AgentActivityOutcome } from "../core/extensions/index.ts";
import { takeModeInputPlan } from "../core/mode-turn-receipts.ts";
import { flushRawStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../core/output-guard.ts";
import { promptReceived } from "../core/received-input.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { toJsonEvent } from "./json-event.ts";
import { writeRetryNotice } from "./retry-notice.ts";
import type { RpcInputRejectedEvent } from "./rpc/rpc-types.ts";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Maximum physical provider attempts for this dispatch. Omitted means unlimited. */
	maxProviderRequests?: number;
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages, maxProviderRequests } = options;
	const inputPlan = takeModeInputPlan(options, initialMessage, initialImages, messages);
	const pendingInputs = [...(inputPlan.initial ? [inputPlan.initial] : []), ...inputPlan.remaining];
	let nextInputIndex = 0;
	let exitCode = 0;
	let providerRequests = 0;
	let requestLimitError: Error | undefined;
	let limitReported = false;
	let compactionError: string | undefined;
	const requestLimitCancellation = new AbortController();
	const requestGuard =
		maxProviderRequests === undefined
			? undefined
			: {
					signal: requestLimitCancellation.signal,
					beforeProviderRequest: () => {
						if (providerRequests >= maxProviderRequests) {
							requestLimitError ??= new ProviderRequestLimitError(providerRequests, maxProviderRequests);
							requestLimitCancellation.abort(requestLimitError);
							throw requestLimitError;
						}
						providerRequests++;
					},
				};
	let settledOutcome: AgentActivityOutcome | undefined;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	const outputCancellation = new AbortController();
	let disposalCompletion: Promise<void> | undefined;
	const signalCleanupHandlers: Array<() => void> = [];

	const disposeRuntime = (): Promise<void> => {
		if (disposalCompletion) return disposalCompletion;
		disposalCompletion = (async () => {
			// Release in-flight transport waits before the native idle join. Publication
			// remains subscribed until final events have been persisted and emitted.
			outputCancellation.abort(new Error("Print transport cancelled for terminal shutdown"));
			try {
				// These occurrences never reached native admission. Return their raw
				// payloads separately; native disposal rejects its own retained queues.
				if (nextInputIndex < pendingInputs.length) {
					const unsubmitted = pendingInputs.slice(nextInputIndex);
					const rejection: RpcInputRejectedEvent = {
						type: "input_rejected",
						reason: "shutdown",
						sessionId: session.sessionId,
						error: "INPUT_ADMISSION_SHUTDOWN: remaining print input was not submitted",
						messages: unsubmitted.map((input) => ({
							role: "user",
							content: [{ type: "text", text: input.text }, ...(input.images ?? [])],
							timestamp: Date.now(),
						})),
					};
					if (mode === "json") writeRawStdout(`${JSON.stringify(rejection)}\n`);
					else
						console.error(
							"Print input delivery incomplete: remaining prompts were not submitted",
							JSON.stringify(rejection.messages),
						);
					nextInputIndex = pendingInputs.length;
					exitCode = 1;
				}
				await runtimeHost.dispose({
					terminal: true,
					rejectQueuedInput: (messages, owner) => {
						exitCode = 1;
						if (mode === "json") {
							writeRawStdout(
								`${JSON.stringify({
									type: "input_rejected",
									reason: "shutdown",
									sessionId: owner.sessionId,
									error: "INPUT_ADMISSION_SHUTDOWN: queued input was not delivered",
									messages,
								} satisfies RpcInputRejectedEvent)}\n`,
							);
						} else {
							console.error("Print input delivery incomplete: queued input cancelled for terminal shutdown");
						}
					},
				});
				unsubscribe?.();
				unsubscribeBackpressure?.();
				// Persistence above must not depend on an unread pipe. Drainage gets its
				// own finite budget, independent of the cancelled transport waits.
				const drainage = AbortSignal.timeout(1000);
				try {
					await raceWithAbortSignal(flushRawStdout(), drainage);
				} catch (cause) {
					if (cause !== drainage.reason) throw cause;
					console.error("Print output delivery incomplete: terminal drainage exceeded 1000 ms");
					exitCode = 1;
				}
			} finally {
				for (const cleanup of signalCleanupHandlers) cleanup();
			}
		})();
		return disposalCompletion;
	};

	requestLimitCancellation.signal.addEventListener(
		"abort",
		() => {
			// Native disposal cancels the current (possibly rebound) session's tools,
			// hooks, retries and owned processes before joining and persisting it.
			killTrackedDetachedChildren();
			// The prompt is still joined below; finally observes any disposal failure.
			void disposeRuntime().catch(() => {});
		},
		{ once: true },
	);

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		if (requestGuard) session.modelRuntime.providerRequestGuard = requestGuard;
		settledOutcome = undefined;
		compactionError = undefined;
		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_settled") settledOutcome = event.outcome;
			if (event.type === "compaction_end") {
				if (event.result) compactionError = undefined;
				else if (!event.aborted) compactionError = event.errorMessage ?? "Compaction failed";
			}
			writeRetryNotice(event);
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(toJsonEvent(event))}\n`);
			}
		});
		unsubscribeBackpressure =
			mode === "json"
				? session.agent.subscribe(async () => {
						try {
							await raceWithAbortSignal(waitForRawStdoutBackpressure(), outputCancellation.signal);
						} catch (cause) {
							if (!outputCancellation.signal.aborted || cause !== outputCancellation.signal.reason) throw cause;
						}
					})
				: undefined;
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});
	};

	try {
		if (
			maxProviderRequests !== undefined &&
			(!Number.isSafeInteger(maxProviderRequests) || maxProviderRequests < 1)
		) {
			throw new Error("maxProviderRequests must be a positive safe integer");
		}
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();
		if (compactionError) throw new Error(compactionError);

		while (nextInputIndex < pendingInputs.length) {
			// Attempted input follows native admission/retention semantics, including
			// late pre-prompt retention. Reject only untouched mode inputs below.
			const input = pendingInputs[nextInputIndex++];
			await promptReceived(session, input);
			if (requestLimitError) throw requestLimitError;
			if (compactionError) throw new Error(compactionError);
		}

		if (mode === "json" && (settledOutcome === "error" || settledOutcome === "aborted")) {
			const lastAssistant = session.state.messages.findLast((message) => message.role === "assistant");
			throw new Error(lastAssistant?.errorMessage || `Request ${settledOutcome}`);
		}

		if (mode === "text") {
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];

			if (settledOutcome === "error" || settledOutcome === "aborted") {
				const lastAssistant = state.messages
					.slice()
					.reverse()
					.find((message) => message.role === "assistant");
				console.error(lastAssistant?.errorMessage || `Request ${settledOutcome}`);
				exitCode = 1;
			} else if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
					if (assistantMsg.stopReason === "length") {
						console.error("Response was truncated: the model reached its output token limit.");
						exitCode = 1;
					}
				}
			}
		}
		// Successful output joins a slow but live reader without the forced-shutdown drain budget (#132 R4-9).
		// A signal still runs disposeRuntime() with its bounded drainage.
		await flushRawStdout();
	} catch (error: unknown) {
		console.error(
			requestLimitError?.message ?? compactionError ?? (error instanceof Error ? error.message : String(error)),
		);
		limitReported = requestLimitError !== undefined;
		exitCode = 1;
	} finally {
		await disposeRuntime();
	}
	if (requestLimitError) {
		if (!limitReported) console.error(requestLimitError.message);
		exitCode = 1;
	}
	return exitCode;
}
