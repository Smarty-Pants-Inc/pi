import { existsSync, statSync } from "node:fs";
import { isAnyArrayBuffer, isArrayBufferView, isBoxedPrimitive, isDate, isMap, isProxy, isSet } from "node:util/types";

/** HTML and string exports need several simultaneous copies of the session payload. */
export const MAX_MATERIALIZED_EXPORT_BYTES = 64 * 1024 * 1024;
export const MAX_MATERIALIZED_EXPORT_ENTRIES = 10_000;

function exportLimitError(format: string): Error {
	if (format === "JSONL" || format === "JSONL entry") {
		return new Error(
			`${format} export exceeds the 64 MiB materialization limit; split data into smaller JSONL files`,
		);
	}
	return new Error(
		`${format} export exceeds the 64 MiB / 10000 entry materialization limit; use JSONL export instead`,
	);
}

/** Check disk size before readers that may clone or load the entire history. */
export function assertExportFileSize(filePath: string, format: string): void {
	if (statSync(filePath).size > MAX_MATERIALIZED_EXPORT_BYTES) throw exportLimitError(format);
}

export function assertMaterializedExportSize(filePath: string | undefined, entryCount: number, format: string): void {
	if (filePath && existsSync(filePath)) assertExportFileSize(filePath, format);
	if (entryCount > MAX_MATERIALIZED_EXPORT_ENTRIES) throw exportLimitError(format);
}

/**
 * Conservative JSON size preflight, without creating a serialized copy. Strings may
 * require six bytes per UTF-16 unit when escaped. Walk shared values each time they
 * occur, as JSON does, but stop early on huge payloads, cycles or excessive depth.
 */
export function assertExportValueSize(value: unknown, format: string, limit = MAX_MATERIALIZED_EXPORT_BYTES): void {
	let remaining = limit;
	const ancestors = new WeakSet<object>();
	const visit = (node: unknown, depth: number): void => {
		remaining -= typeof node === "string" ? node.length * 6 + 2 : 24;
		if (remaining < 0 || depth > 100) throw exportLimitError(format);
		if (node === null || typeof node !== "object") return;
		if (ancestors.has(node)) throw new Error("Cannot export circular session data");
		ancestors.add(node);
		if (Array.isArray(node)) {
			for (let i = 0; i < node.length; i++) visit(node[i], depth + 1);
		} else {
			for (const key in node) {
				if (!Object.hasOwn(node, key)) continue;
				visit(key, depth + 1);
				visit((node as Record<string, unknown>)[key], depth + 1);
			}
		}
		ancestors.delete(node);
	};
	visit(value, 0);
}

function plainJsonError(format: string, detail: string): TypeError {
	return new TypeError(`${format} export accepts only plain JSON data; found ${detail}`);
}

/** Find the first own or inherited data-valued toJSON slot without invoking accessors. */
function findJsonHook(node: object, format: string): ((key: string) => unknown) | undefined {
	let holder: object | null = node;
	while (holder !== null) {
		if (isProxy(holder)) throw plainJsonError(format, "a proxy");
		const descriptor = Object.getOwnPropertyDescriptor(holder, "toJSON");
		if (descriptor !== undefined) {
			if (!("value" in descriptor)) throw plainJsonError(format, "a toJSON accessor");
			if (typeof descriptor.value !== "function") return undefined;
			if (isProxy(descriptor.value)) throw plainJsonError(format, "a proxy");
			return descriptor.value as (key: string) => unknown;
		}
		holder = Object.getPrototypeOf(holder);
	}
	return undefined;
}

