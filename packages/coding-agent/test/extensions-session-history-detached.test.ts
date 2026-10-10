import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

// pi#163 post-merge P2s: extensions share immutable persisted-JSON history snapshots.
it.each([
	["typed-array", new Uint8Array([1, 255]), { "0": 1, "1": 255 }],
	["map", new Map([["original", 1]]), {}],
	["set", new Set([1]), {}],
] as const)("extension contexts cannot poison later %s custom-entry reads", async (customType, data, expected) => {
	const sm = SessionManager.inMemory();
	const id = sm.appendCustomEntry(customType, data);
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const runners = [0, 1].map(() => new ExtensionRunner([], {} as never, process.cwd(), sm, registry));
	const first = runners[0].createContext().sessionManager.getEntry(id);
	if (first?.type !== "custom") throw new Error("missing custom entry");
	expect(first.data).toEqual(expected);
	expect(Object.getPrototypeOf(first.data)).toBe(Object.prototype);
	expect(Object.isFrozen(first.data)).toBe(true);
	expect(Reflect.set(first.data as object, "poisoned", true)).toBe(false);
	const later = runners[1].createContext().sessionManager.getEntry(id);
	expect(later).toBe(first);
	if (later?.type !== "custom") throw new Error("missing later custom entry");
	expect(later.data).toEqual(expected);
});

let tempDir: string | undefined;
afterEach(() => {
	if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

// pi#132 R4-3: a late in-place edit of a captured history entry cannot change native state.
it("extension ctx.sessionManager history reads are deep-detached", async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-detached-history-"));
	const sm = SessionManager.create(tempDir, tempDir);
	sm.appendMessage({ role: "user", content: [{ type: "text", text: "original" }], timestamp: 1 });
	const runner = new ExtensionRunner(
		[],
		{} as never,
		tempDir,
		sm,
		await createInMemoryModelRegistry(AuthStorage.inMemory()),
	);
	const history = runner.createContext().sessionManager;
	const before = { entries: sm.getEntries(), projection: sm.buildSessionProjection(), revision: sm.revision() };
	const snapshot = JSON.stringify(before);
	const journalBytes = fs.readFileSync(sm.getSessionFile()!);
	const captured = [
		...history.getEntries(),
		...history.getBranch(),
		...history.buildContextEntries(),
		history.getLeafEntry(),
		history.getEntry(before.entries[0].id),
		...history.getTree().map((node) => node.entry),
	];
	for (const entry of captured) {
		if (entry?.type === "message" && entry.message.role === "user" && Array.isArray(entry.message.content)) {
			const part = entry.message.content[0];
			if (part.type === "text")
				expect(() => {
					part.text = "late edit";
				}).toThrow(TypeError);
		}
	}
	const projection = history.buildSessionProjection();
	expect(() => {
		(projection.messages[0] as { content: { text: string }[] }).content[0].text = "late edit";
	}).toThrow(TypeError);
	expect(
		JSON.stringify({ entries: sm.getEntries(), projection: sm.buildSessionProjection(), revision: sm.revision() }),
	).toBe(snapshot);
	expect(fs.readFileSync(sm.getSessionFile()!)).toEqual(journalBytes);
});
