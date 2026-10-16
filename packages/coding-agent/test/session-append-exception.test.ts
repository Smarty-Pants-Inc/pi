import * as fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEntryLocation, isColdEntry } from "../src/core/session-lazy-entries.ts";
import { buildSessionProjection, SessionManager } from "../src/core/session-manager.ts";
import { UNSENT_INPUT_TYPE } from "../src/core/unsent-input.ts";

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		appendFileSync: vi.fn(actual.appendFileSync),
		closeSync: vi.fn(actual.closeSync),
		openSync: vi.fn(actual.openSync),
		unlinkSync: vi.fn(actual.unlinkSync),
		writeFileSync: vi.fn(actual.writeFileSync),
	};
});

function snapshot(manager: SessionManager) {
	const entries = manager.getEntries();
	return {
		entries,
		json: JSON.stringify(entries),
		locations: [getEntryLocation(manager.getHeader()!), ...entries.map(getEntryLocation)],
		leaf: manager.getLeafId(),
		count: manager.getEntryCount(),
		physicalCount: manager.getPhysicalEntryCount(),
		branch: manager.getBranch(),
		identity: manager.getBranchIdentity(),
		projection: JSON.stringify(manager.buildSessionProjection()),
		tree: JSON.stringify(manager.getTree()),
		revision: manager.revision(),
	};
}

function expectUnchanged(manager: SessionManager, before: ReturnType<typeof snapshot>): void {
	expect(snapshot(manager)).toEqual(before);
	for (const [index, entry] of manager.getEntries().entries()) {
		expect(entry).toBe(before.entries[index]);
		expect(manager.getEntry(entry.id)).toBe(entry);
	}
}

