import {
	oauthDiagnosticError,
	oauthRecoveryDecision,
	safeOAuthError,
	transferAssistantMessagePrivateDecisions,
} from "../auth/oauth/credential-response.ts";
import type { AssistantMessage, AssistantMessageEvent, ProviderHeaders, StreamOptions } from "../types.ts";
import {
	extractDiagnosticError,
	type ProjectionModel,
	projectAssistantContentBlock,
	projectAssistantMessageDiagnostics,
	projectUsage,
} from "./diagnostics.ts";
import { SETUP_MESSAGES } from "./models-error.ts";
import { isProviderContextOverflow } from "./provider-error-classification.ts";

class FifoQueue<T> {
	private incoming: T[] = [];
	private outgoing: T[] = [];

	get length(): number {
		return this.incoming.length + this.outgoing.length;
	}

	enqueue(value: T): void {
		this.incoming.push(value);
	}

	dequeue(): T | undefined {
		if (this.outgoing.length === 0) {
			while (this.incoming.length > 0) {
				this.outgoing.push(this.incoming.pop()!);
			}
		}
		return this.outgoing.pop();
	}
}

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue = new FifoQueue<T>();
	private waiting = new FifoQueue<(value: IteratorResult<T>) => void>();
	protected done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.dequeue();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.enqueue(event);
		}
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.dequeue()!;
			waiter({ value: undefined as any, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.dequeue()!;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.enqueue(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

const ownedErrorMessages = new WeakMap<AssistantMessage, string>();
const hintMessages = {
	bedrock_data_retention:
		"Configure a supported Bedrock data retention mode. See https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html",
	chatgpt_usage: "Check your ChatGPT usage: https://chatgpt.com/settings/usage",
};

/** Retain only a constructor-validated owned message, never the original error. */
export function recordAssistantMessageError(message: AssistantMessage, error: unknown): void {
	const info = extractDiagnosticError(error);
	message.errorMessage = info.message;
	ownedErrorMessages.set(message, info.message);
}

/** The producer's kind is authoritative: a producer error can never become done. */
function projectTerminalEvent(
	kind: "done" | "error",
	message: AssistantMessage,
	policy?: { secrets: readonly string[]; oauth: boolean },
): Extract<AssistantMessageEvent, { type: "done" | "error" }> {
	if (kind === "error") {
		const reason = message.stopReason === "aborted" ? "aborted" : "error";
		const error: AssistantMessage = {
			...message,
			content: structuredClone(message.content),
			usage: projectUsage(message.usage),
			stopReason: reason,
		};
		transferAssistantMessagePrivateDecisions(message, error);
		delete error.deferred;
		delete error.responseId;
		delete error.responseModel;
		delete error.providerThinkingLevel;
		const priorOwned = ownedErrorMessages.get(message);
		if (priorOwned !== undefined) error.errorMessage = priorOwned;
		// Model-less producers and the proxy have no adapter diagnostic policy.
		// Classify original text before replacing it; retain the owned decision on re-publication.
		if (!policy || (message.stopReason !== "error" && message.stopReason !== "aborted")) {
			const decision = oauthRecoveryDecision(safeOAuthError({ message: message.errorMessage }, true));
			if (isProviderContextOverflow(message.errorMessage ?? "", message.provider))
				decision.recovery = "context_length_exceeded";
			error.oauthRecovery ??= decision;
			const ownedSetup = Object.values(SETUP_MESSAGES).some((value) => value === message.errorMessage);
			error.errorMessage =
				priorOwned ??
				(ownedSetup ? message.errorMessage : extractDiagnosticError(new Error(message.errorMessage ?? "")).message);
		}
		let baseMessage = error.errorMessage;
		if (error.diagnosticHint === "bedrock_data_retention" || error.diagnosticHint === "chatgpt_usage") {
			baseMessage = priorOwned ?? extractDiagnosticError(new Error(message.errorMessage ?? "")).message;
			error.errorMessage = `${baseMessage} ${hintMessages[error.diagnosticHint]}`;
		} else {
			delete error.diagnosticHint;
		}
		if (
			(priorOwned !== undefined ||
				error.diagnosticHint !== undefined ||
				!policy ||
				policy.oauth ||
				(message.stopReason !== "error" && message.stopReason !== "aborted")) &&
			typeof baseMessage === "string"
		) {
			ownedErrorMessages.set(error, baseMessage);
		}
		return { type: "error", reason, error };
	}
	switch (message.stopReason) {
		case "stop":
		case "length":
		case "toolUse":
			return { type: "done", reason: message.stopReason, message };
		case "deferred":
			if (typeof message.deferred?.id === "string") return { type: "done", reason: "deferred", message };
			break;
	}
	return projectTerminalEvent("error", message);
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	private projectionModel?: ProjectionModel & { headers?: ProviderHeaders };

	constructor(model?: ProjectionModel & { headers?: ProviderHeaders }, _options?: StreamOptions) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
		this.projectionModel = model;
	}

	override push(event: AssistantMessageEvent): void {
		if (this.done) return;
		// Runtime producer types are not a wire-schema check. Refuse malformed
		// progress before copying either its envelope or its partial snapshot.
		const progress = event.type !== "start" && event.type !== "done" && event.type !== "error";
		const invalidProgress =
			progress &&
			(!("contentIndex" in event) ||
				!Number.isSafeInteger(event.contentIndex) ||
				event.contentIndex < 0 ||
				event.contentIndex >= 65_536 ||
				!Array.isArray(event.partial?.content) ||
				event.contentIndex >= event.partial.content.length ||
				(["text_delta", "thinking_delta", "toolcall_delta"].includes(event.type) &&
					(!("delta" in event) || typeof event.delta !== "string")) ||
				(["text_end", "thinking_end"].includes(event.type) &&
					(!("content" in event) || typeof event.content !== "string")));
		if (invalidProgress || (event.type === "toolcall_end" && event.toolCall?.type !== "toolCall")) {
			const failure = oauthDiagnosticError("oauth_invalid_response", undefined, undefined, undefined, false);
			const source: AssistantMessage =
				"partial" in event && event.partial
					? event.partial
					: {
							role: "assistant",
							api: this.projectionModel?.api ?? "unknown",
							provider: this.projectionModel?.provider ?? "provider",
							model: this.projectionModel?.id ?? "unknown",
							content: [],
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "error",
							timestamp: Date.now(),
						};
			const error: AssistantMessage = {
				...source,
				content: [],
				stopReason: "error",
				errorMessage: extractDiagnosticError(failure).message,
				oauthRecovery: oauthRecoveryDecision(failure),
			};
			this.push({ type: "error", reason: "error", error });
			return;
		}
		if (event.type === "error" || event.type === "done") {
			const message = event.type === "error" ? event.error : event.message;
			const projected = projectAssistantMessageDiagnostics(
				message,
				[],
				false,
				false,
				this.projectionModel,
				event.type,
			);
			const owned = ownedErrorMessages.get(message);
			if (owned !== undefined) ownedErrorMessages.set(projected, owned);
			super.push(projectTerminalEvent(event.type, projected, { secrets: [], oauth: true }));
		} else {
			const partial = projectAssistantMessageDiagnostics(event.partial, [], false, true, this.projectionModel);
			switch (event.type) {
				case "start":
					super.push({ type: event.type, partial });
					break;
				case "text_start":
				case "thinking_start":
				case "toolcall_start":
					super.push({ type: event.type, contentIndex: event.contentIndex, partial });
					break;
				case "text_delta":
				case "thinking_delta":
				case "toolcall_delta":
					super.push({ type: event.type, contentIndex: event.contentIndex, delta: event.delta, partial });
					break;
				case "text_end":
				case "thinking_end":
					super.push({ type: event.type, contentIndex: event.contentIndex, content: event.content, partial });
					break;
				case "toolcall_end":
					super.push({
						type: event.type,
						contentIndex: event.contentIndex,
						toolCall: projectAssistantContentBlock(event.toolCall),
						partial,
					});
					break;
			}
		}
	}

	override end(result?: AssistantMessage): void {
		if (this.done) {
			// Wake outstanding iterators, but never project an already settled result again.
			super.end();
			return;
		}
		if (result) {
			const projected = projectAssistantMessageDiagnostics(result, [], false, false, this.projectionModel);
			const owned = ownedErrorMessages.get(result);
			if (owned !== undefined) ownedErrorMessages.set(projected, owned);
			const event = projectTerminalEvent("done", projected, { secrets: [], oauth: true });
			result = event.type === "error" ? event.error : event.message;
		}
		super.end(result);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
