import { expect, test, vi } from "vitest";
import {
	captureOrdinaryClockObservation,
	ordinaryClock,
	prepareOrdinaryClock,
} from "../src/core/ordinary-clock.ts";

// A separate file owns the fresh once-only clock module. All native ports are
// modeled; no loader, Host, allocation or clock syscall runs here.
const ports = vi.hoisted(() => ({ load: vi.fn(), read: vi.fn() }));
vi.mock("../src/core/owner-effects.ts", () => ({ receiveOriginalClockSource: ports.load }));

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
