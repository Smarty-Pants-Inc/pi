import assert from "node:assert/strict";
import { existsSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import { exportSessionToJsonl, serializeSessionBranch } from "../../src/core/session-export.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const [mode, scratch] = process.argv.slice(2);
assert.ok(
	mode === "fixed-keys" || mode === "fixed-buffer" || mode === "old-buffer",
	"Expected fixed-keys, fixed-buffer or old-buffer",
);
assert.ok(scratch && existsSync(scratch), "Expected an existing scratch directory");
assert.ok(process.execArgv.includes("--max-old-space-size=1024"), "All modes require the same 1 GiB heap cap");
// Pin the young generation so Node 22 and 24 share one heap budget.
assert.ok(process.execArgv.includes("--max-semi-space-size=16"), "Expected a bounded young generation");
assert.ok(getHeapStatistics().heap_size_limit <= 1152 * 1024 * 1024, "Unexpected effective heap limit");
const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "Expected --expose-gc");

const KEY_COUNT = 10_000_000;
const BUFFER_BYTES = 512 * 1024 * 1024;

/**
 * Retained heap AFTER two forced full GCs. This is not a transient peak: garbage freed
 * during an export call is not visible here. The fixed 1 GiB old-space cap bounds peaks.
 */
function retainedHeapAfterGc(): number {
	gc!();
	gc!();
	return process.memoryUsage().heapUsed;
}

/** Each refusal must leave no output file behind; a thrown error is the only acceptable outcome. */
function expectRefused(label: string, run: () => unknown, pattern: RegExp): void {
	assert.throws(run, pattern, label);
	writeSync(1, `REFUSED ${label} retainedHeapAfterGc=${retainedHeapAfterGc()}\n`);
}

const manager = SessionManager.inMemory(scratch);
manager.appendMessage({ role: "user", content: "seed input", timestamp: 1 });

if (mode === "fixed-keys") {
	// Array-index keys on a plain {}: V8 builds 10M named dictionary keys too slowly
	// for a bounded test, so named-key scale is measured separately (see PR notes).
	const payload: Record<number, number> = {};
	for (let index = 0; index < KEY_COUNT; index++) payload[index] = 0;
	manager.appendCustomEntry("heavy-keys", { payload });
	const trailing = () => [{ type: "custom", customType: "heavy-keys-trailing", data: { payload } }];
	const retainedBeforeAfterGc = retainedHeapAfterGc();
	// Synchronous output survives a fatal OOM, separating setup from export.
	writeSync(1, `EXPORT_READY ${mode} ${KEY_COUNT} retainedHeapAfterGc=${retainedBeforeAfterGc}\n`);
	expectRefused("live-string", () => serializeSessionBranch(manager), /64 MiB/);
	expectRefused("live-jsonl", () => exportSessionToJsonl(manager, join(scratch, "live-keys.jsonl")), /64 MiB/);
	const trailingManager = SessionManager.inMemory(scratch);
	trailingManager.appendMessage({ role: "user", content: "seed input", timestamp: 1 });
	expectRefused("trailing-string", () => serializeSessionBranch(trailingManager, trailing), /64 MiB/);
	expectRefused(
		"trailing-jsonl",
		() => exportSessionToJsonl(trailingManager, join(scratch, "trailing-keys.jsonl"), trailing),
		/64 MiB/,
	);
	assert.ok(!existsSync(join(scratch, "live-keys.jsonl")) && !existsSync(join(scratch, "trailing-keys.jsonl")));
	assert.ok(Object.hasOwn(payload, KEY_COUNT - 1));
	writeSync(1, `FIXED_KEYS_REFUSED retainedGrowthAfterGc=${retainedHeapAfterGc() - retainedBeforeAfterGc}\n`);
} else {
	const payload = Buffer.alloc(BUFFER_BYTES, 1);
	manager.appendCustomEntry("heavy-buffer", { payload });
	const trailing = () => [{ type: "custom", customType: "heavy-buffer-trailing", data: { payload } }];
	writeSync(1, `EXPORT_READY ${mode} ${BUFFER_BYTES} retainedHeapAfterGc=${retainedHeapAfterGc()}\n`);
	if (mode === "fixed-buffer") {
		// Nested data-valued hooks run once per attempt; each returned Buffer snapshot is size-bounded.
		const original = Buffer.prototype.toJSON;
		let hookCalls = 0;
		Buffer.prototype.toJSON = function (this: Buffer) {
			hookCalls++;
			return original.call(this);
		};
		const trailingManager = SessionManager.inMemory(scratch);
		trailingManager.appendMessage({ role: "user", content: "seed input", timestamp: 1 });
		const expectHookRefused = (label: string, run: () => unknown) => {
			const callsBefore = hookCalls;
			expectRefused(label, run, /64 MiB/);
			assert.equal(hookCalls - callsBefore, 1);
		};
		expectHookRefused("live-string", () => serializeSessionBranch(manager));
		expectHookRefused("live-jsonl", () => exportSessionToJsonl(manager, join(scratch, "live-buffer.jsonl")));
		expectHookRefused("trailing-string", () => serializeSessionBranch(trailingManager, trailing));
		expectHookRefused("trailing-jsonl", () =>
			exportSessionToJsonl(trailingManager, join(scratch, "trailing-buffer.jsonl"), trailing),
		);
		assert.ok(!existsSync(join(scratch, "live-buffer.jsonl")) && !existsSync(join(scratch, "trailing-buffer.jsonl")));
		writeSync(1, "FIXED_BUFFER_REFUSED\n");
	} else {
		// Unguarded per-entry line from ceea64516:packages/coding-agent/src/core/session-export.ts
		// (exportSessionToJsonl, `JSON.stringify(entry)`), which invokes Buffer.prototype.toJSON.
		const entry = manager.getEntry(manager.getLeafId()!)!;
		const line = Buffer.from(`${JSON.stringify({ ...entry, parentId: entry.parentId })}\n`);
		writeSync(1, `OLD_BUFFER_SERIALIZED ${line.length}\n`);
	}
}
