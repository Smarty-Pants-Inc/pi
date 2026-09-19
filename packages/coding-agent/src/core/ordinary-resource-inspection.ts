export type OrdinaryResourceRef = Readonly<{ path: string; sha256: string }>;
export type OriginalResourceProofName = "scope" | "epoch" | "enforcement" | "initialFd";
export interface OrdinaryOperationalResourceInspection {
	kind: "ordinary-operational-resources/1";
	nativeIdentity: Readonly<{ ownerEpoch: string; sessionId: string; allocationId: string }>;
	aggregate: Readonly<{ descriptor: number; device: number; inode: number }>;
	lifetime: "borrowed-until-original-host-release";
	current: Readonly<{ nofile: Readonly<{ soft: string; hard: string }>; raw: OrdinaryResourceRef }>;
	preexec: Readonly<{
		nofile: Readonly<{ soft: string; hard: string }>;
		initialFdAndTasks: OrdinaryResourceRef;
		raw: OrdinaryResourceRef;
	}> | null;
	original: Readonly<Record<OriginalResourceProofName, OrdinaryResourceRef | null>>;
	unavailable: Readonly<Partial<Record<OriginalResourceProofName, string>>>;
}

/** Private additive native resource ABI1, supplied only by the original lease. */
export interface NativeResourceObservation {
	descriptor: number;
	device: number;
	inode: number;
	nofileSoft: string;
	nofileHard: string;
	realtimeSeconds: string;
	realtimeNanoseconds: number;
	ownerEpoch: string;
	allocationId: string;
	profileSha256: string;
	hostInvocation: string;
}

function unsigned64(value: string): boolean {
	return typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
}

/** Internal formatting/recording boundary, not an authority supplier. The installed
 * entry supplies only its branded owner's native reader; there is no public reader option. */
export function recordResourceInspection(
	identity: Pick<OrdinaryOperationalResourceInspection["nativeIdentity"], "ownerEpoch" | "allocationId">,
	readOriginal: () => NativeResourceObservation & { readonly sessionId: string },
	retainCurrent: (actualNonsecretFacts: unknown) => OrdinaryResourceRef,
): OrdinaryOperationalResourceInspection {
	const observed = Object.freeze({ ...readOriginal() });
	const nativeIdentity = Object.freeze({
		ownerEpoch: identity.ownerEpoch,
		allocationId: identity.allocationId,
		sessionId: observed.sessionId,
	});
	if (
		![observed.descriptor, observed.device, observed.inode].every(
			(value) => Number.isSafeInteger(value) && value >= 0,
		) ||
		observed.descriptor > 2147483647 ||
		observed.ownerEpoch !== nativeIdentity.ownerEpoch ||
		observed.allocationId !== nativeIdentity.allocationId ||
		!/^[0-9a-f]{64}$/.test(observed.profileSha256) ||
		!/^[0-9a-f]{32}$/.test(observed.hostInvocation) ||
		typeof observed.sessionId !== "string" ||
		!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(observed.sessionId)
	)
		throw new Error("OWNER_RESOURCE_IDENTITY");
	if (
		![observed.nofileSoft, observed.nofileHard].every((value) => value === "infinity" || unsigned64(value)) ||
		(observed.nofileHard !== "infinity" &&
			(observed.nofileSoft === "infinity" || BigInt(observed.nofileSoft) > BigInt(observed.nofileHard)))
	) {
		throw new Error("OWNER_RESOURCE_NOFILE");
	}
	if (
		!unsigned64(observed.realtimeSeconds) ||
		!Number.isInteger(observed.realtimeNanoseconds) ||
		observed.realtimeNanoseconds < 0 ||
		observed.realtimeNanoseconds >= 1_000_000_000
	)
		throw new Error("OWNER_RESOURCE_CLOCK");
	const aggregate = Object.freeze({ descriptor: observed.descriptor, device: observed.device, inode: observed.inode });
	const nofile = Object.freeze({ soft: observed.nofileSoft, hard: observed.nofileHard });
	const facts = Object.freeze({
		kind: "ordinary-operational-resource-current/1",
		nativeIdentity,
		aggregate,
		nofile,
		observation: Object.freeze({
			source: "native-held-host-cgroup/fstat/fstatfs/getrlimit",
			clock: "CLOCK_REALTIME",
			seconds: observed.realtimeSeconds,
			nanoseconds: observed.realtimeNanoseconds,
		}),
		profileSha256: observed.profileSha256,
		hostInvocation: observed.hostInvocation,
	});
	const { path, sha256 } = retainCurrent(facts);
	if (typeof path !== "string" || !path || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
		throw new Error("OWNER_RESOURCE_CURRENT_REF");
	}
	// Recheck after recorder and returned-ref accessors can reenter original close.
	const checked = readOriginal();
	for (const key of [
		"descriptor",
		"device",
		"inode",
		"ownerEpoch",
		"allocationId",
		"sessionId",
		"profileSha256",
		"hostInvocation",
	] as const) {
		if (checked[key] !== observed[key]) throw new Error("OWNER_RESOURCE_CUSTODY_CHANGED");
	}
	return Object.freeze({
		kind: "ordinary-operational-resources/1",
		nativeIdentity,
		aggregate,
		lifetime: "borrowed-until-original-host-release",
		current: Object.freeze({ nofile, raw: Object.freeze({ path, sha256 }) }),
		preexec: null,
		original: Object.freeze({ scope: null, epoch: null, enforcement: null, initialFd: null }),
		unavailable: Object.freeze({
			scope: "OWNER_RESOURCE_SCOPE_UNAVAILABLE: protected Pi receiving has no original whole-Bun resource scope proof",
			epoch: "OWNER_RESOURCE_EPOCH_UNAVAILABLE: native owner epoch is not a received whole-Bun resource epoch",
			enforcement:
				"OWNER_RESOURCE_PREEXEC_UNAVAILABLE: whole-Bun launcher enforcement capture is not received by Pi",
			initialFd:
				"OWNER_RESOURCE_INITIAL_UNAVAILABLE: whole-Bun pre-exec FD/task capture belongs to the original external launcher",
		}),
	});
}
