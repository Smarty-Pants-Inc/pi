import { closeSync, fstatSync, openSync, readSync } from "fs";

/**
 * Bounded session memory (smarty-dev#2177).
 *
 * Problem: SessionManager kept every entry of the append-only session file in memory for the
 * process lifetime. On a 297 MB session, 422 MB of heap were entry strings (compaction summaries,
 * tool output, thinking signatures) that only /tree, fork, export and stats ever read again.
 *
 * Solution: an entry outside the hot set (current context plus a recent window) is replaced by a
 * "cold" copy. The copy keeps every small field (id, parentId, type, role, usage, model, ...) so
 * tree walks, context building and usage totals stay in memory. Each large field becomes an
 * enumerable accessor that re-reads the entry's JSONL line by byte offset, so JSON.stringify,
 * spreads and property reads see the same values as before.
 *
 * Cold copies are new objects: objects that the agent or the TUI still hold are never mutated.
 */

/** Where an entry's JSON line lives in its session file. */
export interface EntryLocation {
	file: string;
	offset: number;
	length: number;
}

/** Fields whose JSON is shorter than this stay resident. */
const LAZY_FIELD_MIN_CHARS = 1024;
const RESIDENT_KEYS = new Set(["type", "id", "parentId", "timestamp", "provenance"]);

type Json = Record<string, unknown>;

const locations = new WeakMap<object, EntryLocation>();
const coldEntries = new WeakSet<object>();
/** Entries already checked that have no large field; they stay resident as they are. */
const smallEntries = new WeakSet<object>();
let lastRead: { location: EntryLocation; value: Json } | undefined;

export function setEntryLocation(entry: object, location: EntryLocation): void {
	locations.set(entry, location);
}

export function getEntryLocation(entry: object): EntryLocation | undefined {
	return locations.get(entry);
}

export function isColdEntry(entry: object): boolean {
	return coldEntries.has(entry);
}

/**
 * Read and parse one session line. The last line read is cached for consecutive field reads.
 * `maxBytes` (smarty-dev#12074) refuses a line longer than the caller's remaining budget before
 * the file is opened; the range is checked against the open file's size before allocation.
 */
function readEntryLine(location: EntryLocation, id: unknown, maxBytes?: number): Json {
	if (lastRead?.location === location) return lastRead.value;
	const { file, offset, length } = location;
	const changed = () =>
		new Error(`Session file changed on disk: entry ${String(id)} is no longer at byte ${offset} of ${file}`);
	if (
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(length) ||
		offset < 0 ||
		length <= 0 ||
		!Number.isSafeInteger(offset + length)
	) {
		throw changed();
	}
	if (maxBytes !== undefined && length > maxBytes) {
		throw new Error(`Session entry ${String(id)} exceeds the remaining export limit (${length} bytes)`);
	}
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch (error) {
		throw new Error(`Session file changed on disk: cannot read entry ${String(id)} from ${file}`, {
			cause: error,
		});
	}
	let buffer: Buffer;
	try {
		if (offset + length > fstatSync(fd).size) throw changed();
		buffer = Buffer.allocUnsafe(length);
		let read = 0;
		while (read < length) {
			const n = readSync(fd, buffer, read, length - read, offset + read);
			if (n <= 0) break;
			read += n;
		}
		if (read !== length) throw changed();
	} finally {
		closeSync(fd);
	}
	let value: Json | undefined;
	try {
		value = JSON.parse(buffer.toString("utf8")) as Json;
	} catch {
		value = undefined;
	}
	// Parsed JSON has only own data properties; read id by descriptor anyway.
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getOwnPropertyDescriptor(value, "id")?.value !== id
	) {
		throw changed();
	}
	lastRead = { location, value };
	return value;
}

function isLarge(value: unknown): boolean {
	if (value === null || value === undefined) return false;
	if (typeof value === "string") return value.length >= LAZY_FIELD_MIN_CHARS;
	if (typeof value !== "object") return false;
	return (JSON.stringify(value)?.length ?? 0) >= LAZY_FIELD_MIN_CHARS;
}

function defineLazy(target: Json, key: string, read: () => unknown): void {
	Object.defineProperty(target, key, {
		enumerable: true,
		configurable: true,
		get: read,
		set(value: unknown) {
			Object.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true });
		},
	});
}

/**
 * Return a cold copy of `entry` whose large fields are read from `location` on access, or `entry`
 * itself when it has no large field. `message` objects are handled one level down so that
 * role, usage and model stay resident.
 */
