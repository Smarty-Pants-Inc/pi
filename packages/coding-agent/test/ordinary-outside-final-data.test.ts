import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
	decodeOutsideFinal,
	decodeOutsideStaged,
	type OutsideRecords,
} from "../src/core/ordinary-sc085-source/outside-final-data.ts";
import type {
	OperationalFinalTailAdmission,
	OperationalSourceAccountingInput,
	RawRef,
} from "../src/core/ordinary-sc085-source/source-contracts.ts";

// Pure DATA definitions, authored but UNRUN. Synthetic refs do not qualify a
// clock, source, issuer, original root, billing, retirement or native operation.
function fixture() {
	const retained = new Map<string, Buffer>();
	const put = (path: string, value: unknown): RawRef => {
		const body = Buffer.from(JSON.stringify(value));
		retained.set(path, body);
		return { path, sha256: createHash("sha256").update(body).digest("hex") };
	};
	const bytes = (ref: RawRef) => {
		const body = retained.get(ref.path);
		if (!body || createHash("sha256").update(body).digest("hex") !== ref.sha256)
			throw new Error("synthetic missing or changed retained bytes");
		return Buffer.from(body);
	};
	const records: OutsideRecords = { bytes, record: (ref) => JSON.parse(bytes(ref as RawRef).toString("utf8")) };
	const owner = put("/fixture/owner", { synthetic: "owner" });
	const observer = put("/fixture/observer", { synthetic: "observer" });
	const accounting: OperationalSourceAccountingInput = {
		owner,
		ownerEpoch: "synthetic-epoch",
		binding: put("/fixture/binding", { synthetic: "binding" }),
		observer,
		target: "synthetic-target",
		watches: [{ watchId: "w", executionKey: "k", input: {} }],
	};
	const admission: OperationalFinalTailAdmission = {
		owner,
		ownerEpoch: accounting.ownerEpoch,
		admission: put("/fixture/admission", { synthetic: "admission" }),
		initial: put("/fixture/initial", { synthetic: "initial" }),
		limits: put("/fixture/limits", { synthetic: "limits" }),
		survivor: put("/fixture/survivor", { synthetic: "survivor" }),
		obligations: [{ id: "fd", kind: "fd-slot-final-proof" }],
	};
	const closure = put("/fixture/closure", { synthetic: "closure" });
	const window = { start: { monotonicNs: "1", uncertaintyNs: "0" }, end: { monotonicNs: "2", uncertaintyNs: "0" } };
	const coverageValue = {
		kind: "ops-source-accounting-coverage",
		selected: { ...accounting, observer: put("/fixture/copied-observer", { synthetic: "observer" }) },
		nativeEpoch: "synthetic-not-qualified",
		window,
		pending: 0,
		outstandingReadbacks: 0,
		ambiguousObserver: false,
		ambiguousWriter: false,
		closure,
	};
	const coverage = put("/fixture/coverage", coverageValue);
	const known = { value: 0, raw: coverage, unknown: null };
	const unknown = { value: null, raw: coverage, unknown: "independent billing absent" };
	const terminal = {
		protocol: "sense-ops-terminal-source/1",
		owner,
		ownerEpoch: accounting.ownerEpoch,
		binding: accounting.binding,
		window,
		coverage,
		sourceRequestsMetric: "completed-source-reads",
		currency: null,
		invocations: known,
		attemptedReads: known,
		completedReads: known,
		writerReadbacks: known,
		billedRequests: unknown,
		sourceCost: unknown,
		closure: { outcome: "closed", raw: closure },
		failures: [] as RawRef[],
	};
	const stage: {
		protocol: string;
		status: "pending-finalization" | "failed";
		admission: OperationalFinalTailAdmission;
		terminalSource: RawRef | null;
		phases: { phase: string; raw: RawRef }[];
		failures: RawRef[];
	} = {
		protocol: "sense-ops-final-tail/1",
		status: "pending-finalization",
		admission: structuredClone(admission),
		terminalSource: put("/fixture/terminal", terminal),
		failures: [],
		phases: ["context", "quiet", "burst", "soak"].map((phase) => ({
			phase,
			raw: put(`/fixture/phase-${phase}`, { kind: "phase-report", value: { phase } }),
		})),
	};
	const receive = () => decodeOutsideStaged(put("/fixture/stage", stage), admission, accounting, records);
	return { retained, put, records, accounting, admission, stage, terminal, coverageValue, receive };
}

