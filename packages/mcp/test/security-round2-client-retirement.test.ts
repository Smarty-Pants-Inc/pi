import { execFileSync } from "node:child_process";
import type { ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	isJsonRpcRequest,
	isJsonRpcResponse,
	JSON_RPC_ERROR_CODES,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcResponse,
	LATEST_PROTOCOL_VERSION,
	McpClient,
	parseJsonRpcMessage,
	StdioTransport,
	StreamableHttpTransport,
} from "../src/index.ts";
import { closeServers, listen, readBody } from "./helpers.ts";

const clients: McpClient[] = [];
const transports: StreamableHttpTransport[] = [];
const releases: (() => void)[] = [];

function deferred<Value>() {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function within<Value>(promise: Promise<Value>): Promise<Value> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Client retirement control exceeded 3000ms")), 3000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function reply(response: ServerResponse, id: JsonRpcId, result: unknown): void {
	response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "controlled-session" });
	response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

async function httpFixture(holdDelete = false) {
	const stream = deferred<ServerResponse>();
	const deletionStarted = deferred<void>();
	const deletionRetired = deferred<void>();
	const responses: JsonRpcResponse[] = [];
	const responseWaiters = new Set<() => void>();
	const barriers = new Map<number, () => void>();
	const deletes: ServerResponse[] = [];
	let nextBarrier = 0;
	let holdingDelete = holdDelete;
	const releaseDelete = () => {
		holdingDelete = false;
		for (const response of deletes) if (!response.writableEnded) response.writeHead(200).end();
	};
	releases.push(releaseDelete);
	const origin = await listen(async (request, response) => {
		if (request.method === "DELETE") {
			deletes.push(response);
			response.on("close", () => deletionRetired.resolve());
			deletionStarted.resolve();
			if (!holdingDelete) response.writeHead(200).end();
			return;
		}
		if (request.method === "GET") {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.flushHeaders();
			stream.resolve(response);
			return;
		}
		const message = parseJsonRpcMessage(JSON.parse(await readBody(request)));
		if (isJsonRpcResponse(message)) {
			responses.push(message);
			for (const waiter of responseWaiters) waiter();
			response.writeHead(202).end();
		} else if (isJsonRpcRequest(message)) {
			if (message.method === "initialize")
				reply(response, message.id, {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: {},
					serverInfo: { name: "client-retirement", version: "1" },
				});
			else reply(response, message.id, {});
		} else response.writeHead(202).end();
	});
	const transport = new StreamableHttpTransport({ url: origin });
	transports.push(transport);
	const client = new McpClient({ name: "client-retirement", version: "1" });
	clients.push(client);
	client.onNotification("fixture/barrier", (params) => {
		if (params && typeof params === "object" && "token" in params && typeof params.token === "number") {
			barriers.get(params.token)?.();
			barriers.delete(params.token);
		}
	});
	await client.connect(transport);
	const serverStream = await within(stream.promise);
	const deliver = async (...messages: JsonRpcMessage[]) => {
		const token = ++nextBarrier;
		const arrived = deferred<void>();
		barriers.set(token, () => arrived.resolve());
		serverStream.write(
			[...messages, { jsonrpc: "2.0", method: "fixture/barrier", params: { token } }]
				.map((message) => `data: ${JSON.stringify(message)}\n\n`)
				.join(""),
		);
		await within(arrived.promise);
	};
	const responseMatching = async (predicate: (response: JsonRpcResponse) => boolean) => {
		const arrived = deferred<JsonRpcResponse>();
		const check = () => {
			const response = responses.find(predicate);
			if (response) arrived.resolve(response);
		};
		responseWaiters.add(check);
		try {
			check();
			return await within(arrived.promise);
		} finally {
			responseWaiters.delete(check);
		}
	};
	return {
		client,
		transport,
		deliver,
		responseMatching,
		responses,
		deletes,
		releaseDelete,
		deletionStarted: deletionStarted.promise,
		deletionRetired: deletionRetired.promise,
	};
}

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
	await Promise.all(transports.splice(0).map((transport) => transport.close().catch(() => {})));
	await closeServers();
});

