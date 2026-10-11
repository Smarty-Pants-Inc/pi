import { createHash } from "node:crypto";
import * as fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseOwnedSessionEntries } from "../../src/core/owned-session-entries.ts";
import { OwnedJournal } from "../../src/core/owner-effects.ts";
import {
	appendOwnedTerminalEntry,
	persistOwnedTerminalSession,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
} from "../../src/core/session-manager.ts";
import { getTurnProvenance } from "../../src/core/turn-provenance.ts";

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		appendFileSync: vi.fn(actual.appendFileSync),
		writeFileSync: vi.fn(actual.writeFileSync),
	};
});

const lifecycle = vi.hoisted(() => ({ terminal: false }));
afterEach(() => {
	lifecycle.terminal = false;
});

// Manager API/control-flow fixture, not native custody or physical-write qualification.
// Retain suffix arguments separately so a full-buffer API cannot pass a disk-size assertion.
vi.mock("../../src/core/owner-effects.ts", () => ({
	isOwnedTerminalWrite: () => lifecycle.terminal,
	OwnedJournal: class {
		file = "/synthetic/owned.jsonl";
		sessionId = "owned";
		initialHeader: SessionHeader = {
			type: "session",
			version: 3,
			id: "owned",
			cwd: "/synthetic",
			timestamp: "2026-01-01T00:00:00.000Z",
		};
		commits: Buffer[] = [];
		suffixes: Buffer[] = [];
		quarantined = false;
		static assertOriginal() {}
		assertActive() {}
		assertWritable() {}
		quarantine() {
			this.quarantined = true;
		}
		read() {
			return Buffer.concat([...this.commits.slice(-1), ...this.suffixes]);
		}
		commit(bytes: Buffer) {
			this.commits.push(Buffer.from(bytes));
			this.suffixes.length = 0;
			return this.currentReceipt();
		}
		append(suffix: Buffer) {
			this.suffixes.push(Buffer.from(suffix));
		}
		async commitTerminalAsync(bytes: Buffer) {
			return this.commit(bytes);
		}
		async appendTerminalAsync(suffix: Buffer) {
			this.append(suffix);
		}
		currentReceipt() {
			const bytes = this.read();
			return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
		}
	},
}));

type JournalFixture = OwnedJournal & {
	initialHeader: SessionHeader;
	commits: Buffer[];
	suffixes: Buffer[];
	quarantined: boolean;
};

function journal(): JournalFixture {
	return Reflect.construct(OwnedJournal, []) as JournalFixture;
}

function childJournal(): JournalFixture {
	const storage = journal();
	Reflect.set(storage, "sessionId", "child");
	Reflect.set(storage, "file", "/synthetic/child.jsonl");
	storage.initialHeader.id = "child";
	return storage;
}

function appendRaw(manager: SessionManager, entry: unknown): void {
	const append = Reflect.get(manager, "_appendEntry") as (entry: SessionEntry) => void;
	append.call(manager, entry as SessionEntry);
}

const userMessage = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

const assistantMessage = (text: string) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }],
	api: "anthropic-messages" as const,
	provider: "anthropic",
	model: "test",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop" as const,
	timestamp: 1,
});

