import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { buildContextEntries, buildSessionProjection, SessionManager } from "../../src/core/session-manager.ts";

// smarty-dev#2177: a stable branch must not allocate/walk full history on each projection.
describe("branch projection cache", () => {
	it("reuses the branch walk and index without sharing mutable result arrays", () => {
		const session = SessionManager.inMemory();
		for (let i = 0; i < 256; i++) session.appendCustomEntry("history", { i });
		let parentReads = 0;
		for (const entry of session.getEntries()) {
			const parentId = entry.parentId;
			Object.defineProperty(entry, "parentId", {
				enumerable: true,
				get: () => {
					parentReads++;
					return parentId;
				},
			});
		}
		const getEntries = vi.spyOn(session, "getEntries");
		const first = session.buildSessionProjection();
		const reads = parentReads;
		expect(reads).toBeGreaterThan(0);
		for (let i = 0; i < 10; i++) {
			const next = session.buildSessionProjection();
			expect(next).toEqual(first);
			expect(next).not.toBe(first);
			next.entries.length = 0;
			session.getBranch().length = 0;
			session.buildContextEntries().length = 0;
		}
		for (let i = 0; i < 10; i++) {
			session.appendCustomEntry("new history", { i });
			expect(session.buildSessionProjection().entries).toHaveLength(257 + i);
		}
		expect(parentReads).toBe(reads);
		expect(getEntries).not.toHaveBeenCalled();
	});

	it("matches fresh byte projections after every branch/context mutation", () => {
		const session = SessionManager.inMemory();
		const check = () => {
			const entries = session.getEntries();
			const leaf = session.getLeafId();
			expect(JSON.stringify(session.buildSessionProjection())).toBe(
				JSON.stringify(buildSessionProjection(entries, leaf)),
			);
			expect(JSON.stringify(session.buildContextEntries())).toBe(JSON.stringify(buildContextEntries(entries, leaf)));
		};
		check();
		const user = session.appendMessage({ role: "user", content: "original", timestamp: 1 });
		check();
		session.appendModelChange("faux", "one");
		session.appendThinkingLevelChange("high");
		check();
		const projection = session.buildSessionProjection();
		if (!projection.model) throw new Error("missing model");
		projection.model.modelId = "not canonical";
		projection.messages.length = 0;
		projection.entries[0].messages.length = 0;
		check();
		session.appendContextEdit(user, { content: "edited" });
		check();
		const edited = session.buildSessionProjection().messages[0];
		if (edited.role !== "user") throw new Error("missing user");
		edited.content = "not canonical";
		check();
		session.appendContextEdit(user, null);
		check();
		session.branch(user);
		check();
		session.appendCustomMessageEntry("visible", "custom", true);
		check();
		const compaction = session.appendCompaction("summary", null, 100);
		check();
		session.appendMessage({ role: "user", content: "after", timestamp: 2 });
		check();
		session.branch(compaction);
		check();
		session.branchWithSummary(user, "branch summary");
		check();
		session.resetLeaf();
		check();
		session.appendCustomEntry("new root");
		check();
		session.newSession();
		check();
	});

	it("invalidates after file reload, session switch, cold/hot replacement and fork", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-branch-cache-"));
		try {
			const writer = SessionManager.create(dir, dir);
			const first = writer.appendMessage({ role: "user", content: "old ".repeat(1024), timestamp: 1 });
			writer.appendMessage(fauxAssistantMessage("answer"));
			for (let i = 0; i < 120; i++) writer.appendCustomEntry("history", "data ".repeat(1024));
			writer.appendCompaction("summary", null, 100);
			writer.appendMessage({ role: "user", content: "current", timestamp: 2 });
			const file = writer.getSessionFile()!;
			const session = SessionManager.open(file);
			const check = (manager: SessionManager) => {
				expect(JSON.stringify(manager.buildSessionProjection())).toBe(
					JSON.stringify(buildSessionProjection(manager.getEntries(), manager.getLeafId())),
				);
				for (const entry of manager.getBranch()) expect(entry).toBe(manager.getEntry(entry.id));
			};
			check(session);
			session.branch(first);
			check(session);
			session.setSessionFile(file);
			check(session);
			writer.appendCustomMessageEntry("reloaded", "added on disk", true);
			session.setSessionFile(file);
			check(session);
			session.createBranchedSession(first);
			check(session);
			session.setSessionFile(file);
			check(session);
			const other = SessionManager.create(dir, dir);
			other.appendMessage({ role: "user", content: "other", timestamp: 3 });
			other.appendMessage(fauxAssistantMessage("other answer"));
			other.appendCompaction("other summary", null, 1);
			session.setSessionFile(other.getSessionFile()!);
			check(session);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
