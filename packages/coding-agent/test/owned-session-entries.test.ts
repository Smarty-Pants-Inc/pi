import { describe, expect, test } from "vitest";
import { materializeOwnedEntry, parseOwnedSessionEntries } from "../src/core/owned-session-entries.ts";
import type { CustomEntry, SessionHeader } from "../src/core/session-manager.ts";

const header: SessionHeader = {
	type: "session",
	version: 3,
	id: "0194d937-18c0-7000-8000-000000000001",
	timestamp: "2026-09-14T00:00:00.000Z",
	cwd: "/synthetic",
};

function custom(data: unknown): CustomEntry {
	return { type: "custom", id: "e1", parentId: null, timestamp: header.timestamp, customType: "synthetic", data };
}

function journal(...entries: unknown[]): Buffer {
	return Buffer.from(`${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

describe("owned native materialization", () => {
	test("detaches the complete persisted graph before caller mutation", () => {
		const supplied = custom({ values: [{ name: "before", body: [1, 2, 3] }] });
		const selected = materializeOwnedEntry(supplied);
		expect(selected).toEqual(supplied);
		expect(selected).not.toBe(supplied);
		expect(selected.data).not.toBe(supplied.data);
		const suppliedData = supplied.data as { values: Array<{ name: string; body: number[] }> };
		suppliedData.values[0].name = "after";
		suppliedData.values[0].body.push(4);
		expect(selected.data).toEqual({ values: [{ name: "before", body: [1, 2, 3] }] });
	});

	test("normalizes only absent optional native fields", () => {
		expect(materializeOwnedEntry({ ...header, parentSession: undefined })).toEqual(header);
		expect(materializeOwnedEntry(custom(undefined))).not.toHaveProperty("data");
		expect(() => materializeOwnedEntry(custom({ nested: undefined }))).toThrow("OWNER_ENTRY_NOT_JSON");
	});

	test.each(
		[
			NaN,
			Infinity,
			1n,
			Symbol("value"),
			new Date(0),
			new Map(),
			new Set(),
			new Uint8Array(1),
			Object.assign(new Array(3), { 0: 1, 2: 3 }),
		].map((value) => ({ value })),
	)("rejects non-JSON data %s", ({ value }) =>
		expect(() => materializeOwnedEntry(custom(value))).toThrow("OWNER_ENTRY_NOT_JSON"),
	);

	test("does not call accessors or toJSON while validating", () => {
		let called = 0;
		const accessor = Object.defineProperty({}, "secret", {
			enumerable: true,
			get: () => {
				called++;
				return "bad";
			},
		});
		expect(() => materializeOwnedEntry(custom(accessor))).toThrow("OWNER_ENTRY_NOT_JSON");
		expect(() =>
			materializeOwnedEntry(
				custom({
					toJSON() {
						called++;
						return "bad";
					},
				}),
			),
		).toThrow("OWNER_ENTRY_NOT_JSON");
		const entry = Object.defineProperty(custom(null), "data", {
			enumerable: true,
			get: () => {
				called++;
				return null;
			},
		});
		expect(() => materializeOwnedEntry(entry)).toThrow("OWNER_ENTRY_ACCESSOR");
		expect(called).toBe(0);
	});

	test("rejects cycles and excessive depth", () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(() => materializeOwnedEntry(custom(cycle))).toThrow("OWNER_ENTRY_NOT_JSON");
		let deep: unknown = null;
		for (let i = 0; i < 600; i++) deep = { child: deep };
		expect(() => materializeOwnedEntry(custom(deep))).toThrow("OWNER_ENTRY_NOT_JSON");
	});
});

describe("strict owned native open", () => {
	test("loads a control-only journal without inventing an assistant", () => {
		const entry = custom({ revision: 1 });
		expect(parseOwnedSessionEntries(journal(entry), header.id)).toEqual([header, entry]);
	});

	test("refuses incomplete tails, skipped records, and malformed UTF-8", () => {
		const bytes = journal(custom({ revision: 1 }));
		expect(() => parseOwnedSessionEntries(bytes.subarray(0, -1), header.id)).toThrow("OWNER_JOURNAL_PARTIAL_TAIL");
		expect(() => parseOwnedSessionEntries(Buffer.concat([bytes, Buffer.from("not-json\n")]), header.id)).toThrow(
			"OWNER_JOURNAL_SKIPPED_LINE",
		);
		expect(() => parseOwnedSessionEntries(Buffer.concat([bytes, Buffer.from([0xff, 0x0a])]), header.id)).toThrow();
		expect(() => parseOwnedSessionEntries(Buffer.concat([bytes, Buffer.from("\n")]), header.id)).toThrow(
			"OWNER_JOURNAL_SKIPPED_LINE",
		);
	});

	test("refuses duplicate JSON keys and a byte-order mark instead of normalizing them", () => {
		const duplicate = Buffer.from(`${JSON.stringify(header).slice(0, -1)},"id":"${header.id}"}\n`);
		expect(() => parseOwnedSessionEntries(duplicate, header.id)).toThrow("OWNER_JOURNAL_ENCODING");
		expect(() =>
			parseOwnedSessionEntries(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), journal()]), header.id),
		).toThrow("OWNER_JOURNAL_ENCODING");
	});

	test("refuses a different identity, old versions, duplicate IDs and missing parents", () => {
		expect(() => parseOwnedSessionEntries(journal(), "other")).toThrow("OWNER_JOURNAL_HEADER");
		const old = Buffer.from(`${JSON.stringify({ ...header, version: 2 })}\n`);
		expect(() => parseOwnedSessionEntries(old, header.id)).toThrow("OWNER_JOURNAL_HEADER");
		expect(() => parseOwnedSessionEntries(journal(custom(null), custom(null)), header.id)).toThrow(
			"OWNER_JOURNAL_ENTRY",
		);
		expect(() => parseOwnedSessionEntries(journal({ ...custom(null), parentId: "missing" }), header.id)).toThrow(
			"OWNER_JOURNAL_ENTRY",
		);
	});

	test("refuses a second header and dangling compaction or label references", () => {
		expect(() => parseOwnedSessionEntries(journal(header), header.id)).toThrow("OWNER_JOURNAL_ENTRY");
		const base = { id: "e1", parentId: null, timestamp: header.timestamp };
		expect(() =>
			parseOwnedSessionEntries(
				journal({ ...base, type: "compaction", summary: "s", firstKeptEntryId: "missing", tokensBefore: 1 }),
				header.id,
			),
		).toThrow("OWNER_JOURNAL_COMPACTION");
		expect(() =>
			parseOwnedSessionEntries(journal({ ...base, type: "label", targetId: "missing", label: "l" }), header.id),
		).toThrow("OWNER_JOURNAL_LABEL");
	});
});
