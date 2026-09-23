import assert from "node:assert/strict";
import { test } from "node:test";
import { assertOriginalCompactionAttempt, OriginalCompaction } from "../src/core/ordinary-compaction.ts";
import { OrdinaryOperationalAudit } from "../src/core/ordinary-operational-audit.ts";
import { OrdinaryOwnerContext } from "../src/core/ordinary-owner-context.ts";
import { OrdinarySc085Setup } from "../src/core/ordinary-sc085-setup.ts";
import {
	abortOrdinaryExposure,
	beginOrdinaryExposure,
	commitOrdinaryExposure,
	compactOrdinarySession,
	createOrdinaryRuntime,
	deliverOrdinaryExposure,
	ordinaryClock,
	receiveOrdinaryOperationalCollector,
	receiveOrdinarySenseComposition,
} from "../src/ordinary.ts";

// C6 revised-boundary definitions. Actual Pi implementation, no module mocks,
// constructor bypass that succeeds, source setter, callback registration or native
// receipt double. Invalid casts below are intentional hostile inputs, NEVER grants.
// Run in a fresh process on BOTH Node24 and Bun only after original source/closure
// admission. Currently UNRUN. These negatives are NOT genuine composed positives,
// native lifecycle proof, or substitutes for legacy constructor/species evidence.

function hostileRecord(names: readonly string[], accessed: () => void): object {
	const value = Object.create(null) as object;
	for (const name of names)
		Object.defineProperty(value, name, {
			get() {
				accessed();
				throw undefined;
			},
		});
	return Object.freeze(value);
}

test("actual shared clock has no generic capture or inherited capture surface", () => {
	assert.equal(Object.getPrototypeOf(ordinaryClock), null);
	assert.equal(Object.isFrozen(ordinaryClock), true);
	assert.equal("capture" in ordinaryClock, false);
});

test("actual runtime rejects supplied operational hooks before owner or hook reads", async () => {
	let accesses = 0;
	const owner = hostileRecord(["owner", "decision", "assertActive", "close"], () => {
		accesses++;
	});
	const hooks = hostileRecord(["executor", "opened", "wakeIntention", "sc085SetupReceiver"], () => {
		accesses++;
	});
	await assert.rejects(
		createOrdinaryRuntime(owner as never, "/not-an-admitted-agent-directory", hooks),
		/OWNER_OPERATIONAL_CALLBACKS_UNSUPPORTED/,
	);
	assert.equal(accesses, 0);
});

for (const poison of ["constructor", "species"] as const) {
	test(`actual runtime rejects legacy ${poison} supplier before its rejected Promise exists`, async () => {
		let calls = 0,
			reads = 0;
		const supplier = () => {
			calls++;
			const original = Promise.reject(new Error("forbidden original rejection"));
			const descriptor = {
				configurable: false,
				get() {
					reads++;
					throw undefined;
				},
			};
			if (poison === "constructor") Object.defineProperty(original, "constructor", descriptor);
			else
				Object.defineProperty(original, "constructor", {
					configurable: false,
					value: Object.defineProperty({}, Symbol.species, descriptor),
				});
			return original;
		};
		await assert.rejects(
			createOrdinaryRuntime({} as never, "/not-an-admitted-agent-directory", supplier),
			/OWNER_OPERATIONAL_CALLBACKS_UNSUPPORTED/,
		);
		assert.equal(calls, 0);
		assert.equal(reads, 0);
	});
}

test("actual factory binding rejects a prototype imitation without invoking its supplier", () => {
	let calls = 0;
	const foreign = Object.create(OrdinaryOwnerContext.prototype) as OrdinaryOwnerContext;
	const supplier = async () => {
		calls++;
		throw undefined;
	};
	assert.throws(() => foreign.bindFactory(supplier), /OWNER_RUNTIME_ORIGINAL_FACTORY_REQUIRED/);
	assert.equal(calls, 0);
});

test("actual collector verifier rejects prebinding before context/token/recorder member access", () => {
	let accesses = 0;
	const foreign = hostileRecord(
		[
			"owner",
			"sessionId",
			"ownerEpoch",
			"allocationId",
			"record",
			"retained",
			"request",
			"exposure",
			"usage",
			"hooks",
			"originalOperationalRecorder",
		],
		() => {
			accesses++;
		},
	);
	assert.throws(
		() => receiveOrdinaryOperationalCollector(foreign as never, foreign, foreign),
		/OWNER_COLLECTOR_ORIGINAL_INTENT_REQUIRED/,
	);
	assert.equal(accesses, 0);
});

test("actual Core receiver rejects equal-looking scope and the real clock without an original token", () => {
	let accesses = 0;
	const foreign = hostileRecord(["scope", "epoch", "isCurrent", "ownerIdentity"], () => {
		accesses++;
	});
	assert.throws(
		() => receiveOrdinarySenseComposition(Object.freeze({}), foreign, ordinaryClock),
		/OWNER_SENSE_ORIGINAL_COMPOSITION_REQUIRED/,
	);
	assert.equal(accesses, 0);
});

test("actual setup registration rejects every legacy callable before invocation", () => {
	const scope = { ownerEpoch: "epoch", sessionId: "session", allocationId: "allocation" };
	const audit = new OrdinaryOperationalAudit(scope, 8, 65536);
	let calls = 0;
	const supplied = () => {
		calls++;
		throw undefined;
	};
	assert.throws(
		() =>
			Reflect.apply(audit.registerValidatedSetupReceiver, audit, [supplied, { get: supplied }, supplied, supplied]),
		/OWNER_SC085_SETUP_CALLBACKS_UNSUPPORTED/,
	);
	assert.throws(() => audit.registerValidatedSetupReceiver(supplied as never), /OWNER_PROFILE_UNAVAILABLE/);
	assert.equal(calls, 0);
	assert.equal("receiveValidatedSetup" in audit, false);
});

