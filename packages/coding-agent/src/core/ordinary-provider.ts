import { randomUUID } from "node:crypto";
import type { ResponsesEvidence } from "@earendil-works/pi-ai/api/responses-evidence";
import type { AgentSession } from "./agent-session.ts";
import { ORDINARY_CREDENTIAL_PLACEHOLDER } from "./ordinary-credential-delivery.ts";
import { assertOrdinaryOwner, type OrdinaryOwnerContext } from "./ordinary-owner-context.ts";
import {
	consumeOrdinaryPairedInput,
	prepareOrdinaryPairedRequest,
	recordOrdinaryPairedView,
} from "./ordinary-request-pair.ts";
import type {
	OrdinaryCapture,
	OrdinaryProviderOutcome,
	OrdinarySenseEntry,
	OrdinarySubmission,
} from "./ordinary-sense.ts";
import { projectResponsesTokenCount } from "./ordinary-token-qualification.ts";

/** Pure wire validation, not permission to submit. The caller still needs the
 * original owner's guard, credential/token bindings and native dispatch. */
export function assertOrdinaryProviderPayload(
	payload: unknown,
	admitted: { readonly wireModel: string; readonly outputTokens: number },
): void {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("OWNER_PROVIDER_PAYLOAD");
	const wire = payload as Record<string, unknown>;
	if (
		wire.model !== admitted.wireModel ||
		wire.stream !== true ||
		wire.store !== false ||
		(wire.background !== undefined && wire.background !== false) ||
		!Number.isSafeInteger(wire.max_output_tokens) ||
		(wire.max_output_tokens as number) <= 0 ||
		(wire.max_output_tokens as number) > admitted.outputTokens
	)
		throw new Error("OWNER_PROVIDER_PAYLOAD");
}

/** Native parser remains Pi's Responses parser. This layer owns final request
 * identity and native operation custody, not a second SSE parser. */
