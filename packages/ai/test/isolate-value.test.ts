import { runInNewContext } from "node:vm";
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

// smarty-dev#5377: clone native Errors faithfully, including subclass, own fields and cause.
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

	// pi#159: tool_result and terminal publication can isolate an already isolated Error.
	it("keeps an Error subclass and own fields across repeated isolation", () => {
		const first = isolateValue(new HttpError("rate limited", { cause: new TypeError("inner") }));
		const second = isolateValue(first);
		expect(second).not.toBe(first);
		expect(second).toBeInstanceOf(HttpError);
		expect(second.message).toBe("rate limited");
		expect(second.status).toBe(429);
		expect(second.cause).toBeInstanceOf(TypeError);
		expect(second.cause).not.toBe(first.cause);
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
		expect(() => isolateValue(new Map([["fn", () => 1]]))).toThrow();
		expect(() => isolateValue(new Set([() => 1]))).toThrow();
	});

	// pi#159: Map/Set/views share the graph memo; aliases and cycles must not split.
	it("keeps aliases of a shared object used as Map key, Map value and direct field", () => {
		const shared = { n: 1 };
		const map = new Map<unknown, unknown>([
			[shared, shared],
			["value", shared],
		]);
		const copy = isolateValue({ map, direct: shared });
		expect(copy.map).toBeInstanceOf(Map);
		expect(copy.map).not.toBe(map);
		expect(copy.direct).not.toBe(shared);
		const [[key, value]] = [...copy.map];
		expect(key).toBe(copy.direct);
		expect(value).toBe(copy.direct);
		expect(copy.map.get("value")).toBe(copy.direct);
		expect(copy.map.get(copy.direct)).toBe(copy.direct);
		copy.direct.n = 2;
		expect(shared.n).toBe(1);
	});

	it("keeps aliases of a shared Set member", () => {
		const shared = { n: 1 };
		const set = new Set([shared, "x"]);
		const copy = isolateValue({ set, direct: shared });
		expect(copy.set).toBeInstanceOf(Set);
		expect(copy.set).not.toBe(set);
		expect(copy.direct).not.toBe(shared);
		expect(copy.set.has(copy.direct)).toBe(true);
		expect(copy.set.has("x")).toBe(true);
		expect([...copy.set][0]).toBe(copy.direct);
	});

	it("keeps cycles through Map and Set and the same container reached twice", () => {
		const root: { map: Map<unknown, unknown>; set: Set<unknown>; again?: Map<unknown, unknown> } = {
			map: new Map(),
			set: new Set(),
		};
		root.map.set("root", root);
		root.map.set(root.map, "self");
		root.set.add(root);
		root.set.add(root.set);
		root.again = root.map;
		const copy = isolateValue(root);
		expect(copy).not.toBe(root);
		expect(copy.map.get("root")).toBe(copy);
		expect(copy.map.get(copy.map)).toBe("self");
		expect(copy.set.has(copy)).toBe(true);
		expect(copy.set.has(copy.set)).toBe(true);
		expect(copy.again).toBe(copy.map);
	});

	it("clones a native Error with own fields inside a Map or Set", () => {
		const error = new HttpError("rate limited");
		const copy = isolateValue({ map: new Map([["e", error]]), set: new Set([error]), direct: error });
		const fromMap = copy.map.get("e") as HttpError;
		expect(fromMap).toBeInstanceOf(HttpError);
		expect(fromMap).not.toBe(error);
		expect(fromMap.status).toBe(429);
		expect(fromMap.code).toBe("E_RATE");
		expect(fromMap).toBe(copy.direct);
		expect(copy.set.has(copy.direct)).toBe(true);
	});

	it("keeps own __proto__ keys as data inside Map and Set members", () => {
		const member = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
		const copy = isolateValue({ map: new Map([["m", member]]), set: new Set([member]) });
		const fromMap = copy.map.get("m") as Record<string, unknown>;
		expect(Object.getPrototypeOf(fromMap)).toBe(Object.prototype);
		expect(Object.hasOwn(fromMap, "__proto__")).toBe(true);
		expect((fromMap as { polluted?: unknown }).polluted).toBeUndefined();
		expect(copy.set.has(fromMap)).toBe(true);
	});

	it("keeps typed array, DataView and backing ArrayBuffer aliasing", () => {
		const buffer = new ArrayBuffer(16);
		const bytes = new Uint8Array(buffer, 4, 8);
		const view = new DataView(buffer, 2, 4);
		const floats = new Float64Array(buffer, 8, 1);
		const other = new Uint8Array(buffer);
		bytes[0] = 9;
		const copy = isolateValue({ buffer, bytes, view, floats, other, again: bytes, map: new Map([["b", bytes]]) });
		expect(copy.buffer).toBeInstanceOf(ArrayBuffer);
		expect(copy.buffer).not.toBe(buffer);
		expect(copy.bytes).toBeInstanceOf(Uint8Array);
		expect(copy.view).toBeInstanceOf(DataView);
		expect(copy.floats).toBeInstanceOf(Float64Array);
		for (const item of [copy.bytes, copy.view, copy.floats, copy.other]) expect(item.buffer).toBe(copy.buffer);
		expect([copy.bytes.byteOffset, copy.bytes.length]).toEqual([4, 8]);
		expect([copy.view.byteOffset, copy.view.byteLength]).toEqual([2, 4]);
		expect([copy.floats.byteOffset, copy.floats.length]).toEqual([8, 1]);
		expect(copy.other.length).toBe(16);
		expect(copy.again).toBe(copy.bytes);
		expect(copy.map.get("b")).toBe(copy.bytes);
		expect(copy.bytes[0]).toBe(9);
		copy.bytes[1] = 7;
		expect(copy.other[5]).toBe(7);
		expect(copy.view.getUint8(3)).toBe(7);
		expect(other[5]).toBe(0);
	});

	it("keeps fixed-length and length-tracking views over a resizable buffer, in either field order", () => {
		const make = () => {
			const buffer = new ArrayBuffer(8, { maxByteLength: 16 });
			return {
				buffer,
				tracking: new Uint8Array(buffer),
				fixed: new Uint8Array(buffer, 2, 4),
				trackingView: new DataView(buffer),
				fixedView: new DataView(buffer, 1, 3),
			};
		};
		const first = make();
		const second = make();
		const bufferFirst = isolateValue(first);
		const viewsFirst = isolateValue({
			tracking: second.tracking,
			fixedView: second.fixedView,
			fixed: second.fixed,
			trackingView: second.trackingView,
			buffer: second.buffer,
		});
		for (const copy of [bufferFirst, viewsFirst]) {
			expect(copy.buffer).not.toBe(first.buffer);
			expect(copy.buffer.resizable).toBe(true);
			for (const view of [copy.tracking, copy.fixed, copy.trackingView, copy.fixedView])
				expect(view.buffer).toBe(copy.buffer);
			copy.buffer.resize(12);
			expect(copy.tracking.length).toBe(12);
			expect(copy.trackingView.byteLength).toBe(12);
			expect([copy.fixed.byteOffset, copy.fixed.length]).toEqual([2, 4]);
			expect([copy.fixedView.byteOffset, copy.fixedView.byteLength]).toEqual([1, 3]);
		}
		expect(first.buffer.byteLength).toBe(8);
	});

	it("keeps aliases through another realm's Map, Set and object and through class instances", () => {
		class Holder {
			ref: unknown;
			back?: unknown;
			constructor(ref: unknown) {
				this.ref = ref;
			}
		}
		const shared = { n: 1 };
		const foreign = runInNewContext("({ map: new Map(), set: new Set(), object: {} })") as {
			map: Map<unknown, unknown>;
			set: Set<unknown>;
			object: Record<string, unknown>;
		};
		foreign.map.set("s", shared);
		foreign.set.add(shared);
		foreign.object.s = shared;
		const holder = new Holder(shared);
		const root = { map: foreign.map, set: foreign.set, object: foreign.object, holder, direct: shared };
		holder.back = root;
		const copy = isolateValue(root);
		expect(copy.direct).not.toBe(shared);
		expect(copy.map).toBeInstanceOf(Map);
		expect(copy.map.get("s")).toBe(copy.direct);
		expect(copy.set).toBeInstanceOf(Set);
		expect(copy.set.has(copy.direct)).toBe(true);
		expect(copy.object.s).toBe(copy.direct);
		expect(copy.holder).not.toBe(holder);
		expect(copy.holder.ref).toBe(copy.direct);
		expect(copy.holder.back).toBe(copy);
		expect(Object.getPrototypeOf(copy.holder)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(copy.holder)).toBe(Object.getPrototypeOf(structuredClone(new Holder(1))));
	});

	it("ignores own properties of Date and RegExp like structuredClone, including detached buffers", () => {
		const detached = new ArrayBuffer(4);
		structuredClone(detached, { transfer: [detached] });
		const date = new Date(7);
		Object.defineProperty(date, "hidden", { value: detached });
		const regex = Object.assign(/x/g, { visible: detached });
		const source = { date, regex };
		expect(() => structuredClone(source)).not.toThrow();
		const copy = isolateValue(source);
		expect(copy.date.getTime()).toBe(7);
		expect(copy.regex.source).toBe("x");
		expect(Object.getOwnPropertyNames(copy.date)).toEqual([]);
	});

	it("reads an enumerable getter once and keeps its view aliased to a buffer field", () => {
		const buffer = new ArrayBuffer(4, { maxByteLength: 16 });
		let calls = 0;
		const source = {
			buffer,
			get view() {
				calls++;
				return new Uint8Array(buffer);
			},
		};
		const native = structuredClone(source);
		expect(native.view.buffer).toBe(native.buffer);
		calls = 0;
		const copy = isolateValue(source);
		expect(calls).toBe(1);
		expect(copy.buffer).not.toBe(buffer);
		expect(copy.view.buffer).toBe(copy.buffer);
		copy.buffer.resize(8);
		expect(copy.view.length).toBe(8);
		expect(buffer.byteLength).toBe(4);
	});

	it("clones another realm's Error with its prototype, own fields and aliases", () => {
		const shared = { n: 1 };
		const error = runInNewContext("new TypeError('boom')") as TypeError & { code?: string; cause?: unknown };
		error.code = "E_X";
		error.cause = shared;
		const copy = isolateValue({ error, again: error, direct: shared });
		expect(copy.error).not.toBe(error);
		expect(copy.again).toBe(copy.error);
		expect(Object.getPrototypeOf(copy.error)).toBe(Object.getPrototypeOf(error));
		expect(copy.error.message).toBe("boom");
		expect(copy.error.stack).toBe(error.stack);
		expect(copy.error.code).toBe("E_X");
		expect(copy.error.cause).toBe(copy.direct);
		expect(copy.direct).not.toBe(shared);
	});

	// pi#159: custom Symbol.toStringTag values must not change native-container handling.
	it("keeps aliases and cycles through Map and Set subclasses with a custom toStringTag", () => {
		class TaggedMap extends Map<unknown, unknown> {
			get [Symbol.toStringTag]() {
				return "Tagged";
			}
		}
		class ObjectTaggedMap extends Map<unknown, unknown> {
			get [Symbol.toStringTag]() {
				return "Object";
			}
		}
		class TaggedSet extends Set<unknown> {
			get [Symbol.toStringTag]() {
				return "Tagged";
			}
		}
		const shared = { n: 1 };
		const map = new TaggedMap([["s", shared]]);
		const objectMap = new ObjectTaggedMap([["s", shared]]);
		const set = new TaggedSet([shared]);
		const root = { map, objectMap, set, direct: shared };
		map.set("self", map);
		map.set("root", root);
		set.add(set);
		const copy = isolateValue(root);
		for (const item of [copy.map, copy.objectMap, copy.set]) {
			expect(Object.getPrototypeOf(item)).toBe(Object.getPrototypeOf(structuredClone(item)));
		}
		expect(copy.map).toBeInstanceOf(Map);
		expect(copy.objectMap).toBeInstanceOf(Map);
		expect(copy.set).toBeInstanceOf(Set);
		expect(copy.direct).not.toBe(shared);
		expect(copy.map.get("s")).toBe(copy.direct);
		expect(copy.map.get("self")).toBe(copy.map);
		expect(copy.map.get("root")).toBe(copy);
		expect(copy.objectMap.get("s")).toBe(copy.direct);
		expect(copy.set.has(copy.direct)).toBe(true);
		expect(copy.set.has(copy.set)).toBe(true);
	});

	it("keeps a view aliased to an ArrayBuffer subclass with a custom toStringTag", () => {
		class TaggedBuffer extends ArrayBuffer {
			constructor(length: number) {
				super(length);
				Object.defineProperty(this, Symbol.toStringTag, { value: "Tagged" });
			}
		}
		const buffer = new TaggedBuffer(4);
		const view = new Uint8Array(buffer);
		const copy = isolateValue({ buffer, view });
		expect(copy.buffer).toBeInstanceOf(ArrayBuffer);
		expect(copy.buffer).not.toBe(buffer);
		expect(copy.view.buffer).toBe(copy.buffer);
	});

	it("clones a class with an Error toStringTag as a plain object, like structuredClone", () => {
		class FakeError {
			message = "m";
			constructor() {
				Object.defineProperty(this, "hidden", { value: 1, enumerable: false });
			}
			get [Symbol.toStringTag]() {
				return "Error";
			}
		}
		const copy = isolateValue(new FakeError()) as unknown as Record<string, unknown>;
		expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
		expect(copy).toEqual(structuredClone(new FakeError()));
		expect(Object.hasOwn(copy, "hidden")).toBe(false);
	});

	it("keeps another realm's Error class across repeated isolation and with a custom toStringTag", () => {
		const error = runInNewContext("Object.assign(new TypeError('boom'), { code: 'E_X' })") as TypeError & {
			code: string;
		};
		const second = isolateValue(isolateValue(error));
		expect(Object.getPrototypeOf(second)).toBe(Object.getPrototypeOf(error));
		expect([second.message, second.code, second.stack]).toEqual(["boom", "E_X", error.stack]);
		const shared = { n: 1 };
		const tagged = runInNewContext(
			"class Tagged extends Error { get [Symbol.toStringTag]() { return 'Tagged'; } }; new Tagged('t')",
		) as Error;
		tagged.cause = shared;
		const copy = isolateValue({ tagged, direct: shared });
		expect(Object.getPrototypeOf(copy.tagged)).toBe(Object.getPrototypeOf(tagged));
		expect(copy.tagged.message).toBe("t");
		expect(copy.tagged.cause).toBe(copy.direct);
		expect(copy.direct).not.toBe(shared);
	});

	it("matches structuredClone for view subclasses, Date and RegExp", () => {
		const node = Buffer.from("ab");
		const copy = isolateValue(node);
		expect(Object.getPrototypeOf(copy)).toBe(Object.getPrototypeOf(structuredClone(node)));
		expect([...copy]).toEqual([97, 98]);
		expect(copy.byteOffset).toBe(node.byteOffset);
		const date = Object.assign(new Date(5), { extra: { n: 1 } });
		const regex = /a+/gi;
		const cloned = isolateValue({ date, regex, date2: date, regex2: regex });
		expect(cloned.date).toBeInstanceOf(Date);
		expect(cloned.date).not.toBe(date);
		expect(cloned.date.getTime()).toBe(5);
		expect(cloned.date2).toBe(cloned.date);
		expect(Object.keys(cloned.date)).toEqual(Object.keys(structuredClone(date)));
		expect(cloned.regex).toBeInstanceOf(RegExp);
		expect(cloned.regex).not.toBe(regex);
		expect([cloned.regex.source, cloned.regex.flags]).toEqual(["a+", "gi"]);
		expect(cloned.regex2).toBe(cloned.regex);
	});
});
