import type { Buffer } from "node:buffer";

/** Source's structural boundary to the original Sense 94ae824 host.
 * These are data and port types, not another host, validator or authority.
 * Full instruction fields are retained; only unused host ports are omitted.
 * See TYPE-ORIGINS.json in the source packet for the original declarations.
 * ponytail: keep this small boundary instead of compiling copied Sense runners
 * in Pi. A change to the original contract requires a paired compatibility review.
 */
export interface RawRef {
	path: string;
	sha256: string;
}
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type EvidenceLevel = "MOCK" | "EXECUTION" | "NATIVE" | "WIRE" | "LIVE" | "JOINT" | "ROLLBACK" | "PILOT";
export interface EvidenceSource {
	commit: string;
	tree: string;
	dirtyState: "clean";
	lockfileSha256: string;
}
export interface EvidenceProfile {
	id: string;
	harness: "pi" | "codex-native-app-server";
	os: string;
	architecture: string;
	provider: string;
	model: string;
	effort: string;
	transport: string;
	authenticationMode: string;
	runtimeVersion: string;
	runtimeSha256: string;
	harnessVersion: string;
	harnessCommit: string;
	binarySha256: string;
	nativePatchSha256: string | null;
	protocolSha256: string;
	configurationSha256: string;
	grantsSha256: string;
	executionIsolationSha256: string;
}
export type OpsBinding =
	| "artifact-grants"
	| "clock"
	| "native-turn-meter"
	| "output-health-events"
	| "sample-byte-meter"
	| "whole-job-cpu"
	| "source-billing"
	| "pending-overlap-highwater"
	| "resource-highwater"
	| "operating-limits"
	| "workload"
	| "source-diagnostics"
	| "accepted-final-request"
	| "matched-request-pair"
	| "refresh-settlement"
	| "soak-boundaries"
	| "joined-retirement";
export interface BurstExpectation {
	change: number;
	sourceSha256: string;
	sourceBytes: number;
	watches: {
		watchId: string;
		executionKey: string;
		stateNamespace: string | { kind: "original-setup" };
		outcome: "OK" | "EXIT_NONZERO";
		body: string;
		diagnostic: string | null;
	}[];
}
export interface Sc085Plan {
	admission: RawRef;
	finalExpectation: BurstExpectation;
	failureExpectations: readonly BurstExpectation[];
}
export interface OperationalFinalTailAdmission {
	owner: RawRef;
	ownerEpoch: string;
	admission: RawRef;
	initial: RawRef;
	limits: RawRef;
	survivor: RawRef;
	obligations: readonly { id: string; kind: "fd-slot-final-proof" | "whole-lifetime-accounting" }[];
}
export interface OperationalSourceInput {
	workload: RawRef;
	package: { document: RawRef; observer: RawRef };
	target: string;
	retention: RawRef;
}
export interface OperationalSourceAccountingInput {
	binding: RawRef;
	owner: RawRef;
	ownerEpoch: string;
	observer: RawRef;
	target: string;
	watches: readonly { watchId: string; executionKey: string; input: JsonObject }[];
}
export interface SourceOperationalInstruction {
	version: 1;
	operation: "sense-operational-pi";
	runId: string;
	identity: {
		source: EvidenceSource;
		profile: EvidenceProfile;
		level: EvidenceLevel;
		ownerRef: RawRef | null;
		commandRef: RawRef | null;
		machineRef: RawRef | null;
		clockKind: "native-monotonic" | "synthetic";
	};
	providerModule: RawRef;
	without: readonly unknown[];
	with: readonly unknown[];
	prompt: string;
	burstChanges: number;
	burstExpectations: readonly BurstExpectation[];
	soakMs: number;
	setupExpectation?: Pick<BurstExpectation, "watches">;
	boundaries: readonly { kind: "restart" | "quota" | "compaction" | "retention"; afterMs: number }[];
	finalTail?: OperationalFinalTailAdmission;
	sc085?: Sc085Plan;
	production?: { source?: OperationalSourceInput; sourceAccounting?: OperationalSourceAccountingInput };
}
export interface SourceAdmissionPorts {
	recorder: {
		retained: ReadonlyMap<string, Uint8Array>;
		record(event: unknown): RawRef;
		bytes(bytes: Uint8Array): RawRef;
		/** Required by the private clock projection; absent ports cannot qualify it. */
		retain?(ref: RawRef, bytes: Uint8Array): void;
		close(): Promise<void>;
	};
	admission: {
		receive(
			input: SourceOperationalInstruction,
			originalBytes: Uint8Array,
		): Promise<Partial<Record<OpsBinding, RawRef | null>>>;
		check(operation: "preflight" | "configure" | "request" | "burst" | "refresh" | "boundary"): void;
	};
}
/** Exact return shape of the original receiveOperationalFile, including the
 * buffer type of the installed Node declarations' actual Buffer.alloc overload.
 * No file receiver is implemented or selected by this type. */
export interface HeldOperationalFile {
	bytes: ReturnType<typeof Buffer.alloc>;
	check: () => void;
	close(): void;
}