// smarty-dev#2241 / PR92 F20 and F26: public client, server-initiated SSE requests, controlled cleanup.
describe("McpClient incoming cancellation custody", () => {
	it.each([42, "42"] as const)(
		"rejects duplicate active incoming ID %s before custom, built-in or missing handlers and retains cancellation",
		async (id) => {
			const { client, deliver, responseMatching, responses } = await httpFixture();
			const gate = deferred<void>();
			let signal: AbortSignal | undefined;
			let calls = 0;
			let duplicateCalls = 0;
			client.setRequestHandler("fixture/held", async (_params, context) => {
				calls++;
				signal = context.signal;
				await gate.promise;
				return { original: true };
			});
			client.setRequestHandler("fixture/fast", () => {
				duplicateCalls++;
				return {};
			});
			try {
				await deliver({ jsonrpc: "2.0", id, method: "fixture/held" });
				await deliver(
					{ jsonrpc: "2.0", id, method: "fixture/fast" },
					{ jsonrpc: "2.0", id, method: "ping" },
					{ jsonrpc: "2.0", id, method: "fixture/missing" },
				);
				expect(calls).toBe(1);
				expect(duplicateCalls).toBe(0);
				await responseMatching(
					() => responses.filter((response) => response.id === id && "error" in response).length === 3,
				);
				expect(responses).toEqual(
					Array(3).fill({
						jsonrpc: "2.0",
						id,
						error: { code: JSON_RPC_ERROR_CODES.invalidRequest, message: "Duplicate active MCP request ID" },
					}),
				);
				await deliver({
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId: id, reason: "cancel first" },
				});
				expect(signal?.aborted).toBe(true);
				expect(signal?.reason).toBe("cancel first");
				// Abort is not settlement: a callback still doing cooperative cleanup owns its ID.
				await deliver({ jsonrpc: "2.0", id, method: "fixture/held" });
				expect(calls).toBe(1);
				gate.resolve();
				await responseMatching((response) => response.id === id && "result" in response);
				await client.ping();
				await deliver({ jsonrpc: "2.0", id, method: "fixture/fast" });
				expect(duplicateCalls).toBe(1);
				await client.ping();
			} finally {
				gate.resolve();
			}
		},
	);

	it.each(["client", "transport"] as const)(
		"%s close aborts every accepted callback even after a duplicate fast request completes",
		async (mode) => {
			const { client, transport, deliver } = await httpFixture();
			const gate = deferred<void>();
			const signals = new Map<JsonRpcId, AbortSignal>();
			client.setRequestHandler("fixture/held", async (params, context) => {
				const id = (params as { id: JsonRpcId }).id;
				signals.set(id, context.signal);
				await gate.promise;
				return {};
			});
			try {
				await deliver(
					{ jsonrpc: "2.0", id: 7, method: "fixture/held", params: { id: 7 } },
					{ jsonrpc: "2.0", id: "7", method: "fixture/held", params: { id: "7" } },
					{ jsonrpc: "2.0", id: 8, method: "fixture/held", params: { id: 8 } },
					{ jsonrpc: "2.0", id: 7, method: "ping" },
				);
				expect(signals.size).toBe(3);
				let completed = false;
				const closing = (mode === "client" ? client.close() : transport.close()).then(() => {
					completed = true;
				});
				if (mode === "transport") await within(closing);
				else await delay(0);
				expect([...signals.values()].map((signal) => signal.aborted)).toEqual([true, true, true]);
				if (mode === "client") expect(completed).toBe(false);
				gate.resolve();
				await within(closing);
			} finally {
				gate.resolve();
			}
		},
	);

	it("normal built-in and custom handlers work, and a failed callback releases its ID", async () => {
		const { client, deliver, responseMatching } = await httpFixture();
		client.setRequestHandler("fixture/fail", () => {
			throw new Error("controlled callback failure");
		});
		client.setRequestHandler("fixture/ok", () => ({ ok: true }));
		await deliver(
			{ jsonrpc: "2.0", id: "ping", method: "ping" },
			{ jsonrpc: "2.0", id: "failure", method: "fixture/fail" },
			{ jsonrpc: "2.0", id: "missing", method: "fixture/missing" },
		);
		expect(await responseMatching((response) => response.id === "ping")).toMatchObject({ result: {} });
		expect(await responseMatching((response) => response.id === "failure")).toMatchObject({
			error: { code: JSON_RPC_ERROR_CODES.internalError, message: "controlled callback failure" },
		});
		expect(await responseMatching((response) => response.id === "missing")).toMatchObject({
			error: { code: JSON_RPC_ERROR_CODES.methodNotFound },
		});
		await client.ping();
		await deliver({ jsonrpc: "2.0", id: "failure", method: "fixture/ok" });
		expect(await responseMatching((response) => response.id === "failure" && "result" in response)).toMatchObject({
			result: { ok: true },
		});
	});

	it("a cancelled old callback cannot remove custody of a reused ID after its own settlement", async () => {
		const { client, deliver, responseMatching } = await httpFixture();
		const firstGate = deferred<void>();
		const secondGate = deferred<void>();
		const signals: AbortSignal[] = [];
		client.setRequestHandler("fixture/held", async (_params, context) => {
			const revision = signals.length;
			signals.push(context.signal);
			await (revision === 0 ? firstGate.promise : secondGate.promise);
			return { revision };
		});
		try {
			await deliver({ jsonrpc: "2.0", id: "reused", method: "fixture/held" });
			await deliver({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "reused" } });
			firstGate.resolve();
			await responseMatching((response) => response.id === "reused" && "result" in response);
			await client.ping();
			await deliver({ jsonrpc: "2.0", id: "reused", method: "fixture/held" });
			expect(signals).toHaveLength(2);
			expect(signals[1].aborted).toBe(false);
			await deliver({ jsonrpc: "2.0", id: "reused", method: "ping" });
			await deliver({
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: "reused", reason: "second only" },
			});
			expect(signals[1].aborted).toBe(true);
			expect(signals[1].reason).toBe("second only");
		} finally {
			firstGate.resolve();
			secondGate.resolve();
		}
	});
});

