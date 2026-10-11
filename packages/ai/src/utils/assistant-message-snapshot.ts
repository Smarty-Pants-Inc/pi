import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "../types.ts";

/**
 * Isolation contract for published assistant-message state.
 *
 * Providers keep one live `AssistantMessage` and mutate it while they stream.
 * Every event and final result handed to a consumer is a detached snapshot of
 * that state at push time: a later provider write cannot change an event a
 * consumer already holds, and a consumer write cannot reach the provider, a
 * later event or the result. Content blocks are rebuilt from their declared
 * fields, so provider-internal or untrusted wire fields never reach consumers.
 */

type ContentBlock = AssistantMessage["content"][number];

function defineData(target: object, key: PropertyKey, value: unknown): void {
	// A data definition never runs the `__proto__` setter, unlike assignment.
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Brand check through a built-in getter that throws on other receivers. Unlike
 * `instanceof`, it also accepts a Map, Set or buffer from another realm.
 */
function hasBrand(prototype: object | undefined, key: string): (value: object) => boolean {
	const getter = prototype === undefined ? undefined : Object.getOwnPropertyDescriptor(prototype, key)?.get;
	return (value) => {
		if (getter === undefined) return false;
		try {
			getter.call(value);
			return true;
		} catch {
			return false;
		}
	};
}

const isMap = hasBrand(Map.prototype, "size");
const isSet = hasBrand(Set.prototype, "size");
const isArrayBuffer = hasBrand(ArrayBuffer.prototype, "byteLength");
const isSharedArrayBuffer = hasBrand(
	typeof SharedArrayBuffer === "function" ? SharedArrayBuffer.prototype : undefined,
	"byteLength",
);

/**
 * The fields `isolate` copies from one source object, read once. A getter runs
 * once, so a getter that returns a fresh view still aliases the buffer the batch
 * clone copied.
 */
type Node =
	| { kind: "array" | "map" | "set"; values: unknown[] }
	| { kind: "object"; keys: string[]; values: unknown[] }
	| { kind: "error"; prototype: object | null; fields: [PropertyKey, PropertyDescriptor][] };

function readObject(value: object): Node {
	// Like structuredClone: enumerable own string keys of an ordinary object.
	const keys = Object.keys(value);
	return { kind: "object", keys, values: keys.map((key) => (value as Record<string, unknown>)[key]) };
}

/**
 * Error copies `isolate` made. They lack native Error slots, and one from another
 * realm also fails `instanceof Error`, so this keeps them errors when isolated again.
 */
const errorCopies = new WeakSet<object>();

function isDOMException(value: unknown): boolean {
	return typeof DOMException === "function" && value instanceof DOMException;
}

function readError(value: object): Node {
	const fields: [PropertyKey, PropertyDescriptor][] = [];
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor) continue;
		if ("value" in descriptor) {
			fields.push([key, descriptor]);
			continue;
		}
		// V8 exposes `stack` as an own accessor. Copy what it reads as data.
		try {
			const read: unknown = descriptor.get?.call(value);
			fields.push([key, { value: read, enumerable: descriptor.enumerable, writable: true, configurable: true }]);
		} catch {}
	}
	return { kind: "error", prototype: Object.getPrototypeOf(value), fields };
}

function readMap(value: object): Node {
	const values: unknown[] = [];
	for (const [key, item] of Map.prototype.entries.call(value as Map<unknown, unknown>)) values.push(key, item);
	return { kind: "map", values };
}

function readSet(value: object): Node {
	return { kind: "set", values: [...Set.prototype.values.call(value as Set<unknown>)] };
}

/**
 * Classify `value` as structuredClone does and read the fields `isolate` copies.
 * Returns undefined for a buffer or view (added to `binary`) and for a leaf such
 * as Date, RegExp, a boxed primitive or a platform object (cloned into `seen`):
 * structuredClone ignores their own properties, so they are not traversed.
 */
