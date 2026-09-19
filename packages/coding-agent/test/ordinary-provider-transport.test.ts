import { withResponsesEvidence } from "@earendil-works/pi-ai/api/responses-evidence";
import { describe, expect, test, vi } from "vitest";
import { assertOwnedCountResult, createOwnedProviderExchange } from "../src/core/ordinary-provider-transport.ts";
import { OrdinaryTokenBudget } from "../src/core/ordinary-token-budget.ts";
import { projectResponsesTokenCount } from "../src/core/ordinary-token-qualification.ts";

// Synthetic native/Node event boundaries; production exchange and Responses
// observer run unchanged. This is NOT TCP/TLS/native/provider qualification.
const fake = vi.hoisted(() => {
	class Events {
		listeners = new Map<string, Array<(...args: unknown[]) => void>>();
		on(name: string, callback: (...args: unknown[]) => void) {
			this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
			return this;
		}
		once(name: string, callback: (...args: unknown[]) => void) {
			let called = false;
			return this.on(name, (...args) => {
				if (!called) {
					called = true;
					callback(...args);
				}
			});
		}
		emit(name: string, ...args: unknown[]) {
			for (const callback of this.listeners.get(name) ?? []) callback(...args);
		}
		destroy() {
			this.emit("close");
			return this;
		}
	}
	const state = {
		hold: false,
		constructed: 0,
		sockets: [] as Events[],
		sent: [] as string[],
		body: "synthetic-body",
		contentType: "text/event-stream",
		status: 200,
	};
	class Socket extends Events {
		constructor() {
			super();
			state.sockets.push(this);
		}
		override destroy() {
			if (!state.hold) this.emit("close");
			return this;
		}
	}
	class Agent {
		createConnection(): Events {
			throw new Error("not overridden");
		}
		destroy() {}
	}
	class Message extends Events {
		statusCode = state.status;
		headers = {};
		rawHeaders = ["content-type", state.contentType];
		complete = false;
		async *[Symbol.asyncIterator]() {
			yield Buffer.from(state.body);
			this.complete = true;
			this.emit("close");
		}
	}
	class Request extends Events {
		headersSent = false;
		readonly deliver: (message: Message) => void;
		constructor(deliver: (message: Message) => void) {
			super();
			this.deliver = deliver;
		}
		setHeader(_name: string, _value: string) {}
		end(bytes: Uint8Array) {
			state.sent.push(Buffer.from(bytes).toString());
			this.headersSent = true;
			this.deliver(new Message());
		}
	}
	return {
		state,
		Socket,
		Agent,
		lookup: async () => ({ address: "192.0.2.1" }),
		connect: () => {
			const socket = new Socket();
			queueMicrotask(() => socket.emit("secureConnect"));
			return socket;
		},
		request: (
			_url: URL,
			options: { agent: Agent; headers: Record<string, string> },
			deliver: (message: Message) => void,
		) => {
			state.constructed++;
			// Model Node's constructor-triggered output, not just end(body).
			if (Object.hasOwn(options.headers, "expect")) state.sent.push("constructor headers");
			options.agent.createConnection();
			return new Request(deliver);
		},
	};
});
vi.mock("node:dns/promises", () => ({ lookup: fake.lookup }));
vi.mock("node:net", () => ({ Socket: fake.Socket, isIP: () => 0 }));
vi.mock("node:tls", () => ({ connect: fake.connect }));
vi.mock("node:https", () => ({ Agent: fake.Agent, request: fake.request }));

function fixture() {
	fake.state.hold = false;
	fake.state.constructed = 0;
	fake.state.sockets = [];
	fake.state.sent = [];
	fake.state.body = "synthetic-body";
	fake.state.contentType = "text/event-stream";
	fake.state.status = 200;
	const custody = { connect: vi.fn(), take: vi.fn(() => 77), retire: vi.fn() };
	const record = vi.fn();
	const controller = new AbortController();
	const prepared = new Request("https://provider.invalid/v1/responses", {
		method: "POST",
		body: '{"model":"synthetic"}',
		signal: controller.signal,
	});
	return { custody, record, controller, prepared };
}

async function* terminal() {
	yield {
		type: "response.completed",
		response: {
			id: "response-A",
			model: "synthetic",
			status: "completed",
			usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
		},
	};
}

