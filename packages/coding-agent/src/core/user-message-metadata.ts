import { AsyncLocalStorage } from "node:async_hooks";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/** Opaque strict-JSON data. Pi snapshots it before dispatch and never sends it to the model. */
export type UserMessageMetadata = Readonly<Record<string, unknown>>;

/** Pi-owned submitter identity, separate from untrusted claims inside metadata. */
export type UserMessageMetadataSource =
	| { readonly kind: "sdk" }
	| { readonly kind: "extension"; readonly extensionPath: string };

export interface SendUserMessageOptions {
	deliverAs?: "steer" | "followUp";
	expandPromptTemplates?: boolean;
	/** Providing metadata opts into an admission receipt instead of waiting for the run to finish. */
	metadata?: UserMessageMetadata;
}

interface MetadataReceipt {
	readonly metadata: UserMessageMetadata;
	readonly metadataSource: UserMessageMetadataSource;
}

/** One receipt per input, including inputs consumed without starting a turn. */
export type SendUserMessageResult = MetadataReceipt &
	(
		| { readonly status: "handled"; readonly entryId: null }
		| { readonly status: "turnStarted"; readonly entryId: string }
	);

/** Internal runtime signature; legacy extension hosts may still return void. */
export type SendUserMessageHandler = (
	content: string | (TextContent | ImageContent)[],
	options?: SendUserMessageOptions,
	// biome-ignore lint/suspicious/noConfusingVoidType: legacy extension actions return void
) => void | Promise<SendUserMessageResult>;

const sdkSource: UserMessageMetadataSource = Object.freeze({ kind: "sdk" });
const extensionSources = new WeakMap<SendUserMessageOptions, UserMessageMetadataSource>();
const extensionExecution = new AsyncLocalStorage<string | undefined>();

/** Private loader binding: callbacks retain their registrar, never an invoker's borrowed identity. */
export function bindExtensionMetadataCallback<Args extends unknown[], Result>(
	extensionPath: string,
	callback: (...args: Args) => Result,
	isFactory = false,
): (...args: Args) => Result {
	// Only the loader enters a factory's identity. A callback installed by an
	// SDK host through a captured API remains SDK-originated when dispatched.
	const source = isFactory ? extensionPath : extensionExecution.getStore();
	return (...args) => extensionExecution.run(source, () => callback(...args));
}

/** Private loader guard: sharing an API must not let another extension register or submit as its owner. */
export function assertExtensionMetadataCaller(extensionPath: string): void {
	const caller = extensionExecution.getStore();
	if (caller !== undefined && caller !== extensionPath) {
		throw new UserMessageMetadataError(
			"INPUT_METADATA_SOURCE_MISMATCH",
			`Extension "${caller}" cannot register callbacks or submit metadata through extension "${extensionPath}"'s API`,
		);
	}
}

/** Private loader route, not exported from the SDK. Caller fields never select the source. */
export function bindExtensionMetadataSource(
	options: SendUserMessageOptions | undefined,
	extensionPath: string,
): SendUserMessageOptions | undefined {
	if (options?.metadata === undefined) return options;
	assertExtensionMetadataCaller(extensionPath);
	const caller = extensionExecution.getStore();
	const bound: SendUserMessageOptions = {
		metadata: options.metadata,
		deliverAs: options.deliverAs,
		expandPromptTemplates: options.expandPromptTemplates,
	};
	// An SDK host calling a captured API object is still SDK-originated. The
	// object is shareable; only Pi-dispatched extension execution supplies identity.
	if (caller !== undefined) extensionSources.set(bound, Object.freeze({ kind: "extension", extensionPath: caller }));
	return bound;
}

/** Private admission route; never read an options.metadataSource or metadata claim. */
export function getUserMessageMetadataSource(options: SendUserMessageOptions | undefined): UserMessageMetadataSource {
	return (options && extensionSources.get(options)) ?? sdkSource;
}

