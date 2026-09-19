import assert from "node:assert/strict";
import { test } from "node:test";
import { OrdinaryRequestProvenance } from "../src/core/ordinary-request-provenance.ts";

type Reservation = { requestId: string };
// Pure custody checks, not installed/native automatic-wake acceptance.
async function originalRun(p: OrdinaryRequestProvenance<Reservation>, retirement = Promise.resolve()) {
	const controller = new AbortController();
	p.started(controller.signal);
	await p.stream(controller.signal, async () => {
		const fetch = p.bindFetch(
			Object.assign(
				async () => {
					p.request({ requestId: "original-automatic" })(retirement);
					return new Response();
				},
				{ preconnect() {} },
			),
		);
		await fetch("https://synthetic.invalid");
	});
}

test("automatic enrollment joins its original reservation and awaits actual retirement", async () => {
	const p = new OrdinaryRequestProvenance<Reservation>();
	let retire!: () => void;
	const retirement = new Promise<void>((resolve) => {
		retire = resolve;
	});
	let returned = false;
	const result = p
		.captureAutomatic(
			(enroll) => enroll(() => originalRun(p, retirement)),
			Date.now() + 10_000,
			(r) => r,
		)
		.then((value) => {
			returned = true;
			return value;
		});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(returned, false);
	retire();
	assert.deepEqual(await result, { requestId: "original-automatic" });
});

test("automatic capture cannot replace enrollment with a direct prompt", async () => {
	const p = new OrdinaryRequestProvenance<Reservation>();
	await assert.rejects(
		p.captureAutomatic(
			() => p.prompt((token) => p.run(token, () => originalRun(p))),
			Date.now() + 10_000,
			(r) => r,
		),
		/NO_REQUEST/,
	);
});

test("repeated enrollment is sticky and stale enrollment cannot dispatch", async () => {
	const p = new OrdinaryRequestProvenance<Reservation>();
	let late!: (run: () => Promise<void>) => Promise<void>;
	await assert.rejects(
		p.captureAutomatic(
			async (enroll) => {
				late = enroll;
				await enroll(() => originalRun(p));
				await assert.rejects(
					enroll(() => originalRun(p)),
					/AUTOMATIC_CAPTURE_ENROLLMENT/,
				);
			},
			Date.now() + 10_000,
			(r) => r,
		),
		/AUTOMATIC_CAPTURE_ENROLLMENT/,
	);
	let dispatched = false;
	await assert.rejects(
		late(async () => {
			dispatched = true;
		}),
		/AUTOMATIC_CAPTURE_ENROLLMENT/,
	);
	assert.equal(dispatched, false);
});

test("automatic close and expiry interrupt a pending original join", async () => {
	const p = new OrdinaryRequestProvenance<Reservation>();
	const capture = p.captureAutomatic(
		() => new Promise(() => {}),
		Date.now() + 10_000,
		(r) => r,
	);
	p.close();
	await assert.rejects(capture, /CLOSED/);
	const fresh = new OrdinaryRequestProvenance<Reservation>();
	await assert.rejects(
		fresh.captureAutomatic(
			() => new Promise(() => {}),
			Date.now() + 20,
			(r) => r,
		),
		/EXPIRED/,
	);
});
