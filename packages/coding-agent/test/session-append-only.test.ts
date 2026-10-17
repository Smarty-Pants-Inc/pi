import type { AssistantMessage } from "@earendil-works/pi-ai";
import * as fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type SessionHeader, SessionManager } from "../src/core/session-manager.ts";

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		appendFileSync: vi.fn(actual.appendFileSync),
		writeFileSync: vi.fn(actual.writeFileSync),
	};
});

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

// smarty-dev#6719: retain the API-submitted-byte scaling probes on plain JSONL storage.
// These are not native authority or physical write(2)/pread(2) qualifications.
describe("plain SessionManager append-only serialization", () => {
	let directory: string;
	let file: string;
	let header: SessionHeader;

	beforeEach(() => {
		directory = fs.mkdtempSync(join(tmpdir(), "pi-append-serialization-"));
		file = join(directory, "session.jsonl");
		header = {
			type: "session",
			version: 3,
			id: "append-only",
			cwd: directory,
			timestamp: "2026-10-09T00:00:00.000Z",
		};
		vi.clearAllMocks();
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test.each([100, 1000])(
		"%i turns submit each new byte once and reopen identical entries",
		(turns) => {
			const prefix = Buffer.from(`${JSON.stringify(header)}\n`);
			fs.writeFileSync(file, prefix);
			const manager = SessionManager.open(file, directory);
			vi.clearAllMocks();
			for (let turn = 0; turn < turns; turn++) {
				manager.appendMessage({ role: "user", content: `question ${turn}: λ`, timestamp: turn });
				manager.appendMessage(assistant(turn));
			}
			const submissions = vi
				.mocked(fs.appendFileSync)
				.mock.calls.map((call) => Buffer.byteLength(call[1] as string));
			const submitted = submissions.reduce((sum, size) => sum + size, 0);
			const bytes = fs.readFileSync(file);
			expect(submitted).toBe(bytes.length - prefix.length);
			expect(submissions).toHaveLength(turns * 2);
			expect(fs.writeFileSync).not.toHaveBeenCalled();
			expect(bytes.subarray(0, prefix.length).equals(prefix)).toBe(true);
			const reopened = SessionManager.open(file, directory);
			expect(reopened.getHeader()).toEqual(manager.getHeader());
			expect(reopened.getEntries()).toEqual(manager.getEntries());
			expect(reopened.getLeafId()).toBe(manager.getLeafId());
		},
		30000,
	);

	// smarty-dev#6719: a 10MiB prefix must not be submitted for every new entry.
	// pi#280 / smarty-dev#3155: use native equality to avoid deep-matcher byte enumeration.
	test("1000 turns after a 10MiB seed submit only suffixes", () => {
		const prefix = seed(header);
		expect(prefix.length).toBe(seedBytes);
		const prefixCopy = Buffer.from(prefix);
		expect(prefixCopy.equals(prefix)).toBe(true);
		prefixCopy[Math.floor(prefixCopy.length / 2)] ^= 0xff;
		expect(prefixCopy.equals(prefix)).toBe(false);
		expect(prefix.subarray(0, prefix.length - 1).equals(prefix)).toBe(false);
		fs.writeFileSync(file, prefix);
		const manager = SessionManager.open(file, directory);
		vi.clearAllMocks();
		for (let turn = 0; turn < 1000; turn++) {
			manager.appendMessage({ role: "user", content: `question ${turn}`, timestamp: turn });
			manager.appendMessage(assistant(turn));
			// Fail promptly rather than serializing 20GiB of old history.
			expect(Buffer.byteLength(vi.mocked(fs.appendFileSync).mock.lastCall![1] as string)).toBeLessThan(2048);
		}
		const submitted = vi
			.mocked(fs.appendFileSync)
			.mock.calls.reduce((sum, call) => sum + Buffer.byteLength(call[1] as string), 0);
		const bytes = fs.readFileSync(file);
		expect(submitted).toBe(bytes.length - seedBytes);
		expect(bytes.subarray(0, seedBytes).equals(prefix)).toBe(true);
		expect(fs.writeFileSync).not.toHaveBeenCalled();
		const reopened = SessionManager.open(file, directory);
		expect(reopened.getEntries()).toEqual(manager.getEntries());
	}, 30000);
});
