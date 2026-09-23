import { createHash } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import {
	beginOrdinaryClockOperation,
	commitOrdinaryClockOperation,
	failOrdinaryClockOperation,
	ordinaryClock,
	prepareOrdinaryClock,
	readOrdinaryClockPreparation,
} from "../src/core/ordinary-clock.ts";
import type { NativeClockSample } from "../src/core/ordinary-clock-evidence.ts";
import { createHistoricalPreparedClock } from "./fixtures/ordinary-clock-preparation-legacy-contract.ts";

// Current preparation/decoder bodies with fixed-addon MODULE MOCKS only. No
// actual addon, owner or native custody is constructed. Only ONE test prepares
// this file's current module; historical contracts have separate modeled state.
const ports = vi.hoisted(() => ({ load: vi.fn(), read: vi.fn<() => NativeClockSample>() }));
vi.mock("../src/core/owner-effects.ts", () => ({
	receiveOriginalClockSource: ports.load,
	readOriginalPreparedClockSample: ports.read,
}));
beforeEach(() => {
	ports.load.mockReset();
	ports.read.mockReset();
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
	expect(ports.load).not.toHaveBeenCalled();
	expect(ports.read).not.toHaveBeenCalled();
});
test.each(["0", "01", "-1", "1000000001", "1.1", "100000000000000000000", 10, null])(
	"rejects preparation ceiling %s",
	(cap) => {
		const { raw, ref } = packet(cap);
		expect(() => readOrdinaryClockPreparation(ref, raw)).toThrow("OWNER_CLOCK_BRACKET_CAP");
		expect(ports.load).not.toHaveBeenCalled();
		expect(ports.read).not.toHaveBeenCalled();
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
	expect(ports.load).not.toHaveBeenCalled();
	expect(ports.read).not.toHaveBeenCalled();
});
test("rejects changed held bytes rather than adopting a different producer", () => {
	const { raw, ref } = packet();
	expect(() => readOrdinaryClockPreparation({ ...ref, sha256: "b".repeat(64) }, raw)).toThrow(
		"OWNER_CLOCK_PRODUCER_BYTES",
	);
	expect(ports.load).not.toHaveBeenCalled();
	expect(ports.read).not.toHaveBeenCalled();
});

test("current DATA-only source preparation retains two reads before an explicitly failed ticket", () => {
	let ns = 0n;
	ports.read.mockImplementation(() => ({
		monotonicNs: String(ns++),
		bootId: "11111111-2222-3333-4444-555555555555",
		timeNamespace: { device: "1", inode: "2" },
		pid: 3,
	}));
	// Current receiver returns DATA only; all samples use the fixed module port.
	ports.load.mockReturnValue({ implementation: source });
	const initial = prepareOrdinaryClock({ profile: source, producer: source, maxBracketNs: "10", guardSource: source });
	expect(ports.load).toHaveBeenCalledExactlyOnceWith(source);
	expect(initial.initial.eventMeaning).toBe("pre-a-initial");
	expect(initial.initial.parent.before.monotonicNs).toBe("0");
	expect(initial.initial.parent.after.monotonicNs).toBe("1");
	expect(ports.read).toHaveBeenCalledTimes(2);
	const ticket = beginOrdinaryClockOperation("event");
	expect(ports.read).toHaveBeenCalledTimes(3);
	const failure = new Error("original operation failed");
	for (const attempt of [
		() => failOrdinaryClockOperation(failure),
		() => commitOrdinaryClockOperation(ticket),
		() => ordinaryClock.monotonic(),
		() => beginOrdinaryClockOperation("retry"),
	]) {
		let caught = false;
		try {
			attempt();
		} catch (cause) {
			caught = true;
			expect(cause).toBe(failure);
		}
		expect(caught).toBe(true);
	}
	expect(ports.read).toHaveBeenCalledTimes(3);
	expect(ports.load).toHaveBeenCalledTimes(1);
});

// HISTORICAL MOCK: retain the old post-invocation observation wrapper, rather
// than replacing its rejection obligation with current API-absence assertions.
test("observation wrapper contains immediate native rejection with noncallable own then", async () => {
	let ns = 0n;
	const read = vi.fn(() => ({
		monotonicNs: String(ns++),
		bootId: "11111111-2222-3333-4444-555555555555",
		timeNamespace: { device: "1", inode: "2" },
		pid: 3,
	}));
	const historicalLoad = vi.fn(() => ({ implementation: source, read }));
	const legacy = createHistoricalPreparedClock(historicalLoad);
	legacy.prepareOrdinaryClock({ profile: source, producer: source, maxBracketNs: "10", guardSource: source });
	expect(read).toHaveBeenCalledTimes(2);
	let refusal: unknown;
	try {
		legacy.captureOrdinaryClockObservation("event", () => {
			const rejected = Promise.reject(new Error("forbidden observation rejection"));
			// biome-ignore lint/suspicious/noThenProperty: Hostile thenable fixture for the original promise boundary.
			Object.defineProperty(rejected, "then", { value: null });
			return rejected;
		});
	} catch (cause) {
		refusal = cause;
	}
	expect((refusal as Error).message).toContain("ASYNC_TRANSITION");
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(() => legacy.ordinaryClock.monotonic()).toThrow(refusal as Error);
	expect(read).toHaveBeenCalledTimes(3); // Two preparation edges, one event before-edge.
	expect(historicalLoad).toHaveBeenCalledExactlyOnceWith(source);
	expect(ports.load).not.toHaveBeenCalled();
	expect(ports.read).not.toHaveBeenCalled();
});
