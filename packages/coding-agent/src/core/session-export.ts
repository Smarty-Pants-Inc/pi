import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { isProxy } from "node:util/types";
import { resolvePath } from "../utils/paths.ts";
import {
	assertExportFileSize,
	assertMaterializedExportSize,
	MAX_MATERIALIZED_EXPORT_BYTES,
	prepareExportValueForJson,
} from "./export-limits.ts";
import { getEntryLocation, isColdEntry, toHotEntry } from "./session-lazy-entries.ts";
import { CURRENT_SESSION_VERSION, type SessionHeader, type SessionManager } from "./session-manager.ts";

type TrailingEntries = (parentId: string | null, timestamp: string) => readonly object[];
type Json = Record<string, unknown>;

/** Guard the original value before copying it or reading its fields (smarty-dev#12074). */
function snapshot(value: unknown, format: string, limit: number): Json {
	// Entry serializers can replace canonical receipts; nested details still go through the
	// JSON-compatible toJSON path in prepareExportValueForJson.
	if (typeof value === "function") throw plainJsonError(format, "a callable entry");
	if (value !== null && typeof value === "object") assertShallowPlain(value, format);
	return prepareExportValueForJson(value, format, limit) as Json;
}

function plainJsonError(format: string, detail: string): TypeError {
	return new TypeError(`${format} export accepts only plain JSON data; found ${detail}`);
}

/** Own data value of a non-proxy object; an accessor is refused, never read. */
function dataField(node: object, key: string, format: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(node, key);
	if (descriptor && !("value" in descriptor)) throw plainJsonError(format, "an accessor property");
	return descriptor?.value;
}

/**
 * Effect-free shallow checks (proxy first, then prototype, then own toJSON) for objects the full
 * guard cannot see: the branch discovery pass and the resident parts of a cold entry.
 */
function assertShallowPlain(node: object, format: string): void {
	if (isProxy(node)) throw plainJsonError(format, "a proxy");
	const prototype = Object.getPrototypeOf(node);
	if (Array.isArray(node) ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype) {
		throw plainJsonError(format, "a non-plain object");
	}
	for (let link: object | null = node; link !== null; link = Object.getPrototypeOf(link)) {
		if (isProxy(link)) throw plainJsonError(format, "a proxy");
		const toJSON = Object.getOwnPropertyDescriptor(link, "toJSON");
		if (toJSON && (!("value" in toJSON) || typeof toJSON.value === "function")) {
			throw plainJsonError(format, "a toJSON property");
		}
		if (
			(link === Object.prototype && Object.getPrototypeOf(link) !== null) ||
			(link === Array.prototype && Object.getPrototypeOf(link) !== Object.prototype)
		) {
			throw plainJsonError(format, "a non-plain object");
		}
	}
}

/** Discovery pass: only the parent link is needed, read by data descriptor after shallow checks. */
function parentLink(entry: object, format: string): string | null {
	assertShallowPlain(entry, format);
	const parentId = dataField(entry, "parentId", format) ?? null;
	if (parentId !== null && typeof parentId !== "string") throw plainJsonError(format, "a non-string parentId");
	return parentId;
}

/**
 * Generated lazy accessor shape (enumerable, get + set), configurable unless its container is
 * frozen (pi#160). Not an identity proof: a user accessor of the same shape on a key the line
 * also holds is replaced by the disk value. It is never invoked either way.
 */
function isLazyShaped(node: object, descriptor: PropertyDescriptor): boolean {
	return (
		descriptor.enumerable === true &&
		(descriptor.configurable === true || Object.isFrozen(node)) &&
		typeof descriptor.get === "function" &&
		typeof descriptor.set === "function"
	);
}

/** Accessor keys of a cold entry or its message; each must be lazy-shaped and present on disk. */
function lazyKeys(node: object, format: string): string[] {
	const keys: string[] = [];
	for (const key in node) {
		if (!Object.hasOwn(node, key)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(node, key)!;
		if ("value" in descriptor) continue;
		if (key === "id" || !isLazyShaped(node, descriptor)) throw plainJsonError(format, "an accessor property");
		keys.push(key);
	}
	return keys;
}

function requireKeys(node: unknown, keys: readonly string[], format: string): void {
	for (const key of keys) {
		if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) {
			throw plainJsonError(format, "an accessor property");
		}
	}
}

