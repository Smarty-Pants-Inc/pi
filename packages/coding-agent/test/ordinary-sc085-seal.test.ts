import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { OrdinaryAutomaticHold } from "../src/core/ordinary-automatic-hold.ts";
import type { OrdinaryOwnerContext } from "../src/core/ordinary-owner-context.ts";
import { createOriginalSc085 } from "../src/core/ordinary-sc085.ts";
import type { Sc085OriginalReceiving } from "../src/core/ordinary-sc085-source/operational-admission.ts";

// Synthetic ports exercise the ORIGINAL gate/seal implementation only. These
// fixtures supply no CI helper, authority, native execution or clock qualification.
const ports = vi.hoisted(() => ({
	check: vi.fn(),
	binding: vi.fn(),
	storage: vi.fn(),
	stamp: vi.fn(),
	admission: vi.fn(),
	callback: vi.fn(),
}));
vi.mock("../src/core/ordinary-sc085-source/operational-admission.ts", () => ({
	checkSc085Operation: ports.check,
	receiveSc085ChildBinding: ports.binding,
	receiveSc085OriginalStorage: ports.storage,
	qualifySc085OriginalStamp: ports.stamp,
	guardSc085OriginalCallback: ports.callback,
}));
vi.mock("../src/core/ordinary-sc085-source/sc085-admission.ts", () => ({
	parseSc085Admission: ports.admission,
	sc085RetainedBytes: () => Buffer.from("{}"),
}));
beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

async function fixture(observations: number[], uncertainty = 0) {
	let helpers = 0;
	let recording: (() => void) | undefined;
	let active = false;
	let failure: Error | undefined;
	const boundary = () => {
		if (active) failure ??= new Error("OPS_SYNCHRONOUS_AUTHORITY_REENTRY");
		if (failure) throw failure;
		helpers++;
	};
	ports.check.mockImplementation(boundary);
	ports.callback.mockImplementation(<T>(_receiving: unknown, action: () => T): T => {
		if (active) throw new Error("fixture callback nesting");
		active = true;
		try {
			const result = action();
			if (failure) throw failure;
			return result;
		} finally {
			active = false;
		}
	});
	const ref = { path: "/synthetic/admission", sha256: "a".repeat(64) };
	ports.binding.mockReturnValue({ admission: ref, binding: ref, primaryWatchId: "primary" });
	const samples = [
		{
			watchId: "primary",
			request: { executionKey: "key", stateNamespace: "namespace" },
			result: { outcome: "OK", body: "final" },
		},
	];
	ports.admission.mockReturnValue({
		checkpoints: [
			{
				watches: [
					{
						watchId: "primary",
						executionKey: "key",
						stateNamespace: "namespace",
						outcome: "OK",
						body: "final",
						diagnostic: null,
					},
				],
			},
		],
		validity: { maxHoldMs: 100000, expiresWallMs: Date.now() + 100000 },
		observation: { unchangedMs: 1000 },
	});
	const retained = new Map<string, Uint8Array>();
	ports.storage.mockReturnValue({
		retained,
		record(value: unknown) {
			recording?.();
			const raw = Buffer.from(JSON.stringify(value));
			const output = { path: `/synthetic/${retained.size}`, sha256: createHash("sha256").update(raw).digest("hex") };
			retained.set(output.path, raw);
			return output;
		},
	});
	const observed = new WeakMap<object, number>();
	ports.stamp.mockImplementation(
		(_receiving: unknown, _context: unknown, selector: { kind: string; cursor?: object }) => {
			boundary();
			boundary();
			return {
				clockId: "synthetic",
				monotonicMs: selector.cursor ? (observed.get(selector.cursor) ?? 0) : 0,
				uncertaintyMs: uncertainty,
				wallMs: Date.now(),
				raw: ref,
				original: ref,
				qualification: ref,
			};
		},
	);
	let iterations = 0;
	const audit = {
		clock: {
			monotonic: () => 0,
			setTimeout: (action: () => void, ms: number) => setTimeout(action, ms),
			clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
		},
		validatedSetup: () => ({ raw: ref, event: { setup: { settlement: { samples } } } }),
		mark: () => ({}),
		sc085FailureEvidence: () => ({}),
		validateSc085Checkpoint: (value: unknown) => value,
		joinedRequest: () => ({
			requestId: "request",
			nativeAccepted: true,
			nativeOperationRetired: true,
			kind: "with-view",
		}),
		requestExposure: () => ({ frame: { hash: "final", revision: 1 } }),
		requestEvidence: () => ({}),
		observeSince: () => ({ events: [] }),
		sc085RapidEvidence: () => {
			const time = observations[iterations++];
			if (time === undefined) throw new Error("fixture observed beyond bounded samples");
			const observedCursor = {};
			observed.set(observedCursor, time);
			return {
				observedCursor,
				observedUntil: { monotonicMs: time },
				exposureAt: { monotonicMs: 0 },
				startsWhileHeld: 0,
				pendingPeak: 1,
				concurrentTurnPeak: 1,
				automaticTurns: 1,
				otherRunStarts: 0,
				repeatedUnchangedWakes: 0,
			};
		},
	};
	const gate = new OrdinaryAutomaticHold();
	const context = {
		operationalAudit: audit,
		inspectCurrentPermission: () => ({ remainingMs: 100000 }),
		decision: { allocation: { expiresMs: Date.now() + 100000 } },
		requestProvenance: {
			captureAutomatic: async (
				release: (enroll: (run: () => Promise<void>) => Promise<void>) => Promise<void>,
				_deadline: number,
				accept: (reservation: unknown) => { requestId: string },
			) => {
				await release((run) => run());
				return accept({});
			},
		},
	} as unknown as OrdinaryOwnerContext;
	const control = createOriginalSc085(context, {} as Sc085OriginalReceiving, gate);
	const held = await control.methods.hold(ref, "rapid");
	const pending = gate.admit(async (enroll) => {
		await enroll!(async () => {});
		return "started";
	});
	await control.methods.release(held.token, {
		settlement: { samples, publication: { hash: "final", revision: 1 } },
	} as Parameters<typeof control.methods.release>[1]);
	await pending;
	helpers = 0;
	return {
		control,
		held,
		counts: () => ({ helpers, iterations }),
		recordCallback: (callback: () => void) => {
			recording = callback;
		},
	};
}

