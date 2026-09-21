import assert from "node:assert/strict";
import { parseCanonicalPilotDecision } from "./references/sense/src/adapters/codex/pilot-canonical.ts";
import { sc085RetainedBytes } from "./sc085-admission.ts";
import type { RawRef } from "./source-contracts.ts";

/** Private leaf DATA at original-ci-soak-methods/1.methods.compaction, not a
 * second soak-boundaries root. Parsing it grants no permission or session method. */
export interface OriginalCompactionSelection {
	version: 1;
	kind: "original-pi-compaction-method/1";
	method: "original-agent-session-built-in-compaction/1";
	implementation: RawRef;
	context: "exclude-observation-frame-bodies";
	customInstructions: null;
}

/** The sole authenticated soak-boundaries root. Other method Refs are retained
 * as operands, not advertised as implemented methods. */
export function receiveOriginalCompactionMethod(input: {
	root: RawRef;
	controller: RawRef;
	retained: ReadonlyMap<string, Uint8Array>;
	application: RawRef;
}): { root: RawRef; plan: RawRef; method: RawRef; selection: OriginalCompactionSelection } {
	const root: unknown = parseCanonicalPilotDecision(sc085RetainedBytes(input.root, input.retained));
	fields(root, "version kind plan controllerSource methods");
	assert(root.version === 1 && root.kind === "original-ci-soak-methods/1", "OPS_COMPACTION_ROOT_KIND");
	assert.deepEqual(root.controllerSource, input.controller, "OPS_COMPACTION_ROOT_CONTROLLER");
	fields(root.methods, "compaction restart quota retention");
	for (const reference of [root.plan, root.controllerSource, ...Object.values(root.methods)]) {
		fields(reference, "path sha256");
		sc085RetainedBytes(reference as unknown as RawRef, input.retained);
	}
	const method = root.methods.compaction as RawRef;
	return {
		root: { ...input.root }, plan: { ...(root.plan as RawRef) }, method: { ...method },
		selection: receiveOriginalCompactionSelection({ ...input, method }),
	};
}

function fields(value: unknown, names: string): asserts value is Record<string, unknown> {
	assert(value !== null && typeof value === "object" && !Array.isArray(value), "OPS_COMPACTION_SELECTION_OBJECT");
	assert.deepEqual(Object.keys(value).sort(), names.split(" ").sort(), "OPS_COMPACTION_SELECTION_FIELDS");
}

/** Inert leaf correspondence only. The original receiving closure must supply
 * method from the authenticated root.methods.compaction and application from
 * its original admission. This function does not validate/replace the root,
 * issue a grant, select future evidence, or implement four-method preflight. */
export function receiveOriginalCompactionSelection(input: {
	method: RawRef;
	retained: ReadonlyMap<string, Uint8Array>;
	application: RawRef;
}): OriginalCompactionSelection {
	const value: unknown = parseCanonicalPilotDecision(sc085RetainedBytes(input.method, input.retained));
	fields(value, "version kind method implementation context customInstructions");
	assert(value.version === 1 && value.kind === "original-pi-compaction-method/1", "OPS_COMPACTION_SELECTION_KIND");
	assert(value.method === "original-agent-session-built-in-compaction/1", "OPS_COMPACTION_SELECTION_METHOD");
	fields(value.implementation, "path sha256");
	const implementation = value.implementation;
	assert(
		typeof implementation.path === "string" &&
			implementation.path.startsWith("/") &&
			!/[\u0000-\u001f\u007f]/.test(implementation.path) &&
			!implementation.path.split("/").slice(1).some((part) => !part || part === "." || part === "..") &&
			typeof implementation.sha256 === "string" &&
			/^[a-f0-9]{64}$/.test(implementation.sha256),
		"OPS_COMPACTION_SELECTION_REF",
	);
	assert.deepEqual(implementation, input.application, "OPS_COMPACTION_SELECTION_APPLICATION");
	assert(
		value.context === "exclude-observation-frame-bodies" && value.customInstructions === null,
		"OPS_COMPACTION_SELECTION_CONTEXT",
	);
	return {
		version: 1,
		kind: "original-pi-compaction-method/1",
		method: "original-agent-session-built-in-compaction/1",
		implementation: { path: implementation.path, sha256: implementation.sha256 },
		context: "exclude-observation-frame-bodies",
		customInstructions: null,
	};
}
