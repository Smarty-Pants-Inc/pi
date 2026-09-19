import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.ts";
import { assertOrdinaryOwner, type OrdinaryOwnerContext } from "./ordinary-owner-context.ts";
import { nonViewRequest, requestDigest } from "./ordinary-request-evidence.ts";
import type { OrdinaryCapture } from "./ordinary-sense.ts";
import type { TokenReservation } from "./ordinary-token-budget.ts";

type StreamCall = Parameters<AgentSession["agent"]["streamFunction"]>;
type Member = {
	kind: "without" | "with";
	signal?: AbortSignal;
	messages?: AgentMessage[];
	transformed?: AgentMessage[];
	converted?: Message[];
	canonical?: Message[];
	stream?: { actual: StreamCall; snapshot: StreamCall };
	capture?: Readonly<OrdinaryCapture>;
	witnessRead: boolean;
	prepared: boolean;
	reservation?: TokenReservation;
	requestId?: string;
};
type Route = { owner: OrdinaryOwnerContext; session: AgentSession; active?: Pair };
type Pair = {
	route: Route;
	open: boolean;
	members: Member[];
	current?: Member;
	baseline?: AgentMessage[];
	wire?: Uint8Array;
	failure?: { cause: unknown };
	reject(cause: unknown): void;
};
const owners = new WeakMap<OrdinaryOwnerContext, Route>();
const sessions = new WeakMap<AgentSession, Route>();
const scope = new AsyncLocalStorage<Pair>();

/** Snapshot data while keeping original callback/signal identities. Stream options
 * and tools contain functions; structuredClone alone cannot bind these inputs. */
function snapshot<T>(value: T, seen = new WeakMap<object, unknown>()): T {
	if (value === null || typeof value !== "object") return value;
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
		if (value instanceof AbortSignal) return value;
		throw new Error("OWNER_PAIR_INPUT_OBJECT");
	}
	if (seen.has(value)) return seen.get(value) as T;
	const copy = (Array.isArray(value) ? [] : Object.create(prototype)) as Record<PropertyKey, unknown>;
	seen.set(value, copy);
	for (const key of Reflect.ownKeys(value)) {
		if (Array.isArray(value) && key === "length") continue;
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
		if (!("value" in descriptor)) throw new Error("OWNER_PAIR_INPUT_ACCESSOR");
		Object.defineProperty(copy, key, { ...descriptor, value: snapshot(descriptor.value, seen) });
	}
	return copy as T;
}

function freezeInput<T>(value: T, seen = new WeakSet<object>()): T {
	if (value !== null && typeof value === "object" && !seen.has(value)) {
		seen.add(value);
		for (const child of Object.values(value)) freezeInput(child, seen);
		Object.freeze(value);
	}
	return value;
}

function fail(pair: Pair, cause: unknown): never {
	pair.failure ??= { cause };
	pair.reject(pair.failure.cause);
	throw pair.failure.cause;
}

function assertPairHealthy(pair: Pair): void {
	if (pair.failure) throw pair.failure.cause;
}

function currentPair(route: Route): Pair | undefined {
	const scoped = scope.getStore(),
		active = route.active;
	if (!scoped && !active) return undefined;
	const pair = active ?? scoped!;
	if (scoped !== active || pair.route !== route || !pair.open) {
		return fail(pair, new Error("OWNER_PAIR_SCOPE"));
	}
	assertPairHealthy(pair);
	try {
		route.owner.assertSessionStart(route.session);
		route.owner.assertSubmission();
	} catch (cause) {
		return fail(pair, cause);
	}
	// Original permission callbacks cannot swallow a nested failure and revive it.
	assertPairHealthy(pair);
	if (!pair.open || route.active !== pair) return fail(pair, new Error("OWNER_PAIR_SCOPE"));
	return pair;
}