// smarty-dev#2241 / F26: every close caller must join actual transport completion, not merely state.
describe("shared public client and HTTP close completion", () => {
	it("client close, abort-listener reentry and onClose reentry all join one held HTTP DELETE", async () => {
		const { client, transport, deliver, deletes, releaseDelete, deletionStarted } = await httpFixture(true);
		const handlerGate = deferred<void>();
		const joins: Promise<void>[] = [];
		let completions = 0;
		let closeCallbacks = 0;
		const observe = (promise: Promise<void>) => {
			joins.push(promise);
			void promise.then(() => {
				completions++;
			});
		};
		client.setRequestHandler("fixture/held", async (_params, context) => {
			// smarty-dev#2241: callback-local shutdown cannot join its own held cleanup.
			context.signal.addEventListener("abort", () => observe(client.close()), { once: true });
			await handlerGate.promise;
			return {};
		});
		client.onClose(() => {
			closeCallbacks++;
			observe(client.close());
		});
		try {
			await deliver({ jsonrpc: "2.0", id: "host-work", method: "fixture/held" });
			const first = client.close();
			observe(first);
			observe(client.close());
			await within(deletionStarted);
			await delay(0);
			expect(closeCallbacks).toBe(1);
			expect(joins).toHaveLength(4);
			expect(completions).toBe(1);
			expect(joins[0]).not.toBe(first);
			expect(joins.slice(1).every((join) => join === first)).toBe(true);
			expect(deletes).toHaveLength(1);
			expect(client.connectionState).toBe("closed");
			releaseDelete();
			await delay(0);
			expect(completions).toBe(1);
			handlerGate.resolve();
			await within(Promise.all(joins));
			expect(completions).toBe(4);
			expect(client.close()).toBe(first);
			await transport.close();
			expect(deletes).toHaveLength(1);
		} finally {
			handlerGate.resolve();
			releaseDelete();
		}
	});

	it("overlapping transport close callers join one real HTTP DELETE and its close event", async () => {
		const { transport, deletes, releaseDelete, deletionStarted } = await httpFixture(true);
		let closeCallbacks = 0;
		let completions = 0;
		transport.onClose(() => {
			closeCallbacks++;
		});
		try {
			const first = transport.close();
			const second = transport.close();
			void first.then(() => {
				completions++;
			});
			void second.then(() => {
				completions++;
			});
			await within(deletionStarted);
			await delay(0);
			expect(completions).toBe(0);
			expect(second).toBe(first);
			expect(closeCallbacks).toBe(0);
			expect(deletes).toHaveLength(1);
			releaseDelete();
			await within(Promise.all([first, second]));
			expect(completions).toBe(2);
			expect(closeCallbacks).toBe(1);
			expect(transport.close()).toBe(first);
		} finally {
			releaseDelete();
		}
	});

	it("all close callers join bounded DELETE timeout and cancellation when the server never acknowledges", async () => {
		const { client, deletes, deletionStarted, deletionRetired, releaseDelete } = await httpFixture(true);
		try {
			const start = performance.now();
			const first = client.close();
			await within(deletionStarted);
			const second = client.close();
			await within(second);
			expect(performance.now() - start).toBeGreaterThanOrEqual(900);
			await within(first);
			await within(deletionRetired);
			expect(deletes).toHaveLength(1);
		} finally {
			releaseDelete();
		}
	});

	it("concurrent client close callers receive the same transport cleanup failure", async () => {
		const { client, transport, deletionStarted, releaseDelete } = await httpFixture(true);
		const failure = new Error("controlled close hook failure");
		transport.onClose(() => {
			throw failure;
		});
		try {
			const first = client.close();
			const firstFailure = first.catch((error: unknown) => error);
			const secondFailure = client.close().catch((error: unknown) => error);
			await within(deletionStarted);
			releaseDelete();
			expect(await within(firstFailure)).toBe(failure);
			expect(await within(secondFailure)).toBe(failure);
			expect(client.close()).toBe(first);
		} finally {
			releaseDelete();
		}
	});

	it("close before connect is idempotent and remains closed", async () => {
		const client = new McpClient({ name: "not-connected", version: "1" });
		const first = client.close();
		expect(client.close()).toBe(first);
		await first;
		expect(client.connectionState).toBe("closed");
	});
});

