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

export class FrameReader {
	private buffer: Buffer = Buffer.alloc(0);
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
		return this.buffer.length;
	}

	push(chunk: Buffer): void {
		if (this.failed) return;
		if (this.buffer.length + chunk.length > this.limits.maxPendingBytes) {
			this.fail("pending_overflow");
			return;
		}
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		for (let at = this.buffer.indexOf(0x0a); at >= 0 && !this.failed; at = this.buffer.indexOf(0x0a)) {
			const line = this.buffer.subarray(0, at);
			this.buffer = this.buffer.subarray(at + 1);
			const message = line.length > this.limits.maxFrameBytes ? undefined : parseFrame(line);
			if (message) this.onFrame(message);
			else this.fail(line.length > this.limits.maxFrameBytes ? "frame_too_large" : "malformed_frame");
		}
		if (!this.failed && this.buffer.length > this.limits.maxFrameBytes) this.fail("frame_too_large");
	}

	private fail(reason: HerdrRpcProtocolReason): void {
		this.failed = true;
		this.buffer = Buffer.alloc(0);
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
