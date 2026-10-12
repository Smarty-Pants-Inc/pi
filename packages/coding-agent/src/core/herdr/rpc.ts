/**
 * Herdr's newline-delimited JSON API over its Unix socket (smarty-dev#2636):
 * `{id, method, params}` -> `{id, result}` or `{id, error}`. An error, timeout or close rejects.
 *
 * The peer is unauthenticated until enrollment verifies its signature, so framing is bounded
 * (pi#160 review): an oversized frame, too many unconsumed bytes or a malformed frame closes the
 * socket and rejects every pending call once with a {@link HerdrRpcProtocolError}.
 */
import { createConnection, type Socket } from "node:net";

export type Rpc = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * ponytail: the largest frame Herdr sends here is an enroll answer (64-hex epoch_key, nonce of at
 * most 128 chars, decimal dev/ino, base64 Ed25519 sig: about 400 bytes) or a cut answer (64-hex MAC,
 * principal with a display name of at most 80 chars: under 1 KiB). 1 MiB leaves three orders of
 * magnitude of headroom while bounding what an unauthenticated peer can make Pi hold.
 */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** Cap on unconsumed bytes after a read: one maximal frame plus the start of the next. */
export const MAX_PENDING_BYTES = 2 * MAX_FRAME_BYTES;

export type HerdrRpcProtocolReason = "frame_too_large" | "pending_overflow" | "malformed_frame";

export class HerdrRpcProtocolError extends Error {
	readonly code = "herdr_rpc_protocol_error";
	readonly reason: HerdrRpcProtocolReason;
	constructor(reason: HerdrRpcProtocolReason) {
		super(`herdr_rpc_protocol_error: ${reason}`);
		this.name = "HerdrRpcProtocolError";
		this.reason = reason;
	}
}

export interface FrameLimits {
	readonly maxFrameBytes: number;
	readonly maxPendingBytes: number;
}

const DEFAULT_LIMITS: FrameLimits = { maxFrameBytes: MAX_FRAME_BYTES, maxPendingBytes: MAX_PENDING_BYTES };

/**
 * Splits a byte stream into JSON-object frames. After the first protocol error it drops its buffer
 * and ignores further input.
 */
function parseFrame(line: Buffer): Record<string, unknown> | undefined {
	let message: unknown;
	try {
		message = JSON.parse(line.toString("utf8"));
	} catch {
		return undefined;
	}
	if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
	return message as Record<string, unknown>;
}

/** First capacity of the pending buffer; it doubles from here as an incomplete frame grows. */
const INITIAL_CAPACITY = 4 * 1024;
const EMPTY = Buffer.alloc(0);

/**
 * Holds an incomplete frame in one growable buffer (pi#160 review). Concatenating the whole buffer
 * on every chunk would copy O(n^2) bytes when a peer drips a frame in tiny chunks (about 512 GiB for
 * 1 MiB sent 1 byte at a time), and keeping a list of chunks would keep one Buffer object per chunk
 * alive (about 100 MB of heap for that drip). Instead the reader keeps one buffer and a fill length:
 * - it scans only the new chunk for a newline;
 * - it copies a byte in once when the byte must wait for a later chunk, and grows by doubling (from
 *   4 KiB, never past maxPendingBytes), so growth copies fewer bytes than were appended;
 * - a line that ends in the same chunk it started in is parsed in place, without a copy.
 * Copying is amortized O(n) (at most 2x the bytes), memory is at most maxPendingBytes, and the
 * reader holds O(1) objects. After a frame completes, a buffer grown past 4 KiB is released.
 */
export class FrameReader {
	private buffer: Buffer = EMPTY;
	private fill = 0;
	private failed = false;
	private readonly limits: FrameLimits;
	private readonly onFrame: (frame: Record<string, unknown>) => void;
	private readonly onError: (error: HerdrRpcProtocolError) => void;

