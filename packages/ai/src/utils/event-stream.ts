import { redactOAuthDiagnostic, redactOAuthDiagnosticValue, redactValues } from "../auth/oauth/credential-response.ts";
import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";
import type { AssistantMessageDiagnostic } from "./diagnostics.ts";

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
	private done = false;
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
	protectedDiagnostics: WeakSet<object>;
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
	else streamProtections.set(stream, { secrets: values, protectedDiagnostics: new WeakSet() });
}

/** Mask in place: providers keep mutating the same partial object between events. */
function protectMessage(message: AssistantMessage, protection: StreamProtection): void {
	const { secrets, protectedDiagnostics } = protection;
	if (typeof message.errorMessage === "string")
		message.errorMessage = redactOAuthDiagnostic(message.errorMessage, secrets);
	if (typeof message.rawStopReason === "string")
		message.rawStopReason = redactOAuthDiagnostic(message.rawStopReason, secrets);
	// The handle id is a provider token that consumers persist and redeem: mask live values only, and
	// replace the handle instead of rewriting the provider's own object (smarty-dev#5443 T-F6-deferred).
	const deferred = message.deferred;
	if (typeof deferred?.id === "string") {
		const id = redactValues(deferred.id, secrets);
		if (id !== deferred.id) message.deferred = { ...deferred, id };
	}
	const diagnostics = message.diagnostics;
	if (!Array.isArray(diagnostics)) return;
	for (let i = 0; i < diagnostics.length; i++) {
		const diagnostic = diagnostics[i];
		if (typeof diagnostic === "object" && diagnostic !== null && protectedDiagnostics.has(diagnostic)) continue;
		const safe = redactOAuthDiagnosticValue(diagnostic, secrets) as AssistantMessageDiagnostic;
		if (typeof safe === "object" && safe !== null) protectedDiagnostics.add(safe);
		diagnostics[i] = safe;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
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
		const protection = streamProtections.get(this);
		if (protection) {
			if ("partial" in event) protectMessage(event.partial, protection);
			if (event.type === "done") protectMessage(event.message, protection);
			if (event.type === "error") protectMessage(event.error, protection);
		}
		super.push(event);
	}

	override end(result?: AssistantMessage): void {
		const protection = streamProtections.get(this);
		if (result && protection) protectMessage(result, protection);
		super.end(result);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
