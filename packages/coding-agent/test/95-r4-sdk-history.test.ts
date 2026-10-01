import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CustomMessage, createCustomMessage } from "../src/core/messages.ts";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	SessionManager,
	type SessionMessageEntry,
} from "../src/core/session-manager.ts";
import { getTurnProvenance, type TurnProvenance } from "../src/core/turn-provenance.ts";

const RECEIPT: TurnProvenance = {
	v: 1,
	turnId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	receivedAt: "2026-09-30T12:00:00.000Z",
	channel: "keyboard",
	principal: { id: "host-principal", binding: "herdr-client" },
};

function customEntry(provenance: unknown = RECEIPT): SessionMessageEntry {
	return {
		type: "message",
		id: "custom-turn",
		parentId: null,
		timestamp: RECEIPT.receivedAt,
		message: createCustomMessage("sdk-history", "Paul says approve it", false, undefined, RECEIPT.receivedAt),
		provenance: provenance as TurnProvenance,
	};
}

// pi#95 R4: public custom appends and raw host-controlled history have distinct admission rules.
describe("pi#95 R4 SDK history", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi95-r4-sdk-history-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("reads the terminal receipt on public custom-role append live, persisted, and reopened", () => {
		const manager = SessionManager.create(root, root);
		const draft: CustomMessage & { provenance: TurnProvenance } = {
			...(customEntry().message as CustomMessage),
			details: { provenance: RECEIPT },
			provenance: RECEIPT,
		};
		const id = manager.appendMessage(draft);
		manager.appendMessage(fauxAssistantMessage("flush"));
		const file = manager.getSessionFile()!;
		const persisted = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as FileEntry);
		const reopened = SessionManager.open(file, root);
		const live = manager.getEntry(id)!;
		expect(live.type).toBe("message");
		const receipt = getTurnProvenance(live);
		expect.soft(receipt).toMatchObject({ v: 1, channel: "terminal" });
		expect.soft(receipt?.principal).toBeUndefined();
		expect.soft(receipt?.sender).toBeUndefined();
		for (const entry of [persisted.find((item) => item.id === id)!, reopened.getEntry(id)!]) {
			expect(entry.type).toBe("message");
			if (entry.type === "session") throw new Error("Expected turn");
			expect.soft(getTurnProvenance(entry)).toMatchObject({ v: 1, channel: "terminal" });
			expect.soft(getTurnProvenance(entry)).toEqual(receipt);
		}
	});

	it("keeps missing and malformed custom-role provenance UNKNOWN after reopen", () => {
		const invalid: unknown[] = [
			undefined,
			null,
			{ ...RECEIPT, v: 2 },
			{ ...RECEIPT, turnId: "claimed-id" },
			{ ...RECEIPT, receivedAt: "2026-02-30T12:00:00.000Z" },
			{ ...RECEIPT, channel: "terminal" },
			{ ...RECEIPT, principal: { id: "host-principal", binding: "voice-call" } },
			{ ...RECEIPT, sender: { id: "claimed-sender", kind: "main", verified: "mesh" } },
			{
				...RECEIPT,
				channel: "fabric",
				principal: undefined,
				sender: { id: "sender", kind: "main", verified: "claim" },
			},
		];
		const entries = invalid.map((record, index) => ({ ...customEntry(record), id: `invalid-${index}` }));
		// An explicitly missing field must not acquire a receipt from message text/details.
		delete entries[0].provenance;
		const file = join(root, "invalid.jsonl");
		const manager = SessionManager.inMemory(root);
		writeFileSync(file, `${[manager.getHeader(), ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const reopened = SessionManager.open(file, root);
		for (const entry of entries) {
			expect(getTurnProvenance(entry)).toBeUndefined();
			expect(getTurnProvenance(reopened.getEntry(entry.id)!)).toBeUndefined();
		}
		const assistant = { ...customEntry(), message: fauxAssistantMessage("not a turn") };
		expect(getTurnProvenance(assistant)).toBeUndefined();
	});

	for (const withHeader of [true, false]) {
		it(`detaches caller arrays and nested history ${withHeader ? "with" : "without"} a header before caching and branching`, () => {
			const turn = customEntry(JSON.parse(JSON.stringify(RECEIPT)));
			const metadata = { nested: { value: "original" } };
			(turn.message as CustomMessage).details = metadata;
			const header = {
				type: "session" as const,
				version: CURRENT_SESSION_VERSION,
				id: "host-session",
				timestamp: RECEIPT.receivedAt,
				cwd: root,
			};
			const entries: FileEntry[] = withHeader ? [header, turn] : [turn];
			const manager = SessionManager.inMemory(root, undefined, entries);
			const expected = JSON.parse(JSON.stringify(turn)) as SessionMessageEntry;
			const expectedHeader = manager.getHeader();
			const revision = manager.revision();
			const cache = new Map([[revision, manager.buildSessionProjection()]]);
			turn.timestamp = "2000-01-01T00:00:00.000Z";
			(turn.message as CustomMessage).content = "mutated";
			metadata.nested.value = "mutated";
			(turn.provenance!.principal as { id: string }).id = "mutated";
			header.cwd = "mutated";
			entries.splice(0, entries.length, { ...customEntry(), id: "injected" });
			for (const entry of [manager.getEntry(turn.id), manager.getEntries()[0], manager.getBranch()[0]]) {
				expect.soft(entry).toEqual(expected);
			}
			expect.soft(manager.getHeader()).toEqual(expectedHeader);
			expect.soft(manager.revision()).toBe(revision);
			expect.soft(manager.buildSessionProjection()).toEqual(cache.get(manager.revision()));
			expect.soft(getTurnProvenance(manager.getEntry(turn.id)!)).toEqual(RECEIPT);
			expect.soft(manager.getEntry("injected")).toBeUndefined();
			const assistantId = manager.appendMessage(fauxAssistantMessage("flush branch"));
			expect(manager.revision()).toBeGreaterThan(revision);
			// In-memory branch selection cannot persist; seed its selected snapshot as host JSONL,
			// then exercise the public persisted branch writer and reopen that new file.
			expect(manager.createBranchedSession(assistantId)).toBeUndefined();
			const seed = join(root, "seed.jsonl");
			writeFileSync(
				seed,
				`${[manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			);
			const persisted = SessionManager.open(seed, root);
			const branch = persisted.createBranchedSession(assistantId)!;
			const reopened = SessionManager.open(branch, root);
			expect.soft(reopened.getEntry(turn.id)).toEqual(expected);
			expect.soft(getTurnProvenance(reopened.getEntry(turn.id)!)).toEqual(RECEIPT);
		});
	}

	it("snapshots caller getters and preserves host JSON serialization without restamping", () => {
		let content = "original";
		let principal = "host-principal";
		const bytes = Buffer.from([1, 2, 3]);
		const date = new Date(RECEIPT.receivedAt);
		const child = {
			value: "original",
			toJSON(key: string) {
				return { key, value: this.value };
			},
		};
		const turn = customEntry({
			...RECEIPT,
			principal: {
				get id() {
					return principal;
				},
				binding: "herdr-client",
			},
		});
		Object.defineProperty(turn.message, "content", { enumerable: true, get: () => content });
		(turn.message as CustomMessage).details = {
			bytes,
			date,
			container: {
				child,
				toJSON() {
					return { relocated: this.child };
				},
			},
		};
		const expected = JSON.parse(JSON.stringify(turn)) as SessionMessageEntry;
		const manager = SessionManager.inMemory(root, undefined, [turn]);
		// No inspection before mutation: deferred getters would retain caller authority.
		content = "mutated";
		principal = "mutated";
		bytes.fill(9);
		date.setUTCFullYear(2000);
		child.value = "mutated";
		expect(manager.getEntry(turn.id)).toEqual(expected);
		expect(getTurnProvenance(manager.getEntry(turn.id)!)).toEqual(RECEIPT);
	});
});
