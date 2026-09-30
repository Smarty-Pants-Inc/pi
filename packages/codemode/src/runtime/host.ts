import { Worker } from "node:worker_threads";
import { toCodemodeIdentifier } from "../identifier.ts";
import type {
	CodemodeCall,
	CodemodeCallStatus,
	CodemodeError,
	CodemodeExecuteOptions,
	CodemodeOutputItem,
	CodemodeResult,
	CodemodeSandboxOptions,
	CodemodeStoreWrites,
	CodemodeTool,
} from "../types.ts";
import { type CodemodeWasmModule, loadQuickJSWasm } from "../wasm.ts";
import {
	CONTROL_WORDS,
	type HostToWorkerMessage,
	INTERRUPT_INDEX,
	isWorkerToHostMessage,
	MAX_CALLS,
	MAX_MESSAGE_BYTES,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_ITEMS,
	MAX_OUTSTANDING_BYTES,
	MAX_OUTSTANDING_MESSAGES,
	MAX_PENDING_CALLS,
	messageBytes,
	QUEUED_BYTES_INDEX,
	QUEUED_ITEMS_INDEX,
	RESPONSE_BYTES_INDEX,
	RESPONSE_ITEMS_INDEX,
	type WorkerData,
	type WorkerToHostMessage,
} from "./protocol.ts";

const DEFAULT_TIMEOUT_MS = 300_000;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_GLOBALS: ReadonlySet<string> = new Set([
	"tools",
	"ALL_TOOLS",
	"console",
	"text",
	"image",
	"exit",
	"globalThis",
	"store",
	"load",
]);

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function serializeStore(store: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
	const serialized: Record<string, string> = {};
	for (const [key, value] of Object.entries(store ?? {})) {
		const json = JSON.stringify(value);
		if (json !== undefined) {
			Object.defineProperty(serialized, key, { value: json, enumerable: true, configurable: true, writable: true });
		}
	}
	return serialized;
}

function parseStoreWrites(json: string): CodemodeStoreWrites {
	const entries: unknown = JSON.parse(json);
	if (!Array.isArray(entries)) throw new Error("Invalid store writes: expected an array");
	const writes: CodemodeStoreWrites = { set: {}, delete: [] };
	for (const entry of entries) {
		if (
			!Array.isArray(entry) ||
			(entry.length !== 1 && entry.length !== 2) ||
			typeof entry[0] !== "string" ||
			(entry.length === 2 && typeof entry[1] !== "string")
		) {
			throw new Error("Invalid store write entry");
		}
		const key: string = entry[0];
		if (entry.length === 1) writes.delete.push(key);
		else {
			const value: unknown = JSON.parse(entry[1]);
			Object.defineProperty(writes.set, key, { value, enumerable: true, configurable: true, writable: true });
		}
	}
	return writes;
}

function defaultWorkerUrl(): URL {
	// `.ts` when running from source (tests, tsx), `.js` from the published dist.
	return new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);
}

interface PendingCall {
	record: CodemodeCall | undefined;
	startedAt: number;
	controller: AbortController;
	/** Includes execute() and its hooks/finally blocks, even after cancellation. */
	promise: Promise<void>;
}

interface ExecutionOptions {
	code: string;
	tools: ReadonlyMap<string, CodemodeTool>;
	globals: ReadonlyMap<string, CodemodeTool>;
	timeoutMs: number;
	signal: AbortSignal | undefined;
	memoryLimitBytes: number | undefined;
	store: Record<string, string>;
	wasm: Promise<CodemodeWasmModule>;
	workerUrl: URL;
}

/**
 * One script run in its own worker and QuickJS VM. A fresh worker per run keeps
 * termination simple: a runaway script, including one that only spins the
 * microtask queue, is killed with `terminate()` and cannot poison a later run.
 */
class Execution {
	readonly promise: Promise<CodemodeResult>;
	private resolveResult!: (result: CodemodeResult) => void;
	private worker: Worker | undefined;
	private readonly interrupt = new SharedArrayBuffer(CONTROL_WORDS * Int32Array.BYTES_PER_ELEMENT);
	private readonly tools: ReadonlyMap<string, CodemodeTool>;
	private readonly globals: ReadonlyMap<string, CodemodeTool>;
	private readonly signal: AbortSignal | undefined;
	private readonly timer: NodeJS.Timeout | undefined;
	private readonly output: CodemodeOutputItem[] = [];
	private readonly calls: CodemodeCall[] = [];
	private readonly pending = new Map<number, PendingCall>();
	private finished = false;
	private outputBytes = 0;
	private callCount = 0;