function countFixture() {
	const f = fixture();
	const bytes = Buffer.from(
		JSON.stringify({
			model: "synthetic",
			stream: true,
			store: false,
			max_output_tokens: 100,
			input: "synthetic input",
		}),
	);
	const projection = projectResponsesTokenCount(bytes, {
		wireModel: "synthetic",
		contextTokens: 1000,
		outputTokens: 100,
	});
	const scope = {
		allocationId: "allocation-A",
		decisionDigest: "a".repeat(64),
		ownerEpoch: "epoch-A",
		sessionId: "session-A",
		provider: "synthetic",
		model: "synthetic",
		contextTokens: 1000,
		outputTokens: 100,
		attempts: 2,
		notBeforeMs: 1000,
		expiresMs: 2000,
	};
	const budget = new OrdinaryTokenBudget(scope);
	const reservation = budget.reserve("request-A", projection.payloadHash, 1000);
	const plan = budget.prepareCount(reservation, projection, 1000);
	const prepared = new Request("https://provider.invalid/v1/responses/input_tokens", {
		method: "POST",
		body: projection.countBody,
		signal: f.controller.signal,
	});
	const count = {
		binding: plan,
		requestId: plan.requestId,
		payloadHash: projection.payloadHash,
		countBodyHash: projection.countBodyHash,
	};
	fake.state.body = '{"object":"response.input_tokens","input_tokens":900}';
	fake.state.contentType = "application/json";
	return { ...f, prepared, bytes, scope, budget, reservation, plan, count };
}

