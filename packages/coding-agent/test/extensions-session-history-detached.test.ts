import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

let tempDir: string | undefined;
afterEach(() => {
	if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

// pi#132 R4-3: a late in-place edit of a captured history entry cannot change native state.
it("extension ctx.sessionManager history reads are deep-detached", async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-detached-history-"));
	const sm = SessionManager.inMemory();
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
			if (part.type === "text") part.text = "late edit";
		}
	}
	const projection = history.buildSessionProjection();
	(projection.messages[0] as { content: { text: string }[] }).content[0].text = "late edit";
	expect(
		JSON.stringify({ entries: sm.getEntries(), projection: sm.buildSessionProjection(), revision: sm.revision() }),
	).toBe(snapshot);
});
