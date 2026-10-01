// pi#95 R4: admission must snapshot caller behavior before receipt selection or branch mutation.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { getTurnProvenance } from "../src/core/turn-provenance.ts";

type Field = "data" | "details";
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-95-r4-residuals-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function append(manager: SessionManager, field: Field, value: unknown): string {
	return field === "data"
		? manager.appendCustomEntry("residual", value)
		: manager.appendCustomMessageEntry("residual", "content", false, value);
}

function metadata(entry: SessionEntry): unknown {
	if (entry.type === "custom") return entry.data;
	if (entry.type === "custom_message") return entry.details;
	throw new Error("Missing metadata entry");
}

function persisted(manager: SessionManager, id: string): SessionEntry {
	return readFileSync(manager.getSessionFile()!, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as SessionEntry)
		.find((entry) => entry.id === id)!;
}

function verifyMetadata(manager: SessionManager, id: string, expected: unknown): void {
	expect.soft(metadata(manager.getEntry(id)!)).toEqual(expected);
	manager.appendMessage(fauxAssistantMessage("explicit JSONL flush"));
	expect.soft(metadata(persisted(manager, id))).toEqual(expected);
	const reopened = SessionManager.open(manager.getSessionFile()!, dir);
	expect.soft(metadata(reopened.getEntry(id)!)).toEqual(expected);
}

