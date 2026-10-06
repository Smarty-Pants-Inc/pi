import { describe, expect, test, vi } from "vitest";
import { materializeOwnedEntry, parseOwnedSessionEntries } from "../src/core/owned-session-entries.ts";
import { OwnedJournal } from "../src/core/owner-effects.ts";
import {
	appendOwnedTerminalCustomMessage,
	appendOwnedTerminalMessage,
	type SessionHeader,
	SessionManager,
} from "../src/core/session-manager.ts";
import { getTurnProvenance } from "../src/core/turn-provenance.ts";
import { captureTerminalTurnReceipt, receiptRecord } from "../src/core/turn-receipts.ts";

// Storage/control-flow fixture only, not native custody, admission, or lifecycle qualification.
// SessionManager, owned materialization and strict JSONL reparsing are the actual implementations.
vi.mock("../src/core/owner-effects.ts", () => ({
	isOwnedTerminalWrite: (journal: { terminalWrite: boolean }) => journal.terminalWrite,
	OwnedJournal: class {
		file = "/synthetic/owned.jsonl";
		sessionId = "owned";
		initialHeader = {
			type: "session",
			version: 3,
			id: "owned",
			cwd: "/synthetic",
			timestamp: "2020-01-01T00:00:00.000Z",
		};
		bytes = Buffer.alloc(0);
		terminalWrite = false;
		wait: Promise<void> = Promise.resolve();
		static assertOriginal() {}
		assertActive() {}
		assertWritable() {}
		quarantine() {
			throw new Error("unexpected quarantine");
		}
		read() {
			return this.bytes;
		}
		commit(bytes: Buffer) {
			this.bytes = Buffer.from(bytes);
			return { bytes: bytes.length, sha256: "synthetic" };
		}
		async commitTerminalAsync(bytes: Buffer) {
			await this.wait;
			return this.commit(bytes);
		}
	},
}));
type JournalFixture = OwnedJournal & { bytes: Buffer; terminalWrite: boolean; wait: Promise<void> };
function journal(bytes?: Buffer): JournalFixture {
	const value = Reflect.construct(OwnedJournal, []) as JournalFixture;
	if (bytes) value.bytes = bytes;
	return value;
}

describe("owned receipt materialization and publication", () => {
	test("normalizes the reserved undefined slot but preserves strict refusal of accessors and nested non-JSON", () => {
		const m = SessionManager.inMemory();
		const id = m.appendCustomEntry("state");
		const e = { ...m.getEntry(id)! };
		expect(Object.hasOwn(e, "provenance")).toBe(true);
		expect(materializeOwnedEntry(e)).not.toHaveProperty("provenance");
		expect(() => materializeOwnedEntry({ ...e, data: { nested: undefined } })).toThrow("OWNER_ENTRY_NOT_JSON");
		expect(() =>
			materializeOwnedEntry(
				Object.defineProperty({ ...e }, "provenance", { enumerable: true, get: () => undefined }),
			),
		).toThrow("OWNER_ENTRY_ACCESSOR");
		expect(() =>
			materializeOwnedEntry(Object.defineProperty({ ...e }, "provenance", { enumerable: false, value: undefined })),
		).toThrow("OWNER_ENTRY_ACCESSOR");
	});

	test("active fallback invokes captured body once, retains receipt, and reparsed canonical entries are sealed", async () => {
		const j = journal();
		const m = SessionManager.openOwned("/synthetic", j);
		const receipt = captureTerminalTurnReceipt();
		m.appendMessage = () => {
			throw new Error("public fallback reached");
		};
		m.appendCustomMessageEntry = () => {
			throw new Error("public fallback reached");
		};
		const a = await appendOwnedTerminalMessage(m, { role: "user", content: "active", timestamp: 1 }, receipt);
		const b = await appendOwnedTerminalCustomMessage(m, "active", "active", true, undefined, receipt);
		expect(getTurnProvenance(m.getEntry(a))).toEqual(receiptRecord(receipt));
		expect(getTurnProvenance(m.getEntry(b))).toEqual(receiptRecord(receipt));
		// Owned reads detach; changing them never changes reparsed canonical storage.
		Reflect.set(m.getEntry(a)!, "provenance", { forged: true });
		expect(getTurnProvenance(m.getEntry(a))).toEqual(receiptRecord(receipt));
		const state = m.appendCustomEntry("state");
		expect(m.getEntry(state)).toHaveProperty("provenance", undefined);
		m.persistCurrent();
		const reopened = SessionManager.openOwned("/synthetic", journal(j.bytes));
		expect(getTurnProvenance(reopened.getEntry(a))).toEqual(receiptRecord(receipt));
		expect(JSON.parse(j.bytes.toString().trim().split("\n").at(-1)!)).not.toHaveProperty("provenance");
	});

	test("terminal queue captures fallback time before waits and preserves supplied occurrence handles", async () => {
		const j = journal();
		const m = SessionManager.openOwned("/synthetic", j);
		j.terminalWrite = true;
		let release!: () => void;
		j.wait = new Promise((resolve) => {
			release = resolve;
		});
		const receipt = captureTerminalTurnReceipt();
		const a = appendOwnedTerminalMessage(m, { role: "user", content: "held", timestamp: 1 }, receipt);
		const b = appendOwnedTerminalCustomMessage(m, "held", "held", false);
		const cutoff = Date.now();
		expect(m.getEntries()).toHaveLength(0);
		await new Promise((resolve) => setTimeout(resolve, 5));
		release();
		const [first, second] = await Promise.all([a, b]);
		expect(getTurnProvenance(m.getEntry(first))).toEqual(receiptRecord(receipt));
		expect(new Date(getTurnProvenance(m.getEntry(second))!.receivedAt).getTime()).toBeLessThanOrEqual(cutoff);
		expect(getTurnProvenance(m.getEntry(second))!.turnId).not.toBe(receiptRecord(receipt).turnId);
		expect(parseOwnedSessionEntries(j.bytes, j.sessionId).filter((e) => e.type !== "session")).toHaveLength(2);
	});

	test("strict owned reopen and selected scratch fork preserve malformed historical metadata and missing slots", () => {
		const h: SessionHeader = {
			type: "session",
			version: 3,
			id: "owned",
			cwd: "/synthetic",
			timestamp: "2020-01-01T00:00:00.000Z",
		};
		const raw = { v: 99, nested: [{ historical: true }] };
		const entries = [
			h,
			{
				type: "message",
				id: "old",
				parentId: null,
				timestamp: h.timestamp,
				message: { role: "user", content: "old", timestamp: 1 },
				provenance: raw,
			},
			{ type: "custom", id: "state", parentId: "old", timestamp: h.timestamp, customType: "state" },
		];
		const bytes = Buffer.from(`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
		const m = SessionManager.openOwned("/synthetic", journal(bytes));
		expect(Reflect.get(m.getEntry("old")!, "provenance")).toEqual(raw);
		expect(m.getEntry("state")).toHaveProperty("provenance", undefined);
		const childJournal = journal();
		Object.assign(childJournal, {
			sessionId: "child",
			file: "/synthetic/child.jsonl",
			initialHeader: { ...h, id: "child" },
		});
		const child = m.forkSelected("state", childJournal);
		expect(Reflect.get(child.getEntry("old")!, "provenance")).toEqual(raw);
		expect(JSON.parse(childJournal.bytes.toString().trim().split("\n").at(-1)!)).not.toHaveProperty("provenance");
	});
});
