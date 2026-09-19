import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RawRef } from "./fd-slot-expectation.ts";
import type { IndependentlyAdmittedFdSlotPreflight } from "./fd-slot-preflight.ts";

// Exact proposed ORIGINAL controller overlay, not caller-selectable executable code.
export const OPERATIONAL_CONTROLLER_SHA256 = "fdf74629e6a1da89ab9ba9c84c5824eb9b912ec1c2b668c2eb80e98b4505ae61";
export interface OperationalBinding {
	version: 1;
	namespace: "sense-operational-pi";
	producer_schema: "ops-bindings-17-source-diagnostics";
	producer_contract: RawRef;
	instruction: RawRef;
	operational_run_id: string;
	native: { decision: RawRef; receiving: RawRef; profile: RawRef };
	producers: Record<string, RawRef>;
	allowed_operations: readonly string[];
	fd_slot_bound: IndependentlyAdmittedFdSlotPreflight | null;
	policy: RawRef;
}
export interface OriginalCISelection {
	readonly controller: RawRef;
	readonly authorizationId: string;
	readonly releaseSha256: string;
	readonly expected: Readonly<
		Record<
			| "repository_id"
			| "run_id"
			| "run_attempt"
			| "source_sha"
			| "source_tree"
			| "control_sha"
			| "workflow_sha"
			| "recipe_sha256"
			| "manifest_sha256",
			string
		>
	>;
}
export interface ReceivedCIData {
	version: 1;
	kind: "original-ci-operational-authorization";
	authorization_id: string;
	release_sha256: string;
	authorization: {
		repository_id: string;
		run_id: string;
		run_attempt: string;
		source_sha: string;
		source_tree: string;
		control_sha: string;
		workflow_sha: string;
		recipe_sha256: string;
		release_sha256: string;
		issued_at: number;
		expires_at: number;
		manifest: unknown;
		operational_binding: OperationalBinding;
	};
	manifest_sha256: string;
}
/** Nonmutating ORIGINAL authorization transport. No caller response/callback injection,
 * sudo, network, file-permission changes, issue/serve/run or native allocation path.
 * Needs actual separately installed matching control and existing canonical access;
 * absent/inaccessible STATE/policy/intent is refusal, never a copied-file fallback. */
export function receiveOriginalCIAuthorization(selection: OriginalCISelection): ReceivedCIData {
	assert(
		/^[a-f0-9]{64}$/.test(selection.authorizationId) && /^[a-f0-9]{64}$/.test(selection.releaseSha256),
		"OPS_CI_SELECTION",
	);
	assert(
		selection.controller.sha256 === OPERATIONAL_CONTROLLER_SHA256 &&
			/^\/opt\/smarty-ci-candidate\/releases\/[a-f0-9]{64}\/candidate-run\.py$/.test(selection.controller.path),
		"OPS_CI_ORIGINAL_CONTROLLER",
	);
	const protectedPath = () => {
		for (let p = selection.controller.path; ; p = dirname(p)) {
			const s = lstatSync(p);
			assert(s.uid === 0 && !s.isSymbolicLink() && !(s.mode & 0o022), "OPS_CI_CONTROLLER_CUSTODY");
			if (p === "/") break;
		}
	};
	protectedPath();
	const fd = openSync(selection.controller.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	const errors: unknown[] = [];
	let received: ReceivedCIData | undefined;
	try {
		const before = fstatSync(fd);
		assert(
			before.isFile() && before.nlink === 1 && !(before.mode & 0o222) && before.size <= 256 * 1024,
			"OPS_CI_CONTROLLER_FILE",
		);
		const check = () => {
			protectedPath();
			for (const s of [fstatSync(fd), lstatSync(selection.controller.path)])
				assert(
					s.dev === before.dev &&
						s.ino === before.ino &&
						s.size === before.size &&
						s.nlink === 1 &&
						s.mode === before.mode &&
						s.uid === before.uid &&
						s.mtimeMs === before.mtimeMs &&
						s.ctimeMs === before.ctimeMs,
					"OPS_CI_CONTROLLER_DRIFT",
				);
		};
		assert(
			createHash("sha256").update(readFileSync(fd)).digest("hex") === OPERATIONAL_CONTROLLER_SHA256,
			"OPS_CI_CONTROLLER_PIN",
		);
		check();
		const raw = execFileSync(
			"/usr/bin/python3",
			["-I", "-B", selection.controller.path, "receive-operational", selection.authorizationId],
			{
				env: { PATH: "/usr/bin:/bin", LANG: "C" },
				timeout: 5000,
				maxBuffer: 65536,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		check();
		const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as ReceivedCIData;
		assert(
			result.version === 1 &&
				result.kind === "original-ci-operational-authorization" &&
				result.authorization_id === selection.authorizationId &&
				result.release_sha256 === selection.releaseSha256 &&
				result.authorization.release_sha256 === selection.releaseSha256,
			"OPS_CI_ORIGINAL_PROVENANCE",
		);
		received = result;
	} catch (cause) {
		errors.push(cause);
	}
	try {
		closeSync(fd);
	} catch (cause) {
		errors.push(cause);
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "OPS_CI_CONTROLLER_CLOSE", { cause: errors[0] });
	return received!;
}