test("actual setup ledger and checkpoint reject foreign custody before any member or event read", () => {
	const scope = { ownerEpoch: "epoch", sessionId: "session", allocationId: "allocation" };
	const ledger = new OrdinarySc085Setup(scope, 65536);
	const audit = new OrdinaryOperationalAudit(scope, 8, 65536);
	let accesses = 0;
	const foreign = hostileRecord(
		[
			"operationalAudit",
			"originalSetupReceiving",
			"assertActive",
			"get",
			"record",
			"baseline",
			"setup",
			"settlement",
		],
		() => {
			accesses++;
		},
	);
	assert.throws(
		() => ledger.receive(foreign as never, foreign as never, foreign as never),
		/OWNER_PROFILE_UNAVAILABLE/,
	);
	assert.throws(() => ledger.checkpoint(foreign as never, foreign as never), /OWNER_PROFILE_UNAVAILABLE/);
	assert.throws(() => audit.validateSc085Checkpoint(foreign as never, foreign as never), /OWNER_PROFILE_UNAVAILABLE/);
	assert.throws(() => audit.registerValidatedSetupReceiver(foreign as never), /OWNER_PROFILE_UNAVAILABLE/);
	assert.throws(
		() => Reflect.apply(OrdinaryOwnerContext.prototype.originalSetupReceiving, foreign, [ledger]),
		/OWNER_SC085_SETUP_ORIGINAL_OWNER_REQUIRED/,
	);
	assert.throws(() => audit.assertOriginalSetup(ledger), /OWNER_SC085_SETUP_ORIGINAL_LEDGER_REQUIRED/);
	assert.equal(accesses, 0);
});

test("actual setup helper cannot retain the old record/current callback entry", () => {
	const ledger = new OrdinarySc085Setup({ ownerEpoch: "e", sessionId: "s", allocationId: "a" }, 65536);
	let calls = 0;
	const supplied = () => {
		calls++;
		throw undefined;
	};
	assert.throws(
		() => Reflect.apply(ledger.receive, ledger, [{}, {}, { get: supplied }, supplied, supplied]),
		/OWNER_SC085_SETUP_CALLBACKS_UNSUPPORTED/,
	);
	assert.equal(calls, 0);
});

test("all four actual exposure edges reject forged capability before DATA/member reads", () => {
	let accesses = 0;
	const foreign = hostileRecord(["scope", "frame", "receipt", "ticket", "phase", "requestId", "then"], () => {
		accesses++;
	});
	assert.throws(
		() => beginOrdinaryExposure(foreign, foreign as never, foreign as never),
		/OWNER_EXPOSURE_ORIGINAL_OWNER_REQUIRED/,
	);
	assert.throws(() => commitOrdinaryExposure(foreign, foreign), /OWNER_EXPOSURE_ORIGINAL_OWNER_REQUIRED/);
	assert.throws(() => deliverOrdinaryExposure(foreign, foreign), /OWNER_EXPOSURE_ORIGINAL_OWNER_REQUIRED/);
	assert.throws(() => abortOrdinaryExposure(foreign, foreign, undefined), /OWNER_EXPOSURE_ORIGINAL_OWNER_REQUIRED/);
	assert.equal(accesses, 0);
});

// Actual authentication negatives, not substitutes for B7's genuine same-owner
// execution through the original Sense command, retained method and provider.
test("actual compaction entry rejects foreign owner before receiving or signal reads", async () => {
	let accesses = 0;
	const foreign = hostileRecord(["owner", "compactOriginal", "compactionEvidence", "signal", "throwIfAborted"], () => {
		accesses++;
	});
	await assert.rejects(
		compactOrdinarySession(foreign as never, foreign as never, foreign as never),
		/OWNER_PROFILE_UNAVAILABLE/,
	);
	assert.equal(accesses, 0);
});

test("actual compaction driver rejects foreign context before method selection or signal reads", async () => {
	let accesses = 0;
	const foreign = hostileRecord(
		[
			"originalCompactionIdentity",
			"checkOriginalCompaction",
			"retainOriginalCompaction",
			"joinOriginalCompaction",
			"qualifyOriginalCompaction",
			"aborted",
			"reason",
			"throwIfAborted",
		],
		() => {
			accesses++;
		},
	);
	const operation = new OriginalCompaction(8192);
	await assert.rejects(
		operation.run(foreign as never, foreign as never, foreign as never, foreign as never),
		/OPS_COMPACTION_ORIGINAL_RECEIVING_REQUIRED/,
	);
	assert.throws(() => operation.snapshot(), /OPS_COMPACTION_NOT_ATTEMPTED/);
	assert.equal(accesses, 0);
});

test("actual compaction attempt authentication rejects an unregistered ticket without member reads", () => {
	let accesses = 0;
	const foreign = hostileRecord(
		["signal", "check", "settle", "request", "beginAppend", "appended", "finishAppend"],
		() => {
			accesses++;
		},
	);
	assert.throws(
		() => assertOriginalCompactionAttempt(foreign as never, foreign as never, foreign as never),
		/OPS_COMPACTION_ORIGINAL_ATTEMPT_REQUIRED/,
	);
	assert.equal(accesses, 0);
});
