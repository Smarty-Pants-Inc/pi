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
import { resolvePath } from "../utils/paths.ts";
import {
	assertExportFileSize,
	assertMaterializedExportSize,
	MAX_MATERIALIZED_EXPORT_BYTES,
	prepareExportValueForJson,
} from "./export-limits.ts";
import { CURRENT_SESSION_VERSION, type SessionHeader, type SessionManager } from "./session-manager.ts";

type TrailingEntries = (parentId: string | null, timestamp: string) => readonly object[];

function serializeEntry(entry: object, format: string, limit = MAX_MATERIALIZED_EXPORT_BYTES): string {
	const serialized = JSON.stringify(prepareExportValueForJson(entry, format, limit));
	if (typeof serialized !== "string") throw new Error("Session entry did not serialize to JSON");
	return serialized;
}

/** Walk single-entry reads rather than cloning the entire owned branch payload. */
function* sessionBranchEntries(
	sessionManager: SessionManager,
	createTrailingEntries?: TrailingEntries,
): Generator<object> {
	const timestamp = new Date().toISOString();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionManager.getSessionId(),
		timestamp,
		cwd: sessionManager.getCwd(),
	};
	yield header;
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
		id = entry.parentId;
	}
	let parentId: string | null = null;
	for (let i = ids.length - 1; i >= 0; i--) {
		const entry = sessionManager.getEntry(ids[i]);
		if (!entry) throw new Error("Session branch changed during export");
		yield { ...entry, parentId };
		parentId = entry.id;
	}
	yield* createTrailingEntries?.(parentId, timestamp) ?? [];
}

/** Serialize a bounded current branch and optional export-only entries as JSONL. */
export function serializeSessionBranch(
	sessionManager: SessionManager,
	createTrailingEntries?: TrailingEntries,
): string {
	assertMaterializedExportSize(sessionManager.getSessionFile(), sessionManager.getEntryCount(), "String JSONL");
	const lines: string[] = [];
	let remaining = MAX_MATERIALIZED_EXPORT_BYTES;
	for (const entry of sessionBranchEntries(sessionManager, createTrailingEntries)) {
		const line = `${serializeEntry(entry, "String JSONL", remaining)}\n`;
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
		for (const entry of sessionBranchEntries(sessionManager, createTrailingEntries)) {
			const line = Buffer.from(`${serializeEntry(entry, "JSONL entry")}\n`);
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
