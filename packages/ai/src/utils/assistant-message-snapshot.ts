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

function isolate(value: unknown, seen: Map<object, unknown>): unknown {
	if (typeof value === "function" || typeof value === "symbol") return structuredClone(value);
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return seen.get(value);

	if (Array.isArray(value)) {
		const copy: unknown[] = new Array(value.length);
		seen.set(value, copy);
		value.forEach((item, index) => {
			copy[index] = isolate(item, seen);
		});
		return copy;
	}

	// DOMException keeps its state in internal slots; structuredClone handles it.
	if (value instanceof Error && !(typeof DOMException === "function" && value instanceof DOMException)) {
		const copy = Object.create(Object.getPrototypeOf(value)) as object;
		seen.set(value, copy);
		for (const key of Reflect.ownKeys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor) continue;
			if ("value" in descriptor) {
				Object.defineProperty(copy, key, { ...descriptor, value: isolate(descriptor.value, seen) });
				continue;
			}
			// V8 exposes `stack` as an own accessor. Copy what it reads as data.
			let read: unknown;
			try {
				read = descriptor.get?.call(value);
			} catch {
				continue;
			}
			Object.defineProperty(copy, key, {
				value: isolate(read, seen),
				enumerable: descriptor.enumerable,
				writable: true,
				configurable: true,
			});
		}
		return copy;
	}

	if (isPlainObject(value)) {
		const copy = {};
		seen.set(value, copy);
		for (const key of Object.keys(value)) defineData(copy, key, isolate(value[key], seen));
		return copy;
	}

	const copy: unknown = structuredClone(value);
	seen.set(value, copy);
	return copy;
}

/**
 * Deep, detached copy for isolation boundaries. Like `structuredClone`, it keeps
 * shared references and cycles and throws on functions. Unlike it, a native Error
 * keeps its prototype (class and `instanceof`), name, stack, cause and own fields
 * such as `code` or `status` (smarty-dev#5377), and an own `__proto__` key stays
 * data instead of replacing a prototype.
 */
export function isolateValue<T>(value: T): T {
	return isolate(value, new Map()) as T;
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
