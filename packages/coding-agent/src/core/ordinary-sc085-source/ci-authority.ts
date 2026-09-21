import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import {
	assertOriginalCIClockQuery,
	type OriginalCIClockQuery,
	parseOriginalCIClock,
	type ReceivedCIClock,
} from "./ci-clock-receiving.ts";
import type { RawRef } from "./fd-slot-expectation.ts";
import type { IndependentlyAdmittedFdSlotPreflight } from "./fd-slot-preflight.ts";
import type { SourceAdmissionPorts } from "./source-contracts.ts";
import { outsideFields, outsideRef } from "./outside-final-data.ts";
import { canonicalPilotDecision } from "./references/sense/src/adapters/codex/pilot-canonical.ts";

// Exact proposed ORIGINAL controller overlay, not caller-selectable executable code.
export const OPERATIONAL_CONTROLLER_SHA256 = "de9d62a9ea0e87c65f17c533f1007e697da400a9a5493cecd1baa96d2d624f80";
export interface OperationalBinding {
	version: 1;
	namespace: "sense-operational-pi";
	producer_schema: "ops-bindings-17-source-diagnostics";
	producer_contract: RawRef;
	instruction: RawRef;
	operational_run_id: string;
	native: { decision: RawRef; receiving: RawRef; profile: RawRef; compiledReceiving?: RawRef };
	producers: Record<string, RawRef>;
	allowed_operations: readonly string[];
	fd_slot_bound: IndependentlyAdmittedFdSlotPreflight | null;
	policy: RawRef;
}
/** Closed existing native selection. The optional fourth Ref is the original
 * compiled producer's ordinary management result, NOT native owner receiving.
 * Historical three-ref data does not admit the outside pre-import bootstrap. */
export function assertOriginalCINativeBinding(
	value: unknown,
	compiledRequired = false,
): asserts value is OperationalBinding["native"] {
	assert(value && typeof value === "object" && !Array.isArray(value), "OPS_CI_NATIVE_BINDING");
	const compiled = Object.hasOwn(value, "compiledReceiving");
	outsideFields(value, compiled ? "decision receiving profile compiledReceiving" : "decision receiving profile");
	for (const ref of Object.values(value)) outsideRef(ref);
	assert(!compiledRequired || compiled, "OPS_OUTSIDE_COMPILED_CLOSURE_BOOTSTRAP_SOURCE_REQUIRED");
}
/** ORIGINAL CI canonical_digest uses Python's default ensure_ascii=True, not
 * Pilot's UTF-8 raw-document encoding. Keep the existing restricted integer and
 * Unicode-scalar domain; a different numeric domain requires a reviewed recipe. */
export function canonicalOriginalCIData(value: unknown): Buffer {
	// ponytail: reuse Pilot's code-point ordering and scalar validation. Escaping
	// UTF-16 units also reproduces Python's paired-surrogate spelling for non-BMP.
	const text = canonicalPilotDecision(value)
		.toString("utf8")
		.replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
	const bytes = Buffer.from(text, "ascii");
	assert(bytes.length <= 65536, "OPS_CI_CANONICAL_BOUND");
	return bytes;
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
export interface OriginalCIInitialProjection {
	release: { raw: RawRef; bytes: Uint8Array };
	initial: { raw: RawRef; bytes: Uint8Array };
}
export interface ReceivedCIInitial {
	authorization: ReceivedCIData;
	projection: OriginalCIInitialProjection;
}

/** DATA decoder for the private same-helper projection, not independent authority. */
export function parseOriginalCIInitial(raw: Uint8Array): ReceivedCIInitial {
	assert(raw.byteLength <= 9 * 1024 * 1024, "OPS_CI_INITIAL_OUTPUT_LIMIT");
	function fields(value: unknown, names: string): asserts value is Record<string, unknown> {
		assert(value !== null && typeof value === "object" && !Array.isArray(value), "OPS_CI_INITIAL_OBJECT");
		assert.deepEqual(Object.keys(value).sort(), names.split(" ").sort(), "OPS_CI_INITIAL_FIELDS");
	}
	const packet: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
	fields(packet, "version kind authorization release initial");
	assert(packet.version === 1 && packet.kind === "original-ci-operational-initial-receiving", "OPS_CI_INITIAL_KIND");
	const decode = (value: unknown, limit: number) => {
		fields(value, "raw base64");
		fields(value.raw, "path sha256");
		assert(
			typeof value.raw.path === "string" &&
				isAbsolute(value.raw.path) &&
				!/[\u0000-\u001f]/.test(value.raw.path) &&
				!value.raw.path
					.split("/")
					.slice(1)
					.some((part) => !part || part === "." || part === "..") &&
				typeof value.raw.sha256 === "string" &&
				/^[a-f0-9]{64}$/.test(value.raw.sha256),
			"OPS_CI_INITIAL_REF",
		);
		assert(
			typeof value.base64 === "string" && value.base64.length <= 4 * Math.ceil(limit / 3),
			"OPS_CI_INITIAL_ENCODING",
		);
		const bytes = Buffer.from(value.base64, "base64");
		assert(bytes.length <= limit && bytes.toString("base64") === value.base64, "OPS_CI_INITIAL_ENCODING");
		assert(createHash("sha256").update(bytes).digest("hex") === value.raw.sha256, "OPS_CI_INITIAL_HASH");
		return { raw: { path: value.raw.path, sha256: value.raw.sha256 }, bytes };
	};
	const release = decode(packet.release, 2 * 1024 * 1024);
	const initial = decode(packet.initial, 4 * 1024 * 1024);
	const released: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(release.bytes));
	fields(
		released,
		"version kind entry captureSha256 initial authorizationId wrapper issuanceLink releasedNs releasedWallSeconds",
	);
	assert(released.version === 1 && released.kind === "original-ci-operational-release", "OPS_CI_INITIAL_RELEASE");
	assert.deepEqual(released.initial, initial.raw, "OPS_CI_INITIAL_CARRIER");
	assert.deepEqual(released.wrapper, packet.authorization, "OPS_CI_INITIAL_AUTHORIZATION");
	const authorization = packet.authorization as ReceivedCIData;
	assert(authorization && released.authorizationId === authorization.authorization_id, "OPS_CI_INITIAL_AUTHORIZATION");
	return { authorization, projection: { release, initial } };
}

