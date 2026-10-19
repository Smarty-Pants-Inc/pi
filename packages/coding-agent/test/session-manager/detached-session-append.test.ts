import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { detachedSessionView, SessionManager } from "../../src/core/session-manager.ts";

const historyRoutes = ["getEntries", "getBranch", "buildContextEntries", "buildSessionProjection"] as const;
let dir: string | undefined;
afterEach(() => {
	vi.restoreAllMocks();
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

// pi#291 / smarty-dev#14609: count entry visits, not wall-clock timing, for the real regression.
it.each(historyRoutes)("extends cached %s after appends by visiting only new entries", (route) => {
	const manager = SessionManager.inMemory();
	for (let i = 0; i < 2_000; i++) manager.appendCustomEntry("old", { i });
	const view = detachedSessionView(manager);
	const before = view[route]();
	const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptors");
	manager.appendMessage({ role: "user", content: "new", timestamp: 1 });
	manager.appendCustomEntry("new", { nested: [1] });
	const names = vi.spyOn(Object, "getOwnPropertyNames");
	const after = view[route]();
	const wrapperVisits = descriptors.mock.calls.length;
	const chargeVisits = names.mock.calls.length;
	descriptors.mockRestore();
	names.mockRestore();
	expect(wrapperVisits).toBe(2);
	expect(chargeVisits).toBeLessThanOrEqual(3);
	const oldEntries = Array.isArray(before) ? before : before.entries;
	const newEntries = Array.isArray(after) ? after : after.entries;
	expect(newEntries[1_000]).toBe(oldEntries[1_000]);
	expect(after).toEqual(
		detachedSessionView(
			SessionManager.inMemory("/synthetic", undefined, [manager.getHeader()!, ...manager.getEntries()]),
		)[route](),
	);
	expect(view[route]()).toBe(after);
	expect(after).not.toBe(before);
	expect(Object.isFrozen(after)).toBe(true);
	if (Array.isArray(before)) expect(before).toHaveLength(2_000);
	else expect(before.entries).toHaveLength(2_000);
});

// Every invalidating mutation must retire cached wrappers, even when no read follows the mutation.
it.each(
	(
		["branch", "reset", "summary", "compaction", "edit", "new", "reload", "rewrite", "fork", "cool", "heat"] as const
	).flatMap((mutation) => historyRoutes.map((route) => ({ mutation, route }))),
)("rebuilds $route after $mutation", ({ mutation, route }) => {
	dir = mkdtempSync(join(tmpdir(), "pi-append-invalidate-"));
	const manager = SessionManager.create(dir, dir);
	const first = manager.appendMessage({ role: "user", content: "original".repeat(10_000), timestamp: 1 });
	for (let i = 0; i < 120; i++) manager.appendCustomEntry("old", { i });
	if (mutation === "heat") manager.appendCompaction("cold", null, 100);
	const view = detachedSessionView(manager);
	const before = view[route]();
	manager.appendCustomEntry("pending-before-mutation", {});
	if (mutation === "branch" || mutation === "heat") manager.branch(first);
	else if (mutation === "reset") manager.resetLeaf();
	else if (mutation === "summary") manager.branchWithSummary(first, "branch summary");
	else if (mutation === "compaction" || mutation === "cool") manager.appendCompaction("summary", null, 100);
	else if (mutation === "edit") manager.appendContextEdit(first, { content: "edited" });
	else if (mutation === "new") manager.newSession();
	else if (mutation === "reload") manager.setSessionFile(manager.getSessionFile()!);
	else if (mutation === "fork") manager.createBranchedSession(first);
	else (manager as unknown as { _rewriteFile(): void })._rewriteFile();
	const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptors");
	const after = view[route]();
	const visits = descriptors.mock.calls.length;
	descriptors.mockRestore();
	expect(after).not.toBe(before);
	expect(after).toEqual(manager[route]());
	const length = Array.isArray(after) ? after.length : after.entries.length;
	if (length) expect(visits).toBeGreaterThanOrEqual(length);
});

it("does not materialize old exceptional lazy payloads while extending a list", () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("exceptional", { map: new Map([["one", 1]]) });
	const view = detachedSessionView(manager);
	const before = view.getEntries();
	manager.appendCustomEntry("new", { nested: [2] });
	const serialize = vi.spyOn(JSON, "stringify");
	const after = view.getEntries();
	expect(serialize).not.toHaveBeenCalled();
	expect(Object.getOwnPropertyDescriptor(after, "0")?.get).toBe(Object.getOwnPropertyDescriptor(before, "0")?.get);
	expect(after).toHaveLength(2);
	serialize.mockRestore();
	expect(after[0]).toEqual(before[0]);
	expect(after).toEqual(manager.getEntries().map((entry) => JSON.parse(JSON.stringify(entry))));
});

it("does not extend an explicit ancestor branch with descendants", () => {
	const manager = SessionManager.inMemory();
	const id = manager.appendCustomEntry("ancestor", {});
	const view = detachedSessionView(manager);
	const before = view.getBranch(id);
	manager.appendCustomEntry("descendant", {});
	const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptors");
	const after = view.getBranch(id);
	const visits = descriptors.mock.calls.length;
	descriptors.mockRestore();
	expect(after).toBe(before);
	expect(visits).toBe(0);
	expect(view.getBranch(id)).toHaveLength(1);
});

it("preserves prior context edits and settings when extending a cached projection", () => {
	const manager = SessionManager.inMemory();
	const user = manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
	manager.appendContextEdit(user, { content: "edited" });
	const view = detachedSessionView(manager);
	const before = view.buildSessionProjection();
	manager.appendThinkingLevelChange("high");
	manager.appendModelChange("faux", "new-model");
	manager.appendCustomMessageEntry("visible", "new custom", true, { nested: [1] });
	const after = view.buildSessionProjection();
	expect(after).toEqual(manager.buildSessionProjection());
	expect(after.thinkingLevel).toBe("high");
	expect(after.model).toEqual({ provider: "faux", modelId: "new-model" });
	expect(before.messages).toHaveLength(1);
	expect(after.entries[0]).toBe(before.entries[0]);
	expect(Object.isFrozen(after.messages.at(-1))).toBe(true);
});
