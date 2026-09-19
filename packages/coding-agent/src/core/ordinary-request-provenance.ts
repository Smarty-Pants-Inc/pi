import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

interface Invocation<R extends object> {
	open: boolean;
	prompts: number;
	pendingPrompts: number;
	runs: number;
	pendingRuns: number;
	pendingFetches: number;
	requests: Map<R, Promise<void> | undefined>;
	failure?: { cause: unknown };
	stopped: Promise<never>;
	reject(cause: unknown): void;
}
interface Run<R extends object> {
	invocation: Invocation<R>;
	active: boolean;
	signal?: AbortSignal;
	input?: readonly AgentMessage[];
}

/** Evidence only. Tokens never enter prompt options, messages, headers or audit IDs.
 * One capture observes one direct prompt or one enrolled original automatic run.
 * Direct captures can retain up to eight original attempts. This store does not
 * schedule, cancel, retry, spend or retire native work. */
export class OrdinaryRequestProvenance<R extends object> {
	readonly #invocations = new AsyncLocalStorage<Invocation<R> | undefined>();
	readonly #starting = new AsyncLocalStorage<Run<R> | undefined>();
	readonly #streams = new AsyncLocalStorage<{ run: Run<R>; prepared: boolean } | undefined>();
	readonly #sending = new AsyncLocalStorage<{ run: Run<R>; active: boolean } | undefined>();
	readonly #prompts = new WeakMap<object, Invocation<R>>();
	readonly #runs = new WeakMap<AbortSignal, Run<R>>();
	#capture?: Invocation<R>;
	#closed = false;

