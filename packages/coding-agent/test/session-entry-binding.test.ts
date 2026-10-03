import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnedJournal } from "../src/core/owner-effects.ts";
import {
	appendOwnedTerminalEntry,
	appendOwnedTerminalMessage,
	loadEntriesFromFile,
	type SessionHeader,
	SessionManager,
} from "../src/core/session-manager.ts";

// Modeled journal ports only: exercise the real manager, serializer and append queue.
// No native custody, allocation, addon or native persistence qualification is claimed.
const ports = vi.hoisted(() => ({ journals: new WeakSet<object>(), terminal: new WeakSet<object>() }));
vi.mock("../src/core/owner-effects.ts", () => ({
	OwnedJournal: {
		assertOriginal(journal: object) {
			if (!ports.journals.has(journal)) throw new Error("OWNED_JOURNAL_REQUIRED");
		},
	},
	isOwnedTerminalWrite: (journal: object) => ports.terminal.has(journal),
}));

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function user(content: string): UserMessage {
	return { role: "user", content, timestamp: 1 };
}

function directory(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-entry-binding-"));
	tempDirs.push(dir);
	return dir;
}

function modeledManager(terminal: boolean) {
	const initialHeader: SessionHeader = {
		type: "session",
		version: 3,
		id: "modeled-session",
		timestamp: "2026-10-03T00:00:00.000Z",
		cwd: "/synthetic",
	};
	const state = { bytes: Buffer.alloc(0), writable: true, wait: Promise.resolve() };
	const journal = {
		file: "/synthetic/modeled-session.jsonl",
		sessionId: initialHeader.id,
		initialHeader,
		assertActive() {
			if (!state.writable) throw new Error("MODELED_OWNER_NOT_WRITABLE");
		},
		assertWritable() {
			if (!state.writable) throw new Error("MODELED_OWNER_NOT_WRITABLE");
		},
		read: () => Buffer.from(state.bytes),
		quarantine: vi.fn(),
		commit: vi.fn((bytes: Buffer) => {
			state.bytes = Buffer.from(bytes);
			return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
		}),
		commitTerminalAsync: vi.fn(async (bytes: Buffer) => {
			await state.wait;
			state.bytes = Buffer.from(bytes);
			return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
		}),
	} satisfies Pick<
		OwnedJournal,
		| "file"
		| "sessionId"
		| "initialHeader"
		| "assertActive"
		| "assertWritable"
		| "read"
		| "quarantine"
		| "commit"
		| "commitTerminalAsync"
	>;
	ports.journals.add(journal);
	if (terminal) ports.terminal.add(journal);
	return { manager: SessionManager.openOwned("/synthetic", journal as unknown as OwnedJournal), journal, state };
}

