import { createHash } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import {
	captureOrdinaryClockObservation,
	ordinaryClock,
	prepareOrdinaryClock,
	readOrdinaryClockPreparation,
} from "../src/core/ordinary-clock.ts";

const load = vi.hoisted(() => vi.fn());
vi.mock("../src/core/owner-effects.ts", () => ({ receiveOriginalClockSource: load }));
beforeEach(() => {
	load.mockReset();
});
const source = { path: "/original/guard-source", sha256: "a".repeat(64) };
function packet(maxBracketNs: unknown = "1000000000", extra = {}) {
	const raw = Buffer.from(
		JSON.stringify({
			existingProducerFields: "unchanged",
			clockPreparation: {
				version: 1,
				kind: "original-native-clock-preparation",
				maxBracketNs,
				guardSource: source,
				...extra,
			},
		}),
	);
	return { raw, ref: { path: "/original/clock-producer", sha256: createHash("sha256").update(raw).digest("hex") } };
}
test("reads bounded nested preparation from exact original bytes without any addon load", () => {
	const { raw, ref } = packet();
	const preparation = readOrdinaryClockPreparation(ref, raw);
	expect(preparation).toEqual({ maxBracketNs: "1000000000", guardSource: source });
	preparation.guardSource.path = "/changed";
	expect(readOrdinaryClockPreparation(ref, raw).guardSource).toEqual(source);
	expect(load).not.toHaveBeenCalled();
});
test.each(["0", "01", "-1", "1000000001", "1.1", "100000000000000000000", 10, null])(
	"rejects preparation ceiling %s",
	(cap) => {
		const { raw, ref } = packet(cap);
		expect(() => readOrdinaryClockPreparation(ref, raw)).toThrow("OWNER_CLOCK_BRACKET_CAP");
		expect(load).not.toHaveBeenCalled();
	},
);
test.each([
	{ clockContractRef: source },
	{ guardSource: { ...source, extra: true } },
	{ guardSource: { ...source, path: "/original/../other" } },
	{ kind: "other" },
])("rejects noncontract preparation %j", (extra) => {
	const { raw, ref } = packet("10", extra);
	expect(() => readOrdinaryClockPreparation(ref, raw)).toThrow();
});
test("rejects changed held bytes rather than adopting a different producer", () => {
	const { raw, ref } = packet();
	expect(() => readOrdinaryClockPreparation({ ...ref, sha256: "b".repeat(64) }, raw)).toThrow(
		"OWNER_CLOCK_PRODUCER_BYTES",
	);
});

test("observation wrapper contains immediate native rejection with noncallable own then", async () => {
	let ns = 0n;
	const read = vi.fn(() => ({
		monotonicNs: String(ns++),
		bootId: "11111111-2222-3333-4444-555555555555",
		timeNamespace: { device: "1", inode: "2" },
		pid: 3,
	}));
	load.mockReturnValue({ implementation: source, read });
	prepareOrdinaryClock({ profile: source, producer: source, maxBracketNs: "10", guardSource: source });
	let refusal: unknown;
	try {
		captureOrdinaryClockObservation("event", () => {
			const rejected = Promise.reject(new Error("forbidden observation rejection"));
			Object.defineProperty(rejected, "then", { value: null });
			return rejected;
		});
	} catch (cause) {
		refusal = cause;
	}
	expect((refusal as Error).message).toContain("ASYNC_TRANSITION");
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(() => ordinaryClock.monotonic()).toThrow(refusal as Error);
	expect(read).toHaveBeenCalledTimes(3); // Two preparation edges, one event before-edge.
});
