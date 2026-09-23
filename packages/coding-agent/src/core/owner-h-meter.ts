import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

/** Private native/Source correspondence. Not an ordinary/index/SDK export. */
export interface OriginalHMeterSelection {
	readonly receivingPath: string;
	readonly release: { path: string; sha256: string };
	readonly intent: Readonly<Record<string, unknown>>;
	readonly native: Readonly<Record<string, unknown>>;
	readonly signal: AbortSignal;
}
export interface NativeHMeterBorrow {
	readonly descriptor: number;
	readonly device: number;
	readonly inode: number;
}
export interface NativeHMeterBinding {
	readonly hMeterAbi: 1;
	startOriginalHMeter(host: object, directory: number, selection: Readonly<Record<string, unknown>>): void;
	pollOriginalHMeter(host: object): Buffer | undefined;
	cancelOriginalHMeter(host: object): void;
	acceptOriginalHMeter(lease: object, packet: Buffer): void;
	borrowOriginalHMeter(lease: object): NativeHMeterBorrow;
	returnOriginalHMeter(borrow: NativeHMeterBorrow, failed: boolean): void;
	finishOriginalHMeter(host: object, packet: Buffer): void;
}
/** Only the actual private Sense consumer gets this one native-branded borrow.
 * close follows its SAME meter.close Promise, never the whole host stopTask.
 * Any meter/read/duplicate-close failure must use fail, including undefined.
 * Neither function creates a replacement FD or claims physical retirement. */
export interface OriginalHMeterBorrow {
	readonly aggregate: Readonly<{ descriptor: number; device: number; inode: number }>;
	close(): void;
	fail(cause: unknown): void;
}

function canonical(value: unknown): string {
	if (value === null || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "string") {
		assert(!/[^\x20-\x7e]/.test(value), "OWNER_H_ASCII_STRING");
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		assert(Number.isSafeInteger(value) && !Object.is(value, -0), "OWNER_H_INTEGER");
		return String(value);
	}
	assert(value && typeof value === "object" && !Array.isArray(value), "OWNER_H_OBJECT");
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${canonical(key)}:${canonical((value as Record<string, unknown>)[key])}`)
		.join(",")}}`;
}
function decode(bytes: Buffer, file: boolean): Record<string, unknown> {
	assert(bytes.length > 0 && bytes.length <= (file ? 16_384 : 4096), "OWNER_H_PACKET_BOUND");
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const value: unknown = JSON.parse(text);
	// Equality rejects duplicates, nonfinite encodings, alternate escapes and
	// whitespace before any member is used. FILE has exactly one terminal LF.
	assert(canonical(value) + (file ? "\n" : "") === text, "OWNER_H_CANONICAL");
	assert(value && typeof value === "object" && !Array.isArray(value), "OWNER_H_OBJECT");
	return value as Record<string, unknown>;
}

/** Held only in OwnerHost's private map; caller-created lookalikes never attach. */
export class OriginalHMeter {
	readonly #native: NativeHMeterBinding;
	readonly #host: object;
	readonly #selection: OriginalHMeterSelection;
	#transfer?: { path: string; sha256: string };
	#accepted = false;
	#borrowed = false;
	#borrowReturned = false;
	#stopping = false;
	#finishAttempted = false;
	#cancelAttempted = false;
	#failure?: { cause: unknown };
	#returned?: Promise<void>;

	private constructor(native: NativeHMeterBinding, host: object, selection: OriginalHMeterSelection) {
		this.#native = native;
		this.#host = host;
		this.#selection = selection;
	}