// pi#262 / smarty-dev#3155: data safety at the real persistence failure boundary.
// This suite calls real unlink/rm implementations and is CI-only under the no-deletion policy.
// Local recorded-call coverage must virtualize unlink AND the failed file's subsequent wx open.
describe("exception-safe session appends", () => {
	let directory: string;

	beforeEach(() => {
		directory = fs.mkdtempSync(join(tmpdir(), "pi-append-exception-"));
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.mocked(fs.appendFileSync).mockReset();
		vi.mocked(fs.closeSync).mockReset();
		vi.mocked(fs.openSync).mockReset();
		vi.mocked(fs.unlinkSync).mockReset();
		vi.mocked(fs.writeFileSync).mockReset();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	// pi#262 / smarty-dev#3155: both first-turn and first unsent-outbox persistence.
	it.each([
		{ kind: "user", failAt: 1 },
		{ kind: "user", failAt: 2 },
		{ kind: "user", failAt: 4 },
		{ kind: "unsent", failAt: 1 },
		{ kind: "unsent", failAt: 2 },
		{ kind: "unsent", failAt: 4 },
	])("failed first $kind write $failAt publishes nothing and retries once", ({ kind, failAt }) => {
		const manager = SessionManager.create(directory, directory);
		const model = manager.appendModelChange("faux", "test-model");
		const thinking = manager.appendThinkingLevelChange("high");
		const file = manager.getSessionFile()!;
		expect(fs.existsSync(file)).toBe(false);
		const before = snapshot(manager);
		const failure = new Error("first flush failed");
		const originalWrite = vi.mocked(fs.writeFileSync).getMockImplementation()!;
		for (let i = 1; i < failAt; i++) vi.mocked(fs.writeFileSync).mockImplementationOnce(originalWrite);
		vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
			throw failure;
		});
		const append = () =>
			kind === "user"
				? manager.appendMessage({ role: "user", content: "retry me", timestamp: 1 })
				: manager.appendCustomEntry(UNSENT_INPUT_TYPE, {
						mode: "followUp",
						message: { role: "user", content: "queued retry", timestamp: 1 },
					});

		expect(append).toThrow(failure);
		expectUnchanged(manager, before);
		expect(fs.unlinkSync).toHaveBeenCalledExactlyOnceWith(file);
		expect(fs.existsSync(file)).toBe(false);
		const next = append();
		expect(manager.getEntries().map((entry) => entry.id)).toEqual([model, thinking, next]);
		expect(manager.getEntry(next)?.parentId).toBe(thinking);
		expect(manager.getLeafId()).toBe(next);
		expect(manager.buildSessionProjection()).toEqual(buildSessionProjection(manager.getEntries(), next));
		const reopened = SessionManager.open(file, directory);
		expect(reopened.getEntries()).toEqual(manager.getEntries());
		expect(reopened.getLeafId()).toBe(next);
		expect(fs.readFileSync(file, "utf8").trimEnd().split("\n")).toHaveLength(4);
		expect(fs.appendFileSync).not.toHaveBeenCalled();
		expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
		if (kind === "unsent") expect(reopened.buildSessionContext().messages).toEqual([]);
	});

	// pi#262 / smarty-dev#3155: label maps, context edits and branchWithSummary also wait for IO.
	it.each(["message", "label", "context-edit", "branch-summary"] as const)(
		"failed %s append keeps the selected branch and physical order for retry",
		(kind) => {
			const manager = SessionManager.create(directory, directory);
			const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
			const abandoned = manager.appendMessage({ role: "user", content: "old branch", timestamp: 2 });
			manager.branch(root);
			const file = manager.getSessionFile()!;
			const bytes = fs.readFileSync(file);
			const before = snapshot(manager);
			const failure = new Error("append failed");
			vi.mocked(fs.appendFileSync).mockImplementationOnce(() => {
				throw failure;
			});
			const append = () => {
				switch (kind) {
					case "message":
						return manager.appendMessage({ role: "user", content: "new branch", timestamp: 3 });
					case "label":
						return manager.appendLabelChange(root, "bookmark");
					case "context-edit":
						return manager.appendContextEdit(root, { content: "edited root" });
					case "branch-summary":
						return manager.branchWithSummary(null, "new root summary");
				}
			};

			expect(append).toThrow(failure);
			const failed = JSON.parse(String(vi.mocked(fs.appendFileSync).mock.lastCall![1])) as { id: string };
			expect(manager.getEntry(failed.id)).toBeUndefined();
			expectUnchanged(manager, before);
			expect(manager.getLabel(root)).toBeUndefined();
			expect(fs.readFileSync(file)).toEqual(bytes);
			expect(fs.unlinkSync).not.toHaveBeenCalled();
			const next = append();
			expect(manager.getEntry(next)?.parentId).toBe(kind === "branch-summary" ? null : root);
			expect(manager.getBranch().map((entry) => entry.id)).toEqual(
				kind === "branch-summary" ? [next] : [root, next],
			);
			expect(manager.getEntries().map((entry) => entry.id)).toEqual([root, abandoned, next]);
			expect(manager.buildSessionProjection()).toEqual(buildSessionProjection(manager.getEntries(), next));
			if (kind === "label") expect(manager.getLabel(root)).toBe("bookmark");
			const reopened = SessionManager.open(file, directory);
			expect(reopened.getEntries()).toEqual(manager.getEntries());
			expect(reopened.getBranch()).toEqual(manager.getBranch());
			expect(fs.readFileSync(file).subarray(0, bytes.length)).toEqual(bytes);
		},
	);

	// pi#262 / smarty-dev#3155: a failed exclusive open does not confer cleanup ownership.
	it.each(["", "pre-existing content\n"])("wx collision preserves pre-existing bytes %j and memory", (content) => {
		const manager = SessionManager.create(directory, directory);
		manager.appendThinkingLevelChange("high");
		const before = snapshot(manager);
		const file = manager.getSessionFile()!;
		fs.writeFileSync(file, content);
		vi.clearAllMocks();

		expect(() => manager.appendMessage({ role: "user", content: "must not appear", timestamp: 1 })).toThrow(
			expect.objectContaining({ code: "EEXIST" }),
		);
		expectUnchanged(manager, before);
		expect(fs.readFileSync(file, "utf8")).toBe(content);
		expect(fs.openSync).toHaveBeenCalledExactlyOnceWith(file, "wx");
		expect(fs.writeFileSync).not.toHaveBeenCalled();
		expect(fs.appendFileSync).not.toHaveBeenCalled();
		expect(fs.unlinkSync).not.toHaveBeenCalled();
	});

	// pi#262 / smarty-dev#3155: cleanup errors must not replace the original persistence failure.
	it("keeps the original write error when both owned cleanup operations throw", () => {
		const manager = SessionManager.create(directory, directory);
		const before = snapshot(manager);
		const failure = new Error("primary write failure");
		const originalClose = vi.mocked(fs.closeSync).getMockImplementation()!;
		vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
			throw failure;
		});
		vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
			originalClose(fd);
			throw new Error("secondary close failure");
		});
		vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
			throw new Error("secondary unlink failure");
		});

		let caught: unknown;
		try {
			manager.appendMessage({ role: "user", content: "not committed", timestamp: 1 });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(failure);
		expectUnchanged(manager, before);
		expect(fs.unlinkSync).toHaveBeenCalledExactlyOnceWith(manager.getSessionFile());
		expect(fs.existsSync(manager.getSessionFile()!)).toBe(true);
	});

	// pi#262 / smarty-dev#3155: even a successful write is unpublished if closing fails.
	it("cleans up a failed first close and retries without publishing locations", () => {
		const manager = SessionManager.create(directory, directory);
		manager.appendThinkingLevelChange("high");
		const before = snapshot(manager);
		const failure = new Error("close failed");
		const originalClose = vi.mocked(fs.closeSync).getMockImplementation()!;
		vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
			originalClose(fd);
			throw failure;
		});
		expect(() => manager.appendMessage({ role: "user", content: "retry", timestamp: 1 })).toThrow(failure);
		expectUnchanged(manager, before);
		expect(fs.unlinkSync).toHaveBeenCalledExactlyOnceWith(manager.getSessionFile());
		const next = manager.appendMessage({ role: "user", content: "retry", timestamp: 1 });
		expect(SessionManager.open(manager.getSessionFile()!, directory).getLeafId()).toBe(next);
	});

	// pi#262 / smarty-dev#3155: retained cold records and cached branch identities survive append failure.
	it("preserves cold entries and the warmed branch cache across append failure and retry", () => {
		const writer = SessionManager.create(directory, directory);
		const root = writer.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const coldId = writer.appendCustomEntry("old-payload", "x".repeat(4096));
		for (let i = 0; i < 110; i++) writer.appendCustomEntry("padding", { i });
		writer.appendCompaction("summary", null, 100);
		const manager = SessionManager.open(writer.getSessionFile()!, directory);
		manager.branch(root);
		const cold = manager.getEntry(coldId)!;
		expect(isColdEntry(cold)).toBe(true);
		const before = snapshot(manager);
		vi.mocked(fs.appendFileSync).mockImplementationOnce(() => {
			throw new Error("cold append failed");
		});
		expect(() => manager.appendMessage({ role: "user", content: "retry", timestamp: 2 })).toThrow(
			"cold append failed",
		);
		expectUnchanged(manager, before);
		expect(manager.getEntry(coldId)).toBe(cold);
		expect(isColdEntry(cold)).toBe(true);
		const next = manager.appendMessage({ role: "user", content: "retry", timestamp: 2 });
		expect(manager.getBranch().map((entry) => entry.id)).toEqual([root, next]);
		expect(manager.getEntries().slice(0, -1)).toEqual(before.entries);
		expect(manager.getEntry(coldId)).toBe(cold);
		expect(manager.buildSessionProjection()).toEqual(buildSessionProjection(manager.getEntries(), next));
		expect(SessionManager.open(manager.getSessionFile()!, directory).getEntries()).toEqual(manager.getEntries());
	});

	// pi#262 / smarty-dev#3155: positive control retains suffix-only successful appends.
	it("persists ordinary success before publishing it and submits only the new suffix", () => {
		const manager = SessionManager.create(directory, directory);
		const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const file = manager.getSessionFile()!;
		const bytes = fs.readFileSync(file);
		const before = snapshot(manager);
		const originalAppend = vi.mocked(fs.appendFileSync).getMockImplementation()!;
		vi.clearAllMocks();
		vi.mocked(fs.appendFileSync).mockImplementationOnce((path, data, options) => {
			expectUnchanged(manager, before);
			originalAppend(path, data, options);
		});

		const next = manager.appendMessage({ role: "user", content: "next", timestamp: 2 });
		expect(manager.getEntry(next)?.parentId).toBe(root);
		expect(manager.getLeafId()).toBe(next);
		expect(manager.revision()).toBeGreaterThan(before.revision);
		expect(manager.buildSessionProjection()).toEqual(buildSessionProjection(manager.getEntries(), next));
		expect(fs.appendFileSync).toHaveBeenCalledExactlyOnceWith(file, `${JSON.stringify(manager.getEntry(next))}\n`);
		expect(fs.writeFileSync).not.toHaveBeenCalled();
		expect(fs.unlinkSync).not.toHaveBeenCalled();
		expect(fs.readFileSync(file).subarray(0, bytes.length)).toEqual(bytes);
		expect(SessionManager.open(file, directory).getEntries()).toEqual(manager.getEntries());
	});
});
