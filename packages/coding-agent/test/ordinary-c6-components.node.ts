import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ordinaryClock, readOrdinaryClockPreparation } from "../src/core/ordinary-clock.ts";
import { projectClockNanoseconds } from "../src/core/ordinary-clock-evidence.ts";
import { OrdinaryOperationalAudit } from "../src/core/ordinary-operational-audit.ts";

// Actual component code, synthetic DATA only, no mocked modules, clock/native
// suppliers or admission flags. Fresh Node24 and Bun processes; all UNRUN.
// These positives do NOT construct canonical composition, native witnesses,
// original setup, physical receipts or a shortened operational plan.

for (const maxBracketNs of ["1", "1000000000"]) {
	test(`A1 actual pre-A DATA decoder preserves selected ceiling ${maxBracketNs}`, () => {
		const guardSource = { path: "/component-input/guard.ts", sha256: "a".repeat(64) };
		const bytes = Buffer.from(
			JSON.stringify({
				clockPreparation: {
					version: 1,
					kind: "original-native-clock-preparation",
					maxBracketNs,
					guardSource,
				},
			}),
		);
		const producer = {
			path: "/component-input/producer.json",
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
		const value = readOrdinaryClockPreparation(producer, bytes);
		assert.deepEqual(value, { maxBracketNs, guardSource });
		value.guardSource.path = "/component-input/other.ts";
		assert.deepEqual(readOrdinaryClockPreparation(producer, bytes), { maxBracketNs, guardSource });
		// These are decoder operands, not held files or an admitted producer. Never
		// call prepareOrdinaryClock with them or claim this prepared a native clock.
	});
}

for (const [ns, ms, error] of [
	["0", 0, "0"],
	["1000000", 1, "0"],
	["1000001", 1.000001, "1"],
] as const) {
	test(`A2 actual integer display projection ${ns}`, () => {
		assert.deepEqual(projectClockNanoseconds(ns), { monotonicNs: ns, monotonicMs: ms, conversionErrorNs: error });
	});
}

test("A3 actual raw clock and audit window preserve unqualified observations", () => {
	const scope = {
		ownerEpoch: "component-epoch",
		sessionId: "component-session",
		allocationId: "component-allocation",
	};
	const audit = new OrdinaryOperationalAudit(scope, 8, 65536);
	assert.equal(audit.clockForCore(), ordinaryClock);
	const start = ordinaryClock.monotonic();
	const window = audit.begin();
	audit.event("owner", "component-observation");
	const result = audit.finish(window);
	assert.deepEqual(result.scope, scope);
	assert.equal(result.events.length, 1);
	assert.equal(result.events[0].kind, "component-observation");
	assert.equal(result.events[0].sequence, result.startSequence + 1);
	assert.equal(result.endSequence, result.startSequence + 1);
	assert.ok(result.startedAt && result.startedAt.monotonicMs >= start);
	assert.ok(result.finishedAt.monotonicMs >= result.startedAt.monotonicMs);
	for (const stamp of [result.startedAt, result.events[0].at, result.finishedAt]) {
		assert.equal(stamp.clockId, result.clockIdentity.id);
		assert.equal(stamp.uncertaintyMs, null);
		assert.equal(stamp.parent, undefined);
		assert.equal(stamp.clockSequence, undefined);
		assert.ok(Number.isFinite(stamp.wallMs));
	}
	assert.equal(result.coverage, "unknown");
	assert.equal(result.lost, false);
	assert.equal(result.nativeEventsComplete, false);
	assert.ok(result.missing.includes("qualified clock mapping"));
	audit.close(); // No native owner was constructed or retired by this component.
});

test("A4 original scheduling callbacks remain asynchronous and cancellable", async () => {
	let cancelledRan = false;
	const cancelled = ordinaryClock.setTimeout(() => {
		cancelledRan = true;
	}, 0);
	ordinaryClock.clearTimeout(cancelled);
	let inline = true;
	await new Promise<void>((resolve, reject) => {
		ordinaryClock.setTimeout(() => {
			try {
				assert.equal(inline, false);
				assert.equal(cancelledRan, false);
				resolve();
			} catch (cause) {
				reject(cause);
			}
		}, 0);
		inline = false;
	});
});