/** Nonmutating ORIGINAL authorization transport. No caller response/callback injection,
 * sudo, network, file-permission changes, issue/serve/run or native allocation path.
 * The independently held receiving ref selects the original per-job readonly reply
 * directory. The helper sends its own nonce on original worker stdout via FD2;
 * its unchanged public wrapper alone returns on captured stdout. No direct STATE
 * access or copied-file fallback. Missing protected context/bind/reply refuses.
 * Continuation requires the reviewed exact helper pin to authenticate the original
 * released-in-time receipt, unchanged authorization/reservation/parent/controller
 * PID-start/invocation/boot and original phase-plan deadline on EVERY read. Its
 * unchanged JSON wrapper is data, not a caller-selectable continuation flag. */
export function receiveOriginalCIAuthorization(
	selection: OriginalCISelection,
	nativeReceiving: RawRef,
	operation: Parameters<SourceAdmissionPorts["admission"]["check"]>[0],
	query: OriginalCIClockQuery,
): ReceivedCIClock;
export function receiveOriginalCIAuthorization(
	selection: OriginalCISelection,
	nativeReceiving: RawRef,
	operation: "preflight",
	initial: true,
): ReceivedCIInitial;
export function receiveOriginalCIAuthorization(
	selection: OriginalCISelection,
	nativeReceiving: RawRef,
	operation: Parameters<SourceAdmissionPorts["admission"]["check"]>[0],
): ReceivedCIData;
export function receiveOriginalCIAuthorization(
	selection: OriginalCISelection,
	nativeReceiving: RawRef,
	operation: Parameters<SourceAdmissionPorts["admission"]["check"]>[0],
	variant: boolean | OriginalCIClockQuery = false,
): ReceivedCIData | ReceivedCIInitial | ReceivedCIClock {
	const initial = variant === true;
	const query = typeof variant === "object" ? variant : undefined;
	if (query) assertOriginalCIClockQuery(query);
	assert(!initial || operation === "preflight", "OPS_CI_INITIAL_OPERATION");
	assert(
		["preflight", "configure", "request", "burst", "refresh", "boundary"].includes(operation),
		"OPS_CI_OPERATION",
	);
	assert(
		isAbsolute(nativeReceiving.path) &&
			!nativeReceiving.path.includes("\0") &&
			/^[a-f0-9]{64}$/.test(nativeReceiving.sha256),
		"OPS_CI_NATIVE_RECEIVING",
	);
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
	let received: ReceivedCIData | ReceivedCIInitial | ReceivedCIClock | undefined;
	try {
		const before = fstatSync(fd);
		assert(
			before.isFile() && before.nlink === 1 && !(before.mode & 0o222) && before.size <= 1024 * 1024,
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
			[
				"-I",
				"-B",
				selection.controller.path,
				"receive-operational",
				selection.authorizationId,
				operation,
				nativeReceiving.path,
				nativeReceiving.sha256,
				...(initial ? ["initial"] : query ? ["clock", query.beforeNs, query.afterNs] : []),
			],
			{
				env: { PATH: "/usr/bin:/bin", LANG: "C" },
				timeout: 5000,
				maxBuffer: initial ? 9 * 1024 * 1024 : 65536,
				stdio: ["ignore", "pipe", 1],
			},
		);
		check();
		const projection = initial
			? parseOriginalCIInitial(raw)
			: query
				? parseOriginalCIClock(raw, query, operation, nativeReceiving)
				: undefined;
		const result = projection
			? projection.authorization
			: (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as ReceivedCIData);
		assert(
			result.version === 1 &&
				result.kind === "original-ci-operational-authorization" &&
				result.authorization_id === selection.authorizationId &&
				result.release_sha256 === selection.releaseSha256 &&
				result.authorization.release_sha256 === selection.releaseSha256,
			"OPS_CI_ORIGINAL_PROVENANCE",
		);
		assertOriginalCINativeBinding(result.authorization.operational_binding.native);
		received = projection ?? result;
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