function read(value: object, binary: object[], seen: Map<object, unknown>): Node | undefined {
	if (Array.isArray(value)) {
		const values: unknown[] = new Array(value.length);
		value.forEach((item, index) => {
			values[index] = item;
		});
		return { kind: "array", values };
	}
	if (ArrayBuffer.isView(value)) {
		binary.push(value);
		return undefined;
	}
	if (isPlainObject(value)) return readObject(value);
	// An Error of this realm or an earlier copy. DOMException keeps its state in
	// internal slots; structuredClone handles it. Checked before the tag, since a
	// copy has no Error slot and reads as "[object Object]".
	if ((value instanceof Error && !isDOMException(value)) || errorCopies.has(value)) return readError(value);
	// The tag selects candidates first; brand checks throw on every other object.
	const tag = Object.prototype.toString.call(value);
	// An ordinary object without a custom tag. A custom tag, even "Object", can hide
	// a Map, Set, buffer or Error, so it takes the native path below.
	if (tag === "[object Object]" && !(Symbol.toStringTag in value)) return readObject(value);
	if (tag === "[object Map]" && isMap(value)) return readMap(value);
	if (tag === "[object Set]" && isSet(value)) return readSet(value);
	if (
		(tag === "[object ArrayBuffer]" && isArrayBuffer(value)) ||
		(tag === "[object SharedArrayBuffer]" && isSharedArrayBuffer(value))
	) {
		binary.push(value);
		return undefined;
	}
	// Anything else, including an Error of another realm: let structuredClone
	// classify it. A container, buffer or Error is then read from the source, so
	// its members share the memo; an ordinary object becomes a plain object; any
	// other type is a leaf.
	const native: unknown = structuredClone(value);
	if (native instanceof Map) return readMap(value);
	if (native instanceof Set) return readSet(value);
	if (
		native instanceof ArrayBuffer ||
		(typeof SharedArrayBuffer === "function" && native instanceof SharedArrayBuffer)
	) {
		binary.push(value);
		return undefined;
	}
	if (native instanceof Error && !isDOMException(native)) return readError(value);
	if (isPlainObject(native)) return readObject(value);
	seen.set(value, native);
	return undefined;
}

function isolate(value: unknown, graph: Map<object, Node | undefined>, seen: Map<object, unknown>): unknown {
	if (typeof value === "function" || typeof value === "symbol") return structuredClone(value);
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return seen.get(value);
	// Every object reached here was read by `isolateValue`; leaves and buffers are in `seen`.
	const node = graph.get(value) as Node;
	switch (node.kind) {
		case "array": {
			const copy: unknown[] = new Array(node.values.length);
			seen.set(value, copy);
			node.values.forEach((item, index) => {
				copy[index] = isolate(item, graph, seen);
			});
			return copy;
		}
		case "error": {
			const copy = Object.create(node.prototype) as object;
			errorCopies.add(copy);
			seen.set(value, copy);
			for (const [key, descriptor] of node.fields) {
				Object.defineProperty(copy, key, { ...descriptor, value: isolate(descriptor.value, graph, seen) });
			}
			return copy;
		}
		// Containers that hold graph references share the memo; structuredClone would
		// restart it and split aliases and cycles that pass through them (pi#159).
		case "map": {
			const copy = new Map<unknown, unknown>();
			seen.set(value, copy);
			for (let index = 0; index < node.values.length; index += 2) {
				copy.set(isolate(node.values[index], graph, seen), isolate(node.values[index + 1], graph, seen));
			}
			return copy;
		}
		case "set": {
			const copy = new Set<unknown>();
			seen.set(value, copy);
			for (const item of node.values) copy.add(isolate(item, graph, seen));
			return copy;
		}
		case "object": {
			// An ordinary object of any class or realm becomes a plain object, as in structuredClone.
			const copy = {};
			seen.set(value, copy);
			node.keys.forEach((key, index) => {
				defineData(copy, key, isolate(node.values[index], graph, seen));
			});
			return copy;
		}
	}
}