describe("original native provider exchange", () => {
	test("count response becomes a once-use qualification only after actual exchange and retirement", async () => {
		const f = countFixture();
		fake.state.hold = true;
		const exchange = createOwnedProviderExchange(
			f.custody,
			f.prepared,
			"synthetic",
			1024,
			(request) => request,
			f.record,
			f.count,
		);
		let ready = false;
		void exchange.countResult!.then(() => {
			ready = true;
		});
		await exchange.response;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ready).toBe(false);
		expect(f.custody.retire).not.toHaveBeenCalled();
		for (const socket of fake.state.sockets) socket.emit("close");
		await exchange.settled;
		const result = await exchange.countResult!;
		expect(f.custody.retire).toHaveBeenCalledWith(f.plan.requestId, "counted");
		expect(f.record).not.toHaveBeenCalled(); // Never inference terminal evidence.
		expect(() => assertOwnedCountResult({ ...result }, f.plan)).toThrow("SCOPE");
		expect(() => assertOwnedCountResult(result, { ...f.plan })).toThrow("SCOPE");
		const receipt = f.budget.qualifyCount(f.plan, result, 1001);
		expect(() => f.budget.consumeQualification({ ...receipt }, f.reservation, f.bytes, 1001)).toThrow("REPLAY");
		const other = new OrdinaryTokenBudget({ ...f.scope, ownerEpoch: "epoch-B" });
		expect(() => other.consumeQualification(receipt, f.reservation, f.bytes, 1001)).toThrow("REPLAY");
		expect(() => f.budget.consumeQualification(receipt, f.reservation, f.bytes, 1001)).not.toThrow();
		expect(() => f.budget.consumeQualification(receipt, f.reservation, f.bytes, 1001)).toThrow("REPLAY");
		expect(() => f.budget.qualifyCount(f.plan, result, 1001)).toThrow("REPLAY");
	});

	test("retains original count metadata and pre-await headers across caller mutation", async () => {
		const f = countFixture();
		const exchange = createOwnedProviderExchange(
			f.custody,
			f.prepared,
			"synthetic",
			1024,
			(request) => request,
			f.record,
			f.count,
		);
		// The exchange is now awaiting body bytes. Neither mutation may alter it.
		f.prepared.headers.set("Expect", "100-continue");
		f.count.binding = { ...f.plan };
		f.count.requestId = "replacement";
		f.count.countBodyHash = "f".repeat(64);
		await exchange.response;
		await exchange.settled;
		const result = (await exchange.countResult)!;
		expect(() => assertOwnedCountResult(result, f.plan)).not.toThrow();
		expect(() => assertOwnedCountResult(result, f.count.binding)).toThrow("SCOPE");
		expect(f.custody.retire).toHaveBeenCalledWith(f.plan.requestId, "counted");
		expect(fake.state.sent).toEqual([f.plan.projection.countBody]);
	});

	test("late count abort joins socket close but cannot issue a usable result", async () => {
		const f = countFixture();
		fake.state.hold = true;
		const exchange = createOwnedProviderExchange(
			f.custody,
			f.prepared,
			"synthetic",
			1024,
			(request) => request,
			f.record,
			f.count,
		);
		const rejected = expect(exchange.settled).rejects.toThrow("late count abort");
		await exchange.response;
		await new Promise<void>((resolve) => setImmediate(resolve));
		f.controller.abort(new Error("late count abort"));
		expect(f.custody.retire).not.toHaveBeenCalled();
		for (const socket of fake.state.sockets) socket.emit("close");
		await rejected;
		await expect(exchange.countResult).rejects.toThrow("late count abort");
		expect(f.custody.retire).toHaveBeenCalledWith(f.plan.requestId, "counted");
		expect(f.record).not.toHaveBeenCalled();
	});

	test("usage above counted input fences later work even below the total reservation", async () => {
		const f = countFixture();
		const exchange = createOwnedProviderExchange(
			f.custody,
			f.prepared,
			"synthetic",
			1024,
			(request) => request,
			f.record,
			f.count,
		);
		await exchange.response;
		await exchange.settled;
		const receipt = f.budget.qualifyCount(f.plan, (await exchange.countResult)!, 1001);
		f.budget.consumeQualification(receipt, f.reservation, f.bytes, 1001);
		const settlement = f.budget.reconcile(f.reservation, {
			responseId: "response-A",
			terminal: "completed",
			streamEnded: true,
			conflict: false,
			usage: { inputTokens: 901, outputTokens: 1, totalTokens: 902, cachedInputTokens: null, reasoningTokens: null },
		});
		expect(settlement.disposition).toBe("over-budget");
		expect(() => f.budget.reserve("request-B", f.plan.projection.payloadHash, 1002)).toThrow("STALE");
	});

	test.each(["payload", "model", "output", "expiry"])(
		"invalidates counted qualification after %s changes",
		async (change) => {
			const f = countFixture();
			const exchange = createOwnedProviderExchange(
				f.custody,
				f.prepared,
				"synthetic",
				1024,
				(request) => request,
				f.record,
				f.count,
			);
			await exchange.response;
			await exchange.settled;
			const receipt = f.budget.qualifyCount(f.plan, (await exchange.countResult)!, 1001);
			const value = JSON.parse(f.bytes.toString()) as Record<string, unknown>;
			if (change === "payload") value.input = "changed";
			if (change === "model") value.model = "other";
			if (change === "output") value.max_output_tokens = 99;
			expect(() =>
				f.budget.consumeQualification(
					receipt,
					f.reservation,
					Buffer.from(JSON.stringify(value)),
					change === "expiry" ? 2000 : 1001,
				),
			).toThrow();
		},
	);

	test("a completed count outside context can retire its own socket but cannot qualify inference", async () => {
		const f = countFixture();
		fake.state.body = '{"object":"response.input_tokens","input_tokens":901}';
		const exchange = createOwnedProviderExchange(
			f.custody,
			f.prepared,
			"synthetic",
			1024,
			(request) => request,
			f.record,
			f.count,
		);
		await exchange.response;
		await exchange.settled;
		const result = (await exchange.countResult)!;
		expect(() => f.budget.qualifyCount(f.plan, result, 1001)).toThrow("CONTEXT_EXCEEDED");
		expect(f.custody.retire).toHaveBeenCalledWith(f.plan.requestId, "counted");
	});

	test.each([
		"malformed",
		"http-error",
		"content-type",
		"negative",
		"truncated",
		"overflow",
		"lost-retirement",
		"changed-body",
	])("does not issue count evidence on %s", async (failure) => {
		const f = countFixture();
		if (failure === "malformed")
			fake.state.body = '{"object":"response.input_tokens","input_tokens":1,"input_tokens":900}';
		if (failure === "http-error") fake.state.status = 500;
		if (failure === "content-type") fake.state.contentType = "text/plain";
		if (failure === "negative") fake.state.body = '{"object":"response.input_tokens","input_tokens":-1}';
		if (failure === "truncated") fake.state.body = '{"object":"response.input_tokens","input_tokens":1';
		if (failure === "overflow")
			fake.state.body = '{"object":"response.input_tokens","input_tokens":9007199254740992}';
		if (failure === "lost-retirement")
			f.custody.retire.mockImplementation(() => {
				throw new Error("lost native reply");
			});
		const count = failure === "changed-body" ? { ...f.count, countBodyHash: "f".repeat(64) } : f.count;
		const exchange = createOwnedProviderExchange(
			f.custody,
			f.prepared,
			"synthetic",
			1024,
			(request) => request,
			f.record,
			count,
		);
		const results = await Promise.allSettled([exchange.response, exchange.settled, exchange.countResult!]);
		expect(results[1].status).toBe("rejected");
		expect(results[2].status).toBe("rejected");
		if (failure === "changed-body") expect(f.custody.connect).not.toHaveBeenCalled();
	});

	test.each(["Expect", "eXpEcT"])("rejects %s before constructor-triggered HTTP output (F1/P1)", async (name) => {
		const f = fixture();
		f.prepared.headers.set(name, "100-continue");
		const beforeSend = vi.fn((request: Request) => request);
		const exchange = createOwnedProviderExchange(f.custody, f.prepared, "synthetic", 1024, beforeSend, f.record);
		const results = await Promise.allSettled([exchange.response, exchange.settled]);
		for (const result of results) {
			expect(result.status).toBe("rejected");
			if (result.status === "rejected") expect(result.reason.message).toBe("OWNER_PROVIDER_EXPECT_HEADER");
		}
		expect(fake.state.constructed).toBe(0);
		expect(fake.state.sent).toEqual([]);
		expect(beforeSend).not.toHaveBeenCalled();
		expect(f.custody.connect).not.toHaveBeenCalled();
		expect(f.custody.retire).not.toHaveBeenCalled();
	});

	test("joins actual parser observation AND socket close before native retirement", async () => {
		const f = fixture();
		fake.state.hold = true;
		const exchange = createOwnedProviderExchange(
			f.custody,
			f.prepared,
			"synthetic",
			1024,
			(request) => request,
			f.record,
		);
		const response = await exchange.response;
		await response.arrayBuffer();
		expect(f.custody.retire).not.toHaveBeenCalled();
		for await (const _event of withResponsesEvidence(response, terminal())) {
			/* Existing parser observer path. */
		}
		await Promise.resolve();
		expect(f.record).toHaveBeenCalledTimes(1);
		expect(f.custody.retire).not.toHaveBeenCalled();
		for (const socket of fake.state.sockets) socket.emit("close");
		await exchange.settled;
		expect(f.custody.retire).toHaveBeenCalledTimes(1);
		expect(f.custody.retire).toHaveBeenCalledWith("response-A", "completed");
		expect(fake.state.sent).toEqual(['{"model":"synthetic"}']);
	});

	test("EOF without a provider terminal keeps remote work unknown", async () => {
		const f = fixture();
		const exchange = createOwnedProviderExchange(
			f.custody,
			f.prepared,
			"synthetic",
			1024,
			(request) => request,
			f.record,
		);
		const rejected = expect(exchange.settled).rejects.toThrow("OWNER_PROVIDER_REMOTE_UNKNOWN");
		const response = await exchange.response;
		await response.arrayBuffer();
		async function* empty() {
			yield { type: "response.created", response: { id: "response-A", model: "synthetic" } };
		}
		for await (const _event of withResponsesEvidence(response, empty())) {
			/* No terminal event. */
		}
		await rejected;
		expect(f.custody.retire).not.toHaveBeenCalled();
	});

	test("abort without terminal evidence does not retire remote work", async () => {
		const f = fixture();
		const exchange = createOwnedProviderExchange(
			f.custody,
			f.prepared,
			"synthetic",
			1024,
			(request) => request,
			f.record,
		);
		const rejected = expect(exchange.settled).rejects.toThrow("synthetic abort");
		const response = await exchange.response;
		await response.arrayBuffer();
		f.controller.abort(new Error("synthetic abort"));
		await rejected;
		expect(f.custody.retire).not.toHaveBeenCalled();
	});

	test("a late abort preserves genuine terminal retirement but still returns the error", async () => {
		const f = fixture();
		const exchange = createOwnedProviderExchange(
			f.custody,
			f.prepared,
			"synthetic",
			1024,
			(request) => request,
			() => f.controller.abort(new Error("synthetic late abort")),
		);
		const rejected = expect(exchange.settled).rejects.toThrow("synthetic late abort");
		const response = await exchange.response;
		await response.arrayBuffer();
		for await (const _event of withResponsesEvidence(response, terminal())) {
			/* Genuine observed terminal in this synthetic transport. */
		}
		await rejected;
		expect(f.custody.retire).toHaveBeenCalledWith("response-A", "completed");
	});

	test("failed final authority check sends no HTTP body and cannot retire remote work", async () => {
		const f = fixture();
		const exchange = createOwnedProviderExchange(
			f.custody,
			f.prepared,
			"synthetic",
			1024,
			() => {
				throw new Error("STALE_OWNER");
			},
			f.record,
		);
		const failures = await Promise.allSettled([exchange.response, exchange.settled]);
		expect(failures.every((result) => result.status === "rejected")).toBe(true);
		expect(fake.state.sent).toEqual([]);
		expect(f.custody.retire).not.toHaveBeenCalled();
	});
});