/**
 * Cold entries hold lazy accessors, also nested in message; they are never invoked. The line is
 * reparsed from disk and walked by the guard before any patch. It is refused before any key name
 * is read when longer than `limit` less the parent link, and before it is read when longer than
 * `limit` less all resident reservations. Resident primitive data fields, which copyEntry patches
 * (parentId, timestamp, firstKeptEntryId) may have changed, are then redefined on the snapshot by descriptor, so
 * "__proto__" stays data. Resident objects come from disk after shallow checks.
 */
function coldSnapshot(entry: object, parentId: string | null, format: string, limit: number): Json {
	assertShallowPlain(entry, format);
	const id = dataField(entry, "id", format);
	if (typeof id !== "string") {
		throw plainJsonError(format, "a session entry without a string id");
	}
	// Preflight before any key or accessor name is enumerated: the line must fit the caller's limit
	// less the parent link reservation. The final check after resident reservations is in toHotEntry.
	const parentBytes = typeof parentId === "string" ? parentId.length * 6 + 26 : 30;
	const location = getEntryLocation(entry);
	if (!location) throw new Error(`Session entry ${id} has no location on disk`);
	if (!(location.length <= limit - parentBytes)) {
		throw new Error(`Session entry ${id} exceeds the remaining export limit (${location.length} bytes)`);
	}
	const rootLazy = lazyKeys(entry, format);
	const message = dataField(entry, "message", format);
	let messageLazy: string[] = [];
	if (message !== null && typeof message === "object") {
		assertShallowPlain(message, format);
		messageLazy = lazyKeys(message, format);
	}
	const patches: [string, unknown][] = [["parentId", parentId]];
	// Reserve conservative bytes for every resident replacement as well as the parsed line.
	// A replacement can grow the line; checking each contribution separately is insufficient.
	let remaining = limit - parentBytes;
	for (const key in entry) {
		if (!Object.hasOwn(entry, key) || key === "parentId") continue;
		const descriptor = Object.getOwnPropertyDescriptor(entry, key)!;
		if (!("value" in descriptor)) continue; // Already checked by lazyKeys; use its disk value.
		const value: unknown = descriptor.value;
		if (value !== null && typeof value === "object") {
			assertShallowPlain(value, format);
			continue;
		}
		// Primitive data only: never validate a callable's hook and then patch the raw callable.
		if (typeof value === "function") throw plainJsonError(format, "a callable resident replacement");
		const prepared = prepareExportValueForJson(value === undefined ? null : value, format, remaining);
		remaining -=
			key.length * 6 +
			26 +
			(typeof value === "string" ? value.length * 6 : typeof value === "number" ? `${value}`.length : 0);
		if (remaining < 0) throw new Error(`${format} export exceeds the 64 MiB materialization limit`);
		patches.push([key, value === undefined ? undefined : prepared]);
	}
	// The line is refused against the budget left after the resident reservations, before it is read.
	const hot = snapshot(toHotEntry(entry, remaining), format, remaining);
	requireKeys(hot, rootLazy, format);
	requireKeys(Object.getOwnPropertyDescriptor(hot, "message")?.value, messageLazy, format);
	for (const [key, value] of patches) {
		Object.defineProperty(hot, key, { value, enumerable: true, writable: true, configurable: true });
	}
	// pi#247: no second walk. `hot` is already the guard's own null-prototype snapshot (its arrays
	// have null prototypes, which a second walk would refuse as foreign), and each patch is a
	// prepared primitive whose bytes were reserved above, so the record fits `limit`.
	return hot;
}

/**
 * Walk single-entry reads rather than copying the entire branch payload, yielding guarded
 * null-prototype snapshots. `budget` returns the caller's current remaining bytes; cold lines
 * longer than it are refused before reading.
 */
