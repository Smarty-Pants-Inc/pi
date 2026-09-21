import { beforeEach, expect, test, vi } from "vitest";
import { ordinaryClock, originalClockInitialObservation, prepareOrdinaryClock } from "../src/core/ordinary-clock.ts";

const ports = vi.hoisted(() => ({ load: vi.fn(), read: vi.fn() }));
vi.mock("../src/core/owner-effects.ts", () => ({ receiveOriginalClockSource: ports.load }));
const ref = { path: "/original/profile", sha256: "a".repeat(64) };
const input = {
	profile: ref,
	producer: { ...ref, path: "/original/clock" },
	maxBracketNs: "10",
	guardSource: { ...ref, path: "/original/guard-source" },
};

beforeEach(() => {
	ports.load.mockReset();
	ports.read.mockReset();
	let ns = 10n;
	ports.read.mockImplementation(() => ({
		monotonicNs: String(ns++),
		bootId: "11111111-2222-3333-4444-555555555555",
		timeNamespace: { device: "1", inode: "2" },
		pid: 3,
	}));
	ports.load.mockReturnValue({ implementation: { ...ref, path: "/original/addon.node" }, read: ports.read });
});

test("original object is bound before its first raw point and retains exact pre-A witness", () => {
	// Each file owns a single fresh module instance; no real addon is loaded.
	const original = ordinaryClock;
	const initial = prepareOrdinaryClock(input);
	expect(ordinaryClock).toBe(original);
	expect(Object.isFrozen(original)).toBe(true);
	expect(ports.load).toHaveBeenCalledExactlyOnceWith(ref);
	expect(initial.initial.parent.before.monotonicNs).toBe("10");
	expect(initial.initial.parent.after.monotonicNs).toBe("11");
	expect(initial.initial.local.monotonicMs).toBeGreaterThanOrEqual(0);
	let raw: number | undefined;
	const observed = ordinaryClock.capture("original-window-end", () => {
		raw = ordinaryClock.monotonic();
		return raw;
	});
	expect(observed.value).toBe(raw);
	expect(observed.witness.after.monotonicNs).toBe("13");
	initial.initial.parent.after.monotonicNs = "999";
	const retained = originalClockInitialObservation();
	expect(retained.parent.after.monotonicNs).toBe("11");
	retained.local.monotonicMs = -1;
	expect(originalClockInitialObservation().local.monotonicMs).toBeGreaterThanOrEqual(0);
	expect(ports.read).toHaveBeenCalledTimes(4);
	expect(() => prepareOrdinaryClock(input)).toThrow("BEFORE_FIRST_SAMPLE_ONCE");
	expect(ports.load).toHaveBeenCalledTimes(1);
	expect(() => ordinaryClock.monotonic()).toThrow("BEFORE_FIRST_SAMPLE_ONCE");
});