function memberAt(pair: Pair, boundary: "context" | "stream" | "request") {
	try {
		const member = pair.current;
		if (!member) throw new Error("OWNER_PAIR_MEMBER_REQUIRED");
		const original = pair.route.owner.requestProvenance.originalPromptInput(
			pair.route.session.agent.signal,
			boundary,
		);
		if (member.signal && member.signal !== original.signal) throw new Error("OWNER_PAIR_RUN_CHANGED");
		return { member, original };
	} catch (cause) {
		return fail(pair, cause);
	}
}

/** Original SDK registration only. The returned selector stays in its construction
 * closure; neither the product entry nor its caller receives a history setter. */
export function bindOrdinaryPairedContext(
	owner: OrdinaryOwnerContext,
	session: AgentSession,
	convert: (messages: AgentMessage[]) => Message[],
) {
	assertOrdinaryOwner(owner);
	owner.assertSessionStart(session);
	if (owners.has(owner) || sessions.has(session)) throw new Error("OWNER_PAIR_SOURCE_BOUND");
	const route: Route = { owner, session };
	owners.set(owner, route);
	sessions.set(session, route);
	const select = (messages: AgentMessage[], signal?: AbortSignal): AgentMessage[] => {
		const pair = currentPair(route);
		if (!pair) return messages;
		try {
			const { member, original } = memberAt(pair, "context");
			if (signal !== original.signal || member.messages) throw new Error("OWNER_PAIR_INPUT_ONCE");
			const prompts = original.input;
			const prefix = messages.length - prompts.length;
			// The original loop appended THESE prompt objects. Queue injection or a
			// different run cannot silently become a member of this retained input.
			if (prefix < 0 || prompts.some((prompt, i) => messages[prefix + i] !== prompt)) {
				throw new Error("OWNER_PAIR_ORIGINAL_PROMPT_SUFFIX");
			}
			if (member.kind === "without") pair.baseline = structuredClone(messages.slice(0, prefix));
			if (!pair.baseline) throw new Error("OWNER_PAIR_BASELINE_REQUIRED");
			const selected = [...structuredClone(pair.baseline), ...prompts];
			member.signal = original.signal;
			member.messages = structuredClone(selected);
			// Only this run's ephemeral request context is selected. Agent state,
			// persistent entries and both real responses continue through normal paths.
			return selected;
		} catch (cause) {
			return fail(pair, cause);
		}
	};
	return Object.freeze({
		select,
		transformed(messages: AgentMessage[], signal?: AbortSignal): void {
			const pair = currentPair(route);
			if (!pair) return;
			const { member, original } = memberAt(pair, "context");
			if (!member.messages || member.transformed || signal !== original.signal)
				fail(pair, new Error("OWNER_PAIR_CONTEXT_ONCE"));
			member.transformed = messages;
		},
		converted(messages: AgentMessage[], converted: Message[]): void {
			const pair = currentPair(route);
			if (!pair) return;
			try {
				const { member } = memberAt(pair, "context");
				if (!member.messages || messages !== member.transformed || member.converted)
					throw new Error("OWNER_PAIR_CONVERSION_ONCE");
				member.canonical = freezeInput(structuredClone(convert(structuredClone(member.messages))));
				member.converted = converted;
			} catch (cause) {
				fail(pair, cause);
			}
		},
	});
}

/** Original lifecycle stream wrapper registers its ACTUAL construction objects.
 * The common guard cannot register or select history through the protected entry. */
export function recordOrdinaryPairedStream(owner: OrdinaryOwnerContext, ...args: StreamCall): void {
	const route = owners.get(owner);
	if (!route) return;
	const pair = currentPair(route);
	if (!pair) return;
	try {
		const { member, original } = memberAt(pair, "stream");
		if (
			!member.converted ||
			!member.canonical ||
			member.stream ||
			args[1].messages !== member.converted ||
			args[2]?.signal !== original.signal ||
			args[2]?.sessionId !== route.session.sessionId
		)
			throw new Error("OWNER_PAIR_STREAM_ASSOCIATION");
		member.stream = { actual: args, snapshot: snapshot(args) };
	} catch (cause) {
		fail(pair, cause);
	}
}

/** Fixed synchronous protected-entry consume BEFORE previous stream, including
 * auxiliary calls. Invalid pair association never falls back to current history. */
