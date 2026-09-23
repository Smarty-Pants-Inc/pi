import { expect, test, vi } from "vitest";
import * as currentClock from "../src/core/ordinary-clock.ts";
import { createHistoricalPreparedClock } from "./fixtures/ordinary-clock-preparation-legacy-contract.ts";

// MOCK: preserve the exact historical delayed-rejection body and its original
// wrapper excerpt, separately from the current once-only ticket module below.
// No loader, Host, allocation or clock syscall runs here. The historical test
// still relies on the boundary alone, not test-side rejected-handler attachment.
const ports = vi.hoisted(() => ({ load: vi.fn(), read: vi.fn() }));
vi.mock("../src/core/owner-effects.ts", () => ({
	receiveOriginalClockSource: ports.load,
	readOriginalPreparedClockSample: ports.read,
}));
const { captureOrdinaryClockObservation, ordinaryClock, prepareOrdinaryClock } = createHistoricalPreparedClock(
	ports.load,
);

test("observation wrapper contains delayed native rejection without invoking poisoned own then", async () => {
	let ns = 0n;
	ports.read.mockImplementation(() => ({
		monotonicNs: String(ns++),
		bootId: "11111111-2222-3333-4444-555555555555",
		timeNamespace: { device: "1", inode: "2" },
		pid: 3,
	}));
	const ref = { path: "/original/source", sha256: "a".repeat(64) };
	ports.load.mockReturnValue({ implementation: ref, read: ports.read });
	prepareOrdinaryClock({ profile: ref, producer: ref, maxBracketNs: "10", guardSource: ref });
	let refusal: unknown;
	let observed = false;
	const rejected = Promise.resolve().then(() => {
		throw new Error("delayed observation rejection");
	});
	// biome-ignore lint/suspicious/noThenProperty: Hostile thenable fixture for the original promise boundary.
	Object.defineProperty(rejected, "then", {
		get() {
			observed = true;
			throw new Error("poisoned native observation then getter");
		},
	});
	try {
		captureOrdinaryClockObservation("event", () => rejected);
	} catch (cause) {
		refusal = cause;
	}
	expect((refusal as Error).message).toContain("ASYNC_TRANSITION");
	expect(observed).toBe(false);
	// The production boundary alone must observe the rejected Promise.
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(observed).toBe(false);
	expect(() => ordinaryClock.wallTime()).toThrow(refusal as Error);
	expect(ports.read).toHaveBeenCalledTimes(3); // Preparation plus event before-edge only.
});

test("current ticket has no after edge when its owning asynchronous operation fails", async () => {
	ports.load.mockReset();
	ports.read.mockReset();
	let ns = 0n;
	ports.read.mockImplementation(() => ({
		monotonicNs: String(ns++),
		bootId: "11111111-2222-3333-4444-555555555555",
		timeNamespace: { device: "1", inode: "2" },
		pid: 3,
	}));
	const ref = { path: "/original/source", sha256: "a".repeat(64) };
	ports.load.mockReturnValue({ implementation: ref });
	currentClock.prepareOrdinaryClock({ profile: ref, producer: ref, maxBracketNs: "10", guardSource: ref });
	const ticket = currentClock.beginOrdinaryClockOperation("native-operation-completion");
	let reject!: (cause: unknown) => void;
	const receipt = new Promise<void>((_resolve, fail) => {
		reject = fail;
	});
	// Modeled operation owns and awaits its work. No caller callback/Promise is
	// enrolled in the current evidence API, and no test swallows a legacy result.
	const settled = (async () => {
		try {
			await receipt;
			return currentClock.commitOrdinaryClockOperation(ticket);
		} catch (cause) {
			return currentClock.failOrdinaryClockOperation(cause);
		}
	})();
	const failure = new Error("original delayed operation failed");
	const refused = expect(settled).rejects.toBe(failure);
	expect(ports.read).toHaveBeenCalledTimes(3);
	reject(failure);
	await refused;
	expect(() => currentClock.ordinaryClock.wallTime()).toThrow(failure);
	expect(() => currentClock.commitOrdinaryClockOperation(ticket)).toThrow(failure);
	expect(ports.read).toHaveBeenCalledTimes(3);
});
