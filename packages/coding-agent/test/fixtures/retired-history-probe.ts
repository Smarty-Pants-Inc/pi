// smarty-dev#11897 / #14576 P2-2: caches must release retired hot AND cold payloads.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detachedSessionView, SessionManager } from "../../src/core/session-manager.ts";

assert(global.gc);
const mode = process.argv[2] ?? "list";
const gc = () => {
	global.gc!();
	global.gc!();
	return process.memoryUsage().heapUsed;
};
const root = mkdtempSync(join(tmpdir(), "pi-retired-history-"));
const baseline = gc();
try {
	const retained = (() => {
		const manager = SessionManager.create(root, root);
		manager.appendMessage({ role: "user", content: "flush", timestamp: 1 });
		const id = manager.appendCustomEntry("retired", { text: "x".repeat(32 * 1024 * 1024), values: [1] });
		const view = detachedSessionView(manager);
		// First select while the 32 MiB graph is hot: a strong cache must be invalidated on cooling.
		if (mode === "projection") view.buildSessionProjection();
		else view.getEntries();
		for (let i = 0; i < 110; i++) manager.appendCustomEntry("metadata", { i });
		manager.appendCompaction("checkpoint", null, 100);
		return { manager, view, id };
	})();
	await new Promise<void>((resolve) => setImmediate(resolve));
	const cooledBytes = gc() - baseline;
	assert(cooledBytes < 16 * 1024 * 1024, `cooled history retained ${cooledBytes} bytes`);
	(() => {
		const entry = retained.view.getEntry(retained.id);
		assert(entry?.type === "custom");
		const data = entry.data as { text: string; values: number[] };
		assert.equal(data.text.length, 32 * 1024 * 1024);
		assert(Object.isFrozen(data));
		assert.throws(() => data.values.push(2), TypeError);
		if (mode === "projection") {
			retained.manager.branch(retained.id);
			retained.view.buildSessionProjection();
		} else retained.view.getEntries();
		retained.manager.newSession();
	})();
	await new Promise<void>((resolve) => setImmediate(resolve));
	const retainedBytes = gc() - baseline;
	console.log(
		`REPORT ${JSON.stringify({ mode: `retire-${mode}`, cooledBytes, retainedBytes, budget: 16 * 1024 * 1024 })}`,
	);
	assert(retainedBytes < 16 * 1024 * 1024, `retired history retained ${retainedBytes} bytes`);
	assert.equal(retained.manager.getEntryCount(), 0);
	assert.equal(retained.view.getSessionId(), retained.manager.getSessionId());
} finally {
	rmSync(root, { recursive: true, force: true });
}