	#fail(invocation: Invocation<R>, cause: unknown): void {
		if (!invocation.open) return;
		invocation.failure ??= { cause };
		invocation.reject(invocation.failure.cause);
	}

	/** Original owner's close/abort fences evidence synchronously, not physical work. */
	interrupt(cause: unknown): void {
		if (this.#capture) this.#fail(this.#capture, cause);
	}

	close(): void {
		this.#closed = true;
		this.interrupt(new Error("OWNER_REQUEST_CAPTURE_CLOSED"));
	}

	capture(
		invoke: () => Promise<unknown>,
		expiresMs: number,
		result: (original: R) => { requestId: string },
	): Promise<{ requestId: string }> {
		return this.#captureInvocation((invocation) => this.#invocations.run(invocation, invoke), expiresMs, result, 1);
	}

	/** Private original automatic-admission join. This supplies evidence enrollment,
	 * not a wake: only the owner passes enroll to its already-pending run boundary.
	 * No prompt token or ambient direct-prompt scope is created. */
	captureAutomatic(
		join: (enroll: (originalRun: () => Promise<void>) => Promise<void>) => Promise<unknown>,
		expiresMs: number,
		result: (original: R) => { requestId: string },
	): Promise<{ requestId: string }> {
		return this.#captureInvocation(
			(invocation) => {
				let enrolled = false;
				return this.#invocations.run(undefined, () =>
					join((originalRun) => {
						if (enrolled || !invocation.open || this.#closed) {
							const cause = new Error("OWNER_AUTOMATIC_CAPTURE_ENROLLMENT");
							this.#fail(invocation, cause);
							return Promise.reject(cause);
						}
						enrolled = true;
						return this.#run(invocation, originalRun);
					}),
				);
			},
			expiresMs,
			result,
			0,
		);
	}

	#assertCapture(invocation: Invocation<R>, expiresMs: number): void {
		if (invocation.failure) throw invocation.failure.cause;
		if (this.#closed) throw new Error("OWNER_REQUEST_CAPTURE_CLOSED");
		if (!invocation.open || this.#capture !== invocation) throw new Error("OWNER_REQUEST_CAPTURE_STALE");
		if (Date.now() >= expiresMs) {
			const cause = new Error("OWNER_REQUEST_CAPTURE_EXPIRED");
			this.#fail(invocation, cause);
			throw cause;
		}
	}

	async #captureInvocation(
		invoke: (invocation: Invocation<R>) => Promise<unknown>,
		expiresMs: number,
		result: (original: R) => { requestId: string },
		expectedPrompts: 0 | 1,
	): Promise<{ requestId: string }> {
		if (this.#closed) throw new Error("OWNER_REQUEST_CAPTURE_CLOSED");
		if (this.#capture) {
			const cause = new Error("OWNER_REQUEST_CAPTURE_OVERLAP");
			this.#fail(this.#capture, cause);
			throw cause;
		}
		const remaining = expiresMs - Date.now();
		if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 2_147_483_647) {
			throw new Error("OWNER_REQUEST_CAPTURE_DEADLINE");
		}
		let reject!: (cause: unknown) => void;
		const stopped = new Promise<never>((_resolve, failed) => {
			reject = failed;
		});
		void stopped.catch(() => {});
		const invocation: Invocation<R> = {
			open: true,
			prompts: 0,
			pendingPrompts: 0,
			runs: 0,
			pendingRuns: 0,
			pendingFetches: 0,
			requests: new Map(),
			stopped,
			reject,
		};
		this.#capture = invocation;
		const timeout = setTimeout(() => this.#fail(invocation, new Error("OWNER_REQUEST_CAPTURE_EXPIRED")), remaining);
		try {
			const work = (async () => {
				try {
					await invoke(invocation);
				} catch (cause) {
					this.#fail(invocation, cause);
					throw cause;
				}
			})();
			await Promise.race([work, stopped]);
			if (invocation.prompts !== expectedPrompts) throw new Error("OWNER_REQUEST_CAPTURE_PROMPTS");
			if (invocation.pendingPrompts || invocation.pendingRuns || invocation.pendingFetches)
				throw new Error("OWNER_REQUEST_CAPTURE_DETACHED");
			if (!invocation.runs || !invocation.requests.size) throw new Error("OWNER_REQUEST_CAPTURE_NO_REQUEST");
			// Cardinality counts attempts, including rejected ones. Never choose a survivor.
			if (invocation.requests.size !== 1) throw new Error("OWNER_REQUEST_CAPTURE_MULTIPLE_REQUESTS");
			const [original, retired] = invocation.requests.entries().next().value!;
			if (!retired) throw new Error("OWNER_REQUEST_CAPTURE_RETIREMENT_MISSING");
			await Promise.race([retired, stopped]);
			this.#assertCapture(invocation, expiresMs);
			const selected = result(original);
			this.#assertCapture(invocation, expiresMs);
			return selected;
		} catch (cause) {
			throw invocation.failure ? invocation.failure.cause : cause;
		} finally {
			clearTimeout(timeout);
			invocation.open = false;
			invocation.requests.clear();
			this.#capture = undefined;
		}
	}

	/** Called at original AgentSession.prompt entry, before its first await.
	 * Clear ambient invocation scope before input handlers or extension callbacks:
	 * nested/automatic prompts cannot borrow the caller's private prompt token. */
	async prompt(invoke: (token?: object) => Promise<void>): Promise<void> {
		const invocation = this.#invocations.getStore();
		if (!invocation) return invoke();
		if (!invocation.open || this.#closed) throw new Error("OWNER_REQUEST_CAPTURE_STALE");
		const token = Object.freeze({});
		this.#prompts.set(token, invocation);
		invocation.prompts = Math.min(2, invocation.prompts + 1);
		invocation.pendingPrompts++;
		try {
			await this.#invocations.run(undefined, () => invoke(token));
		} catch (cause) {
			this.#fail(invocation, cause);
			throw cause;
		} finally {
			invocation.pendingPrompts--;
			this.#prompts.delete(token);
		}
	}

	/** Wrap only the actual Agent.prompt/continue call, not post-run callbacks. */
	async run(
		token: object | undefined,
		invoke: () => Promise<void>,
		input?: AgentMessage | AgentMessage[],
	): Promise<void> {
		const invocation = token ? this.#prompts.get(token) : undefined;
		if (!invocation) return this.#starting.run(undefined, invoke);
		return this.#run(
			invocation,
			invoke,
			input === undefined ? undefined : Array.isArray(input) ? input.slice() : [input],
		);
	}

	/** Read-only original run association for the private paired-input path. No
	 * supplied signal alone can enroll a prompt, stream or reservation. */
	originalPromptInput(signal: AbortSignal | undefined, boundary: "context" | "stream" | "request") {
		const run = this.#starting.getStore();
		if (
			!run ||
			!run.active ||
			!run.input?.length ||
			run.signal !== signal ||
			!signal ||
			signal.aborted ||
			!run.invocation.open ||
			this.#capture !== run.invocation ||
			this.#closed ||
			run.invocation.failure ||
			(boundary === "stream" && this.#streams.getStore()?.run !== run) ||
			(boundary === "request" && (!this.#sending.getStore()?.active || this.#sending.getStore()?.run !== run))
		) {
			throw new Error("OWNER_PAIR_ORIGINAL_RUN_REQUIRED");
		}
		return { signal, input: run.input };
	}

	async #run(invocation: Invocation<R>, invoke: () => Promise<void>, input?: readonly AgentMessage[]): Promise<void> {
		if (!invocation.open || this.#closed) throw new Error("OWNER_REQUEST_CAPTURE_STALE");
		const run: Run<R> = { invocation, active: true, input };
		invocation.runs++;
		invocation.pendingRuns++;
		if (invocation.runs > 8) this.#fail(invocation, new Error("OWNER_REQUEST_CAPTURE_LIMIT"));
		try {
			await this.#starting.run(run, invoke);
			if (!run.signal) this.#fail(invocation, new Error("OWNER_REQUEST_CAPTURE_RUN_MISSING"));
			if (run.signal?.aborted) this.#fail(invocation, run.signal.reason);
		} catch (cause) {
			this.#fail(invocation, cause);
			throw cause;
		} finally {
			run.active = false;
			if (run.signal) this.#runs.delete(run.signal);
			invocation.pendingRuns--;
		}
	}

	/** Only the installed original Agent's synchronous run_start observer calls this. */
	started(signal: AbortSignal | undefined): void {
		const run = this.#starting.getStore();
		if (!run) return;
		if (!signal || run.signal || !run.active) {
			this.#fail(run.invocation, new Error("OWNER_REQUEST_CAPTURE_RUN_IDENTITY"));
			return;
		}
		run.signal = signal;
		this.#runs.set(signal, run);
	}

	/** Only the original loop's stream wrapper enters this scope. Possession of
	 * an equal ID or even an exposed signal alone cannot bind a request. */
	async stream<T>(signal: AbortSignal, invoke: () => T): Promise<Awaited<T>> {
		const run = this.#runs.get(signal);
		try {
			return await this.#streams.run(run?.active ? { run, prepared: false } : undefined, invoke);
		} catch (cause) {
			if (run) this.#fail(run.invocation, cause);
			throw cause;
		}
	}

	/** Bind the common guard's original fetch at native provider preparation.
	 * A per-call closure carries identity across SDK async work and real retries. */
	bindFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
		const stream = this.#streams.getStore();
		if (stream?.prepared) this.#fail(stream.run.invocation, new Error("OWNER_REQUEST_CAPTURE_STREAM_REUSED"));
		if (stream) stream.prepared = true;
		const run = stream?.run;
		return Object.assign(
			async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
				let sending: { run: Run<R>; active: boolean } | undefined;
				try {
					if (run && (!run.active || !run.invocation.open || this.#closed))
						throw new Error("OWNER_REQUEST_CAPTURE_STALE");
					if (run) {
						sending = { run, active: true };
						run.invocation.pendingFetches++;
					}
					return await this.#sending.run(sending, () => fetch(input, init));
				} catch (cause) {
					if (run) this.#fail(run.invocation, cause);
					throw cause;
				} finally {
					if (sending) {
						sending.active = false;
						sending.run.invocation.pendingFetches--;
					}
				}
			},
			{
				preconnect: () => {
					throw new Error("OWNER_PROVIDER_PRECONNECT");
				},
			},
		);
	}

	/** Actual original reservation object, never a supplied row/request ID. */
	request(original: R): (retirement: Promise<unknown>) => void {
		const sending = this.#sending.getStore();
		if (!sending) return () => {};
		const { run } = sending;
		const invocation = run.invocation;
		if (!sending.active || !run.active || !invocation.open || this.#closed) {
			const cause = new Error("OWNER_REQUEST_CAPTURE_STALE");
			this.#fail(invocation, cause);
			throw cause;
		}
		if (invocation.requests.has(original) || invocation.requests.size >= 8) {
			this.#fail(invocation, new Error("OWNER_REQUEST_CAPTURE_REQUEST_IDENTITY"));
			return () => {};
		}
		invocation.requests.set(original, undefined);
		return (retirement) => {
			if (!invocation.open) return;
			if (invocation.requests.get(original)) {
				this.#fail(invocation, new Error("OWNER_REQUEST_CAPTURE_RETIREMENT_REUSED"));
				return;
			}
			const settled = retirement.then(
				() => {},
				(cause: unknown) => {
					this.#fail(invocation, cause);
					throw cause;
				},
			);
			void settled.catch(() => {});
			invocation.requests.set(original, settled);
		};
	}
}
