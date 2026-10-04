import { Worker } from "node:worker_threads";
import { toCodemodeIdentifier } from "../identifier.ts";
import { refuseCodemodeAdmission } from "../security-admission.ts";
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
	boundedJson,
	MAX_CALLS,
	MAX_EXECUTION_MS,
	MAX_MESSAGE_BYTES,
	MAX_OUTPUT_ITEMS,
	MAX_PENDING_CALLS,
	MAX_TRANSIT_BYTES,
	MAX_TRANSIT_ITEMS,
} from "./budgets.ts";
import {
	type HostToWorkerMessage,
	isWorkerToHostMessage,
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
	const serialized: Record<string, string> = Object.create(null);
	for (const [key, value] of Object.entries(store ?? {})) {
		const json = JSON.stringify(value);
		if (json !== undefined) serialized[key] = json;
	}
	return serialized;
}

function parseStoreWrites(json: unknown): CodemodeStoreWrites {
	if (typeof json !== "string") throw new TypeError("Store writes must be JSON text");
	const entries: unknown = JSON.parse(json);
	if (!Array.isArray(entries)) throw new TypeError("Store writes must be an entry array");
	const writes: CodemodeStoreWrites = { set: Object.create(null), delete: [] };
	for (const entry of entries) {
		if (
			!Array.isArray(entry) ||
			(entry.length !== 1 && entry.length !== 2) ||
			typeof entry[0] !== "string" ||
			(entry.length === 2 && typeof entry[1] !== "string")
		) {
			throw new TypeError("Invalid store write entry");
		}
		const [key, value] = entry as [string, string?];
		if (value === undefined) writes.delete.push(key);
		else writes.set[key] = JSON.parse(value);
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
	workerUrl: string | URL;
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
	private readonly interrupt = new SharedArrayBuffer(4);
	private readonly tools: ReadonlyMap<string, CodemodeTool>;
	private readonly globals: ReadonlyMap<string, CodemodeTool>;
	private readonly signal: AbortSignal | undefined;
	private readonly timer: NodeJS.Timeout | undefined;
	private readonly output: CodemodeOutputItem[] = [];
	private readonly calls: CodemodeCall[] = [];
	private readonly pending = new Map<number, PendingCall>();
	private finished = false;
	private receivedBytes = 0;
	private receivedItems = 0;
	private admittedCalls = 0;
	private sentBytes = 0;

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
		if (this.finished) return;
		// Reply credits also belong to the host: a guest may stop consuming them.
		const bytes = Buffer.byteLength(message.payload ?? "") + 128;
		this.sentBytes += bytes;
		if (bytes > MAX_MESSAGE_BYTES || this.sentBytes > MAX_TRANSIT_BYTES) {
			this.finish({ kind: "sandbox", message: "Sandbox reply budget exceeded" });
			return;
		}
		this.worker?.postMessage(message);
	}

	private handleMessage(message: unknown): void {
		if (this.finished || !isWorkerToHostMessage(message)) return;
		try {
			const encoded = boundedJson(message);
			this.receivedBytes += Buffer.byteLength(encoded ?? "");
			if (++this.receivedItems > MAX_TRANSIT_ITEMS || this.receivedBytes > MAX_TRANSIT_BYTES)
				throw new Error("Sandbox transit budget exceeded");
		} catch {
			this.finish({ kind: "sandbox", message: "Sandbox message budget exceeded" });
			return;
		}
		switch (message.type) {
			case "output":
				if (this.output.length >= MAX_OUTPUT_ITEMS) {
					this.finish({ kind: "sandbox", message: "Sandbox output item budget exceeded" });
					break;
				}
				this.output.push(message.item);
				break;
			case "call":
				if (
					++this.admittedCalls > MAX_CALLS ||
					this.pending.size >= MAX_PENDING_CALLS ||
					this.pending.has(message.id)
				) {
					this.finish({ kind: "sandbox", message: "Sandbox call admission budget exceeded" });
					break;
				}
				void this.handleCall(message).catch(() =>
					this.finish({ kind: "sandbox", message: "Sandbox call delivery failed" }),
				);
				break;
			case "done":
				this.handleDone(message);
				break;
			case "crash":
				this.finish({ kind: "sandbox", message: message.message });
				break;
		}
	}

	private handleDone(message: Extract<WorkerToHostMessage, { type: "done" }>): void {
		// Guest intrinsics can forge even valid JSON. Decode and validate every
		// completion field before finish() retires cancellation and deadline ownership.
		try {
			if (message.ok === false) {
				if (typeof message.error !== "string") throw new TypeError("Script error must be JSON text");
				const parsed: unknown = JSON.parse(message.error);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					throw new TypeError("Script error must be an object");
				}
				const error = parsed as Record<string, unknown>;
				if (
					!Object.hasOwn(error, "message") ||
					typeof error.message !== "string" ||
					(Object.hasOwn(error, "name") && typeof error.name !== "string") ||
					(Object.hasOwn(error, "stack") && typeof error.stack !== "string")
				) {
					throw new TypeError("Invalid script error fields");
				}
				this.finish({
					kind: "script",
					message: error.message,
					...(Object.hasOwn(error, "name") ? { name: error.name as string } : {}),
					...(Object.hasOwn(error, "stack") ? { stack: error.stack as string } : {}),
				});
				return;
			}
			if (message.ok !== true || (message.value !== undefined && typeof message.value !== "string")) {
				throw new TypeError("Invalid completion fields");
			}
			const value: unknown = message.value === undefined ? undefined : JSON.parse(message.value);
			const writes = parseStoreWrites(message.writes);
			this.finish(undefined, value, writes);
		} catch {
			this.finish({ kind: "sandbox", message: "Invalid sandbox completion metadata" });
		}
	}

	private async handleCall(message: Extract<WorkerToHostMessage, { type: "call" }>): Promise<void> {
		const { id, name } = message;
		const isTool = message.target === "tool";
		const record: CodemodeCall | undefined = isTool ? { name, status: "cancelled", durationMs: 0 } : undefined;
		if (record) this.calls.push(record);
		const pending: PendingCall = { record, startedAt: performance.now(), controller: new AbortController() };
		this.pending.set(id, pending);

		let status: CodemodeCallStatus;
		let reply: HostToWorkerMessage;
		try {
			const tool = (isTool ? this.tools : this.globals).get(name);
			if (!tool) throw new Error(`Unknown ${isTool ? "tool" : "global"} "${name}"`);
			const args: unknown = message.args === undefined ? undefined : JSON.parse(message.args);
			const value = await tool.execute(args, { signal: pending.controller.signal });
			reply = { type: "result", id, ok: true, payload: value === undefined ? undefined : boundedJson(value) };
			status = "ok";
		} catch (error) {
			reply = { type: "result", id, ok: false, payload: errorMessage(error).slice(0, 2000) };
			status = "error";
		}

		// Already cancelled by finish(): the record keeps "cancelled" and the
		// worker is gone or going.
		if (!this.pending.delete(id)) return;
		if (record) {
			record.status = status;
			record.durationMs = performance.now() - pending.startedAt;
		}
		this.post(reply);
	}

	private finish(error: CodemodeError | undefined, value?: unknown, writes?: CodemodeStoreWrites): void {
		if (this.finished) return;
		this.finished = true;
		clearTimeout(this.timer);
		this.signal?.removeEventListener("abort", this.onAbort);

		const now = performance.now();
		for (const pending of this.pending.values()) {
			if (pending.record) pending.record.durationMs = now - pending.startedAt;
			pending.controller.abort();
		}
		this.pending.clear();

		const result: CodemodeResult = error
			? { ok: false, error, output: this.output, calls: this.calls }
			: {
					ok: true,
					value,
					output: this.output,
					calls: this.calls,
					storeWrites: writes ?? { set: Object.create(null), delete: [] },
				};
		if (!this.worker) {
			this.resolveResult(result);
			return;
		}
		Atomics.store(new Int32Array(this.interrupt), 0, 1);
		this.worker
			.terminate()
			.catch(() => undefined)
			.then(() => this.resolveResult(result));
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
	private readonly workerUrl: string | URL;
	private readonly running = new Set<Execution>();
	private closed = false;

	constructor(options: CodemodeSandboxOptions = {}) {
		refuseCodemodeAdmission();
		this.timeoutMs = Math.min(
			Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs!) : DEFAULT_TIMEOUT_MS,
			MAX_EXECUTION_MS,
		);
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
		if (Buffer.byteLength(code) > MAX_MESSAGE_BYTES)
			return Promise.reject(new Error("Sandbox code byte budget exceeded"));
		const store = serializeStore(options.store);
		boundedJson(store);
		const execution = new Execution({
			code,
			tools: new Map(this.toolsByName),
			globals: this.globalsByName,
			timeoutMs: Math.min(
				Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs!) : this.timeoutMs,
				this.timeoutMs,
			),
			signal: options.signal,
			memoryLimitBytes: this.memoryLimitBytes,
			store,
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
