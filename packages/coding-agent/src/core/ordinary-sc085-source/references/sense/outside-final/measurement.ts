// Source-only composition of Sense2468. See ORIGINS.json; do not edit supplier logic here.
// ponytail: preserve the supplier DATA decoder (including its internal any types)
// rather than maintain a second semantic validator. No authority is imported.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export interface RawRef {
	path: string;
	sha256: string;
}
export interface Fact {
	value: number | null;
	raw: RawRef | null;
	unknown: string | null;
}
export interface Stamp {
	clockId: string;
	monotonicMs: number;
	wallMs: number;
	uncertaintyMs: number | null;
	raw: RawRef | null;
	/** Parent-domain fields only. Local performance samples never populate these. */
	monotonicNs?: string;
	uncertaintyNs?: string;
	basis?: RawRef;
	guard?: RawRef;
	original?: RawRef;
	qualification?: RawRef;
}
export function clockNs(value: unknown): bigint {
	if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error("OPS_CLOCK_NS");
	return BigInt(value);
}
export interface OriginalFinalGraphSelection {
	/** Actual standalone preflight bytes, or the original issued authorization
	 * whose operational_binding.fd_slot_bound contains that preflight inline.
	 * The outside owner authenticates the authorization and release-wrapper join. */
	initial: RawRef | { authorization: RawRef };
	final: RawRef;
	owner: RawRef;
	ownerEpoch: string;
	epochSource: RawRef;
	limits: RawRef;
	aggregate: { device: number; inode: number };
	clockBasis: RawRef;
}

/** Stable Resource8cb graph joins. Deliberately NOT FdSlotBound: release-clock,
 * independent enforcement/clock semantics and terminal/billing are separate
 * receiving obligations. Do not feed this partial result to final acceptance. */
