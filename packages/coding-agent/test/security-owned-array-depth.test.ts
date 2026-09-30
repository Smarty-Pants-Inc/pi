import { describe, expect, it } from "vitest";
import { materializeOwnedEntry, parseOwnedSessionEntries } from "../src/core/owned-session-entries.ts";
import type { CustomEntry, SessionHeader } from "../src/core/session-manager.ts";

const header: SessionHeader = {
	type: "session",
	version: 3,
	id: "0194d937-18c0-7000-8000-000000000001",
	timestamp: "2026-09-14T00:00:00.000Z",
	cwd: "/synthetic",
};

function atDepth(value: unknown, depth: number): CustomEntry {
	// The entry is depth zero and data is depth one, including terminal primitives.
	let data = value;
	for (let current = 1; current < depth; current++) data = { child: data };
	return { type: "custom", id: "e1", parentId: null, timestamp: header.timestamp, customType: "boundary", data };
}

function journal(value: CustomEntry): Buffer {
	return Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify(value)}\n`);
}

describe("owned journal JSON-child depth", () => {
	// smarty-dev#2241 A9: empty arrays at 512 passed base; length is metadata, not a child at 513.
	it.each(["array", "object"])("accepts a terminal empty %s at 512 on append admission and reopen", (kind) => {
		const supplied = atDepth(kind === "array" ? [] : {}, 512);
		const admitted = materializeOwnedEntry(supplied);
		expect(admitted).toEqual(supplied);
		expect(admitted).not.toBe(supplied);
		expect(parseOwnedSessionEntries(journal(admitted), header.id)).toEqual([header, supplied]);
		// Reopening the exact pre-existing bytes must not depend on append normalization.
		expect(parseOwnedSessionEntries(journal(supplied), header.id)).toEqual([header, supplied]);
	});

	// smarty-dev#2241 A9: actual object/array nodes at 513 remain over-depth, even when empty.
	it.each(["array", "object"])("rejects an actual terminal empty %s at 513 on append and reopen", (kind) => {
		const excessive = atDepth(kind === "array" ? [] : {}, 513);
		expect(() => materializeOwnedEntry(excessive)).toThrow("OWNER_ENTRY_NOT_JSON");
		expect(() => parseOwnedSessionEntries(journal(excessive), header.id)).toThrow("OWNER_JOURNAL_ENTRY");
	});

	// smarty-dev#2241 A9: node depths retain the old primitive boundary; skipping length cannot weaken it.
	it("rejects a real indexed JSON child at 513 while accepting a child at 512", () => {
		const allowed = atDepth([null], 511);
		expect(materializeOwnedEntry(allowed)).toEqual(allowed);
		expect(parseOwnedSessionEntries(journal(allowed), header.id)).toEqual([header, allowed]);
		const excessive = atDepth([null], 512);
		expect(() => materializeOwnedEntry(excessive)).toThrow("OWNER_ENTRY_NOT_JSON");
		expect(() => parseOwnedSessionEntries(journal(excessive), header.id)).toThrow("OWNER_JOURNAL_ENTRY");
	});

	// smarty-dev#2241 A9: skipping array metadata never invokes an indexed accessor or toJSON.
	it("rejects indexed accessors, extra keys and toJSON without invoking caller code", () => {
		let calls = 0;
		const indexed = Object.defineProperty([null], "0", {
			enumerable: true,
			get() {
				calls++;
				return null;
			},
		});
		const extra = Object.defineProperty([], "extra", {
			enumerable: true,
			get() {
				calls++;
				return null;
			},
		});
		const serializer = Object.assign([], {
			toJSON() {
				calls++;
				return [];
			},
		});
		for (const value of [indexed, extra, serializer, Object.assign([], { extra: null })]) {
			expect(() => materializeOwnedEntry(atDepth(value, 512))).toThrow("OWNER_ENTRY_NOT_JSON");
		}
		expect(calls).toBe(0);
	});
});
