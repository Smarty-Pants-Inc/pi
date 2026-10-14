import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportSessionToJsonl, serializeSessionBranch } from "../src/core/session-export.ts";
import { SessionManager } from "../src/core/session-manager.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		closeSync: vi.fn(actual.closeSync),
		// Failure cleanup is observed, never executed on local files.
		unlinkSync: vi.fn(),
		rmSync: vi.fn(),
	};
});

describe("session export serialization", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function directory(): string {
		return fs.mkdtempSync(join(tmpdir(), "pi-session-export-serialization-"));
	}

	function manager(): SessionManager {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry("existing", { text: "session data" });
		return sessionManager;
	}

	function trailing(toJSON: () => unknown) {
		return () => [{ type: "custom", customType: "test", toJSON }];
	}

	// #11897: JSON.stringify can return undefined for an otherwise object-shaped export entry.
	it("rejects undefined JSON serialization without replacing the destination or leaking the handle", () => {
		const sessionManager = manager();
		const undefinedEntry = trailing(() => undefined);
		const destination = join(directory(), "existing.jsonl");
		fs.writeFileSync(destination, "existing destination");
		const closeCalls = vi.mocked(fs.closeSync).mock.calls.length;
		const unlinkCalls = vi.mocked(fs.unlinkSync).mock.calls.length;

		expect(() => serializeSessionBranch(sessionManager, undefinedEntry)).toThrow(
			"Session entry did not serialize to JSON",
		);
		expect(() => exportSessionToJsonl(sessionManager, destination, undefinedEntry)).toThrow(
			"Session entry did not serialize to JSON",
		);

		expect(fs.readFileSync(destination, "utf8")).toBe("existing destination");
		expect(fs.closeSync).toHaveBeenCalledTimes(closeCalls + 1);
		expect(fs.unlinkSync).toHaveBeenCalledTimes(unlinkCalls + 1);
		expect(fs.unlinkSync).toHaveBeenLastCalledWith(expect.stringMatching(/existing\.jsonl\..*\.tmp$/));
	});

	it("accepts an object whose toJSON returns a valid record", () => {
		const sessionManager = manager();
		const validEntry = trailing(() => ({ type: "custom", customType: "test", data: "valid" }));
		const serialized = serializeSessionBranch(sessionManager, validEntry);
		expect(JSON.parse(serialized.trim().split("\n").at(-1)!)).toEqual({
			type: "custom",
			customType: "test",
			data: "valid",
		});

		const destination = join(directory(), "valid.jsonl");
		exportSessionToJsonl(sessionManager, destination, validEntry);
		expect(JSON.parse(fs.readFileSync(destination, "utf8").trim().split("\n").at(-1)!)).toEqual({
			type: "custom",
			customType: "test",
			data: "valid",
		});
	});
});