export function consumeOrdinaryPairedInput(
	session: AgentSession,
	model: StreamCall[0],
	context: StreamCall[1],
	streamOptions?: StreamCall[2],
): readonly Message[] | undefined {
	const args: StreamCall = [model, context, streamOptions];
	const route = sessions.get(session);
	if (!route) {
		const pair = scope.getStore();
		if (pair) return fail(pair, new Error("OWNER_PAIR_FOREIGN_SESSION"));
		return undefined;
	}
	const pair = currentPair(route);
	if (!pair) return undefined;
	try {
		const { member } = memberAt(pair, "stream");
		if (
			!member.canonical ||
			!member.stream ||
			member.witnessRead ||
			args.some((value, index) => value !== member.stream!.actual[index])
		)
			throw new Error("OWNER_PAIR_INPUT_WITNESS");
		// Consume before inspecting mutable call objects: swallowed reentry cannot
		// let either invocation publish a second witness over the original failure.
		member.witnessRead = true;
		if (!isDeepStrictEqual(args, member.stream.snapshot) || args[2]?.sessionId !== session.sessionId) {
			throw new Error("OWNER_PAIR_INPUT_WITNESS");
		}
		const input = freezeInput(structuredClone(member.canonical));
		if (pair.failure) throw pair.failure.cause;
		if (!pair.open || route.active !== pair) throw new Error("OWNER_PAIR_SCOPE");
		return input;
	} catch (cause) {
		return fail(pair, cause);
	}
}

/** Original guard's one-shot Core capture, not a caller's view label. */
export function recordOrdinaryPairedView(owner: OrdinaryOwnerContext, capture: OrdinaryCapture | null): void {
	const route = owners.get(owner);
	if (!route) return;
	const pair = currentPair(route);
	if (!pair) return;
	const { member } = memberAt(pair, "stream");
	if (
		!capture ||
		member.capture ||
		!member.messages ||
		(member.kind === "without" ? capture.frameText !== null : !capture.frameText) ||
		(capture.frameText !== null && requestDigest(new TextEncoder().encode(capture.frameText)) !== capture.frameHash)
	) {
		fail(pair, new Error("OWNER_PAIR_ORIGINAL_VIEW"));
	}
	member.capture = Object.freeze({ ...capture });
}

/** Compare the WHOLE final non-view serialization BEFORE reserving the next
 * request. The returned internal closure binds its actual once-created reservation
 * inside the normal transport task, before any count/inference effect. */
export function prepareOrdinaryPairedRequest(owner: OrdinaryOwnerContext, bytes: Uint8Array) {
	const route = owners.get(owner);
	if (!route) return undefined;
	const pair = currentPair(route);
	if (!pair) return undefined;
	try {
		const { member } = memberAt(pair, "request");
		if (!member.capture || !member.witnessRead || member.prepared) throw new Error("OWNER_PAIR_REQUEST_ONCE");
		const projected = nonViewRequest(bytes, member.capture.frameText);
		if (member.kind === "without") pair.wire = Uint8Array.from(projected);
		else if (
			!pair.members[0]?.requestId ||
			!pair.members[0].reservation ||
			!pair.wire ||
			!Buffer.from(pair.wire).equals(Buffer.from(projected))
		)
			throw new Error("OWNER_PAIR_FINAL_INPUT_MISMATCH");
		const payloadHash = requestDigest(bytes);
		member.prepared = true;
		return (reservation: TokenReservation): void => {
			try {
				if (
					currentPair(route) !== pair ||
					memberAt(pair, "request").member !== member ||
					member.reservation ||
					reservation.payloadHash !== payloadHash ||
					reservation.scope.ownerEpoch !== owner.owner.grant ||
					reservation.scope.sessionId !== owner.owner.sessionId ||
					reservation.scope.allocationId !== owner.decision.allocation.id ||
					pair.members.some((other) => other.reservation === reservation)
				)
					throw new Error("OWNER_PAIR_RESERVATION");
				member.reservation = reservation;
			} catch (cause) {
				fail(pair, cause);
			}
		};
	} catch (cause) {
		return fail(pair, cause);
	}
}

