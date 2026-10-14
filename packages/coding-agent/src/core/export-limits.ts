import { existsSync, statSync } from "node:fs";
import {
	isAnyArrayBuffer,
	isArrayBufferView,
	isBoxedPrimitive,
	isDate,
	isMap,
	isNativeError,
	isProxy,
	isRegExp,
	isSet,
} from "node:util/types";

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

/**
 * Snapshot plain JSON data (smarty-dev#12074): null, booleans, finite numbers, strings,
 * plain arrays and plain or null-prototype objects. Undefined object data properties are
 * omitted; undefined array data elements become null. Root undefined is refused.
 * Proxies, serialized accessors, array holes and any toJSON property are refused, so no
 * user code runs and no getter is read. Object hidden and symbol properties, and array
 * non-index properties, are ignored as JSON does. Values come from property descriptors.
 * The result uses null prototypes, so JSON.stringify finds no hooks on it and its output
 * matches native JSON.stringify of the input. The size budget is charged per key as the
 * walk goes, so a huge object is refused before all of its keys are listed.
 */
export function prepareExportValueForJson(
	value: unknown,
	format: string,
	limit = MAX_MATERIALIZED_EXPORT_BYTES,
): unknown {
	let remaining = limit;
	const ancestors = new WeakSet<object>();
	const charge = (units: number): void => {
		remaining -= units;
		if (remaining < 0) throw exportLimitError(format);
	};
	// Verify the only permitted chains, Object.prototype -> null and Array.prototype ->
	// Object.prototype -> null, before any node is enumerated. Each link is checked with
	// isProxy before it is reflected on; Array.prototype's own prototype is mutable.
	const objectPrototypeOk =
		!isProxy(Object.prototype) &&
		Object.getPrototypeOf(Object.prototype) === null &&
		Object.getOwnPropertyDescriptor(Object.prototype, "toJSON") === undefined;
	const arrayPrototypeOk =
		objectPrototypeOk &&
		!isProxy(Array.prototype) &&
		Object.getPrototypeOf(Array.prototype) === Object.prototype &&
		Object.getOwnPropertyDescriptor(Array.prototype, "toJSON") === undefined;
	/** Own data value; refuses holes and accessors without reading them. */
	const dataValue = (node: object, key: string): unknown => {
		const descriptor = Object.getOwnPropertyDescriptor(node, key);
		if (descriptor === undefined) throw plainJsonError(format, "an array hole");
		if (!("value" in descriptor)) throw plainJsonError(format, "an accessor property");
		return descriptor.value;
	};
	const visit = (node: unknown, depth: number): unknown => {
		if (depth > 100) throw exportLimitError(format);
		if (typeof node === "string") {
			charge(node.length * 6 + 2);
			return node;
		}
		charge(24);
		if (node === null || typeof node === "boolean") return node;
		if (typeof node === "number") {
			if (!Number.isFinite(node)) throw plainJsonError(format, "a non-finite number");
			return node;
		}
		if (typeof node !== "object") throw plainJsonError(format, `type ${typeof node}`);
		// Before any reflection: a proxy (live or revoked) could trap every later step.
		if (isProxy(node)) throw plainJsonError(format, "a proxy");
		// Intrinsic brands survive prototype replacement; these are never plain records.
		if (
			isAnyArrayBuffer(node) ||
			isArrayBufferView(node) ||
			isDate(node) ||
			isMap(node) ||
			isSet(node) ||
			isBoxedPrimitive(node) ||
			isRegExp(node) ||
			isNativeError(node)
		) {
			throw plainJsonError(format, "a built-in object");
		}
		if (ancestors.has(node)) throw new Error("Cannot export circular session data");
		const prototype = Object.getPrototypeOf(node);
		const arrayNode = Array.isArray(node);
		if (arrayNode) {
			if (prototype !== Array.prototype || !arrayPrototypeOk) throw plainJsonError(format, "a non-plain array");
		} else if ((prototype !== Object.prototype || !objectPrototypeOk) && prototype !== null) {
			throw plainJsonError(format, "a non-plain object");
		}
		if (Object.getOwnPropertyDescriptor(node, "toJSON") !== undefined) {
			throw plainJsonError(format, "a toJSON property");
		}
		let snapshot: unknown;
		ancestors.add(node);
		if (arrayNode) {
			const length = Object.getOwnPropertyDescriptor(node, "length")!.value as number;
			const array: unknown[] = [];
			Object.setPrototypeOf(array, null);
			for (let i = 0; i < length; i++) {
				const child = dataValue(node, String(i));
				array[i] = visit(child === undefined ? null : child, depth + 1);
			}
			snapshot = array;
		} else {
			const record: Record<string, unknown> = Object.create(null);
			for (const property in node) {
				// Inherited enumerable keys (polluted Object.prototype) are skipped, as JSON does.
				if (!Object.hasOwn(node, property)) continue;
				const child = dataValue(node, property);
				// JSON.stringify omits undefined object data properties, including their keys.
				if (child === undefined) continue;
				charge(property.length * 6 + 2);
				// Null prototype: assigning "__proto__" creates an own property.
				record[property] = visit(child, depth + 1);
			}
			snapshot = record;
		}
		ancestors.delete(node);
		return snapshot;
	};
	return visit(value, 0);
}
