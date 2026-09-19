import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import type { OwnerAdmissionPolicy, OwnerAllocationClaim } from "./owner-effects.ts";
import type { OwnerArtifact, OwnerHostProfile } from "./owner-profile.ts";

/** Private deployment data, never an extension option or a project policy file. */
export interface OrdinaryAdmission {
	issuer: "ci-delivery";
	id: string;
	instruction: string;
	operation: "ordinary-create-execute";
	target: { machineId: string; uid: number; gid: number; unit: string; cgroup: string };
	owner: { principalId: string; tenantId: string };
	allocation: {
		id: string;
		notBeforeMs: number;
		expiresMs: number;
		inference: number;
		automatic: number;
		scopeOpen: boolean;
	};
	retention: string;
}

export interface OrdinaryOwnerRecord {
	version: 1;
	recipe: "sense-ordinary-poc-v1";
	source: { commit: string; tree: string };
	profileSha256: string;
	package: OwnerArtifact;
	application: OwnerArtifact;
	receiving: { path: string; reference: string };
	admission: OrdinaryAdmission;
	roots: Record<"W" | "R" | "D" | "T", { path: string; access: "read-only" | "read-write" }>;
	bun: OwnerArtifact;
	closure: OwnerArtifact[];
	sense: OwnerArtifact;
	effects: OwnerAdmissionPolicy["effects"];
	development: true;
	environment: string[];
	provider: {
		provider: string;
		model: string;
		api: "openai-responses";
		baseUrl: string;
		url: string;
		wireModel: string;
		transport: "sse";
		/** Generation identifies the local delivery, not an upstream key version. */
		credential: { purpose: string; account: string; generation: string; referenceSha256: string };
		contextTokens: number;
		outputTokens: number;
		/** Absent/null means no count authority; never derive it from url. */
		count?: {
			url: string;
			method: "POST";
			operations: number;
			provider: string;
			wireModel: string;
			purpose: string;
			account: string;
			semantics: OwnerArtifact;
		} | null;
	};
	limits: {
		minEveryMs: number;
		maxEveryMs: number;
		timeoutMs: number;
		maxConcurrent: number;
		maxWatches: number;
		maxBodyBytes: number;
		maxStderrBytes: number;
		maxInputBytes: number;
		frameBudgetBytes: number;
		wakeCooldownMs: number;
	};
}

/** Projection of the independently received operation, installed by the existing
 * admission owner. Its protected bytes bind the decision, not vice versa. */
export interface OrdinaryOwnerReceiving {
	version: 1;
	kind: "ordinary-owner-receiving";
	reference: string;
	source: OrdinaryOwnerRecord["source"];
	profileSha256: string;
	package: OwnerArtifact;
	application: OwnerArtifact;
	decisionSha256: string;
	admission: OrdinaryAdmission;
}

function shape(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw new Error("OWNER_DECISION_SHAPE");
}

function text(value: unknown, max = 256): asserts value is string {
	if (typeof value !== "string" || !value.length || value.length > max || /[\u0000-\u0020\u007f]/.test(value)) {
		throw new Error("OWNER_DECISION_TEXT");
	}
}

function digest(value: unknown, length = 64): asserts value is string {
	if (typeof value !== "string" || value.length !== length || !/^[0-9a-f]+$/.test(value))
		throw new Error("OWNER_DECISION_DIGEST");
}

function absolute(value: unknown): asserts value is string {
	if (
		typeof value !== "string" ||
		!isAbsolute(value) ||
		normalize(value) !== value ||
		value === "/" ||
		value.length > 4096 ||
		/[\u0000-\u001f\u007f@]/.test(value)
	)
		throw new Error("OWNER_DECISION_PATH");
}

function integer(value: unknown, min: number, max: number): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
		throw new Error("OWNER_DECISION_LIMIT");
}

function artifact(value: unknown): asserts value is OwnerArtifact {
	shape(value, ["path", "sha256"]);
	absolute(value.path);
	digest(value.sha256);
}

function source(value: unknown): asserts value is OrdinaryOwnerRecord["source"] {
	shape(value, ["commit", "tree"]);
	digest(value.commit, 40);
	digest(value.tree, 40);
}

