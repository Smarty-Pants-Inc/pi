import assert from "node:assert/strict";
import { statSync, writeSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
import { createOriginalCompactionSessionIdentity } from "../../src/core/original-compaction-session-identity.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const [mode, file, expectedSize] = process.argv.slice(2);
assert.ok(mode === "fixed" || mode === "old", "Expected fixed or old child mode");
assert.ok(file, "Expected a journal path");
assert.ok(process.execArgv.includes("--max-old-space-size=1024"), "Both paths require the same 1 GiB heap cap");
// Old-space excludes V8's young generation. Pin its allowance so Node 24's
// larger default does not silently widen the fixed and historical heap budgets.
assert.ok(process.execArgv.includes("--max-semi-space-size=16"), "Expected a bounded young generation");
assert.ok(getHeapStatistics().heap_size_limit <= 1152 * 1024 * 1024, "Unexpected effective heap limit");
assert.equal(statSync(file).size, Number(expectedSize));

const manager = SessionManager.open(file);
assert.equal(manager.getSessionId(), "identity-heavy");
assert.equal(manager.getEntryCount(), 401);
assert.equal(manager.getLeafId(), "tail-99");
const loadedBranch = manager.getBranchIdentity();
assert.equal(loadedBranch.entries.length, 401);
assert.equal(loadedBranch.entries[0]?.id, "checkpoint");
assert.equal(loadedBranch.entries[300]?.id, "body-299");
assert.equal(manager.buildSessionProjection().messages.length, 301);
// Synchronous output survives a fatal OOM. Loader errors, invalid journals, and
// setup OOMs cannot satisfy the parent's old-path regression assertion.
writeSync(1, `IDENTITY_READY ${mode} ${expectedSize} 401\n`);

if (mode === "fixed") {
	const identity = createOriginalCompactionSessionIdentity(manager);
	identity.check();
	for (const customType of [
		"smarty-sense:count-reservation-v1",
		"smarty-sense:count-qualification-v1",
		"smarty-sense:provider-reservation-v1",
		"smarty-sense:provider-usage-v1",
	]) {
		manager.appendCustomEntry(customType, { amount: 1 });
		identity.check();
	}
	writeSync(1, "FIXED_ACCOUNTING_CHECKED\n");
	manager.appendMessage({ role: "user", content: "concurrent context mutation", timestamp: 1 });
	assert.throws(() => identity.check(), /OPS_COMPACTION_SESSION_CHANGED/);
	writeSync(1, "FIXED_MUTATION_REJECTED\n");
} else {
	// #11897 / pi#242: copied from AgentSession's original-compaction fence at
	// ceea64516a6191a280a84e759b71f604ae0cb706^:packages/coding-agent/src/core/agent-session.ts
	// (replaced by that commit around line 5022). Only `this.sessionManager` is
	// renamed to `manager`. Keep the retained baseline and second serialization:
	// per-entry serialization, hashing, or discarding the baseline would hide the bug.
	const branchIdentity = () =>
		JSON.stringify(
			manager
				.getBranch()
				.filter(
					(entry) =>
						!(
							entry.type === "custom" &&
							[
								"smarty-sense:count-reservation-v1",
								"smarty-sense:count-qualification-v1",
								"smarty-sense:provider-reservation-v1",
								"smarty-sense:provider-usage-v1",
							].includes(entry.customType)
						),
				),
		);
	const branch = branchIdentity();
	writeSync(1, "OLD_BASELINE_CREATED\n");
	manager.appendCustomEntry("smarty-sense:provider-usage-v1", { amount: 1 });
	if (branchIdentity() !== branch) throw new Error("OPS_COMPACTION_SESSION_CHANGED");
	// This is deliberately a normal successful exit if V8 can fit the historical
	// path: the parent must fail rather than manufacturing an OOM or abort signal.
	writeSync(1, "OLD_SURVIVED\n");
}
