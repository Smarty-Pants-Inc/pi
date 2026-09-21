import { createHash } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import type {
	OriginalCIInitialProjection,
	OriginalCISelection,
	ReceivedCIInitial,
} from "../src/core/ordinary-sc085-source/ci-authority.ts";
import {
	createOperationalAdmission,
	type HeldOperationalRecord,
	type OperationalHostInstruction,
	producerNames,
} from "../src/core/ordinary-sc085-source/operational-admission.ts";
import { canonicalPilotDecision } from "../src/core/ordinary-sc085-source/references/sense/src/adapters/codex/pilot-canonical.ts";

// Original factory flow with inert parser/helper ports. No real owner, CI
// controller, preexec capture, permission, clock or native effects are created.
const ports = vi.hoisted(() => ({
	helper: vi.fn(),
	released: vi.fn(),
	custody: vi.fn(),
	decision: vi.fn(),
	receiving: vi.fn(),
	profile: vi.fn(),
}));
vi.mock("../src/core/ordinary-sc085-source/ci-authority.ts", () => ({
	receiveOriginalCIAuthorization: ports.helper,
	assertOriginalCINativeBinding: vi.fn(),
}));
vi.mock("../src/core/ordinary-sc085-source/ci-released-selection.ts", () => ({
	readReleasedCISelection: ports.released,
}));
vi.mock("../src/core/ordinary-owner-policy.ts", () => ({
	parseOrdinaryOwnerRecord: ports.decision,
	parseOrdinaryOwnerReceiving: ports.receiving,
}));
vi.mock("../src/core/owner-profile.ts", () => ({ parseOwnerHostProfile: ports.profile }));
beforeEach(() => vi.resetAllMocks());
function fixture(changeSource2?: (source2: Record<string, unknown>) => void) {
	const retained = new Map<string, Uint8Array>();
	const held = (path: string, bytes: Buffer): HeldOperationalRecord => {
		const ref = { path, sha256: createHash("sha256").update(bytes).digest("hex") };
		retained.set(path, bytes);
		return { ref, held: { bytes: Buffer.from(bytes), check() {}, close() {} } };
	};
	const profile = held("/fixture/profile", Buffer.from("profile"));
	const decision = held("/fixture/decision", Buffer.from("decision"));
	const receiving = held("/fixture/receiving", Buffer.from("receiving"));
	const producerContract = held("/fixture/contract", Buffer.from("contract"));
	const source = { commit: "1".repeat(40), tree: "2".repeat(40) };
	const source2 = {
		entry: { path: "/fixture/artifact", sha256: "3".repeat(64) },
		producerContract: producerContract.ref,
		evidence: [],
		agentDir: "/fixture/agent",
	};
	changeSource2?.(source2);
	const input = {
		version: 1,
		operation: "sense-operational-pi",
		runId: "run",
		identity: { source, profile: { harness: "pi" } },
		sc085: { protocol: "sense-ops-sc085-plan/2" },
		production: { source2 },
	} as unknown as OperationalHostInstruction;
	const instruction = held("/fixture/instruction", canonicalPilotDecision(input));
	const producers = new Map(producerNames.map((name) => [name, held(`/fixture/${name}`, Buffer.from(name))]));
	const artifact = { path: "/fixture/artifact", sha256: "3".repeat(64) };
	const admission = {
		target: { uid: 1000, gid: 1000, unit: "unit", cgroup: "/group" },
		allocation: {
			id: "allocation",
			inference: 1,
			scopeOpen: true,
			notBeforeMs: Date.now() - 1000,
			expiresMs: Date.now() + 100000,
		},
	};
	const record = {
		receiving: { path: receiving.ref.path, reference: "reference" },
		profileSha256: profile.ref.sha256,
		source,
		package: artifact,
		application: artifact,
		bun: artifact,
		sense: artifact,
		closure: [],
		roots: {},
		admission,
		limits: { timeoutMs: 1, maxConcurrent: 1, maxInputBytes: 1, maxBodyBytes: 1, maxStderrBytes: 1 },
		provider: {},
	};
	ports.decision.mockReturnValue(record);
	ports.receiving.mockReturnValue({ ...record, reference: "reference", decisionSha256: decision.ref.sha256 });
	ports.profile.mockReturnValue({
		host: admission.target,
		artifacts: { runtime: artifact, closure: [] },
		sandbox: { fileRoots: [] },
		limits: { processTimeoutMs: 10, launchesPerOwner: 10, outputBytes: 10, operationsPerOwner: 10 },
	});
	const expected: OriginalCISelection["expected"] = {
		repository_id: "1",
		run_id: "2",
		run_attempt: "1",
		source_sha: source.commit,
		source_tree: source.tree,
		control_sha: "4".repeat(40),
		workflow_sha: "5".repeat(40),
		recipe_sha256: "6".repeat(64),
		manifest_sha256: "7".repeat(64),
	};
	const authority = { expected, authorizationId: "8".repeat(64), releaseSha256: "9".repeat(64), controller: artifact };
	const makeProjection = (path: string) => {
		const bytes = Buffer.from("{}");
		return { raw: { path, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes };
	};
	const response: ReceivedCIInitial = {
		authorization: {
			version: 1,
			kind: "original-ci-operational-authorization",
			authorization_id: authority.authorizationId,
			release_sha256: authority.releaseSha256,
			manifest_sha256: expected.manifest_sha256,
			authorization: {
				...expected,
				release_sha256: authority.releaseSha256,
				issued_at: Math.floor(Date.now() / 1000) - 1,
				expires_at: Math.floor(Date.now() / 1000) + 299,
				manifest: {},
				operational_binding: {
					version: 1,
					namespace: "sense-operational-pi",
					producer_schema: "ops-bindings-17-source-diagnostics",
					producer_contract: producerContract.ref,
					instruction: instruction.ref,
					operational_run_id: "run",
					native: { profile: profile.ref, decision: decision.ref, receiving: receiving.ref },
					producers: Object.fromEntries([...producers].map(([name, record]) => [name, record.ref])),
					allowed_operations: ["preflight", "boundary"],
					fd_slot_bound: null,
					policy: artifact,
				},
			},
		},
		projection: { release: makeProjection("/fixture/release"), initial: makeProjection("/fixture/initial") },
	};
	ports.helper.mockReturnValue(response);
	ports.released.mockReturnValue({
		selection: authority,
		release: response.projection.release.raw,
		check: ports.custody,
	});
	const inputs = { instruction, producerContract, profile, decision, receiving, producers, retained };
	const supplier = createOperationalAdmission(inputs);
	return { supplier, inputs, input, instruction, response, retained, authority, receiving };
}

test("first bootstrap substitutes initial helper and refuses missing same-map retention without a second call", async () => {
	const f = fixture();
	const retain = vi.fn();
	await expect(f.supplier.preflightSc085(f.input, f.instruction.held.bytes, retain)).rejects.toThrow("NOT_RETAINED");
	expect(retain).toHaveBeenCalledExactlyOnceWith(structuredClone(f.response.projection));
	expect(retain.mock.calls[0][0]).not.toBe(f.response.projection);
	expect(ports.helper).toHaveBeenCalledExactlyOnceWith(f.authority, f.receiving.ref, "preflight", true);
	expect(ports.released).toHaveBeenCalledExactlyOnceWith({
		instruction: f.instruction.ref,
		native: f.response.authorization.authorization.operational_binding.native,
	});
	expect(ports.custody).toHaveBeenCalledWith(f.response.authorization, "preflight");
});

test("initial retention callback swallowed reentry latches before nested helper or graph acceptance", async () => {
	const f = fixture();
	let first: unknown;
	const retain = (projection: OriginalCIInitialProjection) => {
		for (let i = 0; i < 8; i++) {
			try {
				f.supplier.check("boundary");
			} catch (error) {
				first ??= error;
				expect(error).toBe(first);
			}
		}
		for (const entry of [projection.release, projection.initial]) f.retained.set(entry.raw.path, entry.bytes);
	};
	await expect(f.supplier.preflightSc085(f.input, f.instruction.held.bytes, retain)).rejects.toThrow(
		"AUTHORITY_REENTRY",
	);
	expect(ports.helper).toHaveBeenCalledTimes(1);
	await expect(f.supplier.preflightSc085(f.input, f.instruction.held.bytes, retain)).rejects.toBe(first);
	expect(ports.helper).toHaveBeenCalledTimes(1);
});

test("callback cannot rewrite helper-captured projection to make changed retained bytes acceptable", async () => {
	const f = fixture();
	await expect(
		f.supplier.preflightSc085(f.input, f.instruction.held.bytes, (projection) => {
			projection.release.bytes.fill(0);
			for (const entry of [projection.release, projection.initial]) f.retained.set(entry.raw.path, entry.bytes);
		}),
	).rejects.toThrow("REF_PIN");
	expect(ports.helper).toHaveBeenCalledTimes(1);
});

test("legacy factory authority is an extra field, rejected before borrowed input checks", () => {
	const f = fixture(),
		check = vi.spyOn(f.instruction.held, "check");
	expect(() => createOperationalAdmission({ ...f.inputs, authority: f.authority } as typeof f.inputs)).toThrow();
	expect(check).not.toHaveBeenCalled();
	expect(ports.helper).not.toHaveBeenCalled();
	expect(ports.released).not.toHaveBeenCalled();
});

test.each(["authority", "authorizationId", "entry", "producerContract", "evidence", "agentDir"])(
	"old/mixed/missing static Source2 %s refuses before original resolution/helper",
	async (key) => {
		const f = fixture((source2) => {
			if (key === "authority" || key === "authorizationId") source2[key] = null;
			else delete source2[key];
		});
		await expect(f.supplier.preflightSc085(f.input, f.instruction.held.bytes, () => {})).rejects.toThrow(
			"OPS_SOURCE2_FIELDS",
		);
		expect(ports.released).not.toHaveBeenCalled();
		expect(ports.helper).not.toHaveBeenCalled();
	},
);

test("failed selection preserves even undefined as sticky; no helper or resolution replay", async () => {
	const f = fixture();
	ports.released.mockImplementationOnce(() => {
		throw undefined;
	});
	for (let i = 0; i < 2; i++)
		await expect(f.supplier.preflightSc085(f.input, f.instruction.held.bytes, () => {})).rejects.toBeUndefined();
	expect(ports.released).toHaveBeenCalledTimes(1);
	expect(ports.helper).not.toHaveBeenCalled();
});

test("swallowed reentry during private resolution cannot reach the original helper", async () => {
	const f = fixture();
	ports.released.mockImplementationOnce(() => {
		try {
			f.supplier.check("boundary");
		} catch {
			/* hostile swallowed failure */
		}
		return { selection: f.authority, release: f.response.projection.release.raw, check: ports.custody };
	});
	await expect(f.supplier.preflightSc085(f.input, f.instruction.held.bytes, () => {})).rejects.toThrow(
		"OPS_SYNCHRONOUS_AUTHORITY_REENTRY",
	);
	expect(ports.helper).not.toHaveBeenCalled();
	expect(ports.released).toHaveBeenCalledTimes(1);
});

test("helper's initial release cannot differ from the privately selected original release", async () => {
	const f = fixture();
	ports.helper.mockReturnValue({
		...f.response,
		projection: {
			...f.response.projection,
			release: { ...f.response.projection.release, raw: { path: "/foreign", sha256: "0".repeat(64) } },
		},
	});
	const retain = vi.fn();
	await expect(f.supplier.preflightSc085(f.input, f.instruction.held.bytes, retain)).rejects.toThrow(
		"OPS_CI_RELEASED_INITIAL",
	);
	expect(retain).not.toHaveBeenCalled();
	expect(ports.helper).toHaveBeenCalledTimes(1);
});

test("changed helper tuple refuses after the same one initial helper, without retaining it", async () => {
	const f = fixture();
	const changed = structuredClone(f.response);
	changed.authorization.authorization.recipe_sha256 = "0".repeat(64);
	ports.helper.mockReturnValue(changed);
	const retain = vi.fn();
	await expect(f.supplier.preflightSc085(f.input, f.instruction.held.bytes, retain)).rejects.toThrow(
		"OPS_CI_TUPLE_recipe_sha256",
	);
	expect(retain).not.toHaveBeenCalled();
	expect(ports.helper).toHaveBeenCalledTimes(1);
});
