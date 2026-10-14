import { existsSync, statSync } from "node:fs";
import {
	isArrayBuffer,
	isBigIntObject,
	isBooleanObject,
	isDataView,
	isNumberObject,
	isSharedArrayBuffer,
	isStringObject,
	isTypedArray,
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

/**
 * Conservative budget units charged per raw binary byte. A byte can become one
 * element: the walk charges 24 units per value plus up to 8 digits * 6 + 2 = 50
 * units for a numbered key below the 64 MiB cap, so 74 <= 80.
 */
const EXPORT_UNITS_PER_BINARY_BYTE = 80;

function intrinsicByteLengthGetter(prototype: object): (this: unknown) => number {
	return Object.getOwnPropertyDescriptor(prototype, "byteLength")!.get as (this: unknown) => number;
}
const typedArrayByteLength = intrinsicByteLengthGetter(Object.getPrototypeOf(Uint8Array.prototype));
const dataViewByteLength = intrinsicByteLengthGetter(DataView.prototype);
const arrayBufferByteLength = intrinsicByteLengthGetter(ArrayBuffer.prototype);
const sharedArrayBufferByteLength = intrinsicByteLengthGetter(SharedArrayBuffer.prototype);

/** Intrinsic byteLength of Buffer, ArrayBuffer, DataView or any typed array; ignores own overrides. */
function binaryByteLength(node: unknown): number | undefined {
	if (isTypedArray(node)) return Reflect.apply(typedArrayByteLength, node, []);
	if (isDataView(node)) return Reflect.apply(dataViewByteLength, node, []);
	if (isArrayBuffer(node)) return Reflect.apply(arrayBufferByteLength, node, []);
	if (isSharedArrayBuffer(node)) return Reflect.apply(sharedArrayBufferByteLength, node, []);
	return undefined;
}

/**
 * Resolve JSON hooks while bounding their actual output, then serialize only this
 * snapshot. A returned object's own toJSON is not called again at the same position.
 * Null prototypes prevent JSON.stringify from finding hooks on the snapshot itself.
 */
export function prepareExportValueForJson(
	value: unknown,
	format: string,
	limit = MAX_MATERIALIZED_EXPORT_BYTES,
): unknown {
	let remaining = limit;
	const ancestors = new WeakSet<object>();
	// Charge raw binary before any hook (e.g. Buffer#toJSON) can allocate per-byte output.
	const chargeBinary = (node: unknown): void => {
		const byteLength = binaryByteLength(node);
		if (byteLength === undefined) return;
		remaining -= byteLength * EXPORT_UNITS_PER_BINARY_BYTE;
		if (remaining < 0) throw exportLimitError(format);
	};
	const visit = (node: unknown, key: string, depth: number): unknown => {
		if (depth > 100) throw exportLimitError(format);
		chargeBinary(node);
		if ((node !== null && typeof node === "object") || typeof node === "function" || typeof node === "bigint") {
			const toJSON = (node as { toJSON?: unknown }).toJSON;
			if (typeof toJSON === "function") {
				node = Reflect.apply(toJSON, node, [key]);
				chargeBinary(node);
			}
		}
		// JSON unboxes these wrappers after toJSON, but does not invoke another hook.
		if (isNumberObject(node)) node = Number(node);
		else if (isStringObject(node)) node = String(node);
		else if (isBooleanObject(node)) node = Boolean.prototype.valueOf.call(node);
		else if (isBigIntObject(node)) node = BigInt.prototype.valueOf.call(node);
		remaining -= typeof node === "string" ? node.length * 6 + 2 : 24;
		if (remaining < 0) throw exportLimitError(format);
		if (typeof node === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
		if (typeof node === "undefined" || typeof node === "function" || typeof node === "symbol") return undefined;
		if (node === null || typeof node !== "object") return node;
		if (ancestors.has(node)) throw new Error("Cannot export circular session data");
		ancestors.add(node);
		let snapshot: unknown;
		if (Array.isArray(node)) {
			const array: unknown[] = [];
			Object.setPrototypeOf(array, null);
			const length = node.length;
			for (let i = 0; i < length; i++) array[i] = visit(node[i], String(i), depth + 1) ?? null;
			snapshot = array;
		} else {
			const record: Record<string, unknown> = Object.create(null);
			for (const property in node) {
				if (!Object.hasOwn(node, property)) continue;
				remaining -= property.length * 6 + 2;
				if (remaining < 0) throw exportLimitError(format);
				const child = visit((node as Record<string, unknown>)[property], property, depth + 1);
				if (child !== undefined) record[property] = child;
			}
			snapshot = record;
		}
		ancestors.delete(node);
		return snapshot;
	};
	return visit(value, "", 0);
}
