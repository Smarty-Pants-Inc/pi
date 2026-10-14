import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, test, vi } from "vitest";
import { createOriginalCompactionSessionIdentity } from "../src/core/original-compaction-session-identity.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const accountingTypes = [
	"smarty-sense:count-reservation-v1",
	"smarty-sense:count-qualification-v1",
	"smarty-sense:provider-reservation-v1",
	"smarty-sense:provider-usage-v1",
];

function createManager(): { manager: SessionManager; userEntryId: string } {
	const manager = SessionManager.inMemory(process.cwd());
	const userEntryId = manager.appendMessage({ role: "user", content: "seed input", timestamp: Date.now() });
	manager.appendMessage(fauxAssistantMessage("seed reply"));
	return { manager, userEntryId };
}

// #11897: the original-compaction fence must reject supported context and branch changes without copying bodies.
describe("original compaction session identity", () => {
	test.each(accountingTypes)("allows accounting-only append %s", (customType) => {
		const { manager } = createManager();
		const identity = createOriginalCompactionSessionIdentity(manager);

		manager.appendCustomEntry(customType, { amount: 1 });

		expect(() => identity.check()).not.toThrow();
	});

	test("rejects a concurrent user append", async () => {
		const { manager } = createManager();
		const identity = createOriginalCompactionSessionIdentity(manager);
		await Promise.resolve().then(() =>
			manager.appendMessage({ role: "user", content: "concurrent user input", timestamp: Date.now() }),
		);

		expect(() => identity.check()).toThrow("OPS_COMPACTION_SESSION_CHANGED");
	});

	test("rejects a supported context edit append", () => {
		const { manager, userEntryId } = createManager();
		const identity = createOriginalCompactionSessionIdentity(manager);

		manager.appendContextEdit(userEntryId, { content: "edited context" });

		expect(() => identity.check()).toThrow("OPS_COMPACTION_SESSION_CHANGED");
	});

	test("rejects a leaf switch", () => {
		const { manager, userEntryId } = createManager();
		const identity = createOriginalCompactionSessionIdentity(manager);

		manager.branch(userEntryId);

		expect(() => identity.check()).toThrow("OPS_COMPACTION_SESSION_CHANGED");
	});

	test("rejects session replacement/reload", () => {
		const { manager } = createManager();
		const identity = createOriginalCompactionSessionIdentity(manager);

		manager.newSession();

		expect(() => identity.check()).toThrow("OPS_COMPACTION_SESSION_CHANGED");
	});

	test("rejects same-ID reload with changed payload and an accounting tail", () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-compaction-identity-"));
		try {
			const path = join(scratch, "session.jsonl");
			const header = {
				type: "session",
				version: 3,
				id: "same-session",
				timestamp: new Date(0).toISOString(),
				cwd: process.cwd(),
			};
			const userEntry = {
				type: "message",
				id: "user-entry",
				parentId: null,
				timestamp: new Date(1).toISOString(),
				message: { role: "user", content: "old payload", timestamp: 1 },
			};
			const assistantEntry = {
				type: "message",
				id: "assistant-entry",
				parentId: "user-entry",
				timestamp: new Date(2).toISOString(),
				message: fauxAssistantMessage("reply", { timestamp: 2 }),
			};
			const writeJournal = (entries: unknown[]) =>
				writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			writeJournal([header, userEntry, assistantEntry]);
			const manager = SessionManager.open(path);
			const identity = createOriginalCompactionSessionIdentity(manager);
			writeJournal([
				header,
				{ ...userEntry, message: { ...userEntry.message, content: "changed payload" } },
				assistantEntry,
				{
					type: "custom",
					id: "accounting-tail",
					parentId: "assistant-entry",
					timestamp: new Date(3).toISOString(),
					customType: accountingTypes[0],
				},
			]);

			manager.setSessionFile(path);

			expect(manager.getBranchIdentity().entries.map((entry) => entry.id)).toEqual([
				"user-entry",
				"assistant-entry",
				"accounting-tail",
			]);
			expect(manager.buildSessionProjection().messages[0]).toMatchObject({
				role: "user",
				content: "changed payload",
			});
			expect(() => identity.check()).toThrow("OPS_COMPACTION_SESSION_CHANGED");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	test("refreshes its baseline after Pi's own compaction append", () => {
		const { manager, userEntryId } = createManager();
		const identity = createOriginalCompactionSessionIdentity(manager);

		manager.appendCompaction("own compaction", userEntryId, 20);
		identity.afterAppend();
		expect(() => identity.check()).not.toThrow();

		manager.appendCustomEntry("smarty-sense:provider-usage-v1", { tokens: 1 });
		expect(() => identity.check()).not.toThrow();
		manager.appendMessage({ role: "user", content: "new user input", timestamp: Date.now() });
		expect(() => identity.check()).toThrow("OPS_COMPACTION_SESSION_CHANGED");
	});

	test("uses the production metadata path instead of getBranch's owned payload view", () => {
		const { manager } = createManager();
		const getBranch = vi.spyOn(manager, "getBranch").mockImplementation(() => {
			throw new Error("payload-copying branch view must not be used");
		});
		const identity = createOriginalCompactionSessionIdentity(manager);

		expect(() => identity.check()).not.toThrow();
		expect(getBranch).not.toHaveBeenCalled();
	});
});