export function createOrdinaryProviderIntegration(
	context: OrdinaryOwnerContext,
	entry: OrdinarySenseEntry,
	bridge: {
		canSubmit(): boolean;
		takeCapture(): OrdinaryCapture | null;
		submitted(receipt: OrdinarySubmission | OrdinaryProviderOutcome): void;
	},
) {
	assertOrdinaryOwner(context);
	const owner = context.owner;
	const admitted = context.decision.record.provider;
	const maxRequestBytes = owner.host.profile.storage.journalBytes;
	const pending = new Set<Promise<void>>();
	const errors: unknown[] = [];
	let installed = false;
	let closed = false;
	let closing: Promise<void> | undefined;
	let restore: (() => void) | undefined;
	let boundSession: AgentSession | undefined;
	let guarded: AgentSession["agent"]["streamFunction"] | undefined;
	const assertSend = () => {
		context.assertSubmission();
		if (
			closed ||
			!boundSession ||
			!guarded ||
			boundSession.sessionManager !== owner.manager ||
			boundSession.agent.streamFunction !== guarded
		)
			throw new Error("OWNER_PROVIDER_GUARD_CHANGED");
	};
	const send: typeof globalThis.fetch = Object.assign(
		async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
			assertSend();
			const request = new Request(input, { ...init, redirect: "error" });
			if (closed || request.url !== admitted.url || request.method !== "POST")
				throw new Error("OWNER_PROVIDER_ENDPOINT");
			const bytes = new Uint8Array(await request.arrayBuffer());
			assertSend();
			if (bytes.length > maxRequestBytes) throw new Error("OWNER_PROVIDER_REQUEST_BYTES");
			assertOrdinaryProviderPayload(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), admitted);
			// No DNS/TCP/count attempt when independently admitted authority or provider
			// semantics is absent. A matching origin or integer response is not support.
			context.assertNativeTokenReservation();
			if (request.headers.has("expect")) throw new Error("OWNER_PROVIDER_EXPECT_HEADER");
			const countProjection = projectResponsesTokenCount(bytes, admitted);
			const bindPairedReservation = prepareOrdinaryPairedRequest(context, bytes);
			const reservation = context.reserveProviderTokens(randomUUID(), countProjection.payloadHash);
			context.operationalAudit.request(reservation, bytes);
			const joinRetirement = context.requestProvenance.request(reservation);
			let evidenceRecorded = false;
			const recordEvidence = (evidence: Readonly<ResponsesEvidence>) => {
				if (evidenceRecorded) throw new Error("OWNER_USAGE_DUPLICATE");
				evidenceRecorded = true;
				try {
					const receipt = context.reconcileProviderTokens(reservation, evidence);
					context.publishProviderUsage(receipt);
					if (receipt.disposition === "over-budget" || evidence.conflict)
						throw new Error("OWNER_PROVIDER_USAGE_LIMIT");
				} catch (cause) {
					errors.push(cause);
					throw cause;
				}
			};
			let resolve!: (response: Response) => void;
			let reject!: (error: unknown) => void;
			const headersReady = new Promise<Response>((done, failed) => {
				resolve = done;
				reject = failed;
			});
			const transportStop = new AbortController();
			const task = (async () => {
				bindPairedReservation?.(reservation);
				const authority = admitted.count;
				if (!authority) throw new Error("OWNER_COUNT_AUTHORITY_UNAVAILABLE");
				const plan = context.prepareProviderCount(reservation, countProjection);
				const counted = await owner.effect(
					{
						kind: "provider",
						provider: admitted.provider,
						model: admitted.model,
						api: admitted.api,
						baseUrl: admitted.baseUrl,
						count: {
							url: authority.url,
							method: authority.method,
							wireModel: authority.wireModel,
							purpose: authority.purpose,
							account: authority.account,
							requestId: plan.requestId,
							payloadHash: countProjection.payloadHash,
							countBodyHash: countProjection.countBodyHash,
						},
					},
					async (effect) => {
						const signal = AbortSignal.any([
							request.signal,
							effect.signal,
							transportStop.signal,
							AbortSignal.timeout(Math.max(1, context.decision.allocation.expiresMs - Date.now())),
						]);
						const countRequest = new Request(authority.url, {
							method: authority.method,
							signal,
							redirect: "error",
							headers: {
								"content-type": "application/json",
								accept: "application/json",
								authorization: `Bearer ${ORDINARY_CREDENTIAL_PLACEHOLDER}`,
							},
							body: countProjection.countBody,
						});
						const exchange = effect.provider(
							countRequest,
							authority.wireModel,
							1024,
							(finalRequest) => {
								assertSend();
								context.assertNativeTokenReservation();
								signal.throwIfAborted();
								return context.authorizeProviderRequest(finalRequest);
							},
							() => {
								throw new Error("OWNER_COUNT_INFERENCE_EVIDENCE");
							},
							{
								binding: plan,
								requestId: plan.requestId,
								payloadHash: countProjection.payloadHash,
								countBodyHash: countProjection.countBodyHash,
							},
						);
						// Header rejection cannot finish the operation before socket cleanup.
						void exchange.response.catch(() => {});
						await exchange.settled;
						const result = await exchange.countResult;
						if (!result) throw new Error("OWNER_COUNT_RESPONSE_SCOPE");
						return result;
					},
					{ signal: request.signal },
				);
				// Native count completeOperation has returned before a usable receipt exists.
				const qualification = context.qualifyProviderCount(plan, counted);
				assertSend();
				await owner.effect(
					{
						kind: "provider",
						provider: admitted.provider,
						model: admitted.model,
						api: admitted.api,
						baseUrl: admitted.baseUrl,
					},
					async (effect) => {
						const signal = AbortSignal.any([
							request.signal,
							effect.signal,
							transportStop.signal,
							AbortSignal.timeout(
								Math.max(1, context.decision.record.admission.allocation.expiresMs - Date.now()),
							),
						]);
						const prepared = new Request(admitted.url, {
							method: "POST",
							headers: request.headers,
							body: bytes,
							redirect: "error",
							signal,
						});
						const exchange = effect.provider(
							prepared,
							admitted.wireModel,
							owner.host.profile.limits.outputBytes,
							(finalRequest, finalBytes) => {
								// Recheck after durable spending, DNS, TCP and TLS setup, immediately
								// before HTTP request bytes are queued on the original native socket.
								context.assertNativeTokenReservation();
								assertSend();
								signal.throwIfAborted();
								const outgoing = context.authorizeProviderRequest(finalRequest);
								context.consumeProviderQualification(qualification, reservation, finalBytes);
								context.operationalAudit.dispatch(reservation);
								return outgoing;
							},
							recordEvidence,
						);
						void exchange.response.then(resolve, reject);
						await exchange.settled;
					},
					{ signal: request.signal },
				);
				context.operationalAudit.retired(reservation);
			})();
			joinRetirement(task);
			const observed = task.then(
				() => {
					transportStop.abort();
				},
				(error: unknown) => {
					transportStop.abort(error);
					errors.push(error);
					if (!evidenceRecorded) {
						// Retain an unknown charge even if no HTTP reply/parser was obtained.
						evidenceRecorded = true;
						try {
							context.reconcileProviderTokens(reservation, {
								responseId: null,
								terminal: null,
								usage: null,
								streamEnded: false,
								conflict: false,
							});
						} catch (cleanup) {
							errors.push(cleanup);
						}
					}
					reject(error);
					try {
						owner.quarantine();
					} catch (cleanup) {
						errors.push(cleanup);
					}
				},
			);
			pending.add(observed);
			void observed.then(() => pending.delete(observed));
			return headersReady;
		},
		{
			preconnect: () => {
				throw new Error("OWNER_PROVIDER_PRECONNECT");
			},
		},
	);
	return Object.freeze({
		install(session: AgentSession): void {
			context.assertActive();
			if (installed || closed || session.sessionManager !== owner.manager)
				throw new Error("OWNER_PROVIDER_GUARD_BINDING");
			if (entry.consumeOrdinaryPairedInput !== consumeOrdinaryPairedInput)
				throw new Error("OWNER_PAIR_GUARD_MODULE_IDENTITY");
			installed = true;
			boundSession = session;
			const previous = session.agent.streamFunction;
			const preparation: typeof previous = (model, messages, options) => {
				context.assertSubmission();
				if (
					model.provider !== admitted.provider ||
					model.id !== admitted.model ||
					model.api !== admitted.api ||
					model.baseUrl !== admitted.baseUrl ||
					options?.transport !== "sse" ||
					!options.fetch ||
					(options.apiKey !== undefined && options.apiKey !== ORDINARY_CREDENTIAL_PLACEHOLDER) ||
					options.env !== undefined
				) {
					throw new Error("OWNER_PROVIDER_PREPARATION");
				}
				const fetch = context.requestProvenance.bindFetch(options.fetch);
				context.bindPreparedFetch(fetch);
				return previous(model, messages, {
					...options,
					fetch,
					maxTokens: admitted.outputTokens,
					onPayload: async (payload, selected) => {
						context.assertSubmission();
						if (
							selected.provider !== admitted.provider ||
							selected.id !== admitted.model ||
							selected.api !== admitted.api ||
							selected.baseUrl !== admitted.baseUrl
						)
							throw new Error("OWNER_PROVIDER_PAYLOAD");
						assertOrdinaryProviderPayload(payload, admitted);
						const result = await options.onPayload?.(payload, selected);
						assertSend();
						assertOrdinaryProviderPayload(result === undefined ? payload : result, admitted);
						return result;
					},
				});
			};
			session.agent.streamFunction = preparation;
			const removeCommon = entry.installPiRequestGuard(session, {
				takeCapture: () => {
					const capture = bridge.takeCapture();
					context.operationalAudit.capture(capture);
					recordOrdinaryPairedView(context, capture);
					return capture;
				},
				endpoint: admitted.url,
				maxRequestBytes,
				fetch: send,
				canSubmit: () => !closed && session.agent.streamFunction === guarded && bridge.canSubmit(),
				onSubmission: (receipt) => bridge.submitted(receipt),
				providerEvidence: {
					record: (receipt) => {
						bridge.submitted(receipt);
						context.operationalAudit.outcome(receipt);
					},
					failed: () => owner.quarantine(),
				},
			});
			guarded = session.agent.streamFunction;
			restore = () => {
				removeCommon();
				if (session.agent.streamFunction !== preparation) throw new Error("OWNER_PROVIDER_GUARD_CHANGED");
				session.agent.streamFunction = previous;
			};
			context.assertActive();
		},
		close(): Promise<void> {
			if (closing) return closing;
			closed = true;
			closing = Promise.resolve().then(async () => {
				const settled = await Promise.allSettled([...pending]);
				for (const result of settled) if (result.status === "rejected") errors.push(result.reason);
				const releaseGuard = restore;
				restore = undefined;
				try {
					releaseGuard?.();
				} catch (cleanup) {
					errors.push(cleanup);
				}
				if (errors.length) throw new AggregateError(errors, "OWNER_PROVIDER_NOT_RETIRED", { cause: errors[0] });
			});
			return closing;
		},
	});
}