/**
 * Snapshot plain JSON data (smarty-dev#12074): null, booleans, finite numbers, strings,
 * plain arrays and plain or null-prototype objects. Undefined object data properties are
 * omitted; undefined array data elements become null. Root undefined is refused.
 * Proxies, serialized accessors, array holes and toJSON accessors are refused without invoking
 * them. Data-valued toJSON hooks run with JSON.stringify's property key and their results are
 * walked once as already-serialized values. Object hidden and symbol properties, and array
 * non-index properties, are ignored as JSON does. Values come from property descriptors.
 * The result uses null prototypes, so JSON.stringify finds no hooks on it and its output
 * matches native JSON.stringify of the input. The limit is the exact UTF-8 byte length of
 * that output: quotes, escapes, brackets, braces, colons and commas are all charged, and
 * omitted members charge nothing. Strings are measured in place, so no copy is made.
 * The descriptor walk stops at the budget, but V8 first materializes the FULL key list.
 * Node 22.23.2 / 24.19.0 measured a 10M-index-key plain object: 118.84 MB resident
 * key storage, +320 MB retained enumeration / +358.86 MB peak (k < 3.1); 2M named
 * keys added 16 MB retained / 32.01 MB peak over 148.65 MB resident (k < 0.22).
 * These are measured bounds, not constant-space or a guarantee for every V8/input.
 * Allow input-sized heap headroom; near-heap-limit objects can still OOM. The heavy
 * regression proves refusal of 10M keys under a fixed 1 GiB old-space cap.
 */
