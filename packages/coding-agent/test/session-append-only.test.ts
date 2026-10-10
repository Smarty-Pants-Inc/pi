import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { OwnedJournal } from "../src/core/owner-effects.ts";
import {
	appendOwnedTerminalEntry,
	appendOwnedTerminalMessage,
	persistOwnedTerminalSession,
	type SessionHeader,
	SessionManager,
} from "../src/core/session-manager.ts";

// smarty-dev#6719: serialization/control-flow probe, NOT native authority evidence.
// Only the journal port is modeled. SessionManager, JSON materialization, strict
// validation, tree indexing and the captured terminal routes are real code.
vi.mock("../src/core/owner-effects.ts", () => ({
	isOwnedTerminalWrite: (journal: { terminalWrite: boolean }) => journal.terminalWrite,
	OwnedJournal: class {
		file = "/serialization-probe/now_append-only.jsonl";
		sessionId = "append-only";
		initialHeader = {
			type: "session",
			version: 3,
			id: "append-only",
			cwd: "/serialization-probe",
			timestamp: "2026-10-09T00:00:00.000Z",
		};
		bytes = Buffer.alloc(0);
		submissions: number[] = [];
		terminalWrite = false;
		quarantined = false;
		wait: Promise<void> = Promise.resolve();
		failure?: Error;
		static assertOriginal() {}
		assertActive() {
			if (this.quarantined || this.terminalWrite) throw new Error("PROBE_STALE");
		}
		assertWritable() {
			if (this.quarantined) throw new Error("PROBE_QUARANTINED");
		}
		quarantine() {
			this.quarantined = true;
		}
		read() {
			this.assertActive();
			return Buffer.from(this.bytes);
		}
		append(suffix: Buffer): void {
			this.assertWritable();
			this.submissions.push(suffix.length);
			if (this.failure) throw this.failure;
			this.bytes = Buffer.concat([this.bytes, suffix]);
		}
		async appendTerminalAsync(suffix: Buffer): Promise<void> {
			await this.wait;
			this.append(suffix);
		}
		currentReceipt() {
			this.assertWritable();
			return { bytes: this.bytes.length, sha256: createHash("sha256").update(this.bytes).digest("hex") };
		}
		// Baseline-only adapter records the actual full-session submission size;
		// it does not claim that the old native body physically rewrites a prefix.
		commit(bytes: Buffer) {
			this.assertWritable();
			this.submissions.push(bytes.length);
			if (this.failure) throw this.failure;
			this.bytes = Buffer.from(bytes);
			return this.currentReceipt();
		}
		async commitTerminalAsync(bytes: Buffer) {
			await this.wait;
			return this.commit(bytes);
		}
	},
}));

type SerializationJournal = OwnedJournal & {
	bytes: Buffer;
	submissions: number[];
	terminalWrite: boolean;
	quarantined: boolean;
	wait: Promise<void>;
	failure?: Error;
};
function journal(bytes?: Buffer): SerializationJournal {
	// Constructs only the explicitly mocked port above, not a private real owner.
	const value = Reflect.construct(OwnedJournal, []) as SerializationJournal;
	if (bytes) value.bytes = Buffer.from(bytes);
	return value;
}
function assistant(turn: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `answer ${turn}: λ` }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "serialization-probe",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: turn,
	};
}

const seedBytes = 10 * 1024 * 1024;
function seed(header: SessionHeader): Buffer {
	const entry = {
		type: "custom",
		id: "seed",
		parentId: null,
		timestamp: header.timestamp,
		customType: "large-seed",
		data: "",
	};
	const empty = `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`;
	entry.data = "x".repeat(seedBytes - Buffer.byteLength(empty));
	return Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
}

