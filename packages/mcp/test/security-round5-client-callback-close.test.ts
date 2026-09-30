import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { McpClient } from "../src/client.ts";
import { isJsonRpcRequest, JSON_RPC_ERROR_CODES, type JsonRpcMessage } from "../src/protocol/jsonrpc.ts";
import { LATEST_PROTOCOL_VERSION } from "../src/protocol/types.ts";
import { type McpTransport, TransportEvents } from "../src/transports/transport.ts";

function deferred<Value = void>() {
	return Promise.withResolvers<Value>();
}

/** Accepted JSON-RPC messages through the public transport contract, no private client calls. */
class CallbackTransport extends TransportEvents implements McpTransport {
	readonly messages: JsonRpcMessage[] = [];
	readonly closeStarted = deferred();
	readonly closeGate = deferred();
	closeCalls = 0;
	holdClose = false;
	closeFailure: Error | undefined;
	onRetire: (() => void) | undefined;

	async start(): Promise<void> {}

	async send(message: JsonRpcMessage): Promise<void> {
		this.messages.push(message);
		if (!isJsonRpcRequest(message)) return;
		queueMicrotask(() =>
			this.deliver({
				jsonrpc: "2.0",
				id: message.id,
				result:
					message.method === "initialize"
						? {
								protocolVersion: LATEST_PROTOCOL_VERSION,
								capabilities: {},
								serverInfo: { name: "callback-fixture", version: "1" },
							}
						: {},
			}),
		);
	}

	async close(): Promise<void> {
		this.closeCalls++;
		this.closeStarted.resolve();
		this.onRetire?.();
		this.emitClose();
		if (this.holdClose) await this.closeGate.promise;
		if (this.closeFailure) throw this.closeFailure;
	}

	deliver(message: JsonRpcMessage): void {
		this.emitMessage(message);
	}

	drop(): void {
		this.emitClose();
	}
}

const clients: McpClient[] = [];
const releases: (() => void)[] = [];

async function fixture() {
	const transport = new CallbackTransport();
	const client = new McpClient({ name: "callback-client", version: "1" });
	clients.push(client);
	releases.push(() => transport.closeGate.resolve());
	await client.connect(transport);
	return { client, transport };
}

function gate() {
	const value = deferred();
	releases.push(() => value.resolve());
	return value;
}

function observe(promise: Promise<void>) {
	const state = { settled: false, rejected: false, error: undefined as unknown };
	const done = promise.then(
		() => {
			state.settled = true;
		},
		(error: unknown) => {
			state.settled = true;
			state.rejected = true;
			state.error = error;
		},
	);
	return { state, done };
}

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.allSettled(clients.splice(0).map((client) => client.close()));
});

