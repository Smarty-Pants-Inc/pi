import { createHash } from "node:crypto";

/** Native serializer coordinates, not a B5 delivery or logical-input identity. */
export interface NativeEntryLocation {
	file: string;
	offset: number;
	/** UTF-8 JSON bytes, excluding the terminating LF. */
	length: number;
}

/** Owned proof comes from a successful nonempty native commit OR a current native
 * recovery-prefix flush. Custody verification/readback alone cannot issue it.
 * Registration after persistenceReleased remains correlation, not B6 durability. */
export type NativeFlushReceipt =
	| { kind: "file-fsync"; file: string; bytesThrough: number; namespaceDurable: true }
	| { kind: "owned-journal-commit"; file: string; bytes: number; sha256: string };

export interface NativeRecoveryAppend {
	sessionId: string;
	entryId: string;
	location: NativeEntryLocation;
	/** Detached exact native JSON plus LF. */
	bytes: Uint8Array;
	bytesSha256: string;
	flushReceipt: NativeFlushReceipt;
}

/** Inspection is not commit proof, including a complete final object without LF. */
export interface NativeRecoveryCandidate {
	entryId: string;
	location: NativeEntryLocation;
	bytes: Uint8Array;
	terminated: boolean;
}

export interface NativeRecoveryScan {
	sessionId: string;
	file: string;
	bytes: number;
	entries: NativeRecoveryCandidate[];
	/** Exact unclassified ranges remain retained in the native file. */
	issues: Array<{
		location: NativeEntryLocation;
		bytes: Uint8Array;
		reason: "invalid-header" | "invalid-entry" | "duplicate-entry" | "missing-final-lf" | "commit-unproven";
	}>;
}

const persistenceScopes = new WeakMap<object, number>();
const entryTypes = new Set([
	"message",
	"thinking_level_change",
	"model_change",
	"usage",
	"compaction",
	"branch_summary",
	"custom",
	"custom_message",
	"context_edit",
	"label",
	"session_info",
]);

/** Native scope tracking only; never invokes an extension or an append drain. */
export async function withSessionPersistenceScope<T>(manager: object, action: () => T | Promise<T>): Promise<T> {
	persistenceScopes.set(manager, (persistenceScopes.get(manager) ?? 0) + 1);
	try {
		return await action();
	} finally {
		const remaining = persistenceScopes.get(manager)! - 1;
		if (remaining) persistenceScopes.set(manager, remaining);
		else persistenceScopes.delete(manager);
	}
}

export function assertSessionPersistenceReleased(manager: object): void {
	if (persistenceScopes.has(manager)) throw new Error("RECOVERY_PERSISTENCE_NOT_RELEASED");
}

/** Byte-oriented full-domain inspection: never uses the loader's skip-malformed view. */
export function inspectNativeRecoveryBytes(sessionId: string, file: string, bytes: Buffer): NativeRecoveryScan {
	const result: NativeRecoveryScan = { sessionId, file, bytes: bytes.length, entries: [], issues: [] };
	const ids = new Set<string>();
	let offset = 0;
	let header = false;
	while (offset < bytes.length) {
		const lf = bytes.indexOf(10, offset);
		const end = lf < 0 ? bytes.length : lf;
		const raw = bytes.subarray(offset, end);
		const location = { file, offset, length: raw.length };
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
		} catch {
			value = undefined;
		}
		const record = value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
		if (offset === 0) {
			header =
				!!record &&
				"type" in record &&
				record.type === "session" &&
				"id" in record &&
				record.id === sessionId &&
				"version" in record &&
				record.version === 3 &&
				"timestamp" in record &&
				typeof record.timestamp === "string" &&
				"cwd" in record &&
				typeof record.cwd === "string";
			if (!header) result.issues.push({ location, bytes: Uint8Array.from(raw), reason: "invalid-header" });
		} else if (
			!header ||
			!record ||
			!("type" in record) ||
			typeof record.type !== "string" ||
			!entryTypes.has(record.type) ||
			!("id" in record) ||
			typeof record.id !== "string" ||
			!record.id ||
			!("parentId" in record) ||
			(record.parentId !== null && (typeof record.parentId !== "string" || !ids.has(record.parentId))) ||
			!("timestamp" in record) ||
			typeof record.timestamp !== "string"
		) {
			result.issues.push({ location, bytes: Uint8Array.from(raw), reason: "invalid-entry" });
		} else {
			if (ids.has(record.id))
				result.issues.push({ location, bytes: Uint8Array.from(raw), reason: "duplicate-entry" });
			ids.add(record.id);
			result.entries.push({
				entryId: record.id,
				location,
				bytes: Uint8Array.from(bytes.subarray(offset, lf < 0 ? end : end + 1)),
				terminated: lf >= 0,
			});
		}
		if (lf < 0) result.issues.push({ location, bytes: Uint8Array.from(raw), reason: "missing-final-lf" });
		offset = end + 1;
	}
	if (!bytes.length)
		result.issues.push({
			location: { file, offset: 0, length: 0 },
			bytes: new Uint8Array(),
			reason: "invalid-header",
		});
	return result;
}

/** Copies every mutable boundary value before publication. */
export function nativeRecoveryAppend(
	sessionId: string,
	entryId: string,
	location: NativeEntryLocation,
	bytes: Uint8Array,
	flushReceipt: NativeFlushReceipt,
): NativeRecoveryAppend {
	if (bytes.length !== location.length + 1 || bytes[bytes.length - 1] !== 10)
		throw new Error("RECOVERY_ENTRY_FRAMING");
	const through = location.offset + bytes.length;
	const covered = flushReceipt.kind === "file-fsync" ? flushReceipt.bytesThrough : flushReceipt.bytes;
	if (
		location.file !== flushReceipt.file ||
		!Number.isSafeInteger(location.offset) ||
		location.offset < 0 ||
		!Number.isSafeInteger(location.length) ||
		location.length < 0 ||
		!Number.isSafeInteger(through) ||
		!Number.isSafeInteger(covered) ||
		covered < through ||
		(flushReceipt.kind === "owned-journal-commit"
			? !/^[0-9a-f]{64}$/.test(flushReceipt.sha256)
			: flushReceipt.namespaceDurable !== true)
	)
		throw new Error("RECOVERY_RECEIPT_COVERAGE");
	return {
		sessionId,
		entryId,
		location: { ...location },
		bytes: Uint8Array.from(bytes),
		bytesSha256: createHash("sha256").update(bytes).digest("hex"),
		flushReceipt: { ...flushReceipt },
	};
}
