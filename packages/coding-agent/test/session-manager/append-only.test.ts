import * as fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		appendFileSync: vi.fn(actual.appendFileSync),
		writeFileSync: vi.fn(actual.writeFileSync),
	};
});

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

	// pi#291: immutable native payloads reject the index mutations used by the original fork controls.
	it("protects indexed payloads and forks committed disk values rather than a forged public index", () => {
		const manager = SessionManager.create(directory, directory);
		const first = manager.appendMessage({
			role: "system",
			content: "committed system",
			toolsAdded: [],
			timestamp: 0,
		});
		manager.appendMessage(userMessage("flush"));
		const indexed = manager.getEntry(first);
		if (indexed?.type !== "message") throw new Error("fixture message required");
		expect(Reflect.set(indexed.message, "role", "user")).toBe(false);
		expect(Reflect.set(indexed.message, "content", "forged payload")).toBe(false);
		const forged = structuredClone(indexed);
		Reflect.set(forged.message, "role", "user");
		Reflect.set(forged.message, "content", "forged payload");
		const byId = Reflect.get(manager, "byId") as Map<string, typeof indexed>;
		byId.set(first, forged);
		const child = SessionManager.forkFrom(manager.getSessionFile()!, directory, directory);
		expect(child.getEntry(first)).toMatchObject({ message: { role: "system", content: "committed system" } });
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
