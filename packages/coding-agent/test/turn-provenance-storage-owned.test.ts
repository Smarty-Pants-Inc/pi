import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { detachedSessionView, SessionManager } from "../src/core/session-manager.ts";
import { appendReceivedCustomMessage, appendReceivedMessage } from "../src/core/session-turn-appender.ts";
import { getTurnProvenance } from "../src/core/turn-provenance.ts";
import { captureTerminalTurnReceipt, receiptRecord } from "../src/core/turn-receipts.ts";

// pi#289 / pi#291: carry the publication regression on the candidate's surviving disk path.
// This proves owned payload isolation, not the removed OwnedJournal/native custody API.
let directory: string | undefined;
afterEach(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
});

describe("owned receipt payload publication", () => {
	test("detached reads return frozen values and cannot change journal bytes", () => {
		directory = mkdtempSync(join(tmpdir(), "pi-owned-publication-"));
		const m = SessionManager.create(directory, directory);
		const id = m.appendMessage({ role: "user", content: [{ type: "text", text: "original" }], timestamp: 1 });
		m.appendCustomMessageEntry("custom", "visible", true, { nested: [{ value: 1 }] });
		const view = detachedSessionView(m);
		const before = JSON.stringify({
			entries: m.getEntries(),
			projection: m.buildSessionProjection(),
			revision: m.revision(),
		});
		const bytes = readFileSync(m.getSessionFile()!);
		const entries = view.getEntries();
		const reads = [
			() => view.getEntries()[0],
			() => view.getBranch()[0],
			() => view.buildContextEntries()[0],
			() => view.getEntry(id)!,
			() => view.buildSessionProjection().entries[0].sourceEntry,
			() => view.getTree()[0].entry,
		];
		for (const read of reads) {
			const entry = read();
			expect(Object.isFrozen(entry)).toBe(true);
			expect(entry).toEqual(entries[0]);
			expect(() => {
				entry.parentId = "edited";
			}).toThrow(TypeError);
			if (entry.type !== "message" || entry.message.role !== "user" || !Array.isArray(entry.message.content)) {
				throw new Error("missing message");
			}
			const message = entry.message;
			expect(() => {
				message.content = "edited";
			}).toThrow(TypeError);
			expect(read()).toEqual(entries[0]);
		}
		const leaf = view.getLeafEntry()!;
		expect(leaf).toEqual(entries[1]);
		expect(() => {
			leaf.parentId = "edited";
		}).toThrow(TypeError);
		expect(() => {
			(view.buildSessionProjection().messages[0] as { content: { text: string }[] }).content[0].text = "edited";
		}).toThrow(TypeError);
		expect(
			JSON.stringify({ entries: m.getEntries(), projection: m.buildSessionProjection(), revision: m.revision() }),
		).toBe(before);
		expect(readFileSync(m.getSessionFile()!).equals(bytes)).toBe(true);
		m.appendCustomEntry("new", { value: 2 });
		expect(view.getEntries()[0]).toEqual(entries[0]);
		expect(view.getEntries()).toHaveLength(3);
	});

	test("captured ingress owns input before publication and retains its issued receipt", () => {
		directory = mkdtempSync(join(tmpdir(), "pi-owned-ingress-"));
		const m = SessionManager.create(directory, directory);
		const receipt = captureTerminalTurnReceipt();
		m.appendMessage = () => {
			throw new Error("public fallback reached");
		};
		m.appendCustomMessageEntry = () => {
			throw new Error("public fallback reached");
		};
		const message = { role: "user" as const, content: [{ type: "text" as const, text: "active" }], timestamp: 1 };
		const details = { values: [1] };
		const a = appendReceivedMessage(m, message, receipt);
		const b = appendReceivedCustomMessage(m, "active", "active", true, details, receipt);
		const bytes = readFileSync(m.getSessionFile()!);
		message.content[0].text = "caller edit";
		details.values.push(2);
		expect(Object.isFrozen(message.content)).toBe(false);
		expect(getTurnProvenance(m.getEntry(a))).toEqual(receiptRecord(receipt));
		expect(getTurnProvenance(m.getEntry(b))).toEqual(receiptRecord(receipt));
		const reopened = SessionManager.open(m.getSessionFile()!);
		expect(reopened.getEntries()).toEqual(m.getEntries());
		expect(readFileSync(m.getSessionFile()!).equals(bytes)).toBe(true);
	});
});