/**
 * Deep, detached copy for isolation boundaries. Like `structuredClone`, it keeps
 * shared references and cycles and throws on functions. Unlike it, a native Error
 * keeps its prototype (class and `instanceof`), name, stack, cause and own fields
 * such as `code` or `status` (smarty-dev#5377), and an own `__proto__` key stays
 * data instead of replacing a prototype.
 */
export function isolateValue<T>(value: T): T {
	// Read the graph once, then clone every buffer and view in one native call:
	// views of one buffer stay aliased, resizable buffers and length-tracking views
	// keep their behavior, as in structuredClone.
	const graph = new Map<object, Node | undefined>();
	const binary: object[] = [];
	const seen = new Map<object, unknown>();
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const item = pending.pop();
		if (typeof item !== "object" || item === null || graph.has(item)) continue;
		const node = read(item, binary, seen);
		graph.set(item, node);
		if (node?.kind === "error") for (const [, descriptor] of node.fields) pending.push(descriptor.value);
		else if (node) for (const child of node.values) pending.push(child);
	}
	if (binary.length > 0) {
		const copies = structuredClone(binary);
		binary.forEach((item, index) => {
			seen.set(item, copies[index]);
		});
	}
	return isolate(value, graph, seen) as T;
}

/**
 * Build a `ToolCall` from its declared fields only. `fallback` supplies fields the
 * value lacks or carries with the wrong type, for example the block a
 * `toolcall_start` created before an untrusted wire `toolcall_end`.
 */
export function snapshotToolCall(value: unknown, fallback?: ToolCall): ToolCall {
	const source = isPlainObject(value) ? value : {};
	const text = (key: keyof ToolCall): string | undefined => {
		const field = source[key];
		return typeof field === "string" ? field : (fallback?.[key] as string | undefined);
	};
	const thoughtSignature = text("thoughtSignature");
	const namespace = text("namespace");
	return {
		type: "toolCall",
		id: text("id") ?? "",
		name: text("name") ?? "",
		arguments: isolateValue(
			isPlainObject(source.arguments) ? (source.arguments as ToolCall["arguments"]) : (fallback?.arguments ?? {}),
		),
		...(thoughtSignature === undefined ? {} : { thoughtSignature }),
		...(namespace === undefined ? {} : { namespace }),
	};
}

function snapshotContentBlock(block: ContentBlock): ContentBlock {
	switch (block?.type) {
		case "text":
			return {
				type: "text",
				text: block.text,
				...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
			};
		case "thinking":
			return {
				type: "thinking",
				thinking: block.thinking,
				...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
				...(block.redacted === undefined ? {} : { redacted: block.redacted }),
			};
		case "toolCall":
			return snapshotToolCall(block);
		default:
			return isolateValue(block);
	}
}

/** Detached copy of an assistant message with shape-normalized content blocks. */
export function snapshotAssistantMessage(message: AssistantMessage): AssistantMessage {
	const copy = isolateValue({ ...message, content: [] as ContentBlock[] });
	// `map` keeps holes: a block index a provider has not filled yet stays empty.
	copy.content = Array.isArray(message.content)
		? message.content.map(snapshotContentBlock)
		: isolateValue(message.content);
	return copy;
}

/** The event a consumer receives: the same event over detached snapshots. */
export function snapshotAssistantMessageEvent(event: AssistantMessageEvent): AssistantMessageEvent {
	switch (event.type) {
		case "done":
			return { ...event, message: snapshotAssistantMessage(event.message) };
		case "error":
			return { ...event, error: snapshotAssistantMessage(event.error) };
		case "toolcall_end":
			return {
				...event,
				toolCall: snapshotToolCall(event.toolCall),
				partial: snapshotAssistantMessage(event.partial),
			};
		default:
			return { ...event, partial: snapshotAssistantMessage(event.partial) };
	}
}
