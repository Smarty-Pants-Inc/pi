import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isColdEntry } from "../../src/core/session-lazy-entries.ts";
import {
	buildSessionContext,
	loadEntriesFromFile,
	type SessionEntry,
	SessionManager,
} from "../../src/core/session-manager.ts";

// smarty-dev#2177: entries outside the current context and the recent window keep only small
// fields in memory and read large fields back from the session file.

const big = (label: string) => `${label} ${"x".repeat(4000)}`;

function assistant(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 1,
	};
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-lazy-entries-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** 300 user/assistant pairs with 4 KB texts and a compaction after pair 250. */
function writeLargeSession(): { file: string; compactionId: string } {
	const session = SessionManager.create(dir, dir);
	let compactionId = "";
	let firstKept = "";
	for (let i = 0; i < 300; i++) {
		const id = session.appendMessage({ role: "user", content: big(`user ${i}`), timestamp: i });
		if (i === 240) firstKept = id;
		session.appendMessage(assistant(big(`assistant ${i}`)));
		if (i === 250) compactionId = session.appendCompaction(big("summary"), firstKept, 1000, { readFiles: [] });
	}
	return { file: session.getSessionFile()!, compactionId };
}

const eagerEntries = (file: string) => loadEntriesFromFile(file).filter((e): e is SessionEntry => e.type !== "session");

describe("lazy session entries", () => {
	it("keeps old entries cold and reads the same values as an eager load", () => {
		const { file } = writeLargeSession();
		const session = SessionManager.open(file);
		const entries = session.getEntries();

		expect(entries.filter((e) => isColdEntry(e)).length).toBeGreaterThan(400);
		expect(isColdEntry(entries[entries.length - 1])).toBe(false);
		expect(JSON.stringify(entries)).toBe(JSON.stringify(eagerEntries(file)));
		// Small fields stay resident, so usage totals need no disk read.
		const cold = entries.find((e) => isColdEntry(e) && e.type === "message" && e.message.role === "assistant");
		expect(cold?.type === "message" && Object.getOwnPropertyDescriptor(cold.message, "usage")?.value).toBeTruthy();
	});

	it("builds the same context and tree as an eager load", () => {
		const { file } = writeLargeSession();
		const session = SessionManager.open(file);
		const eager = eagerEntries(file);

		expect(session.buildSessionContext()).toEqual(buildSessionContext(eager));
		expect(JSON.stringify(session.getTree())).toBe(
			JSON.stringify(SessionManager.inMemory(dir, undefined, loadEntriesFromFile(file)).getTree()),
		);
	});

	it("writes a branched session with the same entry lines", () => {
		const { file } = writeLargeSession();
		const session = SessionManager.open(file);
		const leaf = session.getEntries()[99];
		const branched = session.createBranchedSession(leaf.id)!;

		const originalLines = readFileSync(file, "utf8").split("\n").slice(1, 101);
		expect(readFileSync(branched, "utf8").split("\n").slice(1, 101)).toEqual(originalLines);
		// The branched session reads its cold fields from its own file.
		expect(JSON.stringify(SessionManager.open(branched).getEntries())).toBe(JSON.stringify(eagerEntries(branched)));
	});

	it("releases entries that a new compaction leaves behind, and reads them after reopen", () => {
		const { file } = writeLargeSession();
		const session = SessionManager.open(file);
		const keep = session.appendMessage({ role: "user", content: big("kept"), timestamp: 1 });
		session.appendMessage(assistant(big("after")));
		const before = session.getEntries().filter((e) => isColdEntry(e)).length;
		session.appendCompaction(big("summary 2"), keep, 1000);

		expect(session.getEntries().filter((e) => isColdEntry(e)).length).toBeGreaterThan(before);
		expect(JSON.stringify(session.getEntries())).toBe(JSON.stringify(eagerEntries(file)));
	});

	it("migrates an old session file and rebinds cold entries to the rewritten file", () => {
		const header = { type: "session", version: 2, id: "old", timestamp: "t", cwd: dir };
		const lines = [JSON.stringify(header)];
		let parentId: string | null = null;
		for (let i = 0; i < 200; i++) {
			const id = `e${i}`;
			lines.push(
				JSON.stringify({
					type: "message",
					id,
					parentId,
					timestamp: "t",
					message: { role: i % 2 ? "hookMessage" : "user", content: big(`m${i}`), timestamp: i },
				}),
			);
			parentId = id;
		}
		lines.push(
			JSON.stringify({
				type: "compaction",
				id: "c",
				parentId,
				timestamp: "t",
				summary: "s",
				firstKeptEntryId: "e190",
				tokensBefore: 1,
			}),
		);
		const file = join(dir, "old.jsonl");
		writeFileSync(file, `${lines.join("\n")}\n`);

		const session = SessionManager.open(file);
		const entries = session.getEntries();
		expect(entries.some((e) => isColdEntry(e))).toBe(true);
		expect(JSON.stringify(entries)).toBe(JSON.stringify(eagerEntries(file)));
		expect(readFileSync(file, "utf8")).not.toContain("hookMessage");
	});

	it("fails clearly when the file changes under a cold entry", () => {
		const { file } = writeLargeSession();
		const session = SessionManager.open(file);
		const cold = session.getEntries().find((e) => isColdEntry(e) && e.type === "message")!;
		writeFileSync(file, `${readFileSync(file, "utf8").split("\n").slice(0, 1).join("\n")}\n`);

		expect(() => JSON.stringify(cold)).toThrow(/Session file changed on disk/);
	});
});
