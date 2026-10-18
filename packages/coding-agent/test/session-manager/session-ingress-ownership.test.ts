import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { detachedSessionView, type FileEntry, SessionManager } from "../../src/core/session-manager.ts";
import { appendReceivedCustomMessage, appendReceivedMessage } from "../../src/core/session-turn-appender.ts";
import { captureKeyboardTurnReceipt } from "../../src/core/turn-receipts.ts";

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

// smarty-dev#14576 P2-1: ingress, not the first observer read, is the ownership boundary.
it.each(["collections", "typed-array", "accessor", "serializer", "class"])(
	"owns %s values at append before caller mutation",
	(kind) => {
		dir = mkdtempSync(join(tmpdir(), "pi-ingress-"));
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "flush", timestamp: 1 });
		const values = [1];
		const map = new Map([["a", values]]);
		const set = new Set([values]);
		Object.defineProperty(map, "toJSON", { value: () => [...map] });
		Object.defineProperty(set, "toJSON", { value: () => [...set] });
		const bytes = new Uint8Array([1, 255]);
		class Payload {
			values = values;
			toJSON() {
				return { values: this.values };
			}
		}
		const data = {
			collections: { map, set, values },
			"typed-array": { bytes, values },
			accessor: {
				get values() {
					return values;
				},
			},
			serializer: {
				toJSON(key: string) {
					return { key, values };
				},
			},
			class: new Payload(),
		}[kind]!;
		const id = manager.appendCustomEntry(kind, data);
		const disk = readFileSync(manager.getSessionFile()!);
		const expected = JSON.parse(disk.toString().trim().split("\n").at(-1)!);
		// Mutate before ANY detached read; no lazy read-time clone can repair ownership.
		values.push(2);
		map.set("b", [2]);
		set.add([2]);
		bytes[0] = 99;
		expect(Object.isFrozen(data)).toBe(false);
		expect(Object.isFrozen(values)).toBe(false);
		const view = detachedSessionView(manager);
		for (const entry of [
			view.getEntry(id),
			view.getEntries().at(-1),
			view.buildSessionProjection().entries.at(-1)?.sourceEntry,
		]) {
			expect(entry).toEqual(expected);
		}
		expect(readFileSync(manager.getSessionFile()!)).toEqual(disk);
	},
);

it("owns imported exceptional entries before sealing without retaining caller objects", () => {
	const values = [1];
	const entry: FileEntry = {
		type: "custom",
		id: "import",
		parentId: null,
		timestamp: "t",
		customType: "import",
		data: {
			bytes: new Uint8Array([1]),
			map: new Map([["a", values]]),
			get values() {
				return values;
			},
		},
	};
	const expected = JSON.parse(JSON.stringify(entry));
	const manager = SessionManager.inMemory("/synthetic", undefined, [entry]);
	values.push(2);
	if (entry.type !== "custom") throw new Error("missing import");
	(entry.data as { bytes: Uint8Array }).bytes[0] = 99;
	expect(detachedSessionView(manager).getEntry("import")).toEqual({ ...expected, provenance: undefined });
	expect(Object.isFrozen(entry)).toBe(false);
	expect(Object.isFrozen(values)).toBe(false);
});

it.each(["message", "custom-message"])("owns exceptional keyboard %s input without freezing the caller", (kind) => {
	const manager = SessionManager.inMemory();
	const receipt = captureKeyboardTurnReceipt("paul", "a".repeat(32), "2026-10-18T00:00:00.000Z");
	const content = [{ type: "text" as const, text: "original" }];
	const details = { values: new Uint8Array([1]) };
	const message = { role: "custom" as const, customType: "keyboard", content, display: true, details, timestamp: 1 };
	const id =
		kind === "message"
			? appendReceivedMessage(manager, message, receipt)
			: appendReceivedCustomMessage(manager, "keyboard", content, true, details, receipt);
	expect(Object.isFrozen(message)).toBe(false);
	expect(Object.isFrozen(content)).toBe(false);
	expect(Object.isFrozen(content[0])).toBe(false);
	content[0].text = "caller edit";
	details.values[0] = 99;
	const entry = detachedSessionView(manager).getEntry(id);
	if (entry?.type === "message" && entry.message.role === "custom") {
		expect(entry.message.content).toEqual([{ type: "text", text: "original" }]);
		expect(entry.message.details).toEqual({ values: { "0": 1 } });
	} else if (entry?.type === "custom_message") {
		expect(entry.content).toEqual([{ type: "text", text: "original" }]);
		expect(entry.details).toEqual({ values: { "0": 1 } });
	} else throw new Error("missing keyboard entry");
});

