import { redactOAuthDiagnostic, redactValues } from "../auth/oauth/credential-response.ts";
import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";
import { cloneToolCall, type PublicationPhase, projectAssistantMessage, terminalPhase } from "./diagnostics.ts";
import { assistantRecovery, ownedRecovery, transferThrottledLimitWait } from "./recovery.ts";

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

interface StreamProtection {
	secrets: string[];
}

// Kept outside the class: new members would break structural compatibility of custom streams.
const streamProtections = new WeakMap<object, StreamProtection>();

/**
 * Mask the live credential values of a request (see `getRequestDiagnosticSecrets`)
 * in every later event and the final result of `stream`, before any consumer sees
 * them. A provider error, partial event or technical metadata field then cannot
 * publish a reflected key or header. Call again to add values.
 */
export function protectAssistantMessageStream(
	stream: AssistantMessageEventStream,
	secrets: readonly string[] | undefined,
): void {
	const values = (secrets ?? []).filter((secret): secret is string => typeof secret === "string" && secret !== "");
	if (values.length === 0) return;
	const protection = streamProtections.get(stream);
	if (protection) protection.secrets.push(...values);
	else streamProtections.set(stream, { secrets: values });
}

/** Mask the stream's own published copy in place. */
function protectMessage(message: AssistantMessage, protection: StreamProtection): void {
	const { secrets } = protection;
	if (typeof message.errorMessage === "string")
		message.errorMessage = redactOAuthDiagnostic(message.errorMessage, secrets);
	if (typeof message.rawStopReason === "string")
		message.rawStopReason = redactOAuthDiagnostic(message.rawStopReason, secrets);
	if (typeof message.rawStopDetails === "string") {
		const redacted = redactValues(message.rawStopDetails, secrets);
		message.rawStopDetails = new TextEncoder().encode(redacted).length <= 4096 ? redacted : JSON.stringify("***");
	}
	for (const record of message.fallback ?? []) {
		if (typeof record.rawBlock !== "string") continue;
		const redacted = redactValues(record.rawBlock, secrets);
		if (new TextEncoder().encode(redacted).length <= 4096) record.rawBlock = redacted;
		else {
			delete record.rawBlock;
			record.blockState = "discarded";
		}
	}
	if (
		message.api === "anthropic-messages" &&
		message.stopReason === "error" &&
		message.rawStopReason === "refusal" &&
		typeof message.responseId === "string"
	) {
		message.responseId = redactValues(message.responseId, secrets);
	}
	// The handle id is a provider token that consumers persist and redeem: mask live values only, and
	// replace the handle instead of rewriting the provider's own object (smarty-dev#5443 T-F6-deferred).
	const deferred = message.deferred;
	if (typeof deferred?.id === "string") {
		const id = redactValues(deferred.id, secrets);
		if (id !== deferred.id) message.deferred = { ...deferred, id };
	}
}

/**
 * Project a message and carry the private throttle wait to the copy. Universal fallback for every source,
 * model-less streams included: a failed message is classified from the producer's original text, before the copy
 * can be masked or its text replaced; a producer's owned decision is kept (smarty-dev#5822 C3).
 */
function projectMessage(message: AssistantMessage, phase: PublicationPhase): AssistantMessage {
	const projected = projectAssistantMessage(message, phase);
	const recovery = message.stopReason === "error" ? assistantRecovery(message) : ownedRecovery(message.recovery);
	if (recovery !== undefined) projected.recovery = recovery;
	transferThrottledLimitWait(message, projected);
	return projected;
}

/**
 * Rebuild an event around its projected message (smarty-dev#5822 C2); producer extras on the event are not
 * copied. Every stream publishes through this, model-less and lazy-forwarding ones included.
 */
function projectEvent(event: AssistantMessageEvent): AssistantMessageEvent {
	switch (event.type) {
		case "done":
			return {
				type: "done",
				reason: event.reason,
				message: projectMessage(event.message, terminalPhase(event.message)),
			};
		case "error":
			return { type: "error", reason: event.reason, error: projectMessage(event.error, "failure") };
		case "start":
			return { type: "start", partial: projectMessage(event.partial, "partial") };
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
			return {
				type: event.type,
				contentIndex: event.contentIndex,
				partial: projectMessage(event.partial, "partial"),
			};
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return {
				type: event.type,
				contentIndex: event.contentIndex,
				delta: event.delta,
				partial: projectMessage(event.partial, "partial"),
			};
		case "text_end":
		case "thinking_end":
			return {
				type: event.type,
				contentIndex: event.contentIndex,
				content: event.content,
				partial: projectMessage(event.partial, "partial"),
			};
		case "toolcall_end": {
			const partial = projectMessage(event.partial, "partial");
			const block = partial.content[event.contentIndex];
			return {
				type: "toolcall_end",
				contentIndex: event.contentIndex,
				toolCall: block?.type === "toolCall" ? block : cloneToolCall(event.toolCall),
				partial,
			};
		}
	}
}

/**
 * Event stream of one assistant response. It also times the response: the final message (`done` or `error` event, or
 * the result passed to `end()`) gets `durationMs`, measured with a monotonic clock from the stream's creation, unless
 * the message already has one or its `timestamp` predates the stream. A stream that forwards a response which started
 * elsewhere, such as a deferred result fetched later, therefore leaves it untimed.
 */
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	readonly #startedAt = Date.now();
	readonly #startedAtMonotonic = performance.now();

	/** `diagnosticSecrets`: see `protectAssistantMessageStream`. */
	constructor(diagnosticSecrets?: readonly string[]) {
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
		protectAssistantMessageStream(this, diagnosticSecrets);
	}

	override push(event: AssistantMessageEvent): void {
		if (this.done) return;
		const published = projectEvent(event);
		const protection = streamProtections.get(this);
		if (protection) {
			if ("partial" in published) protectMessage(published.partial, protection);
			if (published.type === "done") protectMessage(published.message, protection);
			if (published.type === "error") protectMessage(published.error, protection);
		}

		if (published.type === "done") this.#time(published.message);
		else if (published.type === "error") this.#time(published.error);
		super.push(published);
	}

	override end(result?: AssistantMessage): void {
		let published = result;
		if (result !== undefined) {
			published = projectMessage(result, terminalPhase(result));
			const protection = streamProtections.get(this);
			if (protection) protectMessage(published, protection);
			this.#time(published);
		}
		super.end(published);
	}

	#time(message: AssistantMessage): void {
		if (this.done || message.durationMs !== undefined || message.timestamp < this.#startedAt) return;
		message.durationMs = Math.max(0, Math.round(performance.now() - this.#startedAtMonotonic));
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