	static async receive(
		native: NativeHMeterBinding,
		host: object,
		selection: OriginalHMeterSelection,
	): Promise<OriginalHMeter> {
		const meter = new OriginalHMeter(native, host, selection);
		const directory = openSync(
			dirname(selection.receivingPath),
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		let failure: { cause: unknown } | undefined;
		let started = false;
		try {
			const stat = fstatSync(directory);
			assert(stat.isDirectory() && stat.uid === 0 && !(stat.mode & 0o022), "OWNER_H_RECEIVING_DIRECTORY");
			selection.signal.throwIfAborted();
			started = true; // Even a failed native start is not repeatable.
			native.startOriginalHMeter(host, directory, selection.native);
			let offer: Buffer | undefined;
			// biome-ignore lint/suspicious/noAssignInExpressions: Poll until the native meter returns an offer.
			while (!(offer = native.pollOriginalHMeter(host))) {
				// Nonblocking native poll checks the ORIGINAL absolute clock and
				// process/namespace identity. No new timeout or worker thread.
				try {
					await delay(5, undefined, { signal: selection.signal });
				} catch (cause) {
					if (selection.signal.aborted) throw selection.signal.reason;
					throw cause;
				}
				selection.signal.throwIfAborted();
			}
			selection.signal.throwIfAborted();
			const packet = decode(offer, false);
			assert.deepEqual(Object.keys(packet).sort(), ["event", "release", "transfer", "version"]);
			assert(
				packet.version === 1 &&
					packet.event === "ORIGINAL_H" &&
					isDeepStrictEqual(packet.release, selection.release),
				"OWNER_H_RELEASE",
			);
			const transfer = packet.transfer as Record<string, unknown>;
			assert(transfer && typeof transfer === "object" && !Array.isArray(transfer), "OWNER_H_TRANSFER");
			assert.deepEqual(Object.keys(transfer).sort(), ["path", "sha256"]);
			const path = join(dirname(selection.receivingPath), "ordinary-h-meter-transfer-intent.json");
			assert(
				transfer.path === path && typeof transfer.sha256 === "string" && /^[a-f0-9]{64}$/.test(transfer.sha256),
				"OWNER_H_TRANSFER",
			);
			const fd = openSync(
				`/proc/self/fd/${directory}/ordinary-h-meter-transfer-intent.json`,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			let readFailure: { cause: unknown } | undefined;
			try {
				const before = fstatSync(fd);
				assert(
					before.isFile() &&
						before.uid === 0 &&
						before.nlink === 1 &&
						!(before.mode & 0o022) &&
						before.size > 0 &&
						before.size <= 16_384,
					"OWNER_H_INTENT_FILE",
				);
				const buffer = Buffer.alloc(16_385);
				const size = readSync(fd, buffer, 0, buffer.length, 0);
				assert(size === before.size && size <= 16_384, "OWNER_H_INTENT_BOUND");
				const bytes = buffer.subarray(0, size);
				assert(createHash("sha256").update(bytes).digest("hex") === transfer.sha256, "OWNER_H_INTENT_HASH");
				assert.deepEqual(decode(bytes, true), selection.intent, "OWNER_H_INTENT_GRAPH");
				const after = fstatSync(fd);
				assert(
					before.dev === after.dev &&
						before.ino === after.ino &&
						before.size === after.size &&
						before.mtimeMs === after.mtimeMs &&
						before.ctimeMs === after.ctimeMs,
					"OWNER_H_INTENT_CHANGED",
				);
			} catch (cause) {
				readFailure = { cause };
				throw cause;
			} finally {
				try {
					closeSync(fd);
				} catch (cleanup) {
					if (readFailure)
						// biome-ignore lint/correctness/noUnsafeFinally: Cleanup failure must reject; the original failure is retained as the first cause.
						throw new AggregateError([readFailure.cause, cleanup], "OWNER_H_INTENT_CLOSE", {
							cause: readFailure.cause,
						});
					// biome-ignore lint/correctness/noUnsafeFinally: A descriptor close failure must reject.
					throw cleanup;
				}
			}
			meter.#transfer = { path, sha256: transfer.sha256 };
			selection.signal.throwIfAborted();
		} catch (cause) {
			failure = { cause };
		}
		try {
			closeSync(directory);
		} catch (cleanup) {
			failure = {
				cause: failure
					? new AggregateError([failure.cause, cleanup], "OWNER_H_DIRECTORY_CLOSE", { cause: failure.cause })
					: cleanup,
			};
		}
		if (failure) {
			if (started)
				try {
					native.cancelOriginalHMeter(host);
				} catch (cleanup) {
					throw new AggregateError([failure.cause, cleanup], "OWNER_H_RECEIVE_FAILED", { cause: failure.cause });
				}
			throw failure.cause;
		}
		return meter;
	}

	accept(lease: object): void {
		assert(this.#transfer && !this.#accepted && !this.#stopping, "OWNER_H_ACCEPT_ONCE");
		this.#selection.signal.throwIfAborted();
		this.#accepted = true; // Spend before possibly uncertain send.
		try {
			this.#native.acceptOriginalHMeter(
				lease,
				Buffer.from(canonical({ version: 1, event: "H_ACCEPTED", transfer: this.#transfer })),
			);
		} catch (cause) {
			this.#failure ??= { cause };
			throw this.#failure.cause;
		}
	}

	borrow(lease: object): OriginalHMeterBorrow {
		assert(this.#accepted && !this.#borrowed && !this.#stopping && !this.#failure, "OWNER_H_BORROW_ONCE");
		this.#selection.signal.throwIfAborted();
		this.#borrowed = true;
		let original: NativeHMeterBorrow;
		try {
			original = this.#native.borrowOriginalHMeter(lease);
		} catch (cause) {
			this.#failure ??= { cause };
			throw this.#failure.cause;
		}
		let resolve!: () => void, reject!: (cause: unknown) => void;
		this.#returned = new Promise<void>((done, failed) => {
			resolve = done;
			reject = failed;
		});
		// This is our own lifecycle promise, not an intercepted hostile result.
		void this.#returned.catch(() => {});
		let returned = false;
		const finish = (failure?: { cause: unknown }) => {
			if (returned) {
				if (this.#failure) throw this.#failure.cause;
				assert(!failure, "OWNER_H_BORROW_RETURNED");
				return;
			}
			returned = true;
			try {
				this.#native.returnOriginalHMeter(original, failure !== undefined);
			} catch (cleanup) {
				failure = {
					cause: failure
						? new AggregateError([failure.cause, cleanup], "OWNER_H_BORROW_CLOSE", { cause: failure.cause })
						: cleanup,
				};
			}
			if (failure) {
				this.#failure ??= failure;
				reject(this.#failure.cause);
				throw this.#failure.cause;
			}
			this.#borrowReturned = true;
			resolve();
		};
		return Object.freeze({
			aggregate: Object.freeze({ descriptor: original.descriptor, device: original.device, inode: original.inode }),
			close: () => finish(),
			fail: (cause: unknown) => finish({ cause }),
		});
	}

	cancelUnaccepted(): void {
		if (this.#accepted) return; // Unknown acceptance cannot be reclassified as no copy.
		if (this.#cancelAttempted) {
			if (this.#failure) throw this.#failure.cause;
			return;
		}
		this.#cancelAttempted = true;
		this.#stopping = true;
		try {
			this.#native.cancelOriginalHMeter(this.#host);
		} catch (cause) {
			this.#failure ??= { cause };
			throw this.#failure.cause;
		}
	}

	#checkFailure(): void {
		if (this.#failure) throw this.#failure.cause;
	}

	/** Called inside the existing owner.close settle budget, concurrent with the
	 * Sense meter's independent close. Never waits on the whole host stopTask. */
	async joinBorrow(): Promise<void> {
		this.#stopping = true;
		if (this.#failure) throw this.#failure.cause;
		assert(this.#borrowed && this.#returned, "OWNER_H_CONSUMER_NOT_JOINED");
		await this.#returned;
		this.#checkFailure();
	}

	finish(): void {
		assert(
			this.#stopping &&
				this.#accepted &&
				this.#borrowReturned &&
				this.#transfer &&
				!this.#failure &&
				!this.#finishAttempted,
			"OWNER_H_CLOSE_PHASE",
		);
		this.#finishAttempted = true;
		try {
			this.#native.finishOriginalHMeter(
				this.#host,
				Buffer.from(canonical({ version: 1, event: "H_CLOSED", transfer: this.#transfer })),
			);
		} catch (cause) {
			this.#failure ??= { cause };
			throw this.#failure.cause;
		}
	}
}