describe("session entry identity binding", () => {
	// #4078: user message_start metadata must bind to native identity, not the next user by position.
	it("appends a forward-bound custom entry before the reserved native user ID without changing model messages", () => {
		const manager = SessionManager.inMemory("/synthetic");
		const message = user("Alice submission");
		const customId = manager.appendCustomEntry("author", { name: "Alice" }, "reserved-user");
		expect(manager.getEntry("reserved-user")).toBeUndefined();
		expect(manager.appendMessage(message, "reserved-user")).toBe("reserved-user");
		expect(manager.getEntry(customId)).toMatchObject({ beforeMessageId: "reserved-user" });
		expect(manager.getEntry("reserved-user")).toEqual({
			type: "message",
			id: "reserved-user",
			parentId: customId,
			timestamp: expect.any(String),
			message,
		});
		expect(manager.buildSessionContext().messages).toEqual([message]);
		expect(Object.keys(message).sort()).toEqual(["content", "role", "timestamp"]);
	});

	it("retains generated short IDs and unbound custom entries when optional arguments are omitted", () => {
		const manager = SessionManager.inMemory("/synthetic");
		const customId = manager.appendCustomEntry("unbound", { count: 1 });
		const messageId = manager.appendMessage(user("ordinary"));
		expect(customId).toMatch(/^[0-9a-f]{8}$/);
		expect(messageId).toMatch(/^[0-9a-f]{8}$/);
		expect(manager.getEntry(customId)).not.toHaveProperty("beforeMessageId");
	});

	it("rejects an empty reserved ID without changing the tree", () => {
		const manager = SessionManager.inMemory("/synthetic");
		manager.appendCustomEntry("author", { name: "Alice" }, "future");
		const before = manager.getEntries();
		const leaf = manager.getLeafId();
		expect(() => manager.appendMessage(user("invalid"), "")).toThrow("Entry id must be a non-empty string");
		expect(manager.getEntries()).toEqual(before);
		expect(manager.getLeafId()).toBe(leaf);
	});

	it.each(["message", "custom"] as const)(
		"rejects collision with an existing %s entry without replacing it",
		(type) => {
			const manager = SessionManager.inMemory("/synthetic");
			const id = type === "message" ? manager.appendMessage(user("original")) : manager.appendCustomEntry("state");
			const before = manager.getEntries();
			expect(() => manager.appendMessage(user("replacement"), id)).toThrow(`Entry ${id} already exists`);
			expect(manager.getEntries()).toEqual(before);
			expect(manager.getLeafId()).toBe(id);
		},
	);

	// #4078: retaining the preceding author entry must not retarget it to Bob after fork/re-edit.
	it.each(["fork", "re-edit"] as const)(
		"keeps Alice's dangling identity after %s-before-user and Bob replacement",
		(mode) => {
			const manager = SessionManager.inMemory("/synthetic");
			const aliceAuthor = manager.appendCustomEntry("author", { name: "Alice" }, "alice-user");
			manager.appendMessage(user("Alice original"), "alice-user");
			if (mode === "fork") manager.createBranchedSession(aliceAuthor);
			else manager.branch(aliceAuthor);
			expect(manager.getBranch()).toHaveLength(1);
			expect(manager.getBranch()[0]).toMatchObject({ id: aliceAuthor, beforeMessageId: "alice-user" });
			manager.appendCustomEntry("author", { name: "Bob" }, "bob-user");
			manager.appendMessage(user("Bob replacement"), "bob-user");
			const branch = manager.getBranch();
			expect(branch.map((entry) => entry.id)).not.toContain("alice-user");
			expect(branch[0]).toMatchObject({ beforeMessageId: "alice-user" });
			expect(branch[1]).toMatchObject({ beforeMessageId: "bob-user" });
			expect(manager.buildSessionContext().messages).toEqual([user("Bob replacement")]);
		},
	);

	it("preserves the reserved ID and binding through native JSONL flush, cold reload, and full fork", () => {
		const dir = directory();
		const manager = SessionManager.create(dir, dir);
		const customId = manager.appendCustomEntry("author", { name: "Alice", body: "a".repeat(2048) }, "reserved-user");
		const message = user("original");
		manager.appendMessage(message, "reserved-user");
		manager.appendMessage({
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "synthetic",
			model: "synthetic",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const file = manager.getSessionFile()!;
		expect(loadEntriesFromFile(file).find((entry) => entry.id === customId)).toMatchObject({
			beforeMessageId: "reserved-user",
		});
		const reopened = SessionManager.open(file);
		expect(reopened.getEntry(customId)).toMatchObject({ beforeMessageId: "reserved-user" });
		expect(reopened.getEntry("reserved-user")).toMatchObject({ message });
		const fork = SessionManager.forkFrom(file, dir, dir);
		expect(fork.getEntry(customId)).toMatchObject({ beforeMessageId: "reserved-user" });
		expect(fork.getEntry("reserved-user")).toMatchObject({ message });
		const bytes = readFileSync(fork.getSessionFile()!);
		expect(() => fork.appendMessage(user("collision"), "reserved-user")).toThrow("already exists");
		expect(readFileSync(fork.getSessionFile()!)).toEqual(bytes);
	});

	it("preserves bindings and native message IDs when a selected fork strips and rechains labels", () => {
		const manager = SessionManager.inMemory("/synthetic");
		const authorId = manager.appendCustomEntry("author", { name: "Alice" }, "reserved-user");
		manager.appendLabelChange(authorId, "author label");
		manager.appendMessage(user("original"), "reserved-user");
		manager.createBranchedSession("reserved-user");
		expect(manager.getEntry(authorId)).toMatchObject({ beforeMessageId: "reserved-user" });
		expect(manager.getEntry("reserved-user")).toMatchObject({ parentId: authorId });
		expect(manager.getLabel(authorId)).toBe("author label");
	});

	it("rejects invalid reserved IDs before deferred persistence creates a file", () => {
		const dir = directory();
		const manager = SessionManager.create(dir, dir);
		expect(() => manager.appendMessage(user("invalid"), "")).toThrow("non-empty");
		expect(existsSync(manager.getSessionFile()!)).toBe(false);
		expect(manager.getEntries()).toEqual([]);
	});
});

describe("modeled owned terminal identity binding", () => {
	it.each([false, true])("forwards both bindings through captured adapters (terminal=%s)", async (terminal) => {
		const { manager, journal, state } = modeledManager(terminal);
		const authorId = await appendOwnedTerminalEntry(manager, "author", { name: "Alice" }, "reserved-user");
		expect(await appendOwnedTerminalMessage(manager, user("original"), "reserved-user")).toBe("reserved-user");
		expect(manager.getEntry(authorId)).toMatchObject({ beforeMessageId: "reserved-user" });
		expect(manager.getEntry("reserved-user")).toMatchObject({ parentId: authorId });
		expect(state.bytes.toString()).toContain('"beforeMessageId":"reserved-user"');
		expect(manager.buildSessionContext().messages).toEqual([user("original")]);
		expect(journal.commit).toHaveBeenCalledTimes(terminal ? 0 : 2);
		expect(journal.commitTerminalAsync).toHaveBeenCalledTimes(terminal ? 2 : 0);
	});

	it.each([false, true])("omits absent bindings for strict owned JSON (terminal=%s)", async (terminal) => {
		const { manager, state } = modeledManager(terminal);
		const authorId = await appendOwnedTerminalEntry(manager, "state");
		await appendOwnedTerminalMessage(manager, user("ordinary"));
		expect(manager.getEntry(authorId)).not.toHaveProperty("beforeMessageId");
		expect(state.bytes.toString()).not.toContain("beforeMessageId");
	});

	it("validates a queued duplicate only after the prior append publishes, without a second write", async () => {
		const { manager, journal, state } = modeledManager(true);
		let release!: () => void;
		state.wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = appendOwnedTerminalMessage(manager, user("first"), "reserved-user");
		const duplicate = appendOwnedTerminalMessage(manager, user("duplicate"), "reserved-user");
		expect(manager.getEntry("reserved-user")).toBeUndefined();
		expect(() => manager.appendMessage(user("sync"), "other-user")).toThrow("OWNER_TERMINAL_APPEND_BUSY");
		release();
		expect(await first).toBe("reserved-user");
		await expect(duplicate).rejects.toThrow("Entry reserved-user already exists");
		expect(journal.commitTerminalAsync).toHaveBeenCalledTimes(1);
		expect(manager.getEntries()).toHaveLength(1);
		expect(manager.buildSessionContext().messages).toEqual([user("first")]);
	});

	it("rejects an empty queued reservation before journal publication", async () => {
		const { manager, journal, state } = modeledManager(true);
		await expect(appendOwnedTerminalMessage(manager, user("invalid"), "")).rejects.toThrow("non-empty");
		expect(journal.commitTerminalAsync).not.toHaveBeenCalled();
		expect(state.bytes).toHaveLength(0);
		expect(manager.getLeafId()).toBeNull();
	});

	it("retains the writable guard before owned terminal publication", async () => {
		const { manager, journal, state } = modeledManager(true);
		state.writable = false;
		await expect(appendOwnedTerminalMessage(manager, user("refused"), "reserved-user")).rejects.toThrow(
			"MODELED_OWNER_NOT_WRITABLE",
		);
		expect(journal.commitTerminalAsync).not.toHaveBeenCalled();
		expect(manager.getEntry("reserved-user")).toBeUndefined();
	});

	it("does not expose captured owned appenders on an ordinary manager", () => {
		const manager = SessionManager.inMemory("/synthetic");
		expect(() => appendOwnedTerminalMessage(manager, user("refused"), "reserved-user")).toThrow(
			"OWNED_JOURNAL_REQUIRED",
		);
		expect(() => appendOwnedTerminalEntry(manager, "author", undefined, "reserved-user")).toThrow(
			"OWNED_JOURNAL_REQUIRED",
		);
		expect(manager.getEntries()).toEqual([]);
	});
});
