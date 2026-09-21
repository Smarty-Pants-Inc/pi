// Source-only composition of Sense2468. See ORIGINS.json; do not edit supplier logic here.
// ponytail: preserve the supplier DATA decoder (including its internal any types)
// rather than maintain a second semantic validator. No authority is imported.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	receiveOriginalFinalGraphData,
	receiveOriginalTerminalData,
	type OriginalFinalGraphSelection,
	type OriginalTerminalSelection,
	type RawRef,
} from "./measurement.ts";
import type { SourceAdmissionPorts } from "../../../source-contracts.ts";
type OperationalRecorder = Pick<SourceAdmissionPorts["recorder"], "retained">;
export interface OperationalFinalTailAdmission {
	owner: RawRef;
	ownerEpoch: string;
	admission: RawRef;
	initial: RawRef;
	limits: RawRef;
	survivor: RawRef;
	obligations: readonly { id: string; kind: "fd-slot-final-proof" | "whole-lifetime-accounting" }[];
}
interface OriginalPhase {
	phase: "context" | "quiet" | "burst" | "soak";
	raw: RawRef;
}
export interface OperationalStagedCollection {
	protocol: "sense-ops-final-tail/1";
	status: "pending-finalization" | "failed";
	admission: OperationalFinalTailAdmission;
	terminalSource: RawRef | null;
	phases: readonly OriginalPhase[];
	failures: readonly RawRef[];
}
export interface OperationalStagePointer {
	version: 1;
	kind: "sense-operational-staged";
	stage: RawRef;
}

/** Outside-owner DATA receiving seam. Registration waits for Pi's authenticated
 * final intake; caller-supplied selectors cannot confer that authority. Resolve
 * only the designated stage/terminal refs, never scan the recorder for a match. */
export function receiveOperationalFinalGraphData(
	stage: RawRef,
	selection: OriginalFinalGraphSelection,
	recorder: Pick<OperationalRecorder, "retained">,
) {
	const read = (ref: RawRef) => {
		const bytes = ref && recorder.retained.get(ref.path);
		assert(
			bytes && /^[a-f0-9]{64}$/.test(ref.sha256) && createHash("sha256").update(bytes).digest("hex") === ref.sha256,
			"OPS_STAGE_RETAINED",
		);
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	};
	const staged = read(stage) as OperationalStagedCollection;
	assert(
		staged.protocol === "sense-ops-final-tail/1" && ["pending-finalization", "failed"].includes(staged.status),
		"OPS_STAGE_ADMISSION",
	);
	assert(
		isDeepStrictEqual(staged.admission.owner, selection.owner) &&
			staged.admission.ownerEpoch === selection.ownerEpoch,
		"OPS_STAGE_ADMISSION_REBOUND",
	);
	assert(Array.isArray(staged.failures), "OPS_STAGE_SNAPSHOTS");
	for (const ref of staged.failures) read(ref);
	if (staged.terminalSource !== null) {
		const terminal = read(staged.terminalSource);
		assert(
			terminal.protocol === "sense-ops-terminal-source/1" &&
				isDeepStrictEqual(terminal.owner, staged.admission.owner) &&
				terminal.ownerEpoch === staged.admission.ownerEpoch,
			"OPS_STAGE_TERMINAL_OWNER",
		);
	}
	return {
		staged: structuredClone(stage),
		status: staged.status,
		failures: structuredClone(staged.failures),
		terminalSource: structuredClone(staged.terminalSource),
		graph: receiveOriginalFinalGraphData(selection, recorder.retained),
	};
}

/** Same designated staged selection as the original Resource terminal receiver.
 * Called only by the future authenticated outside intake, not worker shutdown. */
export function receiveOperationalTerminalData(
	stage: RawRef,
	selection: OriginalTerminalSelection,
	recorder: Pick<OperationalRecorder, "retained">,
) {
	const bytes = recorder.retained.get(stage.path);
	assert(bytes && createHash("sha256").update(bytes).digest("hex") === stage.sha256, "OPS_STAGE_RETAINED");
	const staged = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as OperationalStagedCollection;
	const fields = (value: unknown, keys: string) =>
		assert(
			value &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				Object.keys(value).sort().join(" ") === keys.split(" ").sort().join(" "),
			"OPS_TERMINAL_STAGE_FIELDS",
		);
	fields(staged, "protocol status admission terminalSource phases failures");
	fields(staged.admission, "owner ownerEpoch admission initial limits survivor obligations");
	assert(
		staged.protocol === "sense-ops-final-tail/1" &&
			staged.status === "pending-finalization" &&
			Array.isArray(staged.failures) &&
			staged.failures.length === 0 &&
			staged.terminalSource,
		"OPS_TERMINAL_STAGE_UNAVAILABLE",
	);
	assert(
		isDeepStrictEqual(staged.admission.owner, selection.owner) &&
			staged.admission.ownerEpoch === selection.ownerEpoch,
		"OPS_STAGE_ADMISSION_REBOUND",
	);
	assert(
		Array.isArray(staged.phases) &&
			isDeepStrictEqual(
				staged.phases.map((row) => row.phase),
				["context", "quiet", "burst", "soak"],
			),
		"OPS_STAGE_PHASES_INCOMPLETE",
	);
	for (const row of staged.phases) {
		fields(row, "phase raw");
		const raw = recorder.retained.get(row.raw.path);
		assert(raw && createHash("sha256").update(raw).digest("hex") === row.raw.sha256, "OPS_STAGE_RETAINED");
	}
	return {
		staged: structuredClone(stage),
		terminal: receiveOriginalTerminalData(staged.terminalSource!, selection, recorder.retained),
	};
}
