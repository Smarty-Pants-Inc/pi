import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { receiveClockParentAssociation } from "../src/core/ordinary-sc085-source/clock-parent-association.ts";

type Input = Parameters<typeof receiveClockParentAssociation>[0];
function fixture(change?: string): Input {
	const retained = new Map<string, Uint8Array>();
	const put = (path: string, value: unknown) => {
		const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
		retained.set(path, bytes);
		return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
	};
	const unused = put("/unused", {}),
		profile = put("/profile", { inert: true }),
		producer = put("/producer", {
			clockPreparation: {
				version: 1,
				kind: "original-native-clock-preparation",
				maxBracketNs: change === "preparation" ? "11" : "10",
				guardSource: unused,
			},
		}),
		addon = { path: "/actual-addon", sha256: "a".repeat(64) };
	const boot = "12345678-1234-1234-1234-123456789abc",
		timeNamespace = { device: "1", inode: "2" };
	const controller = { serviceUnit: "original.service", invocationId: "b".repeat(32), pid: "20", startTicks: "60" };
	const aggregate = { device: 1, inode: 3 },
		allocation = { id: "allocation", session: "session" };
	const adapter = {
		kind: "original-event-clock-bracket-adapter/1",
		producer,
		implementation: change === "addon" ? unused : addon,
		clockAbi: 1,
		inputClock: "CLOCK_MONOTONIC",
		outputClockId: "parent",
		representative: "after",
		localDomain: "node:perf_hooks.performance",
		uncertaintyNs: "1",
	};
	const contract = put("/contract", {
		version: 1,
		kind: "original-ci-clock-tenure-contract",
		owner: unused,
		qualificationAuthority: unused,
		qualification: unused,
		source: unused,
		platform: { boot, timeNamespace, clocksource: "tsc" },
		clock: { clockId: "parent" },
		adapter,
		acquisition: {},
		reference: {},
		rateEnvelope: {
			rateErrorPpb: "0",
			resolutionNs: "1",
			referenceUncertaintyNs: "1",
			initialOffsetUncertaintyNs: "1",
			adapterUncertaintyNs: "1",
		},
		validity: { startNs: "0", endNs: "21600000000000" },
		guardRules: {
			kind: "same-original-controller-clock-guards/1",
			maxGapNs: "1000",
			maxBracketNs: "10",
			invariants: [],
			source: unused,
		},
	});
	const plan = put("/plan", {
		clockBasisRef: contract,
		baselineUncertaintyMs: 0.000014,
		uncertaintyMs: change === "budget" ? 0.000015 : 0.000014,
	});
	const epochSource = put("/epoch-source", {
		clockContract: contract,
		owner: unused,
		allocation,
		resourceEpoch: "epoch",
	});
	const scope = put("/scope", { owner: unused, ownerEpoch: "epoch", aggregate });
	const epoch = put("/epoch", { scope, source: epochSource, owner: unused, ownerEpoch: "epoch", aggregate });
	const association = { scope, epoch, owner: unused, ownerEpoch: "epoch", aggregate };
	const common = {
		binding: association,
		allocation,
		resourceEpoch: "epoch",
		contract,
		adapter,
		boot,
		timeNamespace,
		clockId: "parent",
	};
	const sample = (sequence: string, before: string, after: string) =>
		put(`/sample/${sequence}`, {
			version: 1,
			kind: "original-ci-clock-sample",
			controller,
			sequence,
			errors: change === "root-error" ? [{}] : [],
			monotonicBeforeNs: before,
			monotonicAfterNs: after,
			processBefore: { pid: 20, startTicks: "60" },
			bootBefore: boot,
			timeNamespaceBefore: timeNamespace,
			clocksourceBefore: "tsc",
			processAfter: { pid: 20, startTicks: "60" },
			bootAfter: boot,
			timeNamespaceAfter: timeNamespace,
			clocksourceAfter: "tsc",
			rawNs: before,
			realtimeNs: before,
			boottimeNs: before,
		});
	const basis = put("/basis", {
		version: 1,
		kind: "original-ci-clock-initial-basis",
		...common,
		calibration: sample("0", "50", "51"),
		validity: { startNs: "0", endNs: "21600000000000" },
		uncertainty: { baselineNs: "14", executionNs: "14" },
	});
	const guard = put("/guard", {
		version: 1,
		kind: "original-ci-clock-guard",
		...common,
		sequence: "1",
		prior: basis,
		sample: sample("1", "120", "121"),
	});
	const proofs = Object.fromEntries(
		[
			"inheritedHardLimit",
			"initialFdRoster",
			"aggregateTasksMembership",
			"noForeignTableSharers",
			"noMigrationOrEscape",
			"noLimitRaiseOrExternalMutation",
			"targetAllocationSemantics",
		].map((name) => [
			name,
			put(`/proof/${name}`, {
				binding: association,
				initialAt: { raw: change === "basis" && name === "noMigrationOrEscape" ? unused : basis },
			}),
		]),
	);
	const otherResources = Object.fromEntries(
		["openFileDescriptions", "queuedOrInFlightReferences", "ioUringFixedFiles", "logicalHandles"].map((name) => [
			name,
			{ evidence: put(`/other/${name}`, { binding: association, initialAt: { raw: basis } }) },
		]),
	);
	const initialRef = put("/initial", {
		version: 1,
		kind: "ordinary-resource-initial/1",
		profileSha256: profile.sha256,
		runId: "run",
		allocationId: allocation.id,
		sessionId: allocation.session,
		aggregate,
		resourceEpoch: "epoch",
		original: { scope, epoch, initialFd: proofs.initialFdRoster },
		launcher: { pid: change === "pid" ? 31 : 30 },
	});
	const releaseRef = put("/release", {
		version: 1,
		kind: "original-ci-operational-release",
		initial: initialRef,
		entry: unused,
	});
	const context = put("/context", {
		release: releaseRef,
		entry: unused,
		receiving: unused,
		controller,
		clock: {
			bootId: boot,
			timeNamespace,
			startedNs: "0",
			captureReleaseDeadlineNs: "21000000000000",
			reportingDeadlineNs: "21600000000000",
		},
	});
	const request = put("/request", { context });
	const witness = {
		version: 1 as const,
		kind: "original-native-clock-witness" as const,
		before: { monotonicNs: "100", pid: 30, bootId: boot, timeNamespace },
		after: { monotonicNs: "101", pid: 30, bootId: boot, timeNamespace },
	};
	const reply = put("/reply", {
		request,
		controller,
		checkedNs: change === "stale" ? "2000" : "130",
		clockGuard: {
			basis,
			query: { beforeNs: "100", afterNs: "101" },
			before: change === "coverage" ? guard : basis,
			after: guard,
			head: guard,
		},
	});
	const policy = put("/policy", { operational_prelaunch: { phasePlan: plan, constraints: { epochSource } } });
	// Deliberately incomplete independent qualification DATA: this tests only the
	// association receiver and must never be used as a positive qualified fixture.
	return {
		retained,
		prepared: { profile, producer, implementation: addon, maxBracketNs: "10", guardSource: unused },
		witness,
		guard: reply,
		initial: {
			release: { raw: releaseRef, bytes: retained.get(releaseRef.path)! },
			initial: { raw: initialRef, bytes: retained.get(initialRef.path)! },
		},
		binding: {
			native: { profile, receiving: unused },
			producers: { clock: producer },
			operational_run_id: "run",
			policy,
			fd_slot_bound: { scope, epoch, proofs, otherResources },
		} as unknown as Input["binding"],
	};
}
test("parent DATA joins exact initial basis, actual addon, original launcher and AFTER without local offset", () => {
	const value = receiveClockParentAssociation(fixture());
	expect(value.monotonicNs).toBe("101");
	expect(value.uncertaintyNs).toBe("14");
	expect(value.basis.path).toBe("/basis");
	expect(value.guard.path).toBe("/reply");
	expect(value).not.toHaveProperty("qualification");
});
test.each(["addon", "pid", "basis", "budget", "root-error", "stale", "coverage", "preparation"])(
	"refuses changed original %s even with newly hashed DATA",
	(change) => {
		expect(() => receiveClockParentAssociation(fixture(change))).toThrow();
	},
);
test("requires same retained bytes, no filesystem fallback", () => {
	const input = fixture();
	(input.retained as Map<string, Uint8Array>).delete("/sample/0");
	expect(() => receiveClockParentAssociation(input)).toThrow("OPS_CLOCK_PARENT_RETAINED");
});