	constructor(options: ExecutionOptions) {
		this.promise = new Promise<CodemodeResult>((resolve) => {
			this.resolveResult = resolve;
		});
		this.tools = options.tools;
		this.globals = options.globals;
		this.signal = options.signal;

		if (Number.isFinite(options.timeoutMs)) {
			this.timer = setTimeout(() => {
				this.finish({ kind: "timeout", message: `Execution timed out after ${options.timeoutMs} ms` });
			}, options.timeoutMs);
		}

		if (options.signal) {
			if (options.signal.aborted) {
				this.onAbort();
			} else {
				options.signal.addEventListener("abort", this.onAbort, { once: true });
			}
		}

		options.wasm.then(
			(wasm) => this.start(options, wasm),
			(error: unknown) => {
				this.finish({ kind: "sandbox", message: `Failed to load QuickJS: ${errorMessage(error)}` });
			},
		);
	}

	abort(message: string): Promise<CodemodeResult> {
		this.finish({ kind: "aborted", message });
		return this.promise;
	}

	private start(options: ExecutionOptions, wasm: CodemodeWasmModule): void {
		if (this.finished) return;
		const workerData: WorkerData = {
			code: options.code,
			tools: [...options.tools.values()].map((tool) => ({
				name: tool.name,
				jsName: toCodemodeIdentifier(tool.name),
				description: tool.description ?? "",
			})),
			globals: [...options.globals.values()].map((global) => ({
				name: global.name,
				spread: global.spread === true,
			})),
			wasm,
			memoryLimitBytes: options.memoryLimitBytes,
			store: options.store,
			interrupt: this.interrupt,
		};
		let worker: Worker;
		try {
			worker = new Worker(options.workerUrl, { workerData });
		} catch (error) {
			this.finish({ kind: "sandbox", message: `Failed to start worker: ${errorMessage(error)}` });
			return;
		}
		this.worker = worker;
		worker.on("message", (message: unknown) => this.handleMessage(message));
		worker.on("error", (error: unknown) => {
			this.finish({
				kind: "sandbox",
				name: error instanceof Error ? error.name : undefined,
				message: errorMessage(error),
			});
		});
		worker.on("exit", (code) => {
			this.finish({ kind: "sandbox", message: `Worker exited with code ${code} before the script settled` });
		});
	}

	private readonly onAbort = (): void => {
		const reason: unknown = this.signal?.reason;
		this.finish({ kind: "aborted", message: reason instanceof Error ? reason.message : "Execution aborted" });
	};

	private post(message: HostToWorkerMessage): void {
		const bytes = messageBytes(message);
		if (bytes > MAX_MESSAGE_BYTES) throw new Error("Host response byte budget exceeded");
		const control = new Int32Array(this.interrupt);
		const items = Atomics.add(control, RESPONSE_ITEMS_INDEX, 1) + 1;
		const queuedBytes = Atomics.add(control, RESPONSE_BYTES_INDEX, bytes) + bytes;
		if (items > MAX_OUTSTANDING_MESSAGES || queuedBytes > MAX_OUTSTANDING_BYTES) {
			Atomics.sub(control, RESPONSE_ITEMS_INDEX, 1);
			Atomics.sub(control, RESPONSE_BYTES_INDEX, bytes);
			throw new Error("Outstanding host response budget exceeded");
		}
		this.worker?.postMessage(message);
	}