describe("owned SessionManager append-only serialization (modeled journal port)", () => {
	// smarty-dev#6719: count bytes submitted to the API, not bytes physically written.
	test.each([100, 1000])(
		"%i turns submit each new byte once and reopen identical entries",
		(turns) => {
			const j = journal();
			const manager = SessionManager.openOwned("/serialization-probe", j);
			manager.persistCurrent();
			for (let turn = 0; turn < turns; turn++) {
				manager.appendMessage({ role: "user", content: `question ${turn}: λ`, timestamp: turn });
				manager.appendMessage(assistant(turn));
			}
			const submitted = j.submissions.reduce((sum, size) => sum + size, 0);
			console.info(JSON.stringify({ probe: "api-submitted-bytes", turns, submitted, journalBytes: j.bytes.length }));
			expect(submitted).toBe(j.bytes.length);
			expect(j.submissions).toHaveLength(1 + turns * 2);
			const calls = j.submissions.length;
			const receipt = manager.persistCurrent();
			manager.persistCurrent();
			expect(j.submissions).toHaveLength(calls);
			expect(receipt.bytes).toBe(j.bytes.length);
			expect(receipt.sha256).toBe(createHash("sha256").update(j.bytes).digest("hex"));
			const reopened = SessionManager.openOwned("/serialization-probe", journal(j.bytes));
			expect(reopened.getHeader()).toEqual(manager.getHeader());
			expect(reopened.getEntries()).toEqual(manager.getEntries());
			expect(reopened.getLeafId()).toBe(manager.getLeafId());
		},
		30000,
	);

	// smarty-dev#6719: a 10MiB prefix must not be submitted for every new entry.
	test("1000 turns after a 10MiB seed submit only suffixes", () => {
		const j = journal();
		j.bytes = seed(j.initialHeader);
		expect(j.bytes.length).toBe(seedBytes);
		const manager = SessionManager.openOwned("/serialization-probe", j);
		for (let turn = 0; turn < 1000; turn++) {
			manager.appendMessage({ role: "user", content: `question ${turn}`, timestamp: turn });
			manager.appendMessage(assistant(turn));
			// Fail promptly on base, rather than serializing 20GiB of old history.
			expect(j.submissions.at(-1)).toBeLessThan(2048);
		}
		const submitted = j.submissions.reduce((sum, size) => sum + size, 0);
		console.info(
			JSON.stringify({
				probe: "seeded-api-submitted-bytes",
				turns: 1000,
				seedBytes,
				submitted,
				journalBytes: j.bytes.length,
			}),
		);
		expect(submitted).toBe(j.bytes.length - seedBytes);
		const reopened = SessionManager.openOwned("/serialization-probe", journal(j.bytes));
		expect(reopened.getEntries()).toEqual(manager.getEntries());
	}, 30000);

	// smarty-dev#6719: exercise allowed terminal appends, not only negative routes.
	test("terminal queue serializes valid calls and persists no unchanged prefix", async () => {
		const j = journal();
		const manager = SessionManager.openOwned("/serialization-probe", j);
		manager.persistCurrent();
		j.terminalWrite = true;
		let release!: () => void;
		j.wait = new Promise((resolve) => {
			release = resolve;
		});
		const first = appendOwnedTerminalMessage(manager, assistant(1));
		const second = appendOwnedTerminalEntry(manager, "terminal-control", { ended: true });
		expect(manager.getEntries()).toHaveLength(0);
		expect(() => manager.appendCustomEntry("interleaved")).toThrow("OWNER_TERMINAL_APPEND_BUSY");
		release();
		const [a, b] = await Promise.all([first, second]);
		expect(manager.getEntry(b)?.parentId).toBe(a);
		expect(j.submissions.reduce((sum, size) => sum + size, 0)).toBe(j.bytes.length);
		const calls = j.submissions.length;
		await persistOwnedTerminalSession(manager);
		expect(j.submissions).toHaveLength(calls);
		j.terminalWrite = false;
		expect(SessionManager.openOwned("/serialization-probe", journal(j.bytes)).getEntries()).toEqual(
			manager.getEntries(),
		);
	});

	// smarty-dev#6719: rejected storage never publishes an entry or advances leaf.
	test("failed terminal append poisons the queue without replay or later publication", async () => {
		const j = journal();
		const manager = SessionManager.openOwned("/serialization-probe", j);
		manager.persistCurrent();
		j.terminalWrite = true;
		j.failure = new Error("PROBE_WRITE_FAILURE");
		const first = appendOwnedTerminalEntry(manager, "first");
		const second = appendOwnedTerminalEntry(manager, "must-not-write");
		await expect(first).rejects.toBe(j.failure);
		await expect(second).rejects.toBe(j.failure);
		expect(manager.getEntries()).toHaveLength(0);
		expect(manager.getLeafId()).toBeNull();
		expect(j.submissions).toHaveLength(2);
	});

	// smarty-dev#6719: complete-looking/partial corrupt tails are not repaired.
	test.each(["partial", "duplicate", "missing-parent"])("strict reopen rejects %s tail", (kind) => {
		const j = journal();
		const manager = SessionManager.openOwned("/serialization-probe", j);
		manager.persistCurrent();
		const id = manager.appendCustomEntry("before", { saved: true });
		const entry = manager.getEntry(id)!;
		const tail =
			kind === "partial"
				? '{"type":"custom"'
				: `${JSON.stringify({ ...entry, ...(kind === "missing-parent" ? { id: "bad", parentId: "absent" } : {}) })}\n`;
		const corrupted = journal(Buffer.concat([j.bytes, Buffer.from(tail)]));
		const before = Buffer.from(corrupted.bytes);
		expect(() => SessionManager.openOwned("/serialization-probe", corrupted)).toThrow();
		expect(corrupted.quarantined).toBe(true);
		expect(corrupted.bytes).toEqual(before);
		expect(corrupted.submissions).toHaveLength(0);
	});
});