/** Wrap only original context.captureRequest, never the caller's returned IDs. */
export async function captureOrdinaryPairMember(
	owner: OrdinaryOwnerContext,
	invoke: () => Promise<{ requestId: string }>,
) {
	const route = owners.get(owner);
	if (!route) return invoke();
	const pair = currentPair(route);
	if (!pair) return invoke();
	if (pair.current || pair.members.length >= 2) return fail(pair, new Error("OWNER_PAIR_CAPTURE_CARDINALITY"));
	const member: Member = { kind: pair.members.length === 0 ? "without" : "with", witnessRead: false, prepared: false };
	pair.members.push(member);
	pair.current = member;
	try {
		const result = await invoke();
		if (currentPair(route) !== pair || !member.reservation) throw new Error("OWNER_PAIR_RESERVATION_REQUIRED");
		const actual = owner.operationalAudit.joinedRequest(member.reservation);
		if (
			!actual.nativeAccepted ||
			!actual.nativeOperationRetired ||
			actual.requestId !== result.requestId ||
			member.reservation.requestId !== result.requestId
		)
			throw new Error("OWNER_PAIR_ACCEPTED_RETIREMENT_REQUIRED");
		member.requestId = result.requestId;
		return result;
	} catch (cause) {
		return fail(pair, cause);
	} finally {
		if (pair.current === member) pair.current = undefined;
	}
}

/** Private product workload scope. Caller supplies actions, NEVER history or a
 * verifier. Each member still enters original AgentSession.prompt/capture. */
export async function captureOrdinaryRequestPair(owner: OrdinaryOwnerContext, invoke: () => Promise<void>) {
	assertOrdinaryOwner(owner);
	const route = owners.get(owner);
	if (!route) throw new Error("OWNER_PAIR_ORIGINAL_SOURCE_REQUIRED");
	owner.assertSessionStart(route.session);
	owner.assertSubmission();
	if (route.active || scope.getStore()) {
		const previous = route.active ?? scope.getStore()!;
		return fail(previous, new Error("OWNER_PAIR_OVERLAP"));
	}
	if (!route.session.isIdle) throw new Error("OWNER_PAIR_IDLE_REQUIRED");
	const remaining = owner.decision.allocation.expiresMs - Date.now();
	if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 2_147_483_647)
		throw new Error("OWNER_PAIR_DEADLINE");
	let reject!: (cause: unknown) => void;
	const stopped = new Promise<never>((_resolve, failed) => {
		reject = failed;
	});
	void stopped.catch(() => {});
	const pair: Pair = { route, open: true, members: [], reject };
	route.active = pair;
	const timeout = setTimeout(() => {
		try {
			fail(pair, new Error("OWNER_PAIR_EXPIRED"));
		} catch {
			/* rejected above */
		}
	}, remaining);
	try {
		await Promise.race([scope.run(pair, invoke), stopped]);
		assertPairHealthy(pair);
		owner.assertSessionStart(route.session);
		owner.assertSubmission();
		assertPairHealthy(pair);
		if (!pair.open || route.active !== pair) throw new Error("OWNER_PAIR_SCOPE");
		if (pair.current || pair.members.length !== 2 || !pair.members[0].requestId || !pair.members[1].requestId) {
			throw new Error("OWNER_PAIR_CAPTURE_CARDINALITY");
		}
		return owner.operationalAudit.compareRequests(pair.members[0].requestId, pair.members[1].requestId);
	} catch (cause) {
		return fail(pair, cause);
	} finally {
		clearTimeout(timeout);
		pair.open = false;
		route.active = undefined;
		pair.baseline = undefined;
		pair.wire = undefined;
		pair.members = [];
		pair.current = undefined;
	}
}

export function interruptOrdinaryRequestPair(owner: OrdinaryOwnerContext, cause: unknown): void {
	const pair = owners.get(owner)?.active;
	if (pair) {
		try {
			fail(pair, cause);
		} catch {
			/* Keep original cleanup running. */
		}
	}
}
