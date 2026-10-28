import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AcceptedRecoveryInput,
	type InputOutcomeRequest,
	nativeEntryDeliveryId,
	PI_PROCESS_INCARNATION_ID,
	type SessionRecoveryBinding,
	SessionRecoveryControl,
} from "../src/core/session-recovery-control.ts";

function accepted(): AcceptedRecoveryInput {
	return {
		sessionId: "session",
		originalInputId: "original",
		admissionId: "admission",
		deliveryId: "delivery",
		kind: "initial",
		text: "hello",
		payloadSha256: createHash("sha256").update("hello").digest("hex"),
		deadlineMs: Date.now() + 60_000,
		consumption: { kind: "round" },
	};
}
function fixture(overrides: Partial<SessionRecoveryBinding> = {}) {
	const stop = vi.fn();
	const join = vi.fn(async () => {});
	const binding: SessionRecoveryBinding = {
		deliver: async () => {},
		beforeProvider: async () => ({ permitted: true }),
		projectContext: async (messages) => messages,
		commitNativeEntries: async () => {},
		recordInputOutcome: async () => ({ durable: true, status: "recorded", revision: 1 }),
		getCancelTargets: () => [],
		validateTerminal: async () => ({ complete: true }),
		...overrides,
	};
	const control = new SessionRecoveryControl(
		{ required: true },
		{ sessionId: "session", sessionFile: "/fixture/session.jsonl", stop, join },
	);
	control.bind([{ source: "/fixture/extension.ts", binding }]);
	return { control, stop, join, binding };
}