	private handleMessage(message: unknown): void {
		if (this.finished) return;
		try {
			if (!isWorkerToHostMessage(message)) throw new Error("Invalid worker message");
			const bytes = messageBytes(message);
			const control = new Int32Array(this.interrupt);
			// Crash reports use an emergency, single terminal message, not queue credit.
			if (message.type !== "crash") {
				Atomics.sub(control, QUEUED_ITEMS_INDEX, 1);
				Atomics.sub(control, QUEUED_BYTES_INDEX, bytes);
			}
			if (bytes > MAX_MESSAGE_BYTES) throw new Error("Message byte budget exceeded");
			switch (message.type) {
				case "output":
					if (this.output.length >= MAX_OUTPUT_ITEMS || this.outputBytes + bytes > MAX_OUTPUT_BYTES) {
						throw new Error("Output budget exceeded");
					}
					this.outputBytes += bytes;
					this.output.push(message.item);
					break;
				case "call":
					if (
						this.callCount >= MAX_CALLS ||
						this.pending.size >= MAX_PENDING_CALLS ||
						this.pending.has(message.id)
					) {
						throw new Error("Host call budget exceeded or duplicate call id");
					}
					this.callCount++;
					this.handleCall(message);
					break;
				case "done":
					this.handleDone(message);
					break;
				case "crash":
					this.finish({ kind: "sandbox", message: message.message });
					break;
			}
		} catch (error) {
			this.finish({ kind: "sandbox", message: `Invalid sandbox completion or message: ${errorMessage(error)}` });
		}
	}

	private handleDone(message: Extract<WorkerToHostMessage, { type: "done" }>): void {
		// Validate all guest-controlled JSON before setting terminal state. Guest
		// JSON.stringify can still invoke a poisoned toJSON/prototype method.
		if (!message.ok) {
			const parsed: unknown = JSON.parse(message.error);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				throw new Error("Invalid script error");
			}
			const { name, message: text, stack } = parsed as Record<string, unknown>;
			if (
				typeof text !== "string" ||
				(name !== undefined && typeof name !== "string") ||
				(stack !== undefined && typeof stack !== "string")
			) {
				throw new Error("Invalid script error fields");
			}
			this.finish({ kind: "script", name, message: text, stack });
			return;
		}
		const value: unknown = message.value === undefined ? undefined : JSON.parse(message.value);
		const writes = parseStoreWrites(message.writes);
		this.finish(undefined, value, writes);
	}

	private handleCall(message: Extract<WorkerToHostMessage, { type: "call" }>): void {
		const record: CodemodeCall | undefined =
			message.target === "tool" ? { name: message.name, status: "cancelled", durationMs: 0 } : undefined;
		if (record) this.calls.push(record);
		const pending: PendingCall = {
			record,
			startedAt: performance.now(),
			controller: new AbortController(),
			promise: Promise.resolve(),
		};
		this.pending.set(message.id, pending);
		pending.promise = this.invokeCall(message, pending).catch((error: unknown) => {
			this.finish({ kind: "sandbox", message: `Host call failed: ${errorMessage(error)}` });
		});
	}

	private async invokeCall(
		message: Extract<WorkerToHostMessage, { type: "call" }>,
		pending: PendingCall,
	): Promise<void> {
		// Retain the promise before invoking host code, which can itself abort
		// the execution synchronously. No effects start after retirement.
		await Promise.resolve();
		if (this.finished) {
			this.pending.delete(message.id);
			return;
		}
		const { id, name } = message;
		const isTool = message.target === "tool";
		const { record } = pending;
		let status: CodemodeCallStatus;
		let reply: HostToWorkerMessage;
		try {
			const tool = (isTool ? this.tools : this.globals).get(name);
			if (!tool) throw new Error(`Unknown ${isTool ? "tool" : "global"} "${name}"`);
			const args: unknown = message.args === undefined ? undefined : JSON.parse(message.args);
			const value = await tool.execute(args, { signal: pending.controller.signal });
			reply = { type: "result", id, ok: true, payload: value === undefined ? undefined : JSON.stringify(value) };
			status = "ok";
		} catch (error) {
			reply = { type: "result", id, ok: false, payload: errorMessage(error) };
			status = "error";
		}

		this.pending.delete(id);
		if (record) {
			record.status = this.finished ? "cancelled" : status;
			record.durationMs = performance.now() - pending.startedAt;
		}
		if (!this.finished) this.post(reply);
	}

	private finish(error: CodemodeError | undefined, value?: unknown, writes?: CodemodeStoreWrites): void {
		if (this.finished) return;
		this.finished = true;
		clearTimeout(this.timer);
		this.signal?.removeEventListener("abort", this.onAbort);

		const draining = [...this.pending.values()];
		for (const pending of draining) pending.controller.abort();

		const result: CodemodeResult = error
			? { ok: false, error, output: this.output, calls: this.calls }
			: {
					ok: true,
					value,
					output: this.output,
					calls: this.calls,
					storeWrites: writes ?? { set: {}, delete: [] },
				};
		Atomics.store(new Int32Array(this.interrupt), INTERRUPT_INDEX, 1);
		// Aborting a tool does not join its I/O or hooks (atomic writes may still
		// rename). Keep draining ownership, including close(), until all settle.
		const terminated = this.worker?.terminate();
		void Promise.allSettled([terminated, ...draining.map((pending) => pending.promise)]).then(() => {
			this.pending.clear();
			this.resolveResult(result);
		});
	}
}