function* sessionBranchSnapshots(
	sessionManager: SessionManager,
	format: string,
	budget: () => number,
	createTrailingEntries?: TrailingEntries,
): Generator<Json> {
	const timestamp = new Date().toISOString();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionManager.getSessionId(),
		timestamp,
		cwd: sessionManager.getCwd(),
	};
	yield snapshot(header, format, budget());
	// Retain only IDs while finding root-to-leaf order, not entry payloads.
	const ids: string[] = [];
	const seen = new Set<string>();
	let id = sessionManager.getLeafId();
	while (id) {
		if (seen.has(id)) throw new Error("Cannot export circular session branch");
		const entry = sessionManager.getEntry(id);
		if (!entry) break;
		seen.add(id);
		ids.push(id);
		id = parentLink(entry, format);
	}
	let parentId: string | null = null;
	for (let i = ids.length - 1; i >= 0; i--) {
		const entry = sessionManager.getEntry(ids[i]);
		if (!entry) throw new Error("Session branch changed during export");
		let record: Json;
		if (isColdEntry(entry)) {
			record = coldSnapshot(entry, parentId, format, budget());
		} else {
			// The original is guarded first; parentId is replaced on the safe snapshot (in place,
			// or appended when absent, as a spread would).
			// Reserve for an inserted or longer parent link before the original is materialized.
			const parentBytes = typeof parentId === "string" ? parentId.length * 6 + 26 : 30;
			record = snapshot(entry, format, budget() - parentBytes);
			record.parentId = parentId;
		}
		const nextParent = Object.getOwnPropertyDescriptor(record, "id")?.value;
		if (typeof nextParent !== "string") throw plainJsonError(format, "a session entry without a string id");
		yield record;
		parentId = nextParent;
	}
	for (const entry of createTrailingEntries?.(parentId, timestamp) ?? []) {
		yield snapshot(entry, format, budget());
	}
}

function jsonLine(record: Json): string {
	const serialized = JSON.stringify(record);
	if (typeof serialized !== "string") throw new Error("Session entry did not serialize to JSON");
	return `${serialized}\n`;
}

/** Serialize a bounded current branch and optional export-only entries as JSONL. */
export function serializeSessionBranch(
	sessionManager: SessionManager,
	createTrailingEntries?: TrailingEntries,
): string {
	assertMaterializedExportSize(sessionManager.getSessionFile(), sessionManager.getEntryCount(), "String JSONL");
	const lines: string[] = [];
	let remaining = MAX_MATERIALIZED_EXPORT_BYTES;
	const budget = () => remaining - 1; // JSONL newline.
	for (const record of sessionBranchSnapshots(sessionManager, "String JSONL", budget, createTrailingEntries)) {
		const line = jsonLine(record);
		remaining -= Buffer.byteLength(line);
		if (remaining < 0) throw new Error("String JSONL export exceeds the 64 MiB limit; use JSONL export instead");
		lines.push(line);
	}
	return lines.join("");
}

/** Write the current session branch and optional export-only entries as JSONL. */
export function exportSessionToJsonl(
	sessionManager: SessionManager,
	outputPath?: string,
	createTrailingEntries?: TrailingEntries,
): string {
	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
		process.cwd(),
	);
	const sessionFile = sessionManager.getSessionFile();
	if (sessionFile && existsSync(sessionFile)) assertExportFileSize(sessionFile, "JSONL");
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	// Cold entries can read from the output path. Do not truncate it before reading.
	const target = existsSync(filePath) ? realpathSync(filePath) : filePath;
	const temporary = `${target}.${randomUUID()}.tmp`;
	// Replacing an existing private export must not widen its permissions.
	const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o666;
	const fd = openSync(temporary, "wx", mode);
	let closed = false;
	try {
		const budget = () => MAX_MATERIALIZED_EXPORT_BYTES - 1; // JSONL newline.
		for (const record of sessionBranchSnapshots(sessionManager, "JSONL entry", budget, createTrailingEntries)) {
			const line = Buffer.from(jsonLine(record));
			let offset = 0;
			while (offset < line.length) {
				const written = writeSync(fd, line, offset, line.length - offset);
				if (written <= 0) throw new Error("JSONL export write made no progress");
				offset += written;
			}
		}
		closeSync(fd);
		closed = true;
		renameSync(temporary, target);
	} finally {
		try {
			if (!closed) closeSync(fd);
		} finally {
			if (existsSync(temporary)) unlinkSync(temporary);
		}
	}
	return filePath;
}