test("coverage is not billing: genuine unknown DATA retains refusals and null award", () => {
	const f = fixture(),
		value = f.receive();
	expect(value.billing).toEqual({ status: "unknown", basis: null });
	expect(value.award).toBeNull();
	expect(value.refusals).toEqual([
		"OPS_OUTSIDE_TERMINAL_UNKNOWN:billedRequests",
		"OPS_OUTSIDE_TERMINAL_UNKNOWN:sourceCost",
		"OPS_OUTSIDE_BILLING_UNKNOWN",
	]);
	// Decoder must refuse BEFORE touching any alleged actual final record.
	const unread: OutsideRecords = {
		bytes: () => {
			throw new Error("unexpected final read");
		},
		record: () => {
			throw new Error("unexpected final read");
		},
	};
	const expected = { staged: value } as Parameters<typeof decodeOutsideFinal>[2];
	expect(() => decodeOutsideFinal(f.accounting.owner, f.accounting.owner, expected, unread)).toThrow(
		"OPS_OUTSIDE_FINAL_STAGED_REFUSED",
	);
});

test.each(["owner", "ownerEpoch", "initial", "survivor"] as const)(
	"correctly rehashed foreign stage %s cannot replace original admission",
	(key) => {
		const f = fixture();
		if (key === "ownerEpoch") f.stage.admission.ownerEpoch = "foreign";
		else f.stage.admission[key] = f.put(`/fixture/foreign-${key}`, { foreign: true });
		expect(() => f.receive()).toThrow("OPS_OUTSIDE_STAGE_ADMISSION");
	},
);

test.each(["missing", "changed"])("retained original %s refuses without path fallback", (mode) => {
	const f = fixture();
	if (mode === "missing") f.retained.delete(f.admission.initial.path);
	else f.retained.set(f.admission.initial.path, Buffer.from("{}"));
	expect(() => f.receive()).toThrow("synthetic missing or changed retained bytes");
});

test("copied observer logical key accepts only the originally pinned bytes", () => {
	const f = fixture();
	expect(f.receive().award).toBeNull();
	f.coverageValue.selected.observer = f.put("/fixture/foreign-observer", { synthetic: "foreign" });
	f.terminal.coverage = f.put("/fixture/coverage", f.coverageValue);
	f.stage.terminalSource = f.put("/fixture/terminal", f.terminal);
	expect(() => f.receive()).toThrow("OPS_OUTSIDE_OBSERVER_PIN");
});

test("failed stage with no terminal remains failure DATA, not a fabricated billing basis", () => {
	const f = fixture();
	f.stage.status = "failed";
	f.stage.phases = [];
	f.stage.terminalSource = null;
	f.stage.failures = [f.put("/fixture/failure", { synthetic: "possible effect" })];
	const value = f.receive();
	expect(value).toMatchObject({
		status: "failed",
		terminal: null,
		award: null,
		billing: { status: "unknown", basis: null },
		failures: f.stage.failures,
		refusals: ["OPS_OUTSIDE_STAGE_FAILED", "OPS_OUTSIDE_TERMINAL_MISSING", "OPS_OUTSIDE_BILLING_UNKNOWN"],
	});
});

test("returned staged DATA is detached from original selections and retained bytes", () => {
	const f = fixture(),
		before = [...f.retained].map(([key, value]) => [key, value.toString("hex")]);
	const value = f.receive();
	value.owner.ownerEpoch = "changed";
	value.admission.owner.path = "/changed";
	value.refusals.length = 0;
	expect(f.admission.owner.path).toBe("/fixture/owner");
	expect(f.accounting.ownerEpoch).toBe("synthetic-epoch");
	// receive added only its actual staged fixture row; originals are unchanged.
	expect(
		[...f.retained].filter(([key]) => key !== "/fixture/stage").map(([key, body]) => [key, body.toString("hex")]),
	).toEqual(before);
	expect(f.receive().refusals).toContain("OPS_OUTSIDE_BILLING_UNKNOWN");
});