	constructor(
		limits: FrameLimits,
		onFrame: (frame: Record<string, unknown>) => void,
		onError: (error: HerdrRpcProtocolError) => void,
	) {
		this.limits = limits;
		this.onFrame = onFrame;
		this.onError = onError;
	}

	/** Bytes held for an incomplete frame. */
	get pendingBytes(): number {
		return this.fill;
	}

	push(chunk: Buffer): void {
		if (this.failed) return;
		if (this.fill + chunk.length > this.limits.maxPendingBytes) {
			this.fail("pending_overflow");
			return;
		}
		let start = 0;
		for (let at = chunk.indexOf(0x0a); at >= 0 && !this.failed; at = chunk.indexOf(0x0a, start)) {
			const tail = chunk.subarray(start, at);
			start = at + 1;
			if (this.fill + tail.length > this.limits.maxFrameBytes) {
				this.fail("frame_too_large");
				break;
			}
			if (this.fill > 0) this.append(tail);
			const line = this.fill > 0 ? this.buffer.subarray(0, this.fill) : tail;
			// parseFrame decodes the line before onFrame runs, so the buffer is free to reuse here.
			const message = parseFrame(line);
			this.fill = 0;
			if (this.buffer.length > INITIAL_CAPACITY) this.buffer = EMPTY;
			if (message) this.onFrame(message);
			else this.fail("malformed_frame");
		}
		if (this.failed || start === chunk.length) return;
		if (this.fill + chunk.length - start > this.limits.maxFrameBytes) {
			this.fail("frame_too_large");
			return;
		}
		this.append(start === 0 ? chunk : chunk.subarray(start));
	}

	/** Copies `bytes` after the fill, doubling the buffer first if it is too small. */
	private append(bytes: Buffer): void {
		const needed = this.fill + bytes.length;
		if (needed > this.buffer.length) {
			let capacity = Math.max(this.buffer.length, INITIAL_CAPACITY);
			while (capacity < needed) capacity *= 2;
			// needed <= maxPendingBytes: push checked fill + chunk.length against it.
			const grown = Buffer.allocUnsafe(Math.min(capacity, this.limits.maxPendingBytes));
			this.buffer.copy(grown, 0, 0, this.fill);
			this.buffer = grown;
		}
		bytes.copy(this.buffer, this.fill);
		this.fill = needed;
	}

	private fail(reason: HerdrRpcProtocolReason): void {
		this.failed = true;
		this.buffer = EMPTY;
		this.fill = 0;
		this.onError(new HerdrRpcProtocolError(reason));
	}
}

export function connectRpc(
	socketPath: string,
	timeoutMs: number,
	limits: FrameLimits = DEFAULT_LIMITS,
): { rpc: Rpc; close(): void } {
	const socket: Socket = createConnection(socketPath);
	const pending = new Map<string, { resolve(v: Record<string, unknown>): void; reject(e: Error): void }>();
	let next = 0;
	let protocolError: HerdrRpcProtocolError | undefined;
	const failAll = (error: Error) => {
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
	};
	const reader = new FrameReader(
		limits,
		(message) => {
			const { id, result } = message as { id?: unknown; result?: unknown };
			const waiter = typeof id === "string" ? pending.get(id) : undefined;
			if (!waiter) return;
			pending.delete(id as string);
			if (typeof result === "object" && result !== null) waiter.resolve(result as Record<string, unknown>);
			else waiter.reject(new Error("refused"));
		},
		(error) => {
			protocolError = error;
			socket.destroy();
			failAll(error);
		},
	);
	socket.on("data", (data: Buffer) => reader.push(data));
	socket.on("error", (error) => failAll(error));
	socket.on("close", () => failAll(new Error("closed")));
	const rpc: Rpc = (method, params) =>
		new Promise((resolve, reject) => {
			if (protocolError) return reject(protocolError);
			const id = `pi-ic-${++next}`;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error("timeout"));
			}, timeoutMs);
			pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			socket.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	return { rpc, close: () => socket.destroy() };
}