function admission(value: unknown): asserts value is OrdinaryAdmission {
	shape(value, ["issuer", "id", "instruction", "operation", "target", "owner", "allocation", "retention"]);
	if (value.issuer !== "ci-delivery" || value.operation !== "ordinary-create-execute")
		throw new Error("OWNER_DECISION_OPERATION");
	text(value.id);
	text(value.instruction);
	text(value.retention, 4096);
	shape(value.target, ["machineId", "uid", "gid", "unit", "cgroup"]);
	digest(value.target.machineId, 32);
	integer(value.target.uid, 1, 2_147_483_647);
	integer(value.target.gid, 1, 2_147_483_647);
	text(value.target.unit, 136);
	absolute(value.target.cgroup);
	shape(value.owner, ["principalId", "tenantId"]);
	text(value.owner.principalId);
	text(value.owner.tenantId);
	shape(value.allocation, ["id", "notBeforeMs", "expiresMs", "inference", "automatic", "scopeOpen"]);
	text(value.allocation.id);
	integer(value.allocation.notBeforeMs, 1, Number.MAX_SAFE_INTEGER);
	integer(value.allocation.expiresMs, value.allocation.notBeforeMs + 1, Number.MAX_SAFE_INTEGER);
	integer(value.allocation.inference, 1, 8);
	integer(value.allocation.automatic, 0, 2);
	if (typeof value.allocation.scopeOpen !== "boolean") throw new Error("OWNER_DECISION_SCOPE");
}

function canonical(bytes: Uint8Array): unknown {
	if (!bytes.byteLength || bytes.byteLength > 65_536) throw new Error("OWNER_DECISION_SIZE");
	const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	const value: unknown = JSON.parse(text);
	if (`${JSON.stringify(value, null, 2)}\n` !== text) throw new Error("OWNER_DECISION_ENCODING");
	return value;
}

function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

/** Pure shape validation. Success alone provides no runtime authority. */
export function parseOrdinaryOwnerRecord(bytes: Uint8Array): Readonly<OrdinaryOwnerRecord> {
	const value = canonical(bytes);
	shape(value, [
		"version",
		"recipe",
		"source",
		"profileSha256",
		"package",
		"application",
		"receiving",
		"admission",
		"roots",
		"bun",
		"closure",
		"sense",
		"effects",
		"development",
		"environment",
		"provider",
		"limits",
	]);
	if (value.version !== 1 || value.recipe !== "sense-ordinary-poc-v1" || value.development !== true)
		throw new Error("OWNER_DECISION_RECIPE");
	source(value.source);
	digest(value.profileSha256);
	artifact(value.package);
	artifact(value.application);
	shape(value.receiving, ["path", "reference"]);
	absolute(value.receiving.path);
	text(value.receiving.reference);
	admission(value.admission);
	shape(value.roots, ["W", "R", "D", "T"]);
	const paths = new Set<string>();
	for (const role of ["W", "R", "D", "T"] as const) {
		const root = value.roots[role];
		shape(root, ["path", "access"]);
		absolute(root.path);
		const access = role === "W" || role === "T" ? "read-write" : "read-only";
		if (root.access !== access || paths.has(root.path)) throw new Error("OWNER_DECISION_ROOT");
		for (const other of paths) {
			if (other.startsWith(`${root.path}/`) || root.path.startsWith(`${other}/`))
				throw new Error("OWNER_DECISION_ROOT");
		}
		paths.add(root.path);
	}
	artifact(value.bun);
	artifact(value.sense);
	if (!Array.isArray(value.closure) || !value.closure.length || value.closure.length > 256)
		throw new Error("OWNER_DECISION_CLOSURE");
	const closure = new Set<string>();
	for (const item of value.closure) {
		artifact(item);
		if (closure.has(item.path)) throw new Error("OWNER_DECISION_CLOSURE");
		closure.add(item.path);
	}
	if (
		!Array.isArray(value.effects) ||
		value.effects.length !== 4 ||
		new Set(value.effects).size !== 4 ||
		value.effects.some(
			(kind: unknown) => typeof kind !== "string" || !["process", "read", "write", "provider"].includes(kind),
		)
	) {
		throw new Error("OWNER_DECISION_EFFECTS");
	}
	if (!Array.isArray(value.environment) || value.environment.length > 16)
		throw new Error("OWNER_DECISION_ENVIRONMENT");
	const names = new Set<string>();
	for (const entry of value.environment) {
		if (
			typeof entry !== "string" ||
			entry.length > 4096 ||
			/[\u0000-\u001f\u007f]/.test(entry) ||
			!/^(?:LANG|LC_ALL|TZ)=[\s\S]*$/.test(entry)
		) {
			throw new Error("OWNER_DECISION_ENVIRONMENT");
		}
		const name = entry.slice(0, entry.indexOf("="));
		if (names.has(name)) throw new Error("OWNER_DECISION_ENVIRONMENT");
		names.add(name);
	}
	const providerKeys = [
		"provider",
		"model",
		"api",
		"baseUrl",
		"url",
		"wireModel",
		"transport",
		"credential",
		"contextTokens",
		"outputTokens",
	];
	if (value.provider && typeof value.provider === "object" && Object.hasOwn(value.provider, "count"))
		providerKeys.push("count");
	shape(value.provider, providerKeys);
	text(value.provider.provider, 127);
	text(value.provider.model, 255);
	text(value.provider.wireModel, 255);
	if (value.provider.api !== "openai-responses" || value.provider.transport !== "sse")
		throw new Error("OWNER_DECISION_PROVIDER");
	text(value.provider.baseUrl, 4095);
	text(value.provider.url, 4095);
	for (const url of [value.provider.baseUrl, value.provider.url]) {
		const parsed = new URL(url);
		if (
			parsed.protocol !== "https:" ||
			parsed.username ||
			parsed.password ||
			parsed.search ||
			parsed.hash ||
			parsed.href !== url
		) {
			throw new Error("OWNER_DECISION_ENDPOINT");
		}
	}
	if (value.provider.url !== `${value.provider.baseUrl.replace(/\/$/, "")}/responses`)
		throw new Error("OWNER_DECISION_ENDPOINT");
	shape(value.provider.credential, ["purpose", "account", "generation", "referenceSha256"]);
	text(value.provider.credential.purpose);
	text(value.provider.credential.account);
	text(value.provider.credential.generation);
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(value.provider.credential.generation))
		throw new Error("OWNER_DECISION_DELIVERY_ID");
	digest(value.provider.credential.referenceSha256);
	integer(value.provider.contextTokens, 1, 2_000_000);
	integer(value.provider.outputTokens, 1, value.provider.contextTokens);
	if (value.provider.count !== undefined && value.provider.count !== null) {
		const count = value.provider.count;
		shape(count, ["url", "method", "operations", "provider", "wireModel", "purpose", "account", "semantics"]);
		text(count.url, 4095);
		integer(count.operations, 1, 8);
		artifact(count.semantics);
		const endpoint = new URL(count.url);
		if (
			count.method !== "POST" ||
			endpoint.protocol !== "https:" ||
			endpoint.href !== count.url ||
			endpoint.username ||
			endpoint.password ||
			endpoint.search ||
			endpoint.hash ||
			count.url === value.provider.url ||
			count.provider !== value.provider.provider ||
			count.wireModel !== value.provider.wireModel ||
			count.purpose !== value.provider.credential.purpose ||
			count.account !== value.provider.credential.account
		) {
			throw new Error("OWNER_DECISION_COUNT_SCOPE");
		}
	}
	shape(value.limits, [
		"minEveryMs",
		"maxEveryMs",
		"timeoutMs",
		"maxConcurrent",
		"maxWatches",
		"maxBodyBytes",
		"maxStderrBytes",
		"maxInputBytes",
		"frameBudgetBytes",
		"wakeCooldownMs",
	]);
	integer(value.limits.minEveryMs, 1000, 86_400_000);
	integer(value.limits.maxEveryMs, value.limits.minEveryMs, 86_400_000);
	integer(value.limits.timeoutMs, 1, 5000);
	integer(value.limits.maxConcurrent, 1, 4);
	integer(value.limits.maxWatches, 1, 8);
	integer(value.limits.maxBodyBytes, 1, 2048);
	integer(value.limits.maxStderrBytes, 1, 4096);
	integer(value.limits.maxInputBytes, 1, 65_536);
	integer(value.limits.frameBudgetBytes, 1, 65_536);
	integer(value.limits.wakeCooldownMs, 60_000, 86_400_000);
	return freeze(value as unknown as OrdinaryOwnerRecord);
}

