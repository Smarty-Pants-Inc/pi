import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { createHarness } from "./suite/harness.ts";

class KeyedMetadata {
	value = "original";
	toJSON(key: string) {
		return { key, value: this.value };
	}
}

// The subclass deliberately inherits its serializer rather than owning toJSON.
class InheritedMetadata extends KeyedMetadata {}

class ArrayMetadata extends Array<unknown> {
	toJSON(key: string) {
		return { key, items: [...this] };
	}
}

const cases = [
	{
		name: "plain serializer relocating a key-sensitive child",
		create: () => {
			const child = new InheritedMetadata();
			const value = {
				x: child,
				toJSON() {
					return { y: this.x };
				},
			};
			return {
				value,
				expected: () => ({ y: { key: "y", value: "original" } }),
				mutate: () => {
					child.value = "changed";
				},
			};
		},
	},
	{
		name: "array serializer",
		create: () => {
			const value = new ArrayMetadata();
			value.push(1, 2);
			return {
				value,
				expected: (key: string) => ({ key, items: [1, 2] }),
				mutate: () => {
					value.push(3);
				},
			};
		},
	},
	{
		name: "Buffer",
		create: () => {
			const value = Buffer.from([1, 2, 3]);
			return { value, expected: () => ({ type: "Buffer", data: [1, 2, 3] }), mutate: () => value.fill(9) };
		},
	},
	{
		name: "URL",
		create: () => {
			const value = new URL("https://example.invalid/original");
			return {
				value,
				expected: () => "https://example.invalid/original",
				mutate: () => {
					value.pathname = "/changed";
				},
			};
		},
	},
	{
		name: "Date",
		create: () => {
			const value = new Date("2026-09-30T12:00:00.000Z");
			return { value, expected: () => "2026-09-30T12:00:00.000Z", mutate: () => value.setUTCFullYear(2000) };
		},
	},
	{
		name: "inherited key-sensitive toJSON",
		create: () => {
			const value = new InheritedMetadata();
			return {
				value,
				expected: (key: string) => ({ key, value: "original" }),
				mutate: () => {
					value.value = "changed";
				},
			};
		},
	},
	{
		name: "nested and array key-sensitive toJSON",
		create: () => {
			const nested = new InheritedMetadata();
			const item = new InheritedMetadata();
			const value = { nested, items: [item] };
			return {
				value,
				expected: () => ({
					nested: { key: "nested", value: "original" },
					items: [{ key: "0", value: "original" }],
				}),
				mutate: () => {
					nested.value = "changed";
					item.value = "changed";
					value.items.push(new InheritedMetadata());
				},
			};
		},
	},
];

function metadata(entry: SessionEntry | undefined): unknown {
	if (entry?.type === "custom") return entry.data;
	if (entry?.type === "custom_message") return entry.details;
	throw new Error("Missing custom entry");
}

describe("pi#95 R3 ordinary storage data preservation", () => {
	for (const field of ["data", "details"] as const) {
		for (const testCase of cases) {
			// pi#95: detach caller metadata without changing its ordinary JSON serialization.
			it(`${field}: preserves ${testCase.name} in live snapshots, JSONL, and reopened sessions`, async () => {
				const harness = await createHarness({ persistSession: true });
				try {
					const manager = harness.sessionManager;
					const input = testCase.create();
					const expected = input.expected(field);
					const id =
						field === "data"
							? manager.appendCustomEntry("storage-preservation", input.value)
							: manager.appendCustomMessageEntry("storage-preservation", "custom content", false, input.value);
					const snapshot = manager.getEntries().find((entry) => entry.id === id);
					expect(metadata(snapshot)).toEqual(expected);
					input.mutate();
					expect(metadata(snapshot)).toEqual(expected);
					expect(metadata(manager.getEntry(id))).toEqual(expected);
					expect(metadata(manager.getBranch().find((entry) => entry.id === id))).toEqual(expected);
					// Only an assistant entry is needed to flush the ordinary JSONL session.
					manager.appendMessage(fauxAssistantMessage("flush"));
					const file = manager.getSessionFile()!;
					const persisted = readFileSync(file, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line) as SessionEntry);
					expect(metadata(persisted.find((entry) => entry.id === id))).toEqual(expected);
					const reopened = SessionManager.open(file, harness.tempDir);
					expect(metadata(reopened.getEntry(id))).toEqual(expected);
					expect(metadata(reopened.getEntries().find((entry) => entry.id === id))).toEqual(expected);
					expect(metadata(reopened.getBranch().find((entry) => entry.id === id))).toEqual(expected);
					expect(metadata(manager.getEntry(id))).toEqual(expected);
				} finally {
					harness.cleanup();
				}
			});
		}
	}
});
