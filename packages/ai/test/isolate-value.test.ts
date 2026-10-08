import { describe, expect, it } from "vitest";
import { isolateValue } from "../src/utils/assistant-message-snapshot.ts";

class HttpError extends Error {
	status: number;
	code: string;
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "HttpError";
		this.status = 429;
		this.code = "E_RATE";
	}
}

// smarty-dev#5377: hook isolation must clone a native Error faithfully; structuredClone
// drops the subclass, the custom name and own fields such as `status` and `code`.
describe("isolateValue", () => {
	it("clones a native Error subclass with its prototype, fields and cause", () => {
		const error = new HttpError("rate limited", { cause: new TypeError("inner") });
		const copy = isolateValue({ error }).error;
		expect(copy).not.toBe(error);
		expect(copy).toBeInstanceOf(HttpError);
		expect(copy.name).toBe("HttpError");
		expect(copy.message).toBe("rate limited");
		expect(copy.stack).toBe(error.stack);
		expect(copy.status).toBe(429);
		expect(copy.code).toBe("E_RATE");
		expect(copy.cause).toBeInstanceOf(TypeError);
		expect(copy.cause).not.toBe(error.cause);
		expect(Object.keys(copy)).toEqual(Object.keys(error));
		copy.status = 500;
		expect(error.status).toBe(429);
	});

	it("keeps AggregateError members and DOMException state", () => {
		const aggregate = isolateValue(new AggregateError([new RangeError("x")], "agg"));
		expect(aggregate).toBeInstanceOf(AggregateError);
		expect(aggregate.errors[0]).toBeInstanceOf(RangeError);
		const abort = isolateValue(new DOMException("stopped", "AbortError"));
		expect(abort.name).toBe("AbortError");
		expect(abort.message).toBe("stopped");
	});

	it("deep-copies plain data, preserves shared references and cycles, and never sets a prototype", () => {
		const shared = { n: 1 };
		const source = JSON.parse('{"__proto__":{"polluted":true},"list":[1,{"a":2}]}') as Record<string, unknown>;
		source.left = shared;
		source.right = shared;
		source.self = source;
		const copy = isolateValue(source);
		expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
		expect((copy as { polluted?: unknown }).polluted).toBeUndefined();
		expect(Object.hasOwn(copy, "__proto__")).toBe(true);
		expect(copy.list).toEqual([1, { a: 2 }]);
		expect(copy.list).not.toBe(source.list);
		expect(copy.left).toBe(copy.right);
		expect(copy.left).not.toBe(shared);
		expect(copy.self).toBe(copy);
	});

	it("rejects values structuredClone rejects", () => {
		expect(() => isolateValue({ fn: () => 1 })).toThrow();
	});
});