// smarty-dev#2241 / PR92 round5: abort is not accepted callback cleanup completion.
describe("raw MCP incoming callback close custody", () => {
	it.each(["close", "transport-drop"] as const)(
		"external close joins gated cooperative cleanup after %s, despite incoming ID removal",
		async (mode) => {
			const { client, transport } = await fixture();
			const entered = deferred();
			const aborted = deferred();
			const cleanup = gate();
			let cleaned = false;
			let calls = 0;
			client.setRequestHandler("fixture/cleanup", async (_params, { signal }) => {
				calls++;
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				entered.resolve();
				await aborted.promise;
				await cleanup.promise;
				cleaned = true;
				return {};
			});
			transport.deliver({ jsonrpc: "2.0", id: "cleanup", method: "fixture/cleanup" });
			await entered.promise;
			if (mode === "transport-drop") transport.drop();
			const first = client.close();
			const join = observe(first);
			expect(client.close()).toBe(first);
			await aborted.promise;
			await transport.closeStarted.promise;
			await delay(0);
			expect(cleaned).toBe(false);
			expect(join.state.settled).toBe(false);
			expect(client.connectionState).toBe("closed");
			transport.deliver({ jsonrpc: "2.0", id: "late", method: "fixture/cleanup" });
			expect(calls).toBe(1);
			await expect(client.ping()).rejects.toThrow("closed");
			cleanup.resolve();
			await join.done;
			expect(cleaned).toBe(true);
			expect(join.state.error).toBeUndefined();
			expect(transport.closeCalls).toBe(1);
		},
	);

	it("a handler can await its own close while external callers still join its remaining cleanup", async () => {
		const { client, transport } = await fixture();
		const selfClosed = deferred();
		const cleanup = gate();
		let cleaned = false;
		client.setRequestHandler("fixture/self-close", async () => {
			// This executes synchronously on admission, before the handler returns its promise.
			await client.close();
			selfClosed.resolve();
			await cleanup.promise;
			cleaned = true;
			return {};
		});
		transport.deliver({ jsonrpc: "2.0", id: 1, method: "fixture/self-close" });
		await selfClosed.promise;
		const join = observe(client.close());
		await delay(0);
		expect(join.state.settled).toBe(false);
		cleanup.resolve();
		await join.done;
		expect(cleaned).toBe(true);
	});

	it.each(["close", "cancel-notification"] as const)(
		"abort-listener cleanup can await callback-local close after %s without self-joining",
		async (mode) => {
			const { client, transport } = await fixture();
			const entered = deferred();
			const selfClosed = deferred();
			const cleanup = gate();
			client.setRequestHandler("fixture/abort-close", async (_params, { signal }) => {
				const aborted = deferred();
				signal.addEventListener(
					"abort",
					() => {
						void client.close().then(() => {
							selfClosed.resolve();
							aborted.resolve();
						});
					},
					{ once: true },
				);
				entered.resolve();
				await aborted.promise;
				await cleanup.promise;
				return {};
			});
			transport.deliver({ jsonrpc: "2.0", id: 1, method: "fixture/abort-close" });
			await entered.promise;
			if (mode === "cancel-notification") {
				transport.deliver({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
			}
			const join = observe(client.close());
			await selfClosed.promise;
			await delay(0);
			expect(join.state.settled).toBe(false);
			cleanup.resolve();
			await join.done;
		},
	);

	it("transport failure is shared only after accepted handler cleanup settles", async () => {
		const { client, transport } = await fixture();
		const entered = deferred();
		const cleanup = gate();
		const failure = new Error("controlled transport retirement failure");
		transport.closeFailure = failure;
		client.setRequestHandler("fixture/held", async () => {
			entered.resolve();
			await cleanup.promise;
			throw new Error("controlled handler rejection");
		});
		transport.deliver({ jsonrpc: "2.0", id: 1, method: "fixture/held" });
		await entered.promise;
		const first = client.close();
		const join = observe(first);
		expect(client.close()).toBe(first);
		await delay(0);
		expect(join.state.settled).toBe(false);
		cleanup.resolve();
		await join.done;
		expect(join.state.error).toBe(failure);
		expect(client.close()).toBe(first);
	});

	it.each([false, true])(
		"throwing close/error observers still drain all callbacks and transport (transport failure: %s)",
		async (failTransport) => {
			const { client, transport } = await fixture();
			const cleanups = [gate(), gate()];
			const effects: number[] = [];
			const closeFailure = new Error("controlled close observer failure");
			const observerFailure = new Error("controlled error observer failure");
			const reported: Error[] = [];
			transport.holdClose = true;
			if (failTransport) transport.closeFailure = new Error("controlled transport failure");
			client.onClose(() => {
				throw closeFailure;
			});
			client.onError((error) => {
				reported.push(error);
				throw observerFailure;
			});
			client.setRequestHandler("fixture/reject-held", async (params) => {
				const index = (params as { index: number }).index;
				await cleanups[index].promise;
				effects.push(index);
				throw new Error(`controlled handler rejection ${index}`);
			});
			for (const index of [0, 1]) {
				transport.deliver({ jsonrpc: "2.0", id: index, method: "fixture/reject-held", params: { index } });
			}
			const first = client.close();
			const join = observe(first);
			expect(client.close()).toBe(first);
			await delay(0);
			expect({ retired: transport.closeCalls, settled: join.state.settled, effects }).toEqual({
				retired: 1,
				settled: false,
				effects: [],
			});
			expect(reported).toEqual([closeFailure]);
			cleanups[0].resolve();
			await delay(0);
			expect(effects).toEqual([0]);
			expect(join.state.settled).toBe(false);
			transport.closeGate.resolve();
			await delay(0);
			expect(join.state.settled).toBe(false);
			cleanups[1].resolve();
			await join.done;
			expect(effects).toEqual([0, 1]);
			expect(join.state.error).toBe(observerFailure);
			expect(client.close()).toBe(first);
		},
	);

	it.each([undefined, null, false, 0, ""])(
		"preserves falsy observer rejection %s over later transport failure after draining",
		async (observerFailure) => {
			const { client, transport } = await fixture();
			const cleanup = gate();
			let cleaned = false;
			transport.closeFailure = new Error("later transport failure");
			client.onClose(() => {
				throw new Error("close observer failure");
			});
			client.onError(() => {
				throw observerFailure;
			});
			client.setRequestHandler("fixture/falsy-held", async () => {
				await cleanup.promise;
				cleaned = true;
				return {};
			});
			transport.deliver({ jsonrpc: "2.0", id: "held", method: "fixture/falsy-held" });
			const first = client.close();
			const join = observe(first);
			await delay(0);
			expect(transport.closeCalls).toBe(1);
			expect(join.state.settled).toBe(false);
			cleanup.resolve();
			await join.done;
			expect(cleaned).toBe(true);
			expect(join.state.rejected).toBe(true);
			expect(join.state.error).toBe(observerFailure);
			expect(client.close()).toBe(first);
		},
	);

	it.each(["drop", "close"] as const)(
		"transport-origin observer gets the full join when a handler synchronously invokes transport %s",
		async (mode) => {
			const { client, transport } = await fixture();
			const cleanup = gate();
			const abortClosed = deferred();
			const selfClosed = deferred();
			let observerJoin: Promise<void> | undefined;
			let cleaned = false;
			client.onClose(() => {
				observerJoin = client.close();
			});
			client.setRequestHandler("fixture/drop-self", async (_params, { signal }) => {
				signal.addEventListener(
					"abort",
					() => {
						void client.close().then(() => abortClosed.resolve());
					},
					{ once: true },
				);
				if (mode === "drop") transport.drop();
				else await transport.close();
				await client.close();
				selfClosed.resolve();
				await cleanup.promise;
				cleaned = true;
				return {};
			});
			transport.deliver({ jsonrpc: "2.0", id: "drop-self", method: "fixture/drop-self" });
			await selfClosed.promise;
			await abortClosed.promise;
			const first = client.close();
			const join = observe(first);
			const observed = observe(observerJoin!);
			await delay(0);
			expect(observed.state.settled).toBe(false);
			expect(observerJoin).toBe(first);
			expect(join.state.settled).toBe(false);
			expect(cleaned).toBe(false);
			cleanup.resolve();
			await join.done;
			expect(cleaned).toBe(true);
			expect(join.state.error).toBeUndefined();
		},
	);

	it("multiple held rejecting handlers all drain before the shared transport failure", async () => {
		const { client, transport } = await fixture();
		const cleanups = [gate(), gate()];
		const effects: number[] = [];
		const failure = new Error("controlled transport failure");
		transport.closeFailure = failure;
		client.setRequestHandler("fixture/multi-held", async (params) => {
			const index = (params as { index: number }).index;
			await cleanups[index].promise;
			effects.push(index);
			throw new Error(`controlled handler rejection ${index}`);
		});
		for (const index of [0, 1]) {
			transport.deliver({ jsonrpc: "2.0", id: index, method: "fixture/multi-held", params: { index } });
		}
		const first = client.close();
		const join = observe(first);
		cleanups[0].resolve();
		await delay(0);
		expect(effects).toEqual([0]);
		expect(join.state.settled).toBe(false);
		cleanups[1].resolve();
		await join.done;
		expect(effects).toEqual([0, 1]);
		expect(join.state.error).toBe(failure);
		expect(client.close()).toBe(first);
	});

	it("callback custody on one client does not bypass another client's external drain", async () => {
		const a = await fixture();
		const b = await fixture();
		const cleanup = gate();
		const bEntered = deferred();
		const aEntered = deferred();
		const aFinished = deferred();
		b.client.setRequestHandler("fixture/held", async () => {
			bEntered.resolve();
			await cleanup.promise;
			return {};
		});
		a.client.setRequestHandler("fixture/close-other", async () => {
			aEntered.resolve();
			await b.client.close();
			aFinished.resolve();
			return {};
		});
		b.transport.deliver({ jsonrpc: "2.0", id: 1, method: "fixture/held" });
		await bEntered.promise;
		a.transport.deliver({ jsonrpc: "2.0", id: 1, method: "fixture/close-other" });
		await aEntered.promise;
		let finished = false;
		void aFinished.promise.then(() => {
			finished = true;
		});
		await delay(0);
		expect(finished).toBe(false);
		cleanup.resolve();
		await aFinished.promise;
		await a.client.ping();
	});

	it("normal requests, duplicate-ID cancellation, rejection and ID reuse remain usable", async () => {
		const { client, transport } = await fixture();
		const cleanup = gate();
		let signal: AbortSignal | undefined;
		let calls = 0;
		client.setRequestHandler("fixture/held", async (_params, context) => {
			signal = context.signal;
			calls++;
			await cleanup.promise;
			return { ok: true };
		});
		client.setRequestHandler("fixture/reject", async () => {
			throw new Error("controlled handler rejection");
		});
		transport.deliver({ jsonrpc: "2.0", id: "active", method: "fixture/held" });
		transport.deliver({ jsonrpc: "2.0", id: "active", method: "ping" });
		transport.deliver({ jsonrpc: "2.0", id: "active", method: "fixture/missing" });
		transport.deliver({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: "active", reason: "controlled cancellation" },
		});
		expect(signal?.aborted).toBe(true);
		expect(signal?.reason).toBe("controlled cancellation");
		expect(calls).toBe(1);
		expect(transport.messages.filter((message) => "error" in message && message.id === "active")).toEqual(
			Array(2).fill({
				jsonrpc: "2.0",
				id: "active",
				error: { code: JSON_RPC_ERROR_CODES.invalidRequest, message: "Duplicate active MCP request ID" },
			}),
		);
		cleanup.resolve();
		await delay(0);
		transport.deliver({ jsonrpc: "2.0", id: "active", method: "fixture/reject" });
		await delay(0);
		expect(transport.messages).toContainEqual({
			jsonrpc: "2.0",
			id: "active",
			error: { code: JSON_RPC_ERROR_CODES.internalError, message: "controlled handler rejection" },
		});
		transport.deliver({ jsonrpc: "2.0", id: "active", method: "ping" });
		await delay(0);
		expect(transport.messages.filter((message) => "result" in message && message.id === "active")).toHaveLength(2);
		await client.ping();
		await client.close();
		const fresh = await fixture();
		await fresh.client.ping();
	});

	it("settled callbacks do not lend their inherited context a self-join exemption", async () => {
		const { client, transport } = await fixture();
		const later = gate();
		const cleanup = gate();
		const entered = deferred();
		const detachedClose = deferred<Promise<void>>();
		let joined = false;
		client.setRequestHandler("fixture/detach", () => {
			void later.promise.then(() => {
				const closing = client.close();
				detachedClose.resolve(closing);
				void closing.then(() => {
					joined = true;
				});
			});
			return {};
		});
		transport.deliver({ jsonrpc: "2.0", id: "detached", method: "fixture/detach" });
		await delay(0);
		expect(transport.messages).toContainEqual({ jsonrpc: "2.0", id: "detached", result: {} });
		client.setRequestHandler("fixture/held", async () => {
			entered.resolve();
			await cleanup.promise;
			return {};
		});
		transport.deliver({ jsonrpc: "2.0", id: "held", method: "fixture/held" });
		await entered.promise;
		later.resolve();
		await transport.closeStarted.promise;
		await delay(0);
		expect(joined).toBe(false);
		cleanup.resolve();
		await detachedClose.promise;
		expect(joined).toBe(true);
	});

	it("memoized completion is installed before onClose and transport-close reentry", async () => {
		const { client, transport } = await fixture();
		transport.holdClose = true;
		const joins: Promise<void>[] = [];
		client.onClose(() => joins.push(client.close()));
		transport.onRetire = () => joins.push(client.close());
		const first = client.close();
		const join = observe(first);
		await transport.closeStarted.promise;
		expect(joins).toEqual([first, first]);
		await delay(0);
		expect(join.state.settled).toBe(false);
		transport.closeGate.resolve();
		await Promise.all([first, ...joins]);
		expect(transport.closeCalls).toBe(1);
	});
});
