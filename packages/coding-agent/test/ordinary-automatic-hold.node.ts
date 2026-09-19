import assert from "node:assert/strict";
import { test } from "node:test";
import { OrdinaryAutomaticHold } from "../src/core/ordinary-automatic-hold.ts";
import { OrdinaryRequestProvenance } from "../src/core/ordinary-request-provenance.ts";

// Pure original-promise custody checks; not native or physical-window proof.
test("release resumes only the pending original admission and joins its original run", async () => {
	const hold = new OrdinaryAutomaticHold();
	const provenance = new OrdinaryRequestProvenance<{ requestId: string }>();
	const token = hold.hold("rapid", () => {});
	let starts = 0;
	let retire!: () => void;
	const retired = new Promise<void>((done) => {
		retire = done;
	});
	const pending = hold.admit(async (enroll) => {
		assert(enroll);
		starts++;
		await enroll(async () => {
			const controller = new AbortController();
			provenance.started(controller.signal);
			await provenance.stream(controller.signal, async () => {
				const fetch = provenance.bindFetch(
					Object.assign(
						async () => {
							provenance.request({ requestId: "original" })(retired);
							return new Response();
						},
						{ preconnect() {} },
					),
				);
				await fetch("https://synthetic.invalid");
			});
		});
		return "started";
	});
	await Promise.resolve();
	assert.equal(starts, 0);
	hold.checkHeld(token);
	let completed = false;
	const capture = provenance
		.captureAutomatic(
			(enroll) => hold.release(token, enroll),
			Date.now() + 10_000,
			(r) => r,
		)
		.then((result) => {
			completed = true;
			return result;
		});
	await new Promise<void>((done) => setImmediate(done));
	assert.equal(starts, 1);
	assert.equal(completed, false);
	retire();
	assert.deepEqual(await capture, { requestId: "original" });
	assert.equal(await pending, "started");
	assert.equal(hold.pendingPeak(token), 1);
});

test("hold order, foreign token and absent original pending admission refuse", () => {
	const hold = new OrdinaryAutomaticHold();
	assert.throws(() => hold.hold("failures", () => {}), /ORDER/);
	const token = hold.hold("rapid", () => {});
	assert.throws(() => hold.checkHeld({}), /TOKEN/);
	assert.throws(() => hold.hold("rapid", () => {}), /ORDER/);
	assert.throws(() => hold.release(token, (run) => run()), /NO_PENDING/);
});

test("failure segment consumes pending admission without executing its run", async () => {
	const hold = new OrdinaryAutomaticHold();
	const rapid = hold.hold("rapid", () => {});
	const first = hold.admit(async () => "started");
	await hold.release(rapid, (run) => run());
	await first;
	hold.sealed(rapid);
	const failures = hold.hold("failures", () => {});
	let called = false;
	const pending = hold.admit(async () => {
		called = true;
		return "started";
	});
	await hold.finishFailures(failures);
	assert.equal(await pending, "suppressed");
	assert.equal(called, false);
	assert.throws(() => hold.checkHeld(failures), /NOT_HELD/);
	assert.throws(() => hold.hold("rapid", () => {}), /ORDER/);
});

test("overlap and original cancellation remain sticky without starting work", async () => {
	const hold = new OrdinaryAutomaticHold();
	const token = hold.hold("rapid", () => {});
	const original = hold.admit(async () => {
		assert.fail("must not run");
	});
	await assert.rejects(
		hold.admit(async () => "started"),
		/OVERLAP/,
	);
	await assert.rejects(original, /OVERLAP/);
	assert.throws(() => hold.release(token, (run) => run()), /OVERLAP/);
	const fresh = new OrdinaryAutomaticHold();
	const held = fresh.hold("rapid", () => {});
	const pending = fresh.admit(async () => "started");
	const cause = new Error("original owner close");
	fresh.fail(cause);
	await assert.rejects(pending, (error) => error === cause);
	assert.throws(
		() => fresh.checkHeld(held),
		(error) => error === cause,
	);
});

test("expiry after release but before original continuation prevents dispatch", async () => {
	const hold = new OrdinaryAutomaticHold();
	let expired = false,
		called = false;
	const token = hold.hold("rapid", () => {
		if (expired) throw new Error("expired");
	});
	const pending = hold.admit(async () => {
		called = true;
		return "started";
	});
	const released = hold.release(token, (run) => run());
	expired = true;
	await assert.rejects(released, /expired/);
	await assert.rejects(pending, /expired/);
	assert.equal(called, false);
});

test("normal admission and later wakes are not replaced by a synthetic wake", async () => {
	const hold = new OrdinaryAutomaticHold();
	let calls = 0;
	assert.equal(
		await hold.admit(async (enroll) => {
			assert.equal(enroll, undefined);
			calls++;
			return "started";
		}),
		"started",
	);
	const token = hold.hold("rapid", () => {});
	const pending = hold.admit(async () => {
		calls++;
		return "started";
	});
	await hold.release(token, (run) => run());
	await pending;
	// Actual later producer activity must remain observable by the original audit.
	await hold.admit(async (enroll) => {
		assert.equal(enroll, undefined);
		calls++;
		return "started";
	});
	assert.equal(calls, 3);
});

test("synchronous authority callback reentry is bounded and sticky even when swallowed", () => {
	const hold = new OrdinaryAutomaticHold();
	let calls = 0;
	const token = hold.hold("rapid", () => {
		calls++;
		if (calls > 1) {
			try {
				hold.checkHeld(token);
			} catch {
				/* Deliberately hostile callback. */
			}
		}
	});
	assert.throws(() => hold.checkHeld(token), /REENTRY/);
	assert.equal(calls, 2);
	assert.throws(() => hold.checkHeld(token), /REENTRY/);
	assert.equal(calls, 2);
});