test.each([
	{ observations: [1000], iterations: 1, helpers: 9 },
	{ observations: [50, 1000], iterations: 2, helpers: 12 },
	{ observations: [50, 500, 1000], iterations: 3, helpers: 15 },
])(
	"seal completes unchanged full observation with $iterations attempts / $helpers helper calls",
	async ({ observations, iterations, helpers }) => {
		const f = await fixture(observations);
		const result = f.control.methods.seal(f.held.token, "request");
		await vi.runAllTimersAsync();
		expect((await result).automaticTurns.value).toBe(1);
		expect(f.counts()).toEqual({ helpers, iterations });
	},
);

test.each([
	[50, 50],
	[50, 40],
	[50, 500, 900],
])("nonprogress or exhausted waits refuse without shortened success: %j", async (...observations) => {
	const f = await fixture(observations);
	const result = expect(f.control.methods.seal(f.held.token, "request")).rejects.toThrow("OBSERVATION_NO_PROGRESS");
	await vi.runAllTimersAsync();
	await result;
	expect(f.counts()).toEqual({ helpers: 3 + observations.length * 3, iterations: observations.length });
	await expect(f.control.methods.seal(f.held.token, "request")).rejects.toThrow("OBSERVATION_NO_PROGRESS");
	expect(f.counts().helpers).toBe(3 + observations.length * 3);
});

test("uncertainty is subtracted; reaching only the raw duration cannot seal", async () => {
	const f = await fixture([1000, 1000], 1);
	const result = expect(f.control.methods.seal(f.held.token, "request")).rejects.toThrow("OBSERVATION_NO_PROGRESS");
	await vi.runAllTimersAsync();
	await result;
	expect(f.counts()).toEqual({ helpers: 9, iterations: 2 });
});

test("hostile original record callback cannot amplify helper reads or produce sealed evidence", async () => {
	const f = await fixture([1000]);
	f.recordCallback(() => {
		try {
			f.control.methods.checkHeld(f.held.token);
		} catch {
			/* Hostile swallowed refusal. */
		}
	});
	await expect(f.control.methods.seal(f.held.token, "request")).rejects.toThrow("REENTRY");
	expect(f.counts()).toEqual({ helpers: 7, iterations: 1 });
	await expect(f.control.methods.seal(f.held.token, "request")).rejects.toThrow("REENTRY");
	expect(f.counts().helpers).toBe(7);
});