/**
 * Runs JavaScript in a QuickJS VM (a separate wasm instance) inside a worker
 * thread. The script sees `tools.<name>(args)` for every registered tool, `ALL_TOOLS`,
 * the output helpers `text`, `image`, `exit`, and `console.*`, `store`/`load`, and the
 * configured globals; nothing else (no timers, `fetch`, `process`, `require`, modules).
 *
 * Each `execute()` gets its own worker and VM; the sandbox only holds the tool
 * table and defaults. `close()` aborts in-flight executions.
 */
export class CodemodeSandbox {
	private readonly toolsByName = new Map<string, CodemodeTool>();
	private readonly globalsByName = new Map<string, CodemodeTool>();
	private readonly timeoutMs: number;
	private readonly memoryLimitBytes: number | undefined;
	private readonly wasm: CodemodeWasmModule | Promise<CodemodeWasmModule> | undefined;
	private readonly workerUrl: URL;
	private readonly running = new Set<Execution>();
	private closed = false;

	constructor(options: CodemodeSandboxOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.memoryLimitBytes = options.memoryLimitBytes;
		this.wasm = options.wasm;
		this.workerUrl = options.workerUrl ?? defaultWorkerUrl();
		for (const tool of options.tools ?? []) this.registerTool(tool);
		const namespaces = new Set<string>();
		for (const global of options.globals ?? []) {
			const parts = global.name.split(".");
			if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part)) || RESERVED_GLOBALS.has(parts[0])) {
				throw new Error(`Invalid global name "${global.name}"`);
			}
			if (this.globalsByName.has(global.name)) throw new Error(`Global "${global.name}" is already registered`);
			if (parts.length === 2) namespaces.add(parts[0]);
			this.globalsByName.set(global.name, global);
		}
		for (const name of namespaces) {
			if (this.globalsByName.has(name)) throw new Error(`Global "${name}" conflicts with the namespace "${name}"`);
		}
	}

	/** Throws if a tool with the same name is already registered. */
	registerTool(tool: CodemodeTool): void {
		if (this.toolsByName.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
		this.toolsByName.set(tool.name, tool);
	}

	unregisterTool(name: string): boolean {
		return this.toolsByName.delete(name);
	}

	get tools(): CodemodeTool[] {
		return [...this.toolsByName.values()];
	}

	get globals(): CodemodeTool[] {
		return [...this.globalsByName.values()];
	}

	/**
	 * `code` is an async function body: `return` and top-level `await` work.
	 * Never rejects for script failures; those come back as `{ ok: false }`.
	 * The script can use `store(key, value)` and `load(key)` on `options.store`.
	 */
	execute(code: string, options: CodemodeExecuteOptions = {}): Promise<CodemodeResult> {
		if (this.closed) return Promise.reject(new Error("Sandbox is closed"));
		const execution = new Execution({
			code,
			tools: new Map(this.toolsByName),
			globals: this.globalsByName,
			timeoutMs: options.timeoutMs ?? this.timeoutMs,
			signal: options.signal,
			memoryLimitBytes: this.memoryLimitBytes,
			store: serializeStore(options.store),
			wasm: this.wasm === undefined ? loadQuickJSWasm() : Promise.resolve(this.wasm),
			workerUrl: this.workerUrl,
		});
		this.running.add(execution);
		return execution.promise.finally(() => this.running.delete(execution));
	}

	/** Aborts in-flight executions (they resolve with `kind: "aborted"`) and rejects new ones. */
	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.running].map((execution) => execution.abort("Sandbox closed")));
	}
}
