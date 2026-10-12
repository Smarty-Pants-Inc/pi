import { isJsonValue } from "@earendil-works/chord";
import { type FileEntry, parseSessionEntries, type SessionEntry, type SessionHeader } from "./session-manager.ts";

/** Only immutable reference facts are retained; never message payloads. */
export interface OwnedSessionEntryMetadata {
	readonly type: SessionEntry["type"];
	readonly role?: string;
}

export function ownedSessionEntryMetadata(entry: SessionEntry): OwnedSessionEntryMetadata {
	return Object.freeze({ type: entry.type, ...(entry.type === "message" ? { role: entry.message.role } : {}) });
}

const absentFields = new Set(["parentSession", "details", "usage", "fromHook", "data", "label", "name", "provenance"]);

/** Native optional fields may be absent; arbitrary nested non-JSON is rejected. */
export function materializeOwnedEntry<T extends FileEntry>(entry: T): T {
	if (Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) {
		throw new Error("OWNER_ENTRY_NOT_PLAIN");
	}
	const normalized: Record<string, unknown> = {};
	for (const key of Reflect.ownKeys(entry)) {
		if (typeof key !== "string") throw new Error("OWNER_ENTRY_SYMBOL");
		const property = Object.getOwnPropertyDescriptor(entry, key);
		if (!property?.enumerable || !("value" in property)) throw new Error("OWNER_ENTRY_ACCESSOR");
		if (property.value === undefined && absentFields.has(key)) continue;
		Object.defineProperty(normalized, key, { value: property.value, enumerable: true });
	}
	if (!isJsonValue(normalized)) throw new Error("OWNER_ENTRY_NOT_JSON");
	return JSON.parse(JSON.stringify(normalized)) as T;
}

/** No migration, skipped line, fabricated header or tail repair on an owned open. */
export function parseOwnedSessionEntries(bytes: Buffer, expectedSessionId: string): FileEntry[] {
	const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	if (bytes.length === 0 || !text.endsWith("\n")) throw new Error("OWNER_JOURNAL_PARTIAL_TAIL");
	const lines = text.slice(0, -1).split("\n");
	// Use the native parser, but refuse any line it would skip or repair.
	const values: unknown[] = parseSessionEntries(text);
	if (values.length !== lines.length) throw new Error("OWNER_JOURNAL_SKIPPED_LINE");
	if (values.some((entry, index) => JSON.stringify(entry) !== lines[index])) throw new Error("OWNER_JOURNAL_ENCODING");
	const header = validateOwnedSessionHeader(values[0], expectedSessionId);
	const entries: FileEntry[] = [header];
	const byId = new Map<string, OwnedSessionEntryMetadata>();
	for (const value of values.slice(1)) {
		const entry = validateOwnedSessionEntry(value, byId);
		byId.set(entry.id, ownedSessionEntryMetadata(entry));
		entries.push(entry);
	}
	return entries;
}

/** Validate once at bootstrap; later entries cannot replace the admitted header. */
export function validateOwnedSessionHeader(header: unknown, expectedSessionId: string): SessionHeader {
	if (
		!isJsonValue(header) ||
		header === null ||
		Array.isArray(header) ||
		typeof header !== "object" ||
		header.type !== "session" ||
		header.version !== 3 ||
		header.id !== expectedSessionId ||
		typeof header.cwd !== "string" ||
		typeof header.timestamp !== "string" ||
		(header.parentSession !== undefined && typeof header.parentSession !== "string")
	) {
		throw new Error("OWNER_JOURNAL_HEADER");
	}
	return header as unknown as SessionHeader;
}

/** Validate only the new entry against the already admitted prefix, without changing its index. */
export function validateOwnedSessionEntry(
	value: unknown,
	byId: ReadonlyMap<string, OwnedSessionEntryMetadata>,
): SessionEntry {
	if (
		!isJsonValue(value) ||
		value === null ||
		Array.isArray(value) ||
		typeof value !== "object" ||
		typeof value.id !== "string" ||
		value.id.length === 0 ||
		byId.has(value.id) ||
		typeof value.timestamp !== "string" ||
		(value.parentId !== null && (typeof value.parentId !== "string" || !byId.has(value.parentId)))
	) {
		throw new Error("OWNER_JOURNAL_ENTRY");
	}
	switch (value.type) {
		case "message":
			if (
				value.message === null ||
				typeof value.message !== "object" ||
				Array.isArray(value.message) ||
				typeof value.message.role !== "string"
			)
				throw new Error("OWNER_JOURNAL_MESSAGE");
			break;
		case "model_change":
			if (typeof value.provider !== "string" || typeof value.modelId !== "string")
				throw new Error("OWNER_JOURNAL_MODEL");
			break;
		case "thinking_level_change":
			if (typeof value.thinkingLevel !== "string") throw new Error("OWNER_JOURNAL_THINKING");
			break;
		case "compaction":
			if (
				typeof value.summary !== "string" ||
				typeof value.tokensBefore !== "number" ||
				typeof value.firstKeptEntryId !== "string" ||
				(value.firstKeptEntryId !== value.id && !byId.has(value.firstKeptEntryId))
			)
				throw new Error("OWNER_JOURNAL_COMPACTION");
			break;
		case "branch_summary":
			if (typeof value.summary !== "string" || typeof value.fromId !== "string")
				throw new Error("OWNER_JOURNAL_SUMMARY");
			break;
		case "custom":
			if (typeof value.customType !== "string") throw new Error("OWNER_JOURNAL_CUSTOM");
			break;
		case "custom_message":
			if (
				typeof value.customType !== "string" ||
				typeof value.display !== "boolean" ||
				(typeof value.content !== "string" && !Array.isArray(value.content))
			)
				throw new Error("OWNER_JOURNAL_CUSTOM_MESSAGE");
			break;
		case "context_edit": {
			const target = typeof value.targetId === "string" ? byId.get(value.targetId) : undefined;
			const replacement = value.replacement;
			if (
				!target ||
				!(
					target.type === "custom_message" ||
					(target.type === "message" &&
						target.role !== undefined &&
						["user", "assistant", "toolResult"].includes(target.role))
				) ||
				(replacement !== null &&
					(typeof replacement !== "object" ||
						Array.isArray(replacement) ||
						(typeof replacement.content !== "string" && !Array.isArray(replacement.content))))
			)
				throw new Error("OWNER_JOURNAL_CONTEXT_EDIT");
			break;
		}
		case "label":
			if (
				typeof value.targetId !== "string" ||
				!byId.has(value.targetId) ||
				(value.label !== undefined && typeof value.label !== "string")
			)
				throw new Error("OWNER_JOURNAL_LABEL");
			break;
		case "session_info":
			if (value.name !== undefined && typeof value.name !== "string") throw new Error("OWNER_JOURNAL_NAME");
			break;
		default:
			throw new Error("OWNER_JOURNAL_ENTRY_TYPE");
	}
	return value as unknown as SessionEntry;
}
