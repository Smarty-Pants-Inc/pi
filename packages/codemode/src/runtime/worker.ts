/**
 * Worker thread entry. One worker runs one script inside a fresh QuickJS VM
 * (a separate wasm instance), relays tool calls and output to the host, and
 * reports the result. The host terminates the worker when the script settles,
 * times out, or is aborted; the worker exists so that a spinning script never
 * blocks the host thread.
 *
 * Importing this module starts the worker. Hosts that bundle their code (for
 * example a Bun compiled executable) add a file that imports
 * `@earendil-works/pi-codemode/worker` as a separate entrypoint and pass its URL
 * as `workerUrl`.
 */
import { parentPort, workerData } from "node:worker_threads";
import { JSException, type JSValueHandle, MAX_STACK_SIZE, QuickJS } from "quickjs-wasi";
import { PRELUDE_SOURCE } from "./prelude-source.ts";
import {
	INTERRUPT_INDEX,
	isHostToWorkerMessage,
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

function post(message: WorkerToHostMessage): void {
	parentPort?.postMessage(message);
}

let crashed = false;
function crash(error: unknown): void {
	if (crashed) return;
	crashed = true;
	const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	post({ type: "crash", message: message.slice(0, 1024) });
}

/**
 * QuickJS writes engine diagnostics to fd 1 and 2, which the default shim
 * forwards to the host's stdout and stderr. That output belongs to the host
 * application (for example a TUI), so it is discarded. Reporting every byte as
 * written keeps libc from retrying.
 */
function discardOutput(memory: { readonly buffer: ArrayBufferLike }) {
	return {
		fd_write(_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
			const view = new DataView(memory.buffer);
			let written = 0;
			for (let i = 0; i < iovsLen; i++) {
				written += view.getUint32(iovsPtr + i * 8 + 4, true);
			}
			view.setUint32(nwrittenPtr, written, true);
			return 0;
		},
	};
}

function describeException(error: JSException): string {
	const head = error.message ? `${error.name}: ${error.message}` : error.name;
	const stack = error.stack?.trimEnd();
	return JSON.stringify({ name: error.name, message: error.message, stack: stack ? `${head}\n${stack}` : head });
}

async function main(data: WorkerData): Promise<void> {
	const interrupt = new Int32Array(data.interrupt);
	const vm = await QuickJS.create({
		wasm: data.wasm,
		memoryLimit: data.memoryLimitBytes,
		// Without a guard, deep recursion overflows the wasm stack and traps instead of throwing a
		// catchable RangeError.
		maxStackSize: MAX_STACK_SIZE,
		interruptHandler: () => Atomics.load(interrupt, INTERRUPT_INDEX) !== 0,
		wasi: discardOutput,
	});

	let outputBytes = 0;
	let outputItems = 0;
	let callCount = 0;
	const pendingCalls = new Set<number>();
	const fail = (error: unknown): void => {
		// Native retirement cannot be bypassed by catching a guest exception or
		// replacing its serializer/prototypes. Send just one emergency report.
		crash(error);
		Atomics.store(interrupt, INTERRUPT_INDEX, 1);
	};
	const readString = (handle: JSValueHandle | undefined): string => {
		if (!handle?.isString) throw new Error("Invalid bridge string");
		// Check primitive length before copying out of wasm. UTF-8 accounting
		// below then checks actual bytes before queueing/accumulation.
		if (handle.length > MAX_MESSAGE_BYTES) throw new Error("Message byte budget exceeded");
		return handle.toString();
	};
	const send = (message: WorkerToHostMessage): void => {
		if (crashed || Atomics.load(interrupt, INTERRUPT_INDEX) !== 0) return;
		const bytes = messageBytes(message);
		if (bytes > MAX_MESSAGE_BYTES) throw new Error("Message byte budget exceeded");
		const items = Atomics.add(interrupt, QUEUED_ITEMS_INDEX, 1) + 1;
		const queuedBytes = Atomics.add(interrupt, QUEUED_BYTES_INDEX, bytes) + bytes;
		if (items > MAX_OUTSTANDING_MESSAGES || queuedBytes > MAX_OUTSTANDING_BYTES) {
			Atomics.sub(interrupt, QUEUED_ITEMS_INDEX, 1);
			Atomics.sub(interrupt, QUEUED_BYTES_INDEX, bytes);
			throw new Error("Outstanding message budget exceeded");
		}
		post(message);
	};

	// The native bridge validates even though the prelude normally passes
	// primitives: guest intrinsics remain mutable and are not a trust boundary.
	const bridge = vm.newFunction("bridge", (kind, a, b, c) => {
		if (crashed || Atomics.load(interrupt, INTERRUPT_INDEX) !== 0) return vm.undefined;
		try {
			const target = readString(kind);
			switch (target) {
				case "call":
				case "global": {
					if (!a?.isNumber) throw new Error("Invalid bridge call id");
					const id = a.toNumber();
					if (
						!Number.isSafeInteger(id) ||
						id <= 0 ||
						pendingCalls.has(id) ||
						pendingCalls.size >= MAX_PENDING_CALLS ||
						callCount >= MAX_CALLS
					) {
						throw new Error("Host call budget exceeded or invalid call id");
					}
					pendingCalls.add(id);
					callCount++;
					send({
						type: "call",
						id,
						target: target === "call" ? "tool" : "global",
						name: readString(b),
						args: c === undefined || c.isUndefined ? undefined : readString(c),
					});
					break;
				}
				case "output": {
					if (outputItems >= MAX_OUTPUT_ITEMS) throw new Error("Output item budget exceeded");
					const item =
						readString(a) === "image"
							? { type: "image" as const, data: readString(b), mimeType: readString(c) }
							: { type: "text" as const, text: readString(b) };
					const message: WorkerToHostMessage = { type: "output", item };
					const bytes = messageBytes(message);
					if (outputBytes + bytes > MAX_OUTPUT_BYTES) throw new Error("Output byte budget exceeded");
					outputBytes += bytes;
					outputItems++;
					send(message);
					break;
				}
				case "done":
					if (!a.isBool) throw new Error("Invalid bridge completion");
					if (a.toBoolean()) {
						send({
							type: "done",
							ok: true,
							value: b === undefined || b.isUndefined ? undefined : readString(b),
							writes: readString(c),
						});
					} else {
						send({ type: "done", ok: false, error: readString(b) });
					}
					break;
				default:
					throw new Error("Invalid bridge message kind");
			}
		} catch (error) {
			fail(error);
		}
		return vm.undefined;
	});

	// The VM lives until the host terminates the worker, so these handles are never disposed.
	const api = vm.withScope((scope) =>
		scope.escape(
			vm.callFunction(
				vm.evalCode(PRELUDE_SOURCE, "codemode-prelude.js"),
				vm.undefined,
				bridge,
				vm.newString(JSON.stringify(data.tools)),
				vm.newString(JSON.stringify(data.globals)),
				vm.newString(JSON.stringify(data.store)),
			),
		),
	);
	const settle = api.getProp("settle");
	const run = api.getProp("run");
	const stalled = api.getProp("stalled");
	/** Run queued jobs, then fail a script that waits on nothing that can ever resume it. */
	const drain = () => {
		vm.executePendingJobs();
		vm.callFunction(stalled, api).dispose();
	};

	parentPort?.on("message", (message: unknown) => {
		if (!isHostToWorkerMessage(message) || crashed) return;
		try {
			Atomics.sub(interrupt, RESPONSE_ITEMS_INDEX, 1);
			Atomics.sub(interrupt, RESPONSE_BYTES_INDEX, messageBytes(message));
			pendingCalls.delete(message.id);
			vm.withScope(() => {
				vm.callFunction(
					settle,
					api,
					vm.newNumber(message.id),
					message.ok ? vm.true : vm.false,
					message.payload === undefined ? vm.undefined : vm.newString(message.payload),
				);
			});
			drain();
		} catch (error) {
			fail(error);
		}
	});

	// The prefix shares the first line with the script so reported line numbers
	// match the script as written.
	let fn: JSValueHandle;
	try {
		fn = vm.evalCode(`(async (tools, console) => {${data.code}\n})`, "codemode.js");
	} catch (error) {
		if (!(error instanceof JSException)) throw error;
		send({ type: "done", ok: false, error: describeException(error) });
		return;
	}
	vm.callFunction(run, api, fn).dispose();
	fn.dispose();
	drain();
}

if (parentPort) {
	main(workerData as WorkerData).catch(crash);
}