// Actual native commit-body/storage probe with fabricated low-level Host/Owner
// metadata. No validateHost, admitted profile, JS owner or grant is fabricated.
// It measures journal write(2)/pread(2) bytes independently of API submissions.
test("native commit body appends physically, fences tamper and crash uncertainty", (context) => {
	if (process.platform !== "linux") context.skip("native owner storage body is Linux-only");
	const compiler = process.env.PI_APPEND_CC ?? "cc";
	const available = spawnSync(compiler, ["--version"], { encoding: "utf8", timeout: 5000 });
	if (available.error || available.status !== 0) context.skip(`native probe compiler unavailable: ${compiler}`);
	const headers =
		process.env.PI_APPEND_NODE_HEADERS ??
		[join(dirname(process.execPath), "../include/node"), "/usr/include/node"].find((path) =>
			existsSync(join(path, "node_api.h")),
		);
	if (!headers || !existsSync(join(headers, "node_api.h")))
		return context.skip("official Node headers unavailable; set PI_APPEND_NODE_HEADERS");
	const directory = dirname(fileURLToPath(import.meta.url));
	const scratch = mkdtempSync(join(process.env.PI_APPEND_STORAGE_DIR ?? tmpdir(), "pi-append-native-"));
	try {
		const source = readFileSync(join(directory, "../native/owner-effects/owner-effects.c"), "utf8");
		const binary = join(scratch, "probe");
		const compiled = spawnSync(
			compiler,
			[
				"-std=c11",
				// Keep pread instrumentation visible instead of fortified __pread_chk redirects.
				"-U_FORTIFY_SOURCE",
				"-O1",
				"-ffunction-sections",
				"-fdata-sections",
				"-pthread",
				"-I",
				headers,
				...(source.includes('#include "owner-journal.h"') || source.includes("static int append_journal_bytes(")
					? ["-DAPPEND_ONLY_BODY=1"]
					: []),
				join(directory, "session-append-only-native.c"),
				"-Wl,--gc-sections",
				"-Wl,--wrap=write",
				"-Wl,--wrap=pread",
				"-Wl,--wrap=pread64",
				"-Wl,--wrap=fsync",
				"-o",
				binary,
			],
			{ encoding: "utf8", timeout: 30000 },
		);
		expect(compiled.error).toBeUndefined();
		expect(compiled.status, compiled.stderr).toBe(0);
		const run = spawnSync(binary, [scratch], { encoding: "utf8", timeout: 60000 });
		console.info(run.stdout);
		expect(run.error).toBeUndefined();
		expect(run.status, run.stderr).toBe(0);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}, 90000);