export function receiveOriginalFinalGraphData(
	selection: OriginalFinalGraphSelection,
	retained: ReadonlyMap<string, Uint8Array>,
) {
	const require = (condition: unknown, code: string): void => {
		if (!condition) throw new Error(code);
	};
	const fields = (value: any, names: string) =>
		require(value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.keys(value).sort().join(" ") === names.split(" ").sort().join(" "), "OPS_FINAL_GRAPH_FIELDS");
	const read = (ref: RawRef): any => {
		fields(ref, "path sha256");
		require(typeof ref.path === "string" &&
			ref.path.length > 0 &&
			/^[a-f0-9]{64}$/.test(ref.sha256), "OPS_FINAL_GRAPH_REF");
		const bytes = retained.get(ref.path);
		require(bytes && createHash("sha256").update(bytes).digest("hex") === ref.sha256, "OPS_FINAL_GRAPH_BYTES");
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes!));
	};
	const same = (actual: unknown, expected: unknown, code = "OPS_FINAL_GRAPH_BINDING") =>
		require(isDeepStrictEqual(actual, expected), code);
	const selected = structuredClone(selection);
	let initial: any;
	if (selected.initial && typeof selected.initial === "object" && "authorization" in selected.initial) {
		fields(selected.initial, "authorization");
		const authorization = read(selected.initial.authorization);
		require(authorization &&
			typeof authorization === "object" &&
			!Array.isArray(authorization), "OPS_FINAL_GRAPH_AUTHORIZATION");
		const binding = authorization.operational_binding;
		require(binding &&
			typeof binding === "object" &&
			!Array.isArray(binding) &&
			binding.version === 1 &&
			binding.namespace === "sense-operational-pi", "OPS_FINAL_GRAPH_AUTHORIZATION");
		// Project only this issued field. Do not serialize it into a fabricated Ref,
		// search retained records, or substitute the initial-retention envelope.
		initial = binding.fd_slot_bound;
	} else initial = read(selected.initial as RawRef);
	const final = read(selected.final);
	const base = "version kind quantity semantics N T budget scope epoch proofs otherResources";
	fields(initial, base);
	fields(final, `${base} wholeWindow retirement`);
	require(initial.version === 2 &&
		initial.kind === "admitted-live-fd-slot-preflight" &&
		final.version === 1 &&
		final.kind === "enforced-live-fd-slots", "OPS_FINAL_GRAPH_VERSION");
	require(initial.quantity === "live-fd-table-slots" &&
		initial.semantics === "CONSERVATIVE_UPPER_BOUND", "OPS_FINAL_GRAPH_SEMANTICS");
	for (const key of ["quantity", "semantics", "N", "T", "budget", "scope", "epoch", "otherResources"])
		same(final[key], initial[key]);
	for (const key of ["N", "T", "budget"])
		require(Number.isSafeInteger(final[key]) && final[key] > 0, "OPS_FINAL_GRAPH_BOUND");
	const upperBound = BigInt(final.N) * BigInt(final.T);
	require(upperBound <= BigInt(Number.MAX_SAFE_INTEGER) &&
		upperBound <= BigInt(final.budget), "OPS_FINAL_GRAPH_BOUND");
	const scope = read(final.scope),
		epoch = read(final.epoch);
	fields(scope, "version kind owner ownerEpoch aggregate subjects limits");
	fields(epoch, "version kind scope owner ownerEpoch aggregate source");
	require(scope.version === 2 &&
		scope.kind === "fd-slot-scope" &&
		epoch.version === 1 &&
		epoch.kind === "fd-slot-epoch", "OPS_FINAL_GRAPH_VERSION");
	fields(scope.aggregate, "device inode");
	require(Number.isSafeInteger(scope.aggregate.device) &&
		scope.aggregate.device >= 0 &&
		Number.isSafeInteger(scope.aggregate.inode) &&
		scope.aggregate.inode > 0 &&
		typeof selected.ownerEpoch === "string" &&
		selected.ownerEpoch.length > 0, "OPS_FINAL_GRAPH_IDENTITY");
	same(scope.owner, selected.owner);
	same(scope.ownerEpoch, selected.ownerEpoch);
	same(scope.aggregate, selected.aggregate);
	same(scope.limits, selected.limits);
	same(scope.subjects, ["bun", "native", "observers"]);
	same(epoch.scope, final.scope);
	for (const key of ["owner", "ownerEpoch", "aggregate"]) same(epoch[key], scope[key]);
	same(epoch.source, selected.epochSource);
	read(selected.owner);
	read(selected.limits);
	const source = read(selected.epochSource);
	same(source.owner, selected.owner);
	same(source.ownerEpoch, selected.ownerEpoch);
	same(source.limits, selected.limits);
	const association = {
		scope: final.scope,
		epoch: final.epoch,
		owner: scope.owner,
		ownerEpoch: scope.ownerEpoch,
		aggregate: scope.aggregate,
	};
	const seven =
		"inheritedHardLimit initialFdRoster aggregateTasksMembership noForeignTableSharers noMigrationOrEscape noLimitRaiseOrExternalMutation targetAllocationSemantics";
	fields(initial.proofs, seven);
	fields(final.proofs, `${seven} uninterruptedBoundaryCustody retirementTail`);
	fields(source.initialConditions, seven);
	let initialAt: any;
	for (const name of seven.split(" ")) {
		same(final.proofs[name], initial.proofs[name]);
		const row = read(final.proofs[name]);
		const extra =
			name === "inheritedHardLimit"
				? " soft hard"
				: name === "initialFdRoster"
					? " tasks tables"
					: name === "aggregateTasksMembership"
						? " ceiling initialTaskIds"
						: "";
		fields(row, `version kind binding initialAt source name${extra}`);
		require(row.version === 1 &&
			row.kind === "fd-slot-initial-condition" &&
			row.name === name, "OPS_FINAL_GRAPH_CONDITION");
		same(row.binding, association);
		same(row.source, source.initialConditions[name]);
		read(row.source);
		if (initialAt === undefined) initialAt = row.initialAt;
		else same(row.initialAt, initialAt, "OPS_FINAL_GRAPH_INITIAL_CLOCK");
		if (name === "inheritedHardLimit")
			require(row.hard === final.N &&
				Number.isSafeInteger(row.soft) &&
				row.soft > 0 &&
				row.soft <= row.hard, "OPS_FINAL_GRAPH_BOUND");
		if (name === "aggregateTasksMembership") require(row.ceiling === final.T, "OPS_FINAL_GRAPH_BOUND");
	}
	const quantities = {
		openFileDescriptions: "open-file-descriptions",
		queuedOrInFlightReferences: "queued-or-inflight-references",
		ioUringFixedFiles: "io-uring-fixed-files",
		logicalHandles: "runtime-logical-handles",
	};
	fields(final.otherResources, Object.keys(quantities).join(" "));
	for (const [name, quantity] of Object.entries(quantities)) {
		const disposition = final.otherResources[name],
			exclusion = disposition.kind === "admitted-exclusion";
		fields(disposition, exclusion ? "kind evidence" : "kind evidence bound budget unit");
		require(exclusion || disposition.kind === "separately-bounded", "OPS_FINAL_GRAPH_NON_FD");
		if (!exclusion)
			require(Number.isSafeInteger(disposition.bound) &&
				Number.isSafeInteger(disposition.budget) &&
				disposition.bound >= 0 &&
				disposition.bound <= disposition.budget &&
				typeof disposition.unit === "string" &&
				disposition.unit.length > 0 &&
				disposition.unit.length <= 128, "OPS_FINAL_GRAPH_NON_FD");
		const row = read(disposition.evidence);
		fields(
			row,
			"version kind binding initialAt source quantity disposition" +
				(exclusion ? " restriction" : " bound budget unit"),
		);
		require(row.version === 1 && row.kind === "fd-slot-initial-other-resource", "OPS_FINAL_GRAPH_NON_FD");
		same(row.binding, association);
		same(row.initialAt, initialAt, "OPS_FINAL_GRAPH_INITIAL_CLOCK");
		same(row.quantity, quantity);
		same(row.disposition, disposition.kind);
		read(row.source);
		if (exclusion) {
			same(row.restriction, row.source);
			read(row.restriction);
		} else for (const key of ["bound", "budget", "unit"]) same(row[key], disposition[key]);
	}
	fields(initialAt, "clockId monotonicMs wallMs uncertaintyMs raw");
	same(initialAt.raw, selected.clockBasis, "OPS_FINAL_GRAPH_INITIAL_CLOCK");
	const basis = read(selected.clockBasis),
		calibration = read(basis.calibration);
	require(basis.version === 1 &&
		basis.kind === "original-ci-clock-initial-basis" &&
		calibration.version === 1 &&
		calibration.kind === "original-ci-clock-sample", "OPS_FINAL_GRAPH_INITIAL_CLOCK");
	same(basis.binding, association);
	same(basis.resourceEpoch, selected.ownerEpoch);
	same(initialAt.clockId, basis.clockId, "OPS_FINAL_GRAPH_INITIAL_CLOCK");
	const startNs = clockNs(calibration.monotonicAfterNs);
	require(clockNs(calibration.monotonicBeforeNs) <= startNs, "OPS_FINAL_GRAPH_INITIAL_CLOCK");
	const window = read(final.wholeWindow),
		retirement = read(final.retirement);
	fields(window, "version kind binding startNs endNs clockCoverage");
	require(window.version === 1 && window.kind === "fd-slot-window", "OPS_FINAL_GRAPH_WINDOW");
	same(window.binding, final.scope);
	require(clockNs(window.startNs) === startNs, "OPS_FINAL_GRAPH_WINDOW");
	fields(
		retirement,
		"version kind binding wholeWindow retiredAt snapshotAt releasedAt descendantReceipt finalSnapshot releaseReceipt",
	);
	require(retirement.version === 1 && retirement.kind === "fd-slot-retirement", "OPS_FINAL_GRAPH_RETIREMENT");
	same(retirement.binding, final.scope);
	same(retirement.wholeWindow, final.wholeWindow);
	const snapshot = read(retirement.finalSnapshot);
	const endNs = clockNs(window.endNs),
		retiredNs = clockNs(retirement.retiredAt);
	require(startNs <= retiredNs &&
		retiredNs <= clockNs(snapshot.started_monotonic_ns) &&
		clockNs(snapshot.started_monotonic_ns) <= endNs &&
		endNs === clockNs(snapshot.finished_monotonic_ns) &&
		endNs === clockNs(retirement.snapshotAt), "OPS_FINAL_GRAPH_WINDOW");
	same(retirement.descendantReceipt.retiredNs, retirement.retiredAt, "OPS_FINAL_GRAPH_RETIREMENT");
	const coverage = window.clockCoverage;
	fields(coverage, "basis query before after head");
	fields(coverage.query, "beforeNs afterNs");
	same(coverage.basis, selected.clockBasis, "OPS_FINAL_GRAPH_INITIAL_CLOCK");
	same(coverage.query, { beforeNs: window.startNs, afterNs: window.endNs }, "OPS_FINAL_GRAPH_WINDOW");
	// Selected endpoints are original basis/guard records, not timestamps or
	// stand-alone samples. Full-chain/native qualification remains with Source4.
	const point = (ref: RawRef) => {
		const record = read(ref),
			isBasis = record.kind === "original-ci-clock-initial-basis";
		require(record.version === 1 &&
			(isBasis
				? isDeepStrictEqual(ref, selected.clockBasis)
				: record.kind === "original-ci-clock-guard"), "OPS_FINAL_GRAPH_CLOCK_RECORD");
		for (const key of [
			"binding",
			"allocation",
			"resourceEpoch",
			"contract",
			"adapter",
			"boot",
			"timeNamespace",
			"clockId",
		])
			require(basis[key] !== undefined &&
				isDeepStrictEqual(record[key], basis[key]), "OPS_FINAL_GRAPH_CLOCK_IDENTITY");
		const sequence = isBasis ? 0n : clockNs(record.sequence);
		if (!isBasis) {
			require(sequence > 0n, "OPS_FINAL_GRAPH_CLOCK_SEQUENCE");
			read(record.prior);
		}
		const sample = isBasis ? calibration : read(record.sample);
		require(sample.version === 1 &&
			sample.kind === "original-ci-clock-sample" &&
			clockNs(sample.sequence) === sequence &&
			isDeepStrictEqual(sample.errors, []) &&
			calibration.controller !== undefined &&
			isDeepStrictEqual(sample.controller, calibration.controller), "OPS_FINAL_GRAPH_CLOCK_SAMPLE");
		const before = clockNs(sample.monotonicBeforeNs),
			after = clockNs(sample.monotonicAfterNs);
		require(before <= after, "OPS_FINAL_GRAPH_CLOCK_INTERVAL");
		return { before, after, sequence };
	};
	const covered = (value: any, from: string, to: string) => {
		fields(value, "basis query before after head");
		fields(value.query, "beforeNs afterNs");
		same(value.basis, selected.clockBasis, "OPS_FINAL_GRAPH_INITIAL_CLOCK");
		same(value.query, { beforeNs: from, afterNs: to }, "OPS_FINAL_GRAPH_CLOCK_QUERY");
		const left = point(value.before),
			right = point(value.after),
			head = point(value.head);
		require(clockNs(from) <= clockNs(to) &&
			left.after <= clockNs(from) &&
			right.before >= clockNs(to) &&
			left.sequence <= right.sequence &&
			right.sequence <= head.sequence &&
			right.after <= head.after, "OPS_FINAL_GRAPH_CLOCK_INTERVAL");
		return head;
	};
	const windowHead = covered(coverage, window.startNs, window.endNs);
	const release = read(retirement.releaseReceipt);
	fields(release, "version kind binding outcome aggregate releasedNs");
	require(release.version === 1 &&
		release.kind === "original-ci-resource-release/1" &&
		release.outcome === "released", "OPS_FINAL_GRAPH_RELEASE");
	same(release.binding, final.scope);
	same(release.aggregate, snapshot.aggregate);
	fields(release.aggregate, "path device inode");
	require(typeof release.aggregate.path === "string" &&
		release.aggregate.path.startsWith("/") &&
		clockNs(release.aggregate.device) === BigInt(scope.aggregate.device) &&
		clockNs(release.aggregate.inode) === BigInt(scope.aggregate.inode), "OPS_FINAL_GRAPH_RELEASE");
	require(endNs <= clockNs(release.releasedNs) &&
		clockNs(release.releasedNs) <= clockNs(retirement.releasedAt), "OPS_FINAL_GRAPH_RELEASE_ORDER");
	let releaseClockCoverage: any;
	for (const name of ["uninterruptedBoundaryCustody", "retirementTail"]) {
		const tail = read(final.proofs[name]);
		fields(
			tail,
			"version kind binding name wholeWindow retirement coverageStart coverageEnd initialProofs otherResources finalSnapshot releaseReceipt releaseClockCoverage",
		);
		require(tail.version === 1 &&
			tail.kind === "fd-slot-condition" &&
			tail.name === name, "OPS_FINAL_GRAPH_CONDITION");
		same(tail.binding, final.scope);
		same(tail.wholeWindow, final.wholeWindow);
		same(tail.retirement, final.retirement);
		same(tail.initialProofs, initial.proofs);
		same(tail.otherResources, initial.otherResources);
		same(tail.finalSnapshot, retirement.finalSnapshot);
		same(tail.releaseReceipt, retirement.releaseReceipt);
		same(tail.coverageStart, final.wholeWindow.path);
		same(tail.coverageEnd, retirement.releaseReceipt.path);
		if (releaseClockCoverage === undefined) releaseClockCoverage = tail.releaseClockCoverage;
		else same(tail.releaseClockCoverage, releaseClockCoverage, "OPS_FINAL_GRAPH_RELEASE_COVERAGE");
	}
	const releaseHead = covered(releaseClockCoverage, release.releasedNs, retirement.releasedAt);
	require(windowHead.sequence < releaseHead.sequence &&
		windowHead.after <= releaseHead.after, "OPS_FINAL_GRAPH_RELEASE_COVERAGE");
	return {
		kind: "original-final-graph-data" as const,
		final: structuredClone(selected.final),
		scope: structuredClone(final.scope) as RawRef,
		epoch: structuredClone(final.epoch) as RawRef,
		window: {
			startNs: startNs.toString(),
			endNs: endNs.toString(),
			raw: structuredClone(final.wholeWindow) as RawRef,
		},
		upperBound: Number(upperBound),
		releaseClockCoverage: structuredClone(releaseClockCoverage),
		award: null,
		remaining: [
			"outside-owner-authenticated-final-custody",
			"independent-nine-four-and-clock-semantics",
			"qualified-release-and-tail-coverage",
			"terminal-source-and-independent-billing",
		] as const,
	};
}

