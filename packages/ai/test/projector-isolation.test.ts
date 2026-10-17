import { describe, expect, it } from "vitest";
import type { AssistantMessage, AssistantMessageEvent } from "../src/types.ts";
import { projectAssistantMessage } from "../src/utils/assistant-message-snapshot.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

// smarty-dev#5443 S2 / smarty-dev#5822 C2 / pi#159: one isolation pass per published message.
class HttpError extends Error {
	status = 429;
	code = "E_RATE";
}

function baseMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "pi-messages",
		provider: "radius",
		model: "auto",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

interface RichArguments {
	map: Map<unknown, unknown>;
	set: Set<unknown>;
	direct: { n: number };
	error: HttpError;
	data: Record<string, unknown>;
	buffer: ArrayBuffer;
	tracking: Uint8Array;
}

function richArguments() {
	const shared = { n: 1 };
	const map = new Map<unknown, unknown>([[shared, shared]]);
	const set = new Set<unknown>([shared]);
	const buffer = new ArrayBuffer(4, { maxByteLength: 16 });
	const args: RichArguments = {
		map,
		set,
		direct: shared,
		error: new HttpError("rate limited", { cause: shared }),
		data: JSON.parse('{"__proto__":{"polluted":true}}'),
		buffer,
		tracking: new Uint8Array(buffer),
	};
	map.set("root", args);
	set.add(set);
	return { args, shared, buffer };
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("publication projector isolation", () => {
	it("keeps Map/Set aliases and cycles, Error fields, __proto__ data and resizable views in tool arguments", async () => {
		const { args, shared, buffer } = richArguments();
		const live = baseMessage();
		live.content.push({ type: "toolCall", id: "call_1", name: "read", arguments: args as never });
		const stream = new AssistantMessageEventStream();
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: live.content[0] as never, partial: live });
		live.stopReason = "toolUse";
		stream.push({ type: "done", reason: "toolUse", message: live });
		const events = await collect(stream);
		const end = events[0];
		const done = events[1];
		if (end?.type !== "toolcall_end" || done?.type !== "done") throw new Error("missing events");
		expect(end.toolCall).toBe(end.partial.content[0]);
		for (const block of [end.toolCall, done.message.content[0]]) {
			if (block?.type !== "toolCall") throw new Error("missing tool call");
			const copy = block.arguments as unknown as RichArguments;
			expect(copy).not.toBe(args);
			expect(copy.direct).not.toBe(shared);
			expect(copy.map).toBeInstanceOf(Map);
			expect(copy.map.get(copy.direct)).toBe(copy.direct);
			expect(copy.map.get("root")).toBe(copy);
			expect(copy.set.has(copy.direct)).toBe(true);
			expect(copy.set.has(copy.set)).toBe(true);
			expect(copy.error).toBeInstanceOf(HttpError);
			expect(copy.error).not.toBe(args.error);
			expect([copy.error.status, copy.error.code, copy.error.message]).toEqual([429, "E_RATE", "rate limited"]);
			expect(copy.error.cause).toBe(copy.direct);
			expect(Object.getPrototypeOf(copy.data)).toBe(Object.prototype);
			expect(Object.hasOwn(copy.data, "__proto__")).toBe(true);
			expect(copy.data.polluted).toBeUndefined();
			expect(copy.buffer).not.toBe(buffer);
			expect(copy.buffer.resizable).toBe(true);
			expect(copy.tracking.buffer).toBe(copy.buffer);
			copy.buffer.resize(8);
			expect(copy.tracking.length).toBe(8);
			copy.direct.n = 2;
		}
		expect(buffer.byteLength).toBe(4);
		expect(shared.n).toBe(1);
		expect(end.toolCall).not.toBe(done.message.content[0]);
	});

	it("shares one memo across fields of one message, never between messages", () => {
		const shared = { n: 1 };
		const live = baseMessage();
		live.content.push(
			{ type: "toolCall", id: "a", name: "x", arguments: { ref: shared } },
			{ type: "text", text: "t" },
			{ type: "toolCall", id: "b", name: "y", arguments: { ref: shared } },
		);
		const first = projectAssistantMessage(live, "partial");
		const second = projectAssistantMessage(live, "partial");
		const [a, , b] = first.content;
		if (a?.type !== "toolCall" || b?.type !== "toolCall") throw new Error("missing tool calls");
		expect(a.arguments.ref).toBe(b.arguments.ref);
		expect(a.arguments.ref).not.toBe(shared);
		const other = second.content[0];
		if (other?.type !== "toolCall") throw new Error("missing tool call");
		expect(other.arguments.ref).not.toBe(a.arguments.ref);
		expect(first.content[1]).toEqual({ type: "text", text: "t" });
	});

	it("drops scratch fields, diagnostic payloads and failure-time wire metadata", () => {
		const live = baseMessage();
		live.content.push({ type: "toolCall", id: "a", name: "x", arguments: { k: 1 }, partialJson: "{" } as never);
		live.responseId = "resp_1";
		live.responseModel = "m";
		live.diagnostics = [
			{ type: "provider_transport_failure", timestamp: 5, details: { error: new Error("secret") } } as never,
		];
		live.stopReason = "error";
		const failed = projectAssistantMessage(live, "failure");
		expect(failed.content[0]).toStrictEqual({ type: "toolCall", id: "a", name: "x", arguments: { k: 1 } });
		expect(failed.responseId).toBeUndefined();
		expect(failed.responseModel).toBeUndefined();
		expect(failed.diagnostics).toHaveLength(1);
		expect(Object.keys(failed.diagnostics?.[0] ?? {}).sort()).toEqual(["timestamp", "type"]);
		expect(failed.diagnostics?.[0]?.timestamp).not.toBe(5);
		live.stopReason = "stop";
		const succeeded = projectAssistantMessage(live, "success");
		expect(succeeded.responseId).toBe("resp_1");
		expect(succeeded.responseModel).toBe("m");
	});

	it("isolates usage and deferred handles from the producer", () => {
		const live = baseMessage();
		live.deferred = { provider: "radius", modelId: "auto", api: "pi-messages", id: "batch_1" };
		const projected = projectAssistantMessage(live, "partial");
		expect(projected.usage).toEqual(live.usage);
		expect(projected.usage).not.toBe(live.usage);
		expect(projected.usage.cost).not.toBe(live.usage.cost);
		expect(projected.deferred).toEqual(live.deferred);
		expect(projected.deferred).not.toBe(live.deferred);
		projected.usage.cost.total = 9;
		if (projected.deferred) projected.deferred.id = "consumer";
		expect(live.usage.cost.total).toBe(0);
		expect(live.deferred.id).toBe("batch_1");
	});

	it("rejects functions in tool arguments like structuredClone did", () => {
		const live = baseMessage();
		live.content.push({ type: "toolCall", id: "a", name: "x", arguments: { fn: () => 1 } as never });
		expect(() => projectAssistantMessage(live, "partial")).toThrow();
	});
});
