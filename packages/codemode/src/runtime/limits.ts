import type { CodemodeStoreWrites } from "../types.ts";
import { MAX_OUTPUT_CHARS, MAX_STORE_TOTAL_CHARS, MAX_STORE_VALUE_CHARS } from "./prelude-source.ts";
import type { WorkerToHostMessage } from "./protocol.ts";

/**
 * Host-owned budgets for one execution. They are enforced outside the QuickJS VM: the worker
 * checks each message before it posts it, and the host checks again before it keeps anything.
 * Script options can only tighten them.
 */
export interface CodemodeLimits {
	/** Ceiling for the execution deadline. A larger or infinite `timeoutMs` is clamped to it. */
	maxTimeoutMs: number;
	/** Characters in one message across the bridge (call arguments, an output item, a result, a tool reply). */
	maxMessageChars: number;
	/** Characters of all messages from the script together. */
	maxTotalChars: number;
	/** Tool and global calls one execution may start. */
	maxCalls: number;
	/** Calls in flight at once. Each holds host state and possibly a queued model waiter. */
	maxPendingCalls: number;
}

export const DEFAULT_CODEMODE_LIMITS: Readonly<CodemodeLimits> = Object.freeze({
	maxTimeoutMs: 30 * 60_000,
	maxMessageChars: MAX_OUTPUT_CHARS,
	maxTotalChars: 4 * MAX_OUTPUT_CHARS,
	maxCalls: 10_000,
	maxPendingCalls: 256,
});

/** Default QuickJS heap budget for every backend: 256 MiB. */
export const DEFAULT_CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
/** Host-owned ceiling. Callers may tighten, never raise, the QuickJS heap budget. */
export const MAX_CODEMODE_MEMORY_LIMIT_BYTES = DEFAULT_CODEMODE_MEMORY_LIMIT_BYTES;

/** A script went over a {@link CodemodeLimits} budget or a store quota. The execution fails with `kind: "limit"`. */
export class CodemodeLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodemodeLimitError";
	}
}

/** Callers may tighten the defaults. Every value must be a positive finite number. */
export function resolveCodemodeLimits(limits: Partial<CodemodeLimits> = {}): CodemodeLimits {
	const resolved = { ...DEFAULT_CODEMODE_LIMITS, ...limits };
	for (const key of Object.keys(resolved) as (keyof CodemodeLimits)[]) {
		const value = resolved[key];
		if (!(value > 0 && Number.isFinite(value)))
			throw new Error(`Codemode limit ${key} must be a positive finite number`);
		resolved[key] = Math.min(value, DEFAULT_CODEMODE_LIMITS[key]);
	}
	return resolved;
}

/** Resolve at each admission boundary. Like other budgets, oversized requests are clamped. */
export function resolveMemoryLimit(requested: number | undefined): number {
	if (requested === undefined) return DEFAULT_CODEMODE_MEMORY_LIMIT_BYTES;
	if (!(requested > 0 && Number.isFinite(requested))) {
		throw new CodemodeLimitError("Codemode memoryLimitBytes must be a positive finite number");
	}
	return Math.min(requested, MAX_CODEMODE_MEMORY_LIMIT_BYTES);
}

/** Characters a worker message carries. */
export function messageChars(message: WorkerToHostMessage): number {
	switch (message.type) {
		case "call":
			return message.name.length + (message.args?.length ?? 0);
		case "output":
			return message.item.type === "image"
				? message.item.data.length + message.item.mimeType.length
				: message.item.text.length;
		case "done":
			return message.ok ? (message.value?.length ?? 0) + message.writes.length : message.error.length;
		case "started":
			return message.fingerprint.length;
		case "crash":
		case "limit":
			return message.message.length;
		default:
			return 0;
	}
}

/** Counts one execution's bridge traffic against its limits. Methods throw {@link CodemodeLimitError}. */
export class BridgeBudget {
	private readonly limits: CodemodeLimits;
	private totalChars = 0;
	private calls = 0;
	private pending = 0;

	constructor(limits: CodemodeLimits) {
		this.limits = limits;
	}

	/** One message from the script, before it is posted or kept. */
	charge(message: WorkerToHostMessage): void {
		this.addChars(messageChars(message));
		if (message.type !== "call") return;
		if (++this.calls > this.limits.maxCalls) {
			throw new CodemodeLimitError(`script started more than ${this.limits.maxCalls} calls`);
		}
		if (++this.pending > this.limits.maxPendingCalls) {
			throw new CodemodeLimitError(`script has more than ${this.limits.maxPendingCalls} calls in flight`);
		}
	}

	/** A call's reply of `chars` characters, before it is posted to the script. Replies count toward the total too. */
	settle(chars: number): void {
		this.pending--;
		this.addChars(chars);
	}

	private addChars(chars: number): void {
		if (chars > this.limits.maxMessageChars) {
			throw new CodemodeLimitError(
				`a message across the sandbox bridge has ${chars} characters, more than the limit of ${this.limits.maxMessageChars}`,
			);
		}
		this.totalChars += chars;
		if (this.totalChars > this.limits.maxTotalChars) {
			throw new CodemodeLimitError(`script traffic exceeded the limit of ${this.limits.maxTotalChars} characters`);
		}
	}
}

/**
 * Check the store that results from applying `writes` to `store`, outside the guest: each value and
 * the whole store must fit the quotas the guest's `store()` enforces, and the writes themselves,
 * deletions included, must fit the total quota. Sizes count key and JSON characters. Throws
 * {@link CodemodeLimitError}.
 */
export function checkCodemodeStoreQuota(store: Readonly<Record<string, unknown>>, writes: CodemodeStoreWrites): void {
	const fail = (problem: string) => new CodemodeLimitError(`store quota exceeded: ${problem}`);
	const sizes = new Map<string, number>();
	for (const [key, value] of Object.entries(store)) sizes.set(key, key.length + (JSON.stringify(value)?.length ?? 0));
	let written = 0;
	for (const key of writes.delete) {
		written += key.length;
		sizes.delete(key);
	}
	for (const [key, value] of Object.entries(writes.set)) {
		const chars = JSON.stringify(value)?.length ?? 0;
		if (chars > MAX_STORE_VALUE_CHARS) {
			throw fail(`${JSON.stringify(key)} has ${chars} characters of JSON, more than ${MAX_STORE_VALUE_CHARS}`);
		}
		written += key.length + chars;
		sizes.set(key, key.length + chars);
	}
	if (written > MAX_STORE_TOTAL_CHARS) throw fail(`the writes exceed ${MAX_STORE_TOTAL_CHARS} characters`);
	let total = 0;
	for (const size of sizes.values()) total += size;
	if (total > MAX_STORE_TOTAL_CHARS) throw fail(`the store would exceed ${MAX_STORE_TOTAL_CHARS} characters`);
}