/** Original outside-owner selection DATA, not a final-intake capability. */
export interface OriginalTerminalSelection {
	owner: RawRef;
	ownerEpoch: string;
	binding: RawRef;
	clockBasis: RawRef;
	clockContract: RawRef;
	startedNs: string;
	captureReleaseDeadlineNs: string;
}

/** Resource382 correspondence on the actual Sense terminal carrier. Unknown
 * billing/counters refuse without mutating retained originals. Success is DATA,
 * never a clock, billing, source-completeness or finalization award. */
export function receiveOriginalTerminalData(
	raw: RawRef,
	selection: OriginalTerminalSelection,
	retained: ReadonlyMap<string, Uint8Array>,
) {
	const require = (condition: unknown, code: string): void => {
		if (!condition) throw new Error(code);
	};
	const fields = (value: any, names: string) =>
		require(value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.keys(value).sort().join(" ") === names.split(" ").sort().join(" "), "OPS_TERMINAL_FIELDS");
	const read = (ref: RawRef): any => {
		fields(ref, "path sha256");
		require(typeof ref.path === "string" &&
			ref.path.length > 0 &&
			/^[a-f0-9]{64}$/.test(ref.sha256), "OPS_TERMINAL_REF");
		const bytes = retained.get(ref.path);
		require(bytes && createHash("sha256").update(bytes).digest("hex") === ref.sha256, "OPS_TERMINAL_BYTES");
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes!));
	};
	const value = read(raw),
		selected = structuredClone(selection);
	const counters = ["invocations", "attemptedReads", "completedReads", "writerReadbacks", "billedRequests"] as const;
	fields(
		value,
		"protocol owner ownerEpoch binding window coverage sourceRequestsMetric sourceCost currency closure failures " +
			counters.join(" ") +
			(Object.hasOwn(value, "sourceBilling") ? " sourceBilling" : ""),
	);
	require(value.protocol === "sense-ops-terminal-source/1" &&
		value.sourceRequestsMetric === "completed-source-reads" &&
		value.ownerEpoch === selected.ownerEpoch &&
		isDeepStrictEqual(value.owner, selected.owner) &&
		isDeepStrictEqual(value.binding, selected.binding), "OPS_TERMINAL_SELECTION");
	for (const ref of [value.owner, value.binding, value.coverage]) read(ref);
	fields(value.closure, "outcome raw");
	read(value.closure.raw);
	require(value.closure.outcome === "closed" &&
		Array.isArray(value.failures) &&
		value.failures.length === 0, "OPS_TERMINAL_UNCLOSED");
	fields(value.window, "start end");
	const basis = read(selected.clockBasis),
		contract = read(selected.clockContract);
	require(isDeepStrictEqual(basis.contract, selected.clockContract), "OPS_TERMINAL_CLOCK_CONTRACT");
	const allowance = clockNs(contract.adapter.uncertaintyNs);
	require(allowance === clockNs(contract.rateEnvelope.adapterUncertaintyNs), "OPS_TERMINAL_CLOCK_ALLOWANCE");
	for (const stamp of [value.window.start, value.window.end]) {
		fields(
			stamp,
			"clockId monotonicMs wallMs uncertaintyMs raw monotonicNs uncertaintyNs basis guard original qualification conversionErrorNs",
		);
		require(typeof stamp.clockId === "string" &&
			stamp.clockId.length > 0 &&
			stamp.clockId.length <= 256 &&
			isDeepStrictEqual(stamp.basis, selected.clockBasis), "OPS_TERMINAL_CLOCK_BASIS");
		const point = clockNs(stamp.monotonicNs),
			error = clockNs(stamp.uncertaintyNs),
			conversion = clockNs(stamp.conversionErrorNs);
		require(Number.isFinite(stamp.wallMs) &&
			Number.isFinite(stamp.monotonicMs) &&
			Number.isFinite(stamp.uncertaintyMs) &&
			stamp.monotonicMs === Number(point) / 1000000 &&
			stamp.uncertaintyMs === Number(error) / 1000000 &&
			error <= 1000000000n, "OPS_TERMINAL_CLOCK_DISPLAY");
		const view = read(stamp.raw);
		require(["sense-ops-sc085-qualified-stamp/2", "sense-ops-sc085-qualified-bootstrap-stamp/2"].includes(
			view.protocol,
		), "OPS_TERMINAL_CLOCK_VIEW");
		for (const key of Object.keys(stamp).filter((key) => key !== "raw"))
			require(isDeepStrictEqual(stamp[key], view[key]), "OPS_TERMINAL_CLOCK_VIEW");
		for (const ref of [stamp.guard, stamp.original, stamp.qualification]) read(ref);
		// Same exact binary64 rational method as the original Pi projection. Never
		// invert a rounded float into a timestamp or charge this error a second time.
		const bits = new DataView(new ArrayBuffer(8));
		bits.setFloat64(0, stamp.monotonicMs);
		const encoded = bits.getBigUint64(0),
			exponent = Number((encoded >> 52n) & 2047n);
		const mantissa = (encoded & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n);
		const power = (exponent || 1) - 1023 - 52,
			denominator = power < 0 ? 1n << BigInt(-power) : 1n;
		const numerator = mantissa * 1000000n * (power > 0 ? 1n << BigInt(power) : 1n);
		const difference = point * denominator - numerator,
			absolute = difference < 0n ? -difference : difference;
		require(conversion === (absolute + denominator - 1n) / denominator &&
			conversion <= allowance, "OPS_TERMINAL_CLOCK_ERROR");
	}
	const start = value.window.start,
		end = value.window.end;
	require(start.clockId === end.clockId &&
		clockNs(selected.startedNs) <= clockNs(start.monotonicNs) &&
		clockNs(start.monotonicNs) <= clockNs(end.monotonicNs) &&
		clockNs(end.monotonicNs) < clockNs(selected.captureReleaseDeadlineNs), "OPS_TERMINAL_CLOCK_WINDOW");
	for (const name of [...counters, "sourceCost"]) {
		const fact = value[name];
		fields(fact, "value raw unknown");
		require(typeof fact.value === "number" &&
			Number.isFinite(fact.value) &&
			fact.value >= 0 &&
			fact.unknown === null &&
			(name === "sourceCost" || Number.isSafeInteger(fact.value)), `OPS_TERMINAL_UNKNOWN:${name}`);
		read(fact.raw);
	}
	require(value.completedReads.value <= value.attemptedReads.value &&
		value.writerReadbacks.value <= value.completedReads.value &&
		value.billedRequests.value <= value.completedReads.value, "OPS_TERMINAL_COUNTER_RELATIONS");
	if (Object.hasOwn(value, "sourceBilling")) {
		const billing = value.sourceBilling;
		fields(billing, "kind basis currency excludes");
		read(billing.basis);
		require(billing.kind === "unbilled-local-source" &&
			billing.currency === "not-applicable" &&
			value.currency === null &&
			isDeepStrictEqual(billing.excludes, ["compute", "model"]) &&
			value.sourceCost.value === 0 &&
			value.billedRequests.value === 0, "OPS_TERMINAL_BILLING");
	} else
		require(typeof value.currency === "string" &&
			value.currency.length > 0 &&
			value.currency.length <= 256 &&
			value.currency !== "not-applicable", "OPS_TERMINAL_CURRENCY");
	return {
		kind: "original-terminal-data" as const,
		raw: structuredClone(raw),
		value: value as TerminalSourceAccounting,
		award: null,
		remaining: [
			"outside-owner-authenticated-terminal-selection",
			"independent-clock-and-source-coverage",
			"independent-billing-or-local-backing",
		] as const,
	};
}

export interface TerminalSourceAccounting {
	protocol: "sense-ops-terminal-source/1";
	binding: RawRef;
	owner: RawRef;
	ownerEpoch: string;
	window: { start: Stamp; end: Stamp };
	coverage: RawRef;
	invocations: Fact;
	attemptedReads: Fact;
	completedReads: Fact;
	writerReadbacks: Fact;
	billedRequests: Fact;
	sourceRequestsMetric: "completed-source-reads";
	sourceCost: Fact;
	currency: string | null;
	sourceBilling?: {
		kind: "unbilled-local-source";
		basis: RawRef;
		currency: "not-applicable";
		excludes: readonly ["compute", "model"];
	};
	closure: { outcome: "closed" | "failed" | "unknown"; raw: RawRef | null };
	failures: readonly RawRef[];
}