// smarty-dev#6719: appends must scale with new bytes, not the retained transcript.
describe("plain session append-only persistence", () => {
	let directory: string;

	beforeEach(() => {
		directory = fs.mkdtempSync(join(tmpdir(), "pi-append-only-"));
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.mocked(fs.appendFileSync).mockRestore();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	it("writes only 100 new turns after a 10 MiB seed and reopens the same session", () => {
		const file = join(directory, "seed.jsonl");
		const header = { type: "session", version: 3, id: "plain", timestamp: "2026-01-01", cwd: directory };
		const seed = {
			type: "custom",
			id: "seed",
			parentId: null,
			timestamp: header.timestamp,
			customType: "large-history",
			data: "x".repeat(10 * 1024 * 1024),
		};
		const prefix = Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify(seed)}\n`);
		fs.writeFileSync(file, prefix);
		vi.clearAllMocks();
		const manager = SessionManager.open(file, directory);
		for (let turn = 0; turn < 100; turn++) {
			manager.appendMessage(userMessage(`question ${turn}`));
			manager.appendMessage(assistantMessage(`answer ${turn}`));
		}

		const appends = vi.mocked(fs.appendFileSync).mock.calls;
		expect(appends).toHaveLength(200);
		const written = appends.reduce((total, call) => total + Buffer.byteLength(call[1] as string), 0);
		expect(written).toBeLessThan(200 * 2048);
		expect(fs.writeFileSync).not.toHaveBeenCalled();
		const bytes = fs.readFileSync(file);
		expect(bytes.length).toBe(prefix.length + written);
		expect(bytes.subarray(0, prefix.length).equals(prefix)).toBe(true);
		const reopened = SessionManager.open(file, directory);
		expect(reopened.getSessionId()).toBe("plain");
		expect(reopened.getEntryCount()).toBe(201);
		expect(reopened.getEntry("seed")).toMatchObject({ data: seed.data });
		expect(reopened.buildSessionContext()).toEqual(manager.buildSessionContext());
	});

	it("recovers a partial append on reopen and keeps the next appended record separate", () => {
		const manager = SessionManager.create(directory, directory);
		const retained = manager.appendMessage(userMessage("retained"));
		const file = manager.getSessionFile()!;
		const prefix = fs.readFileSync(file);
		const originalAppend = vi.mocked(fs.appendFileSync).getMockImplementation()!;
		vi.mocked(fs.appendFileSync).mockImplementationOnce((path, data) => {
			originalAppend(path, String(data).slice(0, 35));
			throw new Error("simulated partial append");
		});
		expect(() => manager.appendMessage(userMessage("interrupted"))).toThrow("simulated partial append");
		const partial = fs.readFileSync(file);
		expect(partial.subarray(0, prefix.length)).toEqual(prefix);
		expect(partial.at(-1)).not.toBe(10);

		const reopened = SessionManager.open(file, directory);
		expect(reopened.getEntryCount()).toBe(1);
		expect(fs.readFileSync(file)).toEqual(Buffer.concat([partial, Buffer.from("\n")]));
		const next = reopened.appendMessage(userMessage("after recovery"));
		expect(reopened.getEntry(next)?.parentId).toBe(retained);
		const recoveredAgain = SessionManager.open(file, directory);
		expect(recoveredAgain.getEntries().map((entry) => entry.id)).toEqual([retained, next]);
		expect(recoveredAgain.buildSessionContext().messages.map((message) => Reflect.get(message, "content"))).toEqual([
			"retained",
			"after recovery",
		]);
	});

	it("repairs a complete unterminated tail before the next append", () => {
		const manager = SessionManager.create(directory, directory);
		const retained = manager.appendMessage(userMessage("complete tail"));
		const file = manager.getSessionFile()!;
		fs.writeFileSync(file, fs.readFileSync(file).subarray(0, -1));
		const reopened = SessionManager.open(file, directory);
		const next = reopened.appendMessage(userMessage("next"));
		expect(
			SessionManager.open(file, directory)
				.getEntries()
				.map((entry) => entry.id),
		).toEqual([retained, next]);
	});
});

// smarty-dev#6719: explicit forks select committed bytes, never caller-mutable source indices.
describe("owned fork committed selection", () => {
	it("restores a mutated system role and rejects child context edits", () => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		const first = manager.appendMessage({ role: "system", content: "committed system", timestamp: 1 });
		const before = storage.read();
		const indexed = (Reflect.get(manager, "byId") as Map<string, SessionEntry>).get(first)!;
		if (indexed.type !== "message") throw new Error("fixture message required");
		Reflect.set(indexed.message, "role", "user");
		const childStorage = childJournal();
		const child = manager.forkSelected(first, childStorage);
		expect(child.getEntry(first)).toMatchObject({ message: { role: "system", content: "committed system" } });
		const childBefore = childStorage.read();
		expect(() => child.appendContextEdit(first, null)).toThrow("does not contribute editable model content");
		expect(childStorage.read()).toEqual(childBefore);
		expect(storage.read()).toEqual(before);
	});

	it.each([false, true])(
		"rejects injected uncommitted history with committed parent=%s before child publish",
		(committed) => {
			const storage = journal();
			const manager = SessionManager.openOwned("/synthetic", storage);
			const parentId = committed ? manager.appendMessage(userMessage("committed")) : null;
			const before = storage.read();
			(Reflect.get(manager, "fileEntries") as Array<SessionEntry | SessionHeader>).push({
				type: "message",
				id: "ghost",
				parentId,
				timestamp: storage.initialHeader.timestamp,
				message: userMessage("never committed"),
			});
			(Reflect.get(manager, "_buildIndex") as () => void).call(manager);
			const childStorage = childJournal();
			expect(() => manager.forkSelected("ghost", childStorage)).toThrow("Entry ghost not found");
			expect(childStorage.read()).toHaveLength(0);
			expect(childStorage.commits).toHaveLength(0);
			expect(childStorage.suffixes).toHaveLength(0);
			expect(storage.read()).toEqual(before);
		},
	);

	it.each(["system", "user"] as const)("preserves normal %s fork editability", (role) => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		const first = manager.appendMessage({ role, content: "original", timestamp: 1 });
		const before = storage.read();
		const childStorage = childJournal();
		const child = manager.forkSelected(first, childStorage);
		expect(child.getEntry(first)).toMatchObject({ message: { role } });
		expect(child.getHeader()?.parentSession).toBe(storage.file);
		if (role === "system") expect(() => child.appendContextEdit(first, null)).toThrow("editable model content");
		else {
			child.appendContextEdit(first, { content: "edited child" });
			expect(childStorage.suffixes).toHaveLength(1);
		}
		expect(parseOwnedSessionEntries(childStorage.read(), "child")).toHaveLength(role === "system" ? 2 : 3);
		expect(storage.read()).toEqual(before);
	});

	it("preserves committed ancestors, payloads, branch selection and resolved labels", () => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		const root = manager.appendMessage(userMessage("root"));
		manager.appendMessage(userMessage("abandoned"));
		manager.branch(root);
		const selected = manager.appendMessage(userMessage("selected"));
		manager.appendLabelChange(root, "old");
		manager.appendLabelChange(root, "resolved");
		const before = storage.read();
		const indexed = (Reflect.get(manager, "byId") as Map<string, SessionEntry>).get(selected)!;
		if (indexed.type !== "message") throw new Error("fixture message required");
		Reflect.set(indexed.message, "content", "forged payload");
		indexed.parentId = null;
		(Reflect.get(manager, "labelsById") as Map<string, string>).set(root, "forged label");
		const read = vi.spyOn(storage, "read");
		const childStorage = childJournal();
		const child = manager.forkSelected(selected, childStorage);
		expect(read).toHaveBeenCalledTimes(1);
		read.mockRestore();
		expect(
			child
				.getEntries()
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.id),
		).toEqual([root, selected]);
		expect(child.getEntry(selected)).toMatchObject({ parentId: root, message: { content: "selected" } });
		expect(child.getLabel(root)).toBe("resolved");
		expect(child.getEntries().filter((entry) => entry.type === "label")).toHaveLength(1);
		expect(parseOwnedSessionEntries(childStorage.read(), "child")).toHaveLength(4);
		expect(storage.read()).toEqual(before);
	});

	it.each([false, true])("preserves header-only null fork with flushed source=%s", (flushed) => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		if (flushed) manager.persistCurrent();
		const before = storage.read();
		const childStorage = childJournal();
		const child = manager.forkSelected(null, childStorage);
		expect(child.getEntries()).toEqual([]);
		expect(child.getHeader()?.parentSession).toBe(storage.file);
		expect(parseOwnedSessionEntries(childStorage.read(), "child")).toHaveLength(1);
		expect(storage.read()).toEqual(before);
	});

	it.each([false, true])("keeps missing leaf not-found with flushed source=%s", (flushed) => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		if (flushed) manager.persistCurrent();
		const before = storage.read();
		const childStorage = childJournal();
		expect(() => manager.forkSelected("missing", childStorage)).toThrow("Entry missing not found");
		expect(childStorage.commits).toHaveLength(0);
		expect(childStorage.read()).toHaveLength(0);
		expect(storage.read()).toEqual(before);
	});

	it("fails source integrity reads before child commit", () => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		const first = manager.appendMessage(userMessage("committed"));
		const childStorage = childJournal();
		const read = vi.spyOn(storage, "read").mockImplementationOnce(() => {
			throw new Error("source tamper read failure");
		});
		expect(() => manager.forkSelected(first, childStorage)).toThrow("source tamper read failure");
		read.mockRestore();
		expect(childStorage.commits).toHaveLength(0);
		expect(childStorage.suffixes).toHaveLength(0);
		expect(childStorage.read()).toHaveLength(0);
	});

	it.each(["sessionId", "file", "nonempty"])("retains fresh child rejection for %s", (kind) => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		const first = manager.appendMessage(userMessage("committed"));
		const childStorage = childJournal();
		if (kind === "nonempty") childStorage.commits.push(Buffer.from("occupied"));
		else Reflect.set(childStorage, kind, Reflect.get(storage, kind));
		const before = childStorage.read();
		expect(() => manager.forkSelected(first, childStorage)).toThrow("OWNER_FRESH_CHILD_REQUIRED");
		expect(childStorage.read()).toEqual(before);
		expect(childStorage.suffixes).toHaveLength(0);
	});
});

// smarty-dev#6719: retain every strict check when validating only the admitted suffix.
describe("incremental owned entry validation", () => {
	// smarty-dev#6719: a JS-visible index is not evidence that a reference was committed.
	it.each(["parent", "label", "compaction", "context"])("rejects an injected ghost %s reference", (kind) => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		const first = manager.appendMessage(userMessage("retained"));
		const byId = Reflect.get(manager, "byId") as Map<string, SessionEntry>;
		byId.set("ghost", {
			type: "message",
			id: "ghost",
			parentId: first,
			timestamp: storage.initialHeader.timestamp,
			message: userMessage("never committed"),
		});
		const before = storage.read();
		const entry = { id: "candidate", parentId: first, timestamp: storage.initialHeader.timestamp };
		const attempt = () => {
			if (kind === "parent") {
				manager.branch("ghost");
				manager.appendCustomEntry("dangling-parent");
			} else if (kind === "label") manager.appendLabelChange("ghost", "dangling-label");
			else if (kind === "compaction")
				appendRaw(manager, {
					...entry,
					type: "compaction",
					summary: "s",
					tokensBefore: 1,
					firstKeptEntryId: "ghost",
				});
			else {
				manager.branch("ghost");
				manager.appendContextEdit("ghost", null);
			}
		};
		expect(attempt).toThrow(/OWNER_JOURNAL_/);
		expect(storage.read()).toEqual(before);
		expect(parseOwnedSessionEntries(storage.read(), storage.sessionId)).toHaveLength(2);
	});

	// smarty-dev#6719: rebuilding a JS-public index must never refresh authoritative refs.
	it("rejects ghost references after forged fileEntries and a public index rebuild", () => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		const first = manager.appendMessage(userMessage("retained"));
		const before = storage.read();
		const entries = Reflect.get(manager, "fileEntries") as Array<SessionEntry | SessionHeader>;
		entries.push({
			type: "message",
			id: "ghost",
			parentId: first,
			timestamp: storage.initialHeader.timestamp,
			message: userMessage("forged"),
		});
		(Reflect.get(manager, "_buildIndex") as () => void).call(manager);
		expect(() => manager.appendCustomEntry("parent")).toThrow("OWNER_JOURNAL_ENTRY");
		manager.branch(first);
		expect(() => manager.appendLabelChange("ghost", "label")).toThrow("OWNER_JOURNAL_LABEL");
		expect(() =>
			appendRaw(manager, {
				type: "context_edit",
				id: "edit",
				parentId: first,
				timestamp: storage.initialHeader.timestamp,
				targetId: "ghost",
				replacement: null,
			}),
		).toThrow("OWNER_JOURNAL_CONTEXT_EDIT");
		expect(storage.read()).toEqual(before);
	});

	// smarty-dev#6719: edits use committed type/role, not mutable published payloads.
	it("does not admit context edits after a caller changes the indexed type or role", () => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		const first = manager.appendMessage({ role: "system", content: "system", timestamp: 1 });
		const state = manager.appendCustomEntry("state");
		const byId = Reflect.get(manager, "byId") as Map<string, SessionEntry>;
		const message = byId.get(first)!;
		if (message.type !== "message") throw new Error("fixture message required");
		Reflect.set(message.message, "role", "user");
		Reflect.set(byId.get(state)!, "type", "custom_message");
		const before = storage.read();
		for (const targetId of [first, state])
			expect(() =>
				appendRaw(manager, {
					type: "context_edit",
					id: "edit",
					parentId: state,
					timestamp: storage.initialHeader.timestamp,
					targetId,
					replacement: null,
				}),
			).toThrow("OWNER_JOURNAL_CONTEXT_EDIT");
		expect(storage.read()).toEqual(before);
	});

	// smarty-dev#6719: clearing the public index cannot permit a committed ID to be reused.
	it("rejects duplicate IDs even after the public index is cleared", () => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		const first = manager.appendMessage(userMessage("retained"));
		const before = storage.read();
		(Reflect.get(manager, "byId") as Map<string, SessionEntry>).clear();
		expect(() =>
			appendRaw(manager, {
				type: "custom",
				id: first,
				parentId: null,
				timestamp: storage.initialHeader.timestamp,
				customType: "duplicate",
			}),
		).toThrow("OWNER_JOURNAL_ENTRY");
		expect(storage.read()).toEqual(before);
	});

	// smarty-dev#6719: a shadowed public method or forged flag cannot omit the header.
	it.each(["shadow", "flag", "both", "header"])("bootstraps privately despite a forged %s", (kind) => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		const header = { ...storage.initialHeader };
		const shadow = vi.fn();
		if (kind === "shadow" || kind === "both") Reflect.set(manager, "persistCurrent", shadow);
		if (kind === "flag" || kind === "both") Reflect.set(manager, "flushed", true);
		if (kind === "header") {
			(Reflect.get(manager, "fileEntries") as SessionHeader[])[0].id = "forged";
			Reflect.set(manager, "encodeOwnedEntries", () => Buffer.from("forged\n"));
		}
		manager.appendCustomEntry("first");
		expect(storage.commits).toEqual([Buffer.from(`${JSON.stringify(header)}\n`)]);
		expect(shadow).not.toHaveBeenCalled();
		expect(parseOwnedSessionEntries(storage.read(), storage.sessionId)).toHaveLength(2);
	});

	// smarty-dev#6719: a fresh bootstrap also excludes uncommitted public-container additions.
	it("rejects a forged fresh prefix after public index rebuild without committing it", () => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		(Reflect.get(manager, "fileEntries") as Array<SessionEntry | SessionHeader>).push({
			type: "message",
			id: "ghost",
			parentId: null,
			timestamp: storage.initialHeader.timestamp,
			message: userMessage("forged"),
		});
		(Reflect.get(manager, "_buildIndex") as () => void).call(manager);
		expect(() => manager.appendCustomEntry("first")).toThrow("OWNER_JOURNAL_ENTRY");
		expect(storage.read()).toHaveLength(0);
	});

	it("cannot publish a headerless record under combined bootstrap forgery", () => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		Reflect.set(manager, "persistCurrent", vi.fn());
		Reflect.set(manager, "flushed", true);
		try {
			manager.appendCustomEntry("first");
		} catch (error) {
			// The original full-reparse manager rejects its empty forged prefix before writing.
			expect(error).toMatchObject({ message: "OWNER_JOURNAL_HEADER" });
			expect(storage.read()).toHaveLength(0);
			return;
		}
		expect(parseOwnedSessionEntries(storage.read(), storage.sessionId)).toHaveLength(2);
	});

	it("admits a selected fork's committed reference facts before its next suffix", () => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		const first = manager.appendMessage(userMessage("retained"));
		const childStorage = journal();
		Reflect.set(childStorage, "sessionId", "child");
		Reflect.set(childStorage, "file", "/synthetic/child.jsonl");
		childStorage.initialHeader.id = "child";
		const child = manager.forkSelected(first, childStorage);
		child.appendContextEdit(first, { content: "edited child" });
		expect(childStorage.commits).toHaveLength(1);
		expect(childStorage.suffixes).toHaveLength(1);
		expect(parseOwnedSessionEntries(childStorage.read(), "child")).toHaveLength(3);
	});

	// smarty-dev#6719: compare the original full-reparse manager and the incremental manager.
	it("preserves an ordinary fresh header even with shadowed persistCurrent", () => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		Reflect.set(manager, "persistCurrent", vi.fn());
		manager.appendCustomEntry("first");
		const parsed = parseOwnedSessionEntries(storage.read(), storage.sessionId);
		expect(parsed[0]).toEqual(storage.initialHeader);
		expect(parsed).toHaveLength(2);
	});

	it("preserves valid branch references and editable targets", () => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		const first = manager.appendMessage(userMessage("first"));
		const abandoned = manager.appendMessage(userMessage("abandoned"));
		manager.branch(first);
		manager.appendMessage(userMessage("branch"));
		manager.appendLabelChange(abandoned, "retained");
		manager.appendContextEdit(first, { content: "edited" });
		manager.appendCompaction("summary", abandoned, 1);
		expect(parseOwnedSessionEntries(storage.read(), storage.sessionId)).toHaveLength(7);
	});

	it("initializes reference facts from strict reopen bytes, not a later rebuild", () => {
		const storage = journal();
		const original = SessionManager.openOwned("/synthetic", storage);
		const first = original.appendMessage(userMessage("retained"));
		const manager = SessionManager.openOwned("/synthetic", storage);
		(Reflect.get(manager, "fileEntries") as Array<SessionEntry | SessionHeader>).length = 1;
		(Reflect.get(manager, "_buildIndex") as () => void).call(manager);
		appendRaw(manager, {
			type: "context_edit",
			id: "edit",
			parentId: first,
			timestamp: storage.initialHeader.timestamp,
			targetId: first,
			replacement: null,
		});
		expect(parseOwnedSessionEntries(storage.read(), storage.sessionId)).toHaveLength(3);
	});

	it("does not admit metadata for a suffix whose write failed", () => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		manager.persistCurrent();
		const entry = {
			type: "custom",
			id: "retry",
			parentId: null,
			timestamp: storage.initialHeader.timestamp,
			customType: "state",
		};
		vi.spyOn(storage, "append").mockImplementationOnce(() => {
			throw new Error("write failed");
		});
		expect(() => appendRaw(manager, entry)).toThrow("write failed");
		appendRaw(manager, entry);
		expect(parseOwnedSessionEntries(storage.read(), storage.sessionId)).toHaveLength(2);
	});

	// smarty-dev#6719: captured terminal routes share the private integrity boundary.
	it("rejects a terminal ghost parent without publishing bytes", async () => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		const first = manager.appendMessage(userMessage("retained"));
		(Reflect.get(manager, "byId") as Map<string, SessionEntry>).set("ghost", {
			type: "custom",
			id: "ghost",
			parentId: first,
			timestamp: storage.initialHeader.timestamp,
			customType: "ghost",
		});
		manager.branch("ghost");
		const before = storage.read();
		lifecycle.terminal = true;
		await expect(appendOwnedTerminalEntry(manager, "terminal")).rejects.toThrow("OWNER_JOURNAL_ENTRY");
		expect(storage.read()).toEqual(before);
	});

	it.each(["append", "persist"])("bootstraps the terminal %s despite a forged flushed flag", async (operation) => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		Reflect.set(manager, "flushed", true);
		Reflect.set(manager, "persistCurrent", vi.fn());
		Reflect.set(manager, "encodeOwnedEntries", () => Buffer.from("forged\n"));
		lifecycle.terminal = true;
		if (operation === "append") await appendOwnedTerminalEntry(manager, "terminal");
		else await persistOwnedTerminalSession(manager);
		expect(storage.commits).toEqual([Buffer.from(`${JSON.stringify(storage.initialHeader)}\n`)]);
		expect(parseOwnedSessionEntries(storage.read(), storage.sessionId)).toHaveLength(operation === "append" ? 2 : 1);
	});

	it("commits a fresh header once, then publishes only detached new entry lines", () => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		expect(manager.getHeader()).toEqual(storage.initialHeader);
		expect(storage.commits).toHaveLength(0);
		const data = { nested: { value: "before" } };
		const id = manager.appendCustomEntry("state", data);
		expect(storage.commits.map((bytes) => bytes.toString())).toEqual([`${JSON.stringify(storage.initialHeader)}\n`]);
		expect(storage.suffixes).toHaveLength(1);
		expect(JSON.parse(storage.suffixes[0].toString())).toMatchObject({ id, type: "custom", data });
		data.nested.value = "after";
		expect(manager.getEntry(id)).toMatchObject({ data: { nested: { value: "before" } } });
		const user = manager.appendMessage(userMessage("new turn"));
		expect(getTurnProvenance(manager.getEntry(user))?.channel).toBe("terminal");
		const receipt = manager.persistCurrent();
		expect(receipt).toMatchObject(storage.currentReceipt());
		expect(storage.commits).toHaveLength(1);
		expect(storage.suffixes).toHaveLength(2);
		expect(parseOwnedSessionEntries(storage.read(), storage.sessionId)).toEqual([
			manager.getHeader(),
			...JSON.parse(JSON.stringify(manager.getEntries())),
		]);
	});

	it("refuses an invalid fresh header before publishing anything", () => {
		const storage = journal();
		storage.initialHeader.version = 2;
		expect(() => SessionManager.openOwned("/synthetic", storage)).toThrow("OWNER_JOURNAL_HEADER");
		expect(storage.commits).toHaveLength(0);
		expect(storage.suffixes).toHaveLength(0);
		expect(storage.quarantined).toBe(true);
	});

	it("rejects duplicate IDs, dangling parents/references, malformed edits, and a second header before publish", () => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		const first = manager.appendMessage(userMessage("first"));
		const state = manager.appendCustomEntry("state");
		const base = { id: "candidate", parentId: state, timestamp: storage.initialHeader.timestamp };
		const bad: Array<[unknown, string]> = [
			[{ ...base, type: "custom", id: first, customType: "duplicate" }, "OWNER_JOURNAL_ENTRY"],
			[{ ...base, type: "custom", parentId: "missing", customType: "parent" }, "OWNER_JOURNAL_ENTRY"],
			[
				{ ...base, type: "compaction", summary: "s", tokensBefore: 1, firstKeptEntryId: "missing" },
				"OWNER_JOURNAL_COMPACTION",
			],
			[{ ...base, type: "label", targetId: "missing", label: "name" }, "OWNER_JOURNAL_LABEL"],
			[{ ...base, type: "context_edit", targetId: "missing", replacement: null }, "OWNER_JOURNAL_CONTEXT_EDIT"],
			[{ ...base, type: "context_edit", targetId: state, replacement: null }, "OWNER_JOURNAL_CONTEXT_EDIT"],
			[{ ...base, type: "context_edit", targetId: first, replacement: {} }, "OWNER_JOURNAL_CONTEXT_EDIT"],
			[{ ...base, type: "branch_summary", fromId: 1, summary: "s" }, "OWNER_JOURNAL_SUMMARY"],
			[storage.initialHeader, "OWNER_JOURNAL_ENTRY"],
		];
		const before = storage.read();
		for (const [entry, error] of bad) {
			expect(() => appendRaw(manager, entry)).toThrow(error);
			expect(storage.read()).toEqual(before);
			expect(manager.getEntryCount()).toBe(2);
			expect(manager.getLeafId()).toBe(state);
		}
	});

	it("accepts compaction self-reference and references across admitted branches", () => {
		const storage = journal();
		const manager = SessionManager.openOwned("/synthetic", storage);
		const first = manager.appendMessage(userMessage("first"));
		const abandoned = manager.appendMessage(userMessage("abandoned"));
		manager.branch(first);
		const secondBranch = manager.appendMessage(userMessage("second branch"));
		const summary = manager.branchWithSummary(first, "branch summary");
		expect(manager.getEntry(summary)).toMatchObject({ parentId: first, fromId: secondBranch });
		const self = manager.appendCompaction("retain none", null, 3);
		expect(manager.getEntry(self)).toMatchObject({ firstKeptEntryId: self });
		const retained = manager.appendCompaction("retained reference", abandoned, 4);
		expect(manager.getEntry(retained)).toMatchObject({ firstKeptEntryId: abandoned });
		manager.appendLabelChange(abandoned, "earlier branch");
		manager.appendContextEdit(first, { content: "edited" });
		expect(parseOwnedSessionEntries(storage.read(), storage.sessionId).length).toBe(manager.getEntryCount() + 1);
		expect(storage.commits).toHaveLength(1);
	});

	it("keeps owned partial tails fail-closed rather than using plain tail repair", () => {
		const storage = journal();
		storage.commits.push(Buffer.from(`${JSON.stringify(storage.initialHeader)}\n{"type":"message"`));
		const before = storage.read();
		expect(() => SessionManager.openOwned("/synthetic", storage)).toThrow("OWNER_JOURNAL_PARTIAL_TAIL");
		expect(storage.quarantined).toBe(true);
		expect(storage.read()).toEqual(before);
		expect(storage.suffixes).toHaveLength(0);
	});
});