export function prepareExportValueForJson(
	value: unknown,
	format: string,
	limit = MAX_MATERIALIZED_EXPORT_BYTES,
): unknown {
	let remaining = limit;
	const ancestors = new WeakSet<object>();
	const charge = (bytes: number): void => {
		remaining -= bytes;
		if (remaining < 0) throw exportLimitError(format);
	};
	const chargeString = (text: string): void => {
		// Quotes, then at least one byte per UTF-16 unit: refuse huge strings before scanning.
		charge(2 + text.length);
		// Add the extra bytes of each unit. Indexing and single-unit comparisons on a
		// primitive string run no user code.
		const length = text.length;
		for (let i = 0; i < length; i++) {
			const unit = text[i];
			if (unit < " ") {
				// \b \t \n \f \r take 2 bytes; other control codes take \u00XX, 6 bytes.
				remaining -= unit === "\b" || unit === "\t" || unit === "\n" || unit === "\f" || unit === "\r" ? 1 : 5;
			} else if (unit === '"' || unit === "\\") {
				remaining -= 1;
			} else if (unit < "\u0080") {
				continue;
			} else if (unit < "\u0800") {
				remaining -= 1;
			} else if (unit >= "\ud800" && unit <= "\udfff") {
				const next = i + 1 < length ? text[i + 1] : "";
				if (unit <= "\udbff" && next >= "\udc00" && next <= "\udfff") {
					// A valid pair is one 4-byte UTF-8 sequence over two units.
					remaining -= 2;
					i++;
				} else {
					// JSON.stringify writes a lone surrogate as \uXXXX.
					remaining -= 5;
				}
			} else {
				remaining -= 2;
			}
			if (remaining < 0) throw exportLimitError(format);
		}
	};
	// Verify the only permitted chains, Object.prototype -> null and Array.prototype ->
	// Object.prototype -> null, before any node is enumerated. Each link is checked with
	// isProxy before it is reflected on; Array.prototype's own prototype is mutable.
	const objectPrototypeOk = !isProxy(Object.prototype) && Object.getPrototypeOf(Object.prototype) === null;
	const arrayPrototypeOk =
		objectPrototypeOk && !isProxy(Array.prototype) && Object.getPrototypeOf(Array.prototype) === Object.prototype;
	/** Own data value; refuses holes and accessors without reading them. */
	const dataValue = (node: object, key: string): unknown => {
		const descriptor = Object.getOwnPropertyDescriptor(node, key);
		if (descriptor === undefined) throw plainJsonError(format, "an array hole");
		if (!("value" in descriptor)) throw plainJsonError(format, "an accessor property");
		return descriptor.value;
	};
	const visit = (node: unknown, depth: number, key: string, applyToJson = true): unknown => {
		if (depth > 100) throw exportLimitError(format);
		if (node === undefined) return undefined;
		if (typeof node === "string") {
			chargeString(node);
			return node;
		}
		if (node === null) {
			charge(4);
			return node;
		}
		if (typeof node === "boolean") {
			charge(node ? 4 : 5);
			return node;
		}
		if (typeof node === "number") {
			if (!Number.isFinite(node)) throw plainJsonError(format, "a non-finite number");
			// Template ToString on a primitive runs no user code; -0 gives "0", as JSON writes.
			charge(`${node}`.length);
			return node;
		}
		// JSON.stringify omits symbols in objects and writes null for array elements;
		// the root result is rejected below when it remains undefined.
		if (typeof node === "symbol") return undefined;
		const callable = typeof node === "function";
		if (typeof node !== "object" && !callable) throw plainJsonError(format, `type ${typeof node}`);
		const objectNode = node as object;
		// Before any reflection: a proxy (live or revoked) could trap every later step.
		if (isProxy(objectNode)) throw plainJsonError(format, "a proxy");
		if (ancestors.has(objectNode)) throw new Error("Cannot export circular session data");
		ancestors.add(objectNode);
		try {
			// JSON.stringify calls an own or inherited data-valued toJSON before checking the
			// holder's brand or enumerating its fields. Guard the replacement at the same depth
			// and with the same property key before materializing any snapshot. A replacement is
			// then processed as the already-serialized value, so its own toJSON is not chained.
			const toJSON = applyToJson ? findJsonHook(objectNode, format) : undefined;
			if (toJSON) return visit(Reflect.apply(toJSON, node, [key]), depth, key, false);
			// JSON.stringify omits functions in objects and writes null for array elements;
			// the root result is rejected below when it remains undefined.
			if (callable) return undefined;
			// Intrinsic brands survive prototype replacement; built-ins without toJSON remain refused.
			if (
				isAnyArrayBuffer(node) ||
				isArrayBufferView(node) ||
				isDate(node) ||
				isMap(node) ||
				isSet(node) ||
				isBoxedPrimitive(node)
			) {
				throw plainJsonError(format, "a built-in object");
			}
			const prototype = Object.getPrototypeOf(node);
			const arrayNode = Array.isArray(node);
			if (arrayNode) {
				if (prototype !== Array.prototype || !arrayPrototypeOk) throw plainJsonError(format, "a non-plain array");
			} else if ((prototype !== Object.prototype || !objectPrototypeOk) && prototype !== null) {
				throw plainJsonError(format, "a non-plain object");
			}
			let snapshot: unknown;
			if (arrayNode) {
				const length = Object.getOwnPropertyDescriptor(node, "length")!.value as number;
				const array: unknown[] = [];
				Object.setPrototypeOf(array, null);
				// Brackets, then one comma before every element after the first.
				charge(2);
				for (let i = 0; i < length; i++) {
					if (i > 0) charge(1);
					const child = dataValue(node, String(i));
					const prepared = visit(child === undefined ? null : child, depth + 1, String(i));
					// A toJSON result of undefined is null in an array, as JSON.stringify writes.
					array[i] = prepared === undefined ? null : prepared;
					if (prepared === undefined) charge(4);
				}
				snapshot = array;
			} else {
				const record: Record<string, unknown> = Object.create(null);
				// Braces; each emitted member adds its comma, quoted key and colon.
				charge(2);
				let emitted = false;
				for (const property in node) {
					// Inherited enumerable keys (polluted Object.prototype) are skipped, as JSON does.
					if (!Object.hasOwn(node, property)) continue;
					const child = dataValue(node, property);
					// JSON.stringify omits undefined object data properties, including their keys.
					if (child === undefined) continue;
					const prepared = visit(child, depth + 1, property);
					// A toJSON result of undefined omits an object member, as JSON.stringify writes.
					if (prepared === undefined) continue;
					if (emitted) charge(1);
					emitted = true;
					chargeString(property);
					charge(1);
					// Null prototype: assigning "__proto__" creates an own property.
					record[property] = prepared;
				}
				snapshot = record;
			}
			return snapshot;
		} finally {
			ancestors.delete(objectNode);
		}
	};
	const snapshot = visit(value, 0, "");
	if (snapshot === undefined) throw plainJsonError(format, "type undefined");
	return snapshot;
}
