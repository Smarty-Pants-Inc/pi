import { Buffer } from "node:buffer";
import type { CodemodeOutputItem } from "../types.ts";
import type { CodemodeWasmModule } from "../wasm.ts";

// Native limits, outside the mutable guest realm. Queue credit is returned on
// receipt, not on tool completion; pending host invocations have a separate cap.
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
export const MAX_OUTPUT_ITEMS = 4096;
export const MAX_CALLS = 4096;
export const MAX_PENDING_CALLS = 128;
export const MAX_OUTSTANDING_MESSAGES = 1024;
export const MAX_OUTSTANDING_BYTES = 32 * 1024 * 1024;
export const INTERRUPT_INDEX = 0;
export const QUEUED_ITEMS_INDEX = 1;
export const QUEUED_BYTES_INDEX = 2;
export const RESPONSE_ITEMS_INDEX = 3;
export const RESPONSE_BYTES_INDEX = 4;
export const CONTROL_WORDS = 5;

/**
 * Messages between the host (main thread) and the worker. Tool arguments,
 * results, and values cross as JSON strings: the worker passes them into and
 * out of the QuickJS VM as strings and never builds structured values itself.
 */

export interface WorkerData {
	code: string;
	/** `jsName` is the identifier the script uses; `description` is listed in `ALL_TOOLS`. */
	tools: { name: string; jsName: string; description: string }[];
	globals: { name: string; spread: boolean }[];
	/** Compiled `quickjs-wasi` module. Structured clone shares the compiled code with the worker. */
	wasm: CodemodeWasmModule;
	memoryLimitBytes: number | undefined;
	/** Snapshot for `load()`: key to JSON text. */
	store: Record<string, string>;
	/**
	 * Native shared control words: interrupt flag and queued items/bytes in
	 * each direction.
	 * The VM polls the flag because Bun's `worker.terminate()` cannot stop
	 * a thread that is spinning in wasm. The worker reserves queue credit
	 * before posting and the host returns it as each message is received.
	 */
	interrupt: SharedArrayBuffer;
}

/** JSON-encoded `{ name?, message, stack? }` of an error thrown by the script. */
export type ScriptErrorJson = string;

export type WorkerToHostMessage =
	| { type: "call"; id: number; target: "tool" | "global"; name: string; args: string | undefined }
	| { type: "output"; item: CodemodeOutputItem }
	/** `writes` is a JSON array of `[key, json]` for `store()` and `[key]` for deletions. */
	| { type: "done"; ok: true; value: string | undefined; writes: string }
	| { type: "done"; ok: false; error: ScriptErrorJson }
	/** The VM failed outside the script's control, for example a wasm trap. */
	| { type: "crash"; message: string };

export type HostToWorkerMessage =
	/** `payload` is the JSON result when `ok`, otherwise the error message. */
	{ type: "result"; id: number; ok: boolean; payload: string | undefined };

export function isWorkerToHostMessage(value: unknown): value is WorkerToHostMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	switch (message.type) {
		case "call":
			return (
				Number.isSafeInteger(message.id) &&
				typeof message.id === "number" &&
				message.id > 0 &&
				(message.target === "tool" || message.target === "global") &&
				typeof message.name === "string" &&
				(message.args === undefined || typeof message.args === "string")
			);
		case "output": {
			if (typeof message.item !== "object" || message.item === null) return false;
			const item = message.item as Record<string, unknown>;
			return (
				(item.type === "text" && typeof item.text === "string") ||
				(item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string")
			);
		}
		case "done":
			return message.ok === true
				? (message.value === undefined || typeof message.value === "string") && typeof message.writes === "string"
				: message.ok === false && typeof message.error === "string";
		case "crash":
			return typeof message.message === "string";
		default:
			return false;
	}
}

/** UTF-8 payload bytes; item/count limits also bound message/object overhead. */
export function messageBytes(message: WorkerToHostMessage | HostToWorkerMessage): number {
	switch (message.type) {
		case "call":
			return Buffer.byteLength(message.name) + Buffer.byteLength(message.args ?? "");
		case "output":
			return message.item.type === "text"
				? Buffer.byteLength(message.item.text)
				: Buffer.byteLength(message.item.data) + Buffer.byteLength(message.item.mimeType);
		case "done":
			return message.ok
				? Buffer.byteLength(message.value ?? "") + Buffer.byteLength(message.writes)
				: Buffer.byteLength(message.error);
		case "crash":
			return Buffer.byteLength(message.message);
		case "result":
			return Buffer.byteLength(message.payload ?? "");
	}
}

export function isHostToWorkerMessage(value: unknown): value is HostToWorkerMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return (
		message.type === "result" &&
		Number.isSafeInteger(message.id) &&
		typeof message.ok === "boolean" &&
		(message.payload === undefined || typeof message.payload === "string")
	);
}