export function parseOrdinaryOwnerReceiving(bytes: Uint8Array): Readonly<OrdinaryOwnerReceiving> {
	const value = canonical(bytes);
	shape(value, [
		"version",
		"kind",
		"reference",
		"source",
		"profileSha256",
		"package",
		"application",
		"decisionSha256",
		"admission",
	]);
	if (value.version !== 1 || value.kind !== "ordinary-owner-receiving") throw new Error("OWNER_DECISION_RECEIVING");
	text(value.reference);
	source(value.source);
	digest(value.profileSha256);
	digest(value.decisionSha256);
	artifact(value.package);
	artifact(value.application);
	admission(value.admission);
	return freeze(value as unknown as OrdinaryOwnerReceiving);
}

export interface OrdinaryDecision {
	readonly record: Readonly<OrdinaryOwnerRecord>;
	readonly digest: string;
	readonly policy: OwnerAdmissionPolicy;
	readonly allocation: OwnerAllocationClaim;
	readonly roots: Readonly<Record<"W" | "R" | "D" | "T", number>>;
}

/** Called by protected receiving before native creation. `observed` is supplied
 * by that receiver, never by settings, prompt input or an extension factory. */
export function produceOrdinaryPocDecision(
	bytes: Uint8Array,
	receivingBytes: Uint8Array,
	profile: Readonly<OwnerHostProfile>,
	observed: {
		profileSha256: string;
		applicationPath: string;
		machineId: string;
		uid: number;
		gid: number;
		now: number;
	},
): OrdinaryDecision {
	const record = parseOrdinaryOwnerRecord(bytes);
	const receiving = parseOrdinaryOwnerReceiving(receivingBytes);
	const decision = createHash("sha256").update(bytes).digest("hex");
	if (
		receiving.reference !== record.receiving.reference ||
		receiving.decisionSha256 !== decision ||
		receiving.profileSha256 !== record.profileSha256 ||
		record.profileSha256 !== observed.profileSha256 ||
		receiving.source.commit !== record.source.commit ||
		receiving.source.tree !== record.source.tree ||
		receiving.package.path !== record.package.path ||
		receiving.package.sha256 !== record.package.sha256 ||
		receiving.application.path !== record.application.path ||
		receiving.application.sha256 !== record.application.sha256 ||
		record.application.path !== observed.applicationPath ||
		JSON.stringify(receiving.admission) !== JSON.stringify(record.admission)
	) {
		throw new Error("OWNER_DECISION_RECEIVING_MISMATCH");
	}
	const { target, allocation, owner } = record.admission;
	if (
		target.machineId !== observed.machineId ||
		target.uid !== observed.uid ||
		target.gid !== observed.gid ||
		target.uid !== profile.host.uid ||
		target.gid !== profile.host.gid ||
		target.unit !== profile.host.unit ||
		target.cgroup !== profile.host.cgroup ||
		!Number.isSafeInteger(observed.now) ||
		observed.now < allocation.notBeforeMs ||
		observed.now >= allocation.expiresMs
	) {
		throw new Error("OWNER_DECISION_TARGET_OR_LIFETIME");
	}
	const roots = {} as Record<"W" | "R" | "D" | "T", number>;
	const permissions: Array<{ index: number; access: "read-only" | "read-write" }> = [];
	for (const role of ["W", "R", "D", "T"] as const) {
		const requested = record.roots[role];
		const index = profile.sandbox.fileRoots.findIndex((root) => root.path === requested.path);
		const ceiling = profile.sandbox.fileRoots[index];
		if (!ceiling || (requested.access === "read-write" && ceiling.access !== "read-write"))
			throw new Error("OWNER_DECISION_ROOT_CEILING");
		roots[role] = index;
		permissions.push({ index, access: requested.access });
	}
	const artifacts = [profile.artifacts.runtime, ...profile.artifacts.closure];
	for (const item of [record.application, record.bun, record.sense, ...record.closure]) {
		if (!artifacts.some((artifact) => artifact.path === item.path && artifact.sha256 === item.sha256))
			throw new Error("OWNER_DECISION_ARTIFACT_CEILING");
	}
	for (const item of [
		record.package.path,
		record.application.path,
		record.receiving.path,
		record.sense.path,
		...(record.provider.count ? [record.provider.count.semantics.path] : []),
	]) {
		if (profile.sandbox.fileRoots.some((root) => item === root.path || item.startsWith(`${root.path}/`)))
			throw new Error("OWNER_DECISION_EXPOSED_DEPLOYMENT");
	}
	if (
		record.limits.timeoutMs > profile.limits.processTimeoutMs ||
		record.limits.maxConcurrent > profile.limits.launchesPerOwner ||
		record.limits.maxInputBytes > profile.limits.outputBytes ||
		record.limits.maxBodyBytes + record.limits.maxStderrBytes > profile.limits.outputBytes ||
		allocation.inference + (record.provider.count?.operations ?? 0) > profile.limits.operationsPerOwner
	)
		throw new Error("OWNER_DECISION_RESOURCE_CEILING");
	return freeze({
		record,
		digest: decision,
		roots,
		policy: {
			roots: permissions,
			commands: [record.bun.path],
			effects: [...record.effects],
			provider: {
				provider: record.provider.provider,
				model: record.provider.model,
				api: record.provider.api,
				baseUrl: record.provider.baseUrl,
				attempts: allocation.inference,
				count: record.provider.count
					? {
							url: record.provider.count.url,
							method: record.provider.count.method,
							operations: record.provider.count.operations,
							provider: record.provider.count.provider,
							wireModel: record.provider.count.wireModel,
							purpose: record.provider.count.purpose,
							account: record.provider.count.account,
						}
					: null,
			},
		},
		allocation: {
			id: createHash("sha256").update(allocation.id).digest("hex"),
			decision,
			instruction: createHash("sha256").update(record.admission.instruction).digest("hex"),
			principal: createHash("sha256").update(JSON.stringify(owner)).digest("hex"),
			notBeforeMs: allocation.notBeforeMs,
			expiresMs: allocation.expiresMs,
			inference: allocation.inference,
			count: record.provider.count?.operations ?? 0,
			automatic: allocation.automatic,
			scopeOpen: allocation.scopeOpen,
		},
	});
}