// Smarty-Pants-Inc/smarty-dev#16188: native controls consume B5 ports; these fixtures are not a B5 store or host proof.
describe("REQUIRED recovery state and outcome ports", () => {
	afterEach(() => vi.useRealTimers());
	it("is inert without REQUIRED and rejects a missing or ambiguous binding", () => {
		const host = { sessionId: "s", sessionFile: "f", stop() {}, async join() {} };
		expect(new SessionRecoveryControl(undefined, host).phase).toBe("READY");
		const { control, binding } = fixture();
		expect(() => control.bind([])).toThrow("RECOVERY_BINDING_REQUIRED");
		expect(() =>
			control.bind([
				{ source: "a", binding },
				{ source: "b", binding },
			]),
		).toThrow("RECOVERY_BINDING_REQUIRED");
	});
	it("does not grant permission from a fence release or a stale epoch", async () => {
		const { control, binding } = fixture();
		control.select(accepted(), "native-input");
		const epoch = control.epoch;
		const held = control.beforeProvider();
		const rejected = expect(held).rejects.toThrow("RECOVERY_EPOCH_REVOKED");
		control.close();
		control.bind([{ source: "a", binding }]);
		await rejected;
		await expect(control.permit(epoch)).rejects.toThrow("RECOVERY_EPOCH_REVOKED");
		expect(control.phase).toBe("HELD");
	});
	it("requires the exact round, digest and non-native delivery namespace", () => {
		for (const input of [
			{ ...accepted(), payloadSha256: "bad" },
			{ ...accepted(), deliveryId: nativeEntryDeliveryId("session", "entry") },
			{ ...accepted(), consumption: { kind: "effect-read" as const, effectKey: "issued-key" } },
		])
			expect(() => fixture().control.select(input)).toThrow("RECOVERY_INPUT_BINDING_INVALID");
	});
	it("freezes the selected logical identity and rechecks B5 before every provider boundary", async () => {
		const beforeProvider = vi.fn(async () => ({ permitted: true }));
		const { control } = fixture({ beforeProvider });
		const input = accepted();
		const selected = control.select(input, "entry");
		input.text = "mutated";
		expect(selected.text).toBe("hello");
		expect(Object.isFrozen(selected.consumption)).toBe(true);
		await control.permit(control.epoch);
		await control.beforeProvider();
		await control.beforeProvider();
		expect(beforeProvider).toHaveBeenCalledTimes(3);
		expect(control.phase).toBe("RUNNING");
	});
	it("persists E before stop and joins before reporting cancellation", async () => {
		const recorded = Promise.withResolvers<{ durable: true; status: "recorded"; revision: number }>();
		const requests: InputOutcomeRequest[] = [];
		const { control, stop, join } = fixture({
			recordInputOutcome: async (request) => {
				requests.push(request);
				return recorded.promise;
			},
		});
		control.select(accepted(), "entry");
		const pending = control.cancel();
		await Promise.resolve();
		expect(control.phase).toBe("CANCELLING");
		expect(stop).not.toHaveBeenCalled();
		recorded.resolve({ durable: true, status: "recorded", revision: 1 });
		await pending;
		expect(stop).toHaveBeenCalledOnce();
		expect(join).toHaveBeenCalledOnce();
		expect(requests[0]).toMatchObject({
			originalInputId: "original",
			kind: "user-cancel",
			bootId: PI_PROCESS_INCARNATION_ID,
		});
	});
	it("retains request identity and timestamp for a same-ID retry after unknown durability", async () => {
		const requests: InputOutcomeRequest[] = [];
		let durable = false;
		const { control, stop } = fixture({
			recordInputOutcome: async (request) => {
				requests.push(request);
				return durable
					? { durable: true, status: "existing", revision: 2 }
					: { durable: false, reason: "store-unavailable" };
			},
		});
		control.select(accepted(), "entry");
		await expect(control.cancel()).rejects.toThrow("cancellation NOT confirmed durable");
		expect(control.phase).toBe("BLOCKED");
		expect(stop).toHaveBeenCalledOnce();
		durable = true;
		await control.cancel();
		const attempts = requests.filter((request) => request.kind === "user-cancel");
		expect(attempts).toHaveLength(2);
		expect(attempts[1]).toMatchObject({
			requestId: attempts[0].requestId,
			at: attempts[0].at,
			originalInputId: attempts[0].originalInputId,
		});
		expect(requests.some((request) => request.kind === "lifecycle-interrupt")).toBe(true);
	});
	it("bounds a non-cooperative durability call and distinguishes an unjoined stop", async () => {
		vi.useFakeTimers();
		const { control, stop, join } = fixture({ recordInputOutcome: () => new Promise(() => {}) });
		join.mockImplementation(() => new Promise(() => {}));
		control.select(accepted(), "entry");
		const pending = control.cancel();
		const rejected = expect(pending).rejects.toThrow("computation has NOT joined");
		await vi.advanceTimersByTimeAsync(1000);
		expect(stop).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1000);
		await rejected;
		expect(control.phase).toBe("BLOCKED");
	});
	it("lifecycle interruption never requests user-cancel", async () => {
		const requests: InputOutcomeRequest[] = [];
		const { control } = fixture({
			recordInputOutcome: async (request) => {
				requests.push(request);
				return { durable: true, status: "recorded", revision: 1 };
			},
		});
		control.select(accepted(), "entry");
		await control.interrupt("reload");
		expect(requests.map((request) => request.kind)).toEqual(["lifecycle-interrupt"]);
		expect(control.phase).toBe("HELD");
	});
	it("does not equate an already settled target with confirmed user cancellation", async () => {
		const { control } = fixture({
			recordInputOutcome: async () => ({ durable: true, status: "already-terminal", kind: "settled", revision: 1 }),
		});
		control.select(accepted(), "entry");
		await expect(control.cancel()).rejects.toThrow("RECOVERY_CANCEL_NOT_DURABLE");
	});
	it("native entry delivery IDs are stable, disjoint and session-bound", () => {
		expect(nativeEntryDeliveryId("s", "e")).toBe(nativeEntryDeliveryId("s", "e"));
		expect(nativeEntryDeliveryId("s", "e")).not.toBe(nativeEntryDeliveryId("other", "e"));
		expect(nativeEntryDeliveryId("s", "e")).toMatch(/^pi-native-entry:v1:[0-9a-f]{64}$/);
	});
});