describe("pi#95 R4 admission residuals", () => {
	for (const initial of ["assistant", "custom"] as const) {
		it(`${initial} role getter cannot turn into an unreceipted user during admission`, () => {
			const manager = SessionManager.create(dir, dir);
			let reads = 0;
			const input = {
				...fauxAssistantMessage("initial content"),
				customType: "residual",
				display: false,
				get role() {
					return ++reads <= 2 ? initial : "user";
				},
			} as AssistantMessage;
			const id = manager.appendMessage(input);
			manager.appendMessage(fauxAssistantMessage("explicit JSONL flush"));
			const reopened = SessionManager.open(manager.getSessionFile()!, dir);
			for (const entry of [manager.getEntry(id)!, persisted(manager, id), reopened.getEntry(id)!]) {
				expect.soft(entry.type === "message" && entry.message.role).toBe(initial);
				if (initial === "custom") expect.soft(getTurnProvenance(entry)?.channel).toBe("terminal");
			}
			expect(reads).toBe(1);
		});
	}

	it("user receipt and full frozen message snapshot precede subsequent caller reads", () => {
		const manager = SessionManager.create(dir, dir);
		let reads = 0;
		const details = {
			value: "original",
			toJSON(key: string) {
				return { key, value: this.value };
			},
		};
		const input = Object.freeze({
			get role() {
				if (++reads > 1) throw new Error("role read twice");
				return "user" as const;
			},
			content: [{ type: "text" as const, text: "original" }],
			timestamp: 1,
			details,
		});
		const id = manager.appendMessage(input);
		input.content[0].text = "changed";
		details.value = "changed";
		manager.appendMessage(fauxAssistantMessage("explicit JSONL flush"));
		const reopened = SessionManager.open(manager.getSessionFile()!, dir);
		const receipt = getTurnProvenance(manager.getEntry(id)!);
		expect(receipt?.channel).toBe("terminal");
		expect(Object.isFrozen(receipt)).toBe(true);
		for (const entry of [manager.getEntry(id)!, persisted(manager, id), reopened.getEntry(id)!]) {
			expect(getTurnProvenance(entry)).toEqual(receipt);
			if (entry.type !== "message" || entry.message.role !== "user") throw new Error("Missing user message");
			expect(entry.message.content).toEqual([{ type: "text", text: "original" }]);
			expect(Reflect.get(entry.message, "details")).toEqual({ key: "details", value: "original" });
		}
		expect(reads).toBe(1);
	});

	for (const field of ["data", "details"] as const) {
		it(`${field}: function serializer is detached before caller backing state changes`, () => {
			const manager = SessionManager.create(dir, dir);
			const state = { value: "original" };
			const value = Object.assign(function metadataFunction() {}, {
				state,
				toJSON(key: string) {
					return { key, value: this.state.value };
				},
			});
			const expected = JSON.parse(JSON.stringify({ [field]: value }))[field];
			const id = append(manager, field, value);
			state.value = "changed";
			verifyMetadata(manager, id, expected);
		});

		it(`${field}: a function without a serializer keeps omitted object and null array JSON behavior`, () => {
			const manager = SessionManager.create(dir, dir);
			const value = { omitted() {}, items: [function omittedItem() {}] };
			const expected = JSON.parse(JSON.stringify(value));
			const id = append(manager, field, value);
			value.omitted = Object.assign(value.omitted, { toJSON: () => "late serializer" });
			value.items[0] = Object.assign(value.items[0], { toJSON: () => "late item" });
			// Compare JSON here: ordinary undefined object properties/array items may remain in live views.
			expect.soft(JSON.parse(JSON.stringify(metadata(manager.getEntry(id)!)))).toEqual(expected);
			manager.appendMessage(fauxAssistantMessage("explicit JSONL flush"));
			expect.soft(metadata(persisted(manager, id))).toEqual(expected);
			expect(metadata(SessionManager.open(manager.getSessionFile()!, dir).getEntry(id)!)).toEqual(expected);
		});

		for (const kind of ["object", "function"] as const) {
			it(`${field}: ${kind} toJSON getter is captured once with original this, relocation and key`, () => {
				const manager = SessionManager.create(dir, dir);
				let reads = 0;
				let calls = 0;
				let unexpectedRootCalls = 0;
				const child = {
					value: "original",
					toJSON(key: string) {
						return { key, value: this.value };
					},
				};
				const value = kind === "object" ? { child } : Object.assign(function serializerFunction() {}, { child });
				Object.defineProperty(value, "toJSON", {
					get() {
						if (++reads > 1) throw new Error("toJSON read twice");
						return function (this: typeof value, key: string) {
							calls++;
							expect(this).toBe(value);
							return {
								key,
								moved: this.child,
								toJSON() {
									unexpectedRootCalls++;
									throw new Error("serializer result serialized twice");
								},
							};
						};
					},
				});
				const id = append(manager, field, value);
				child.value = "changed";
				verifyMetadata(manager, id, { key: field, moved: { key: "moved", value: "original" } });
				expect(reads).toBe(1);
				expect(calls).toBe(1);
				expect(unexpectedRootCalls).toBe(0);
			});
		}
	}

	for (const target of ["earlier entry", "root"] as const) {
		it(`rejected summary to ${target} leaves branch, index, revision, file and next parent unchanged`, () => {
			const manager = SessionManager.create(dir, dir);
			const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
			const leaf = manager.appendMessage(fauxAssistantMessage("flush existing branch"));
			const file = manager.getSessionFile()!;
			const beforeBytes = readFileSync(file, "utf8");
			const beforeEntries = manager.getEntries();
			const beforeBranch = manager.getBranch();
			const revision = manager.revision();
			const failure = new Error("rejected summary details");
			expect(() =>
				manager.branchWithSummary(target === "root" ? null : root, "rejected", {
					get payload() {
						throw failure;
					},
				}),
			).toThrow(failure);
			expect.soft(manager.getLeafId()).toBe(leaf);
			expect.soft(manager.getBranch()).toEqual(beforeBranch);
			expect.soft(manager.getEntries()).toEqual(beforeEntries);
			expect.soft(manager.revision()).toBe(revision);
			expect.soft(readFileSync(file, "utf8")).toBe(beforeBytes);
			const next = manager.appendCustomEntry("after rejection", 1);
			const reopened = SessionManager.open(file, dir);
			for (const entry of [manager.getEntry(next)!, persisted(manager, next), reopened.getEntry(next)!]) {
				expect.soft(entry.parentId).toBe(leaf);
			}
			expect(reopened.getEntries()).toHaveLength(beforeEntries.length + 1);
			const parentId = target === "root" ? null : root;
			const accepted = manager.branchWithSummary(parentId, "accepted", { value: "original" });
			const reopenedAccepted = SessionManager.open(file, dir);
			for (const entry of [
				manager.getEntry(accepted)!,
				persisted(manager, accepted),
				reopenedAccepted.getEntry(accepted)!,
			]) {
				expect(entry.parentId).toBe(parentId);
				expect(entry.type === "branch_summary" && entry.fromId).toBe(next);
			}
			expect(manager.getLeafId()).toBe(accepted);
		});
	}
});