const descendantSource = `
import { closeSync } from "node:fs";
process.on("SIGTERM", () => {});
closeSync(1);
closeSync(2);
process.send({ pid: process.pid });
process.disconnect();
setTimeout(() => process.exit(0), 15000);
`;
const wrapperSource = String.raw`
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const descendant = spawn(process.execPath, ["--input-type=module", "-e", process.argv[1]], { stdio: ["ignore", 1, 2, "ipc"] });
descendant.on("error", () => process.exit(1));
descendant.on("message", (ready) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "fixture/ready", params: { descendantPid: ready.pid } }) + "\n"));
descendant.unref();
process.on("SIGTERM", () => process.exit(0));
const lines = createInterface({ input: process.stdin });
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "owned-descendant", version: "1" },
  } }) + "\n");
});
setTimeout(() => process.exit(0), 15000);
`;

function processInfo(pid: number): { group: number; running: boolean } | undefined {
	let output: string;
	try {
		output = execFileSync("ps", ["-o", "pgid=,stat=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 1000,
			maxBuffer: 4096,
		});
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		if (failure.status === 1 && !failure.stdout?.trim() && !failure.stderr?.trim()) return undefined;
		throw error;
	}
	if (!output.trim()) return undefined;
	const [group, state] = output.trim().split(/\s+/);
	return { group: Number(group), running: !state.startsWith("Z") };
}

function cleanupOwnedGroup(group: number | undefined, descendant: number | undefined): void {
	if (group === undefined) return;
	if (
		![group, descendant].some((pid) => {
			if (pid === undefined) return false;
			const info = processInfo(pid);
			return info?.group === group && info.running;
		})
	)
		return;
	try {
		process.kill(-group, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

// smarty-dev#2241 / F26: an exited leader is not completion while a stubborn descendant still runs.
it.skipIf(process.platform === "win32")(
	"concurrent and reentrant public client close joins POSIX descendant escalation",
	async () => {
		const transport = new StdioTransport({
			command: process.execPath,
			args: ["--input-type=module", "-e", wrapperSource, descendantSource],
			closeTimeoutMs: 300,
		});
		const client = new McpClient({ name: "stdio-client-retirement", version: "1" });
		const ready = deferred<number>();
		const leaderClosed = deferred<void>();
		const joins: Promise<void>[] = [];
		let completions = 0;
		let group: number | undefined;
		let descendant: number | undefined;
		client.onNotification("fixture/ready", (params) => {
			if (
				params &&
				typeof params === "object" &&
				"descendantPid" in params &&
				typeof params.descendantPid === "number"
			)
				ready.resolve(params.descendantPid);
		});
		client.onClose(() => {
			const join = client.close();
			joins.push(join);
			void join.then(() => {
				completions++;
			});
		});
		transport.onClose(() => leaderClosed.resolve());
		try {
			await within(client.connect(transport));
			group = transport.pid;
			descendant = await within(ready.promise);
			expect(group).toBeTypeOf("number");
			expect(processInfo(descendant)).toEqual({ group, running: true });
			const first = client.close();
			joins.push(first, client.close());
			await within(leaderClosed.promise);
			expect(processInfo(descendant)?.running).toBe(true);
			expect(completions).toBe(0);
			expect(joins.every((join) => join === first)).toBe(true);
			await within(Promise.all(joins));
			// SIGKILL receipt and OS scheduling are separate; zombies cannot run server work.
			for (let attempt = 0; attempt < 100 && processInfo(descendant)?.running; attempt++) await delay(10);
			expect(processInfo(descendant)?.running ?? false).toBe(false);
		} finally {
			cleanupOwnedGroup(group, descendant);
			await within(client.close());
			await within(transport.close());
		}
	},
	10000,
);
