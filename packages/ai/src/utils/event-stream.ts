import { getOAuthDiagnosticSecrets } from "../auth/oauth/credential-response.ts";
import type { AssistantMessage, AssistantMessageEvent, ProviderHeaders, StreamOptions } from "../types.ts";
import { projectAssistantMessageDiagnostics } from "./diagnostics.ts";

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

const diagnosticPolicies = new WeakMap<AssistantMessageEventStream, { secrets: readonly string[]; oauth: boolean }>();

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(model?: { headers?: ProviderHeaders }, options?: StreamOptions) {
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
		if (model) {
			diagnosticPolicies.set(this, {
				secrets: getOAuthDiagnosticSecrets(options?.apiKey, model.headers, [
					...(options?.diagnosticSecrets ?? []),
					...getOAuthDiagnosticSecrets(options?.apiKey, options?.headers),
				]),
				oauth: options?.oauthDiagnostics === true || options?.apiKey?.includes("sk-ant-oat") === true,
			});
		}
	}

	override push(event: AssistantMessageEvent): void {
		const policy = diagnosticPolicies.get(this);
		if (policy) {
			const message =
				"partial" in event
					? event.partial
					: event.type === "done"
						? event.message
						: event.type === "error"
							? event.error
							: undefined;
			if (message) projectAssistantMessageDiagnostics(message, policy.secrets, policy.oauth);
		}
		super.push(event);
	}

	override end(result?: AssistantMessage): void {
		const policy = diagnosticPolicies.get(this);
		if (result && policy) projectAssistantMessageDiagnostics(result, policy.secrets, policy.oauth);
		super.end(result);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