export type UserMessageMetadataErrorCode =
	| "INPUT_METADATA_TOO_LARGE"
	| "INPUT_METADATA_TOO_DEEP"
	| "INPUT_METADATA_TOO_MANY_ITEMS"
	| "INPUT_METADATA_SOURCE_MISMATCH";

/** A metadata validation failure, raised before admission without a queue or receipt side effect. */
export class UserMessageMetadataError extends TypeError {
	readonly code: UserMessageMetadataErrorCode;
	constructor(code: UserMessageMetadataErrorCode, message: string) {
		super(message);
		this.name = "UserMessageMetadataError";
		this.code = code;
	}
}

/** Copy and freeze strict JSON while bounding UTF-8 bytes, container depth and total keys/elements. */
export function snapshotUserMessageMetadata(metadata: UserMessageMetadata): UserMessageMetadata {
	if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
		throw new TypeError("User message metadata must be a JSON-serializable object");
	}
	let bytes = 0;
	let items = 0;
	const ancestors = new Set<object>();
	const addBytes = (count: number) => {
		bytes += count;
		if (bytes > 16_384)
			throw new UserMessageMetadataError(
				"INPUT_METADATA_TOO_LARGE",
				"User message metadata exceeds 16 KiB of serialized JSON",
			);
	};
	const addString = (value: string) => {
		// JSON cannot encode a string in fewer bytes than its UTF-16 length. Refuse
		// huge strings before allocating their escaped representation.
		if (value.length > 16_384 - bytes) addBytes(value.length);
		addBytes(Buffer.byteLength(JSON.stringify(value), "utf8"));
	};
	const addItems = (count: number) => {
		items += count;
		if (items > 1000)
			throw new UserMessageMetadataError(
				"INPUT_METADATA_TOO_MANY_ITEMS",
				"User message metadata exceeds 1,000 total keys/elements",
			);
	};
	const copy = (value: unknown, parentDepth: number): unknown => {
		if (typeof value === "string") {
			addString(value);
			return value;
		}
		if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
			addBytes(JSON.stringify(value).length);
			return value;
		}
		if (typeof value !== "object") throw new TypeError("User message metadata must contain only strict JSON values");
		const depth = parentDepth + 1;
		if (depth > 16)
			throw new UserMessageMetadataError(
				"INPUT_METADATA_TOO_DEEP",
				"User message metadata exceeds 16 nested containers, including the root",
			);
		if (ancestors.has(value)) throw new TypeError("User message metadata contains cycles");
		ancestors.add(value);
		try {
			addBytes(2); // Brackets or braces.
			const prototype = Object.getPrototypeOf(value);
			if (Array.isArray(value)) {
				addItems(value.length);
				if (prototype !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1)
					throw new TypeError("User message metadata requires dense plain arrays");
				const result: unknown[] = [];
				for (let index = 0; index < value.length; index++) {
					const descriptor = Object.getOwnPropertyDescriptor(value, index);
					if (!descriptor?.enumerable || !("value" in descriptor))
						throw new TypeError("User message metadata requires enumerable indexed data properties");
					if (index > 0) addBytes(1);
					result.push(copy(descriptor.value, depth));
				}
				return Object.freeze(result);
			}
			if (prototype !== Object.prototype && prototype !== null)
				throw new TypeError("User message metadata requires plain objects");
			const keys = Reflect.ownKeys(value);
			addItems(keys.length);
			const result = Object.create(prototype) as Record<string, unknown>;
			for (const [index, key] of keys.entries()) {
				if (typeof key !== "string") throw new TypeError("User message metadata cannot contain symbol keys");
				const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
				if (!descriptor.enumerable || !("value" in descriptor))
					throw new TypeError("User message metadata requires enumerable data properties");
				if (index > 0) addBytes(1);
				addString(key);
				addBytes(1); // Colon.
				Object.defineProperty(result, key, { value: copy(descriptor.value, depth), enumerable: true });
			}
			return Object.freeze(result);
		} finally {
			ancestors.delete(value);
		}
	};
	return copy(metadata, 0) as UserMessageMetadata;
}