export function toColdEntry<T extends object>(entry: T, location: EntryLocation): T {
	if (smallEntries.has(entry)) {
		setEntryLocation(entry, location);
		return entry;
	}
	const source = entry as Json;
	const id = source.id;
	const copy: Json = {};
	let cold = false;
	// Keys stay in the original order so JSON.stringify output is byte-identical.
	for (const key of Object.keys(source)) {
		const value = source[key];
		if (RESIDENT_KEYS.has(key)) {
			copy[key] = value;
		} else if (key === "message" && value && typeof value === "object" && !Array.isArray(value)) {
			const message = value as Json;
			const coldMessage: Json = {};
			for (const messageKey of Object.keys(message)) {
				if (isLarge(message[messageKey])) {
					defineLazy(coldMessage, messageKey, lazyReader(location, id, "message", messageKey));
					cold = true;
				} else {
					coldMessage[messageKey] = message[messageKey];
				}
			}
			copy[key] = coldMessage;
		} else if (isLarge(value)) {
			defineLazy(copy, key, lazyReader(location, id, undefined, key));
			cold = true;
		} else {
			copy[key] = value;
		}
	}
	setEntryLocation(entry, location);
	if (!cold) {
		smallEntries.add(entry);
		return entry;
	}
	setEntryLocation(copy, location);
	coldEntries.add(copy);
	return copy as T;
}

/**
 * Build a field reader in its own scope. A closure created inside toColdEntry would share V8's
 * context with the loop variables and keep the original (large) message alive.
 */
function lazyReader(location: EntryLocation, id: unknown, parent: string | undefined, key: string): () => unknown {
	return () => {
		const line = readEntryLine(location, id);
		return parent === undefined ? line[key] : (line[parent] as Json | undefined)?.[key];
	};
}

/**
 * Like `{ ...entry, ...patch }`, but lazy fields stay lazy: a cold entry's copy reads the same
 * line until it is written to a new file.
 */
export function copyEntry<T extends object>(entry: T, patch: Partial<T>): T {
	const copy = {};
	for (const key of Object.keys(entry)) {
		Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(entry, key)!);
	}
	for (const [key, value] of Object.entries(patch)) {
		Object.defineProperty(copy, key, { value, writable: true, enumerable: true, configurable: true });
	}
	const location = locations.get(entry);
	if (coldEntries.has(entry) && location) {
		coldEntries.add(copy);
		locations.set(copy, location);
	}
	return copy as T;
}

/**
 * Return a fully resident copy of a cold entry (parsed from its line), or the entry itself.
 * `maxBytes` refuses a longer line before it is read. The id is read by data descriptor only.
 */
export function toHotEntry<T extends object>(entry: T, maxBytes?: number): T {
	if (!coldEntries.has(entry)) return entry;
	const location = locations.get(entry)!;
	const id = Object.getOwnPropertyDescriptor(entry, "id");
	if (!id || !("value" in id) || typeof id.value !== "string") {
		throw new TypeError("Cold session entry id must be a string data property");
	}
	if (lastRead?.location === location) lastRead = undefined;
	const hot = readEntryLine(location, id.value, maxBytes);
	lastRead = undefined;
	setEntryLocation(hot, location);
	return hot as T;
}

/**
 * Stream a session file line by line with byte offsets. Splitting on 0x0A is safe in UTF-8.
 * Returns whether the file ends without a trailing newline.
 */
export function readSessionFileLines(
	filePath: string,
	onLine: (line: string, offset: number, length: number) => void,
	chunkSize = 1024 * 1024,
): { missingFinalNewline: boolean } {
	const fd = openSync(filePath, "r");
	const buffer = Buffer.allocUnsafe(chunkSize);
	let pending: Buffer[] = [];
	let lineStart = 0;
	let position = 0;
	try {
		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
			if (bytesRead === 0) break;
			const chunk = buffer.subarray(0, bytesRead);
			let start = 0;
			let newline = chunk.indexOf(10, start);
			while (newline !== -1) {
				const part = chunk.subarray(start, newline);
				const line = pending.length > 0 ? Buffer.concat([...pending, part]) : part;
				onLine(line.toString("utf8"), lineStart, line.length);
				pending = [];
				start = newline + 1;
				lineStart = position + start;
				newline = chunk.indexOf(10, start);
			}
			if (start < chunk.length) pending.push(Buffer.from(chunk.subarray(start)));
			position += bytesRead;
		}
	} finally {
		closeSync(fd);
	}
	if (pending.length === 0) return { missingFinalNewline: false };
	const line = Buffer.concat(pending);
	onLine(line.toString("utf8"), lineStart, line.length);
	return { missingFinalNewline: true };
}
