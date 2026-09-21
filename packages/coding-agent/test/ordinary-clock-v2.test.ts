import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { requireIndependentClockQualification } from "../src/core/ordinary-sc085-source/clock-parent-association.ts";
import { canonicalSc085AuditClockQualification, parseSc085AuditClockQualification, type Sc085AuditClockQualificationV2 } from "../src/core/ordinary-sc085-source/sc085-admission.ts";

const ref = { path: "/inert/metadata", sha256: "a".repeat(64) };
const metadata: Sc085AuditClockQualificationV2 = {
	protocol: "sense-ops-sc085-audit-clock/2", owner: { ownerEpoch: "child", sessionId: "session", allocationId: "allocation" }, admittedClockId: "parent", nativeIdentity: ref, source: "node:perf_hooks.performance", sourceIdentity: ref,
	mapping: { kind: "original-native-clock-witness", nativeClockId: "local", contract: ref, basis: ref, producer: ref, implementation: ref, uncertaintyNs: "1000000000" }, validity: { notBeforeWallMs: 1, expiresWallMs: 2 },
};
// Encoding tests ONLY. References deliberately identify no qualified mechanism,
// artifact or physical evidence. No positive admission/qualification fixture.
test("v2 metadata has canonical exact-ns fields without fractional JSON substitution", () => {
	const raw = canonicalSc085AuditClockQualification(metadata);
	expect(parseSc085AuditClockQualification(raw)).toEqual(metadata);
	expect(raw.toString()).not.toContain("same-original-source");
});
test.each(["-1", "01", "1.1", "1000000001"])("v2 refuses malformed/over-budget error %s", (uncertaintyNs) => {
	expect(() => canonicalSc085AuditClockQualification({ ...metadata, mapping: { ...metadata.mapping, uncertaintyNs } })).toThrow();
});
test("v1 cannot be relabeled into v2", () => {
	const old = { ...metadata, protocol: "sense-ops-sc085-audit-clock/1", mapping: { kind: "same-original-source", nativeClockId: "local", uncertaintyMs: 0 } };
	expect(() => parseSc085AuditClockQualification(Buffer.from(JSON.stringify(old)))).toThrow("SC085_CLOCK_PROTOCOL");
});
test("no positive independent-method award exists for consistency observations", () => {
	expect(() => requireIndependentClockQualification()).toThrow("OPS_CLOCK_INDEPENDENT_METHOD_UNSUPPORTED");
});
test("original routes use v2 carriers and the last existing recheck, no old float-copy emission", () => {
	const source = readFileSync(new URL("../src/core/ordinary-sc085-source/operational-admission.ts", import.meta.url), "utf8");
	expect(source).not.toContain('protocol: "sense-ops-sc085-qualified-stamp/1"');
	expect(source).not.toContain('protocol: "sense-ops-sc085-qualified-bootstrap-stamp/1"');
	expect(source).toContain('protocol: "sense-ops-sc085-qualified-stamp/2"');
	expect(source).toContain('protocol: "sense-ops-sc085-qualified-bootstrap-stamp/2"');
	expect(source).toContain('recheck("preflight", terminalAccounting, clock)');
	expect(source).toContain('recheck("boundary", false, clock)');
	expect(source).toContain("requireIndependentClockQualification();");
});
