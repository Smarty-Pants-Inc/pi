import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { detachedSessionView, type FileEntry, SessionManager } from "../../src/core/session-manager.ts";

let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

// smarty-dev#14576 P2-1: caller-owned ordinary JSON must not change history after publication.
it("owns message, custom data, details, and context edits without freezing caller inputs", () => {
	root = mkdtempSync(join(tmpdir(), "pi-publication-"));
	const manager = SessionManager.create(root, root);
	const message = { role: "user" as const, content: [{ type: "text" as const, text: "original" }], timestamp: 1 };
	const user = manager.appendMessage(message);
	const shared = { values: [1] };
	const data = { nested: shared, same: shared };
	const custom = manager.appendCustomEntry("publish", data);
	const details = { values: [1] };
	const customMessage = manager.appendCustomMessageEntry("publish", [{ type: "text", text: "custom" }], true, details);
	const replacement = { content: [{ type: "text" as const, text: "edited" }] };
	manager.appendContextEdit(user, replacement);
	const history = detachedSessionView(manager);
	const before = JSON.stringify({
		entries: history.getEntries(),
		context: history.buildSessionProjection(),
		revision: manager.revision(),
	});
	const bytes = readFileSync(manager.getSessionFile()!);
	message.content[0].text = "poisoned";
	data.nested.values.push(2);
	details.values.push(2);
	replacement.content[0].text = "poisoned";
	expect(Object.isFrozen(message.content)).toBe(false);
	expect(Object.isFrozen(data.nested)).toBe(false);
	expect(Object.isFrozen(details)).toBe(false);
	expect(
		JSON.stringify({
			entries: history.getEntries(),
			context: history.buildSessionProjection(),
			revision: manager.revision(),
		}),
	).toBe(before);
	expect(readFileSync(manager.getSessionFile()!)).toEqual(bytes);
	const expected = history.getEntry(custom);
	for (const entry of [
		history.getEntry(custom),
		history.getEntries()[1],
		history.getBranch(custom).at(-1),
		history.buildContextEntries()[1],
		history.getTree()[0].children[0].entry,
	]) {
		expect(entry).toEqual(expected);
		if (entry?.type !== "custom") throw new Error("missing custom entry");
		expect(() => (entry.data as { nested: { values: number[] } }).nested.values.push(3)).toThrow(TypeError);
	}
	expect(manager.getEntry(customMessage)).toEqual(history.getEntry(customMessage));
	expect(SessionManager.open(manager.getSessionFile()!).getEntries()).toEqual(history.getEntries());
	const context = manager.buildSessionProjection().messages[0];
	if (context.role !== "user" || !Array.isArray(context.content)) throw new Error("missing projected user");
	if (context.content[0].type === "text") context.content[0].text = "local model view";
	expect(JSON.stringify(history.getEntries())).toBe(JSON.stringify(JSON.parse(before).entries));
});

// Cold-entry status alone must not bless unrelated caller-defined getters.
it("detaches unsafe SDK getters even beside trusted lazy disk fields", () => {
	root = mkdtempSync(join(tmpdir(), "pi-cold-accessor-"));
	const manager = SessionManager.create(root, root);
	manager.appendMessage({ role: "user", content: "flush", timestamp: 1 });
	const values = [1];
	const details = {
		get values() {
			return values;
		},
	};
	const id = manager.appendCustomMessageEntry("accessor", "x".repeat(2048), true, details);
	for (let i = 0; i < 110; i++) manager.appendCustomEntry("padding", { i });
	manager.appendCompaction("checkpoint", null, 1);
	const view = detachedSessionView(manager);
	for (const entry of [
		view.getEntry(id),
		view.getEntries().find((entry) => entry.id === id),
		view.getBranch(id).at(-1),
	]) {
		if (entry?.type !== "custom_message") throw new Error("missing accessor entry");
		const snapshot = entry.details as { values: number[] };
		expect(() => snapshot.values.push(2)).toThrow(TypeError);
	}
	expect(values).toEqual([1]);
	expect(Object.isFrozen(details)).toBe(false);
});

it("owns preloaded JSON payloads while preserving non-JSON in-memory state", () => {
	const entries: FileEntry[] = [
		{ type: "session", version: 3, id: "import", timestamp: "2026-10-18T00:00:00.000Z", cwd: "/synthetic" },
		{
			type: "custom",
			id: "a",
			parentId: null,
			timestamp: "2026-10-18T00:00:00.000Z",
			customType: "import",
			data: { values: [1] },
		},
	];
	const manager = SessionManager.inMemory("/synthetic", undefined, entries);
	const before = JSON.stringify(manager.getEntries());
	if (entries[1].type !== "custom") throw new Error("missing import");
	(entries[1].data as { values: number[] }).values.push(2);
	expect(JSON.stringify(manager.getEntries())).toBe(before);
	const cycle: { self?: unknown } = {};
	cycle.self = cycle;
	const cyclic = manager.appendCustomEntry("cycle", cycle);
	expect(manager.getEntry(cyclic)).toMatchObject({ data: cycle });
	expect(() => detachedSessionView(manager).getEntry(cyclic)).toThrow(TypeError);
	expect(Object.isFrozen(cycle)).toBe(false);
});
