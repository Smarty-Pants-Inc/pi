import * as fs from "fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager, SessionPersistenceError } from "../../src/core/session-manager.ts";

vi.mock("fs", async (original) => {
	const actual = await original<typeof fs>();
	return { ...actual, writeSync: vi.fn(actual.writeSync) };
});

describe("original-writer append receipts", () => {
	const directories: string[] = [];
	afterEach(() => {
		vi.mocked(fs.writeSync).mockClear();
		for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
	});

	function manager(existing = false) {
		const directory = fs.mkdtempSync(join(tmpdir(), "pi-append-receipt-"));
		directories.push(directory);
		if (!existing) return SessionManager.create(directory, directory);
		const file = join(directory, "session.jsonl");
		fs.writeFileSync(file, "");
		return SessionManager.open(file);
	}

	it("does not expose a failed append in indexes or move the selected branch", () => {
		const session = manager(true);
		const parent = session.appendMessage({ role: "user", content: "parent", timestamp: 1 });
		const file = session.getSessionFile()!;
		const before = fs.readFileSync(file);
		// A real open failure is portable, including privileged test processes.
		fs.renameSync(file, `${file}.retained`);
		fs.mkdirSync(file);
		let failure: unknown;
		try { session.appendMessage({ role: "user", content: "failed", timestamp: 2 }); } catch (error) { failure = error; }
		expect(failure).toBeInstanceOf(SessionPersistenceError);
		expect((failure as SessionPersistenceError).outcome).toBe("not_written");
		expect(session.getBranch().map((entry) => entry.id)).toEqual([parent]);
		expect(session.getLeafId()).toBe(parent);
		expect(fs.readFileSync(`${file}.retained`)).toEqual(before);
		expect(session.getPersistenceError()).toBeUndefined();
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("preserves the real EACCES witness", () => {
		const session = manager(true);
		const file = session.getSessionFile()!;
		const before = fs.readFileSync(file);
		fs.chmodSync(file, 0o400);
		try {
			expect(() => session.appendMessage({ role: "user", content: "denied", timestamp: 1 })).toThrow(/EACCES/);
			expect(session.getBranch()).toEqual([]);
			expect(fs.readFileSync(file)).toEqual(before);
		} finally { fs.chmodSync(file, 0o600); }
	});

	it("keeps legacy buffering but explicitly persists the first receipted user without a seed turn", () => {
		const session = manager();
		const buffered = session.appendMessage({ role: "user", content: "buffered", timestamp: 1 });
		expect(fs.existsSync(session.getSessionFile()!)).toBe(false);
		const receipt = session.appendMessageWithReceipt({ role: "user", content: "saved", timestamp: 2 });
		expect(receipt).toMatchObject({ status: "appended", sessionId: session.getSessionId(), parentId: buffered });
		const entries = fs.readFileSync(receipt.sessionFile!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(entries.slice(1).map((entry) => entry.id)).toEqual([buffered, receipt.entryId]);
		expect(entries.at(-1)).toEqual(session.getEntry(receipt.entryId));
		expect(entries.filter((entry) => entry.message?.role === "assistant")).toEqual([]);
	});

	it("retains partial bytes and the first uncertainty, without retry, truncation, or false indexing", () => {
		const session = manager(true);
		const file = session.getSessionFile()!;
		const before = fs.readFileSync(file);
		const cause = new Error("injected failure after a real partial append");
		vi.mocked(fs.writeSync).mockImplementationOnce(() => {
			fs.appendFileSync(file, '{"type":"message"');
			throw cause;
		});
		let failure: unknown;
		try { session.appendMessageWithReceipt({ role: "user", content: "uncertain", timestamp: 1 }); } catch (error) { failure = error; }
		expect(failure).toBeInstanceOf(SessionPersistenceError);
		expect((failure as SessionPersistenceError).outcome).toBe("unknown");
		expect((failure as Error).cause).toBe(cause);
		expect(session.getPersistenceError()).toBe(failure);
		expect(session.getBranch()).toEqual([]);
		const partial = fs.readFileSync(file);
		expect(partial).toEqual(Buffer.concat([before, Buffer.from('{"type":"message"')]));
		expect(() => session.appendMessage({ role: "user", content: "do not retry", timestamp: 2 })).toThrow(failure as Error);
		expect(() => session.newSession()).toThrow(failure as Error);
		expect(fs.readFileSync(file)).toEqual(partial);
		expect(vi.mocked(fs.writeSync)).toHaveBeenCalledTimes(1);
	});

	it("reports memory-only storage without claiming a file append", () => {
		const session = SessionManager.inMemory();
		const receipt = session.appendMessageWithReceipt({ role: "user", content: "memory", timestamp: 1 });
		expect(receipt.status).toBe("memory");
		expect(receipt.sessionFile).toBeUndefined();
		expect(session.getEntry(receipt.entryId)).toBeDefined();
	});
});
