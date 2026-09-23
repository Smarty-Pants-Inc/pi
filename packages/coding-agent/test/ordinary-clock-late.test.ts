import { expect, test, vi } from "vitest";
import { ordinaryClock, prepareOrdinaryClock } from "../src/core/ordinary-clock.ts";

const load = vi.hoisted(() => vi.fn());
vi.mock("../src/core/owner-effects.ts", () => ({ receiveOriginalClockSource: load }));

test("even one earlier local sample refuses pre-A binding before any native load", () => {
	ordinaryClock.monotonic();
	const ref = { path: "/original/profile", sha256: "a".repeat(64) };
	expect(() => prepareOrdinaryClock({ profile: ref, producer: ref, maxBracketNs: "10", guardSource: ref })).toThrow(
		"BEFORE_FIRST_SAMPLE_ONCE",
	);
	expect(load).not.toHaveBeenCalled();
	expect(() => ordinaryClock.wallTime()).toThrow("BEFORE_FIRST_SAMPLE_ONCE");
});