it("owns cyclic and BigInt in-memory graphs while retaining their non-JSON read errors", () => {
	const manager = SessionManager.inMemory();
	const data: { values: number[]; self?: unknown; big: bigint } = { values: [1], big: 1n };
	data.self = data;
	const id = manager.appendCustomEntry("non-json", data);
	data.values.push(2);
	const entry = manager.getEntry(id);
	if (entry?.type !== "custom") throw new Error("missing entry");
	const owned = entry.data as typeof data;
	expect(owned).not.toBe(data);
	expect(owned.values).toEqual([1]);
	expect(owned.self).toBe(owned);
	expect(owned.big).toBe(1n);
	expect(() => detachedSessionView(manager).getEntry(id)).toThrow(TypeError);
});

it("owns shared typed-array backing bytes even in non-JSON graphs", () => {
	const manager = SessionManager.inMemory();
	const data: { bytes: Uint8Array; self?: unknown } = { bytes: new Uint8Array(new SharedArrayBuffer(1)) };
	data.bytes[0] = 1;
	data.self = data;
	const id = manager.appendCustomEntry("shared", data);
	data.bytes[0] = 99;
	const entry = manager.getEntry(id);
	if (entry?.type !== "custom") throw new Error("missing entry");
	const owned = entry.data as typeof data;
	expect(owned.bytes[0]).toBe(1);
	expect(owned.bytes.buffer).not.toBe(data.bytes.buffer);
	expect(owned.bytes.buffer).toBeInstanceOf(ArrayBuffer);
	expect(owned.self).toBe(owned);
	expect(Object.isFrozen(data)).toBe(false);
});

it("owns native Map, Set, Date and typed-array state without JSON-normalizing it", () => {
	const manager = SessionManager.inMemory();
	const values = [1];
	const data = {
		map: new Map([["a", values]]),
		set: new Set([values]),
		date: new Date(0),
		bytes: new Uint8Array([1]),
	};
	const id = manager.appendCustomEntry("native", data);
	data.map.set("b", [2]);
	data.set.add([2]);
	data.date.setTime(99);
	data.bytes[0] = 99;
	values.push(2);
	const entry = manager.getEntry(id);
	if (entry?.type !== "custom") throw new Error("missing native entry");
	const owned = entry.data as typeof data;
	expect(owned.map).toEqual(new Map([["a", [1]]]));
	expect(owned.set).toEqual(new Set([[1]]));
	expect(owned.date).toEqual(new Date(0));
	expect(owned.bytes).toEqual(new Uint8Array([1]));
	expect(owned.map.get("a")).not.toBe(values);
	const view = detachedSessionView(manager);
	const first = view.buildSessionProjection();
	// Detached exceptional payloads are copies, not metadata-only cache candidates.
	expect(view.buildSessionProjection()).not.toBe(first);
	expect(view.getEntry(id)).toMatchObject({
		data: { map: {}, set: {}, date: new Date(0).toISOString(), bytes: { "0": 1 } },
	});
});

it("rejects unownable serializer closures clearly without appending", () => {
	const manager = SessionManager.inMemory();
	const data = {
		toJSON() {
			throw new Error("serializer failure");
		},
	};
	expect(() => manager.appendCustomEntry("unownable", data)).toThrow(/Cannot own session entry/);
	expect(manager.getEntryCount()).toBe(0);
	expect(Object.isFrozen(data)).toBe(false);
});
