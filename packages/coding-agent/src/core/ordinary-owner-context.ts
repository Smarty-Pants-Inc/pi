import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import type { ResponsesEvidence } from "@earendil-works/pi-ai/api/responses-evidence";
import type { AgentSession } from "./agent-session.ts";
import type { CreateAgentSessionRuntimeFactory } from "./agent-session-runtime.ts";
import type { AgentSessionServices } from "./agent-session-services.ts";
import { OrdinaryAutomaticHold, type OriginalAutomaticEnrollment } from "./ordinary-automatic-hold.ts";
import { assertCountSemantics, type CountSemantics, parseCountSemantics } from "./ordinary-count-semantics.ts";
import { receivePreparedCredential } from "./ordinary-credential-binding.ts";
import { type NativeTuiAuditState, OrdinaryOperationalAudit } from "./ordinary-operational-audit.ts";
import {
	type OrdinaryDecision,
	parseOrdinaryOwnerRecord,
	produceOrdinaryPocDecision,
} from "./ordinary-owner-policy.ts";
import type { OwnedCountResult } from "./ordinary-provider-transport.ts";
import {
	captureOrdinaryPairMember,
	interruptOrdinaryRequestPair,
	recordOrdinaryPairedStream,
} from "./ordinary-request-pair.ts";
import { OrdinaryRequestProvenance } from "./ordinary-request-provenance.ts";
import { createOriginalSc085 } from "./ordinary-sc085.ts";
import {
	bindSc085OriginalChild,
	checkSc085Operation,
	enterSc085OriginalReceiving,
	receiveSc085OriginalStorage,
	type Sc085OriginalReceiving,
} from "./ordinary-sc085-source/operational-admission.ts";
import type { OrdinaryOperationalHooks } from "./ordinary-sense.ts";
import {
	OrdinaryTokenBudget,
	type TokenCountPlan,
	type TokenQualification,
	type TokenReservation,
	type TokenSettlement,
} from "./ordinary-token-budget.ts";
import type { ResponsesCountProjection } from "./ordinary-token-qualification.ts";
import { OwnerHost, openReleaseFile } from "./owner-effects.ts";
import { ownerProfileDigest, parseOwnerHostProfile } from "./owner-profile.ts";
import { assertUnownedSessionManager, type SessionManager } from "./session-manager.ts";
import { currentSessionOwnership, ownershipOf, SessionOwnership } from "./session-ownership.ts";

const constructionKey = Symbol("ordinary-owner-receiving");
const contexts = new WeakSet<OrdinaryOwnerContext>();
const factories = new WeakMap<CreateAgentSessionRuntimeFactory, OrdinaryOwnerContext>();
const serviceOwners = new WeakMap<AgentSessionServices, OrdinaryOwnerContext>();
const inputs = new WeakMap<object, OrdinaryOwnerContext>();

/** Private propagation, deliberately absent from public option shapes/exports. */
export function bindOrdinaryOptions<T extends object>(options: T, owner: OrdinaryOwnerContext): T {
	assertOrdinaryOwner(owner);
	if (inputs.has(options)) throw new Error("OWNER_RUNTIME_INPUT_REUSED");
	inputs.set(options, owner);
	return options;
}

export function ordinaryOwnerOf(options: object): OrdinaryOwnerContext | undefined {
	return inputs.get(options);
}

export function ordinaryOwnerForFactory(factory: CreateAgentSessionRuntimeFactory): OrdinaryOwnerContext | undefined {
	return factories.get(factory);
}

/** Private original-services lookup, never an extension-supplied audit sink. */
export function bindOrdinaryTuiAudit(
	services: AgentSessionServices,
	session: AgentSession,
	source: object,
	snapshot: () => NativeTuiAuditState,
): ((kind: string) => void) | undefined {
	return serviceOwners.get(services)?.bindTuiAudit(services, session, source, snapshot);
}

/** Private installed Sense entry result, not an ExtensionAPI option. */
export interface OrdinarySenseBridge {
	readonly owner: SessionOwnership;
	bindSession(session: AgentSession): void;
	installProviderGuard(session: AgentSession): void;
	canSubmit(): boolean;
	close(): Promise<void>;
}

/** Private original-owner handle. A parsed record or matching UUID cannot make one. */
export class OrdinaryOwnerContext {
	readonly owner: SessionOwnership;
	readonly operationalAudit: OrdinaryOperationalAudit;
	readonly requestProvenance = new OrdinaryRequestProvenance<TokenReservation>();
	readonly #auditSubscriptions: Array<() => void> = [];
	readonly decision: OrdinaryDecision;
	readonly profilePath: string;
	readonly applicationPath: string;
	readonly #files: number[];
	readonly #tokenBudget: OrdinaryTokenBudget;
	readonly #countSemantics?: Readonly<CountSemantics>;
	#usageSink?: (receipt: TokenSettlement) => void;
	readonly #publishedUsage = new WeakSet<TokenSettlement>();
	#stopped = false;
	readonly #credential: ReturnType<typeof receivePreparedCredential>;
	#automaticStopped: boolean;
	#closing?: Promise<void>;
	#services?: Readonly<
		Pick<AgentSessionServices, "cwd" | "agentDir" | "resourceLoader" | "settingsManager" | "modelRuntime"> & {
			value: AgentSessionServices;
		}
	>;
	#sense?: OrdinarySenseBridge;
	#runtimeFactory?: CreateAgentSessionRuntimeFactory;
	#operational?: Readonly<OrdinaryOperationalHooks>;
	#session?: AgentSession;
	#bindingSession = false;
	#guardInstalled = false;
	readonly #automaticHold = new OrdinaryAutomaticHold();
	readonly #sc085Receiving?: Sc085OriginalReceiving;
	#sc085?: ReturnType<typeof createOriginalSc085>;
	#admission?: {
		session: AgentSession;
		agent: AgentSession["agent"];
		requestWake(recheck: () => boolean, enroll?: OriginalAutomaticEnrollment): Promise<"started" | "suppressed">;
	};
	readonly #preparedFetches = new WeakSet<typeof globalThis.fetch>();

	constructor(
		key: symbol,
		owner: SessionOwnership,
		decision: OrdinaryDecision,
		profilePath: string,
		applicationPath: string,
		files: number[],
		countSemantics?: Readonly<CountSemantics>,
		sc085?: Sc085OriginalReceiving,
	) {
		if (key !== constructionKey || ownershipOf(owner.manager) !== owner) throw new Error("OWNER_NATIVE_CONSTRUCTION");
		this.owner = owner;
		this.#sc085Receiving = sc085;
		this.decision = decision;
		this.profilePath = profilePath;
		this.applicationPath = applicationPath;
		this.#files = files;
		this.operationalAudit = new OrdinaryOperationalAudit(
			{ ownerEpoch: owner.grant, sessionId: owner.sessionId, allocationId: decision.allocation.id },
			Math.min(65536, owner.host.profile.limits.operationsPerOwner * 64),
			owner.host.profile.storage.journalBytes,
			{
				profileSha256: decision.record.profileSha256,
				recipe: decision.record.recipe,
				packageSha256: decision.record.package.sha256,
				applicationSha256: decision.record.application.sha256,
				senseSha256: decision.record.sense.sha256,
				provider: decision.record.provider.provider,
				model: decision.record.provider.model,
				api: decision.record.provider.api,
				baseUrl: decision.record.provider.baseUrl,
			},
		);
		this.#countSemantics = countSemantics;
		this.#tokenBudget = new OrdinaryTokenBudget({
			allocationId: decision.allocation.id,
			decisionDigest: decision.digest,
			ownerEpoch: owner.grant,
			sessionId: owner.sessionId,
			provider: decision.record.provider.provider,
			model: decision.record.provider.model,
			contextTokens: decision.record.provider.contextTokens,
			outputTokens: decision.record.provider.outputTokens,
			attempts: decision.allocation.inference,
			notBeforeMs: decision.allocation.notBeforeMs,
			expiresMs: decision.allocation.expiresMs,
		});
		this.#automaticStopped = !decision.record.admission.allocation.scopeOpen;
		const { provider, credential, url } = decision.record.provider;
		const allocation = decision.record.admission.allocation;
		this.#credential = receivePreparedCredential(
			owner,
			{
				deliveryId: credential.generation,
				decisionDigest: decision.digest,
				allocationId: allocation.id,
				provider,
				purpose: credential.purpose,
				account: credential.account,
				referenceSha256: credential.referenceSha256,
				notBeforeMs: allocation.notBeforeMs,
				expiresMs: allocation.expiresMs,
			},
			url,
			decision.record.provider.count?.url,
		);
		contexts.add(this);
		Object.freeze(this);
	}

	assertActive(): void {
		if (!contexts.has(this) || this.#stopped) throw new Error("STALE_OWNER");
		this.owner.assertActive();
	}

	/** Original provider facade reads this only after B/full admission. No setter
	 * or fallback can expose the five methods without the private Source route. */
	get sc085(): ReturnType<typeof createOriginalSc085>["methods"] | undefined {
		if (!this.#sc085Receiving) return undefined;
		checkSc085Operation(this.#sc085Receiving, this, "boundary");
		this.#sc085 ??= createOriginalSc085(this, this.#sc085Receiving, this.#automaticHold);
		return this.#sc085.methods;
	}

	/** Read the received bundle itself. Passing a /proc FD path to a resolver
	 * could resolve it back to a replaced pathname before opening the source. */
	readSenseEntry(): string {
		this.assertActive();
		const fd = this.#files.at(-1);
		if (fd === undefined) throw new Error("OWNER_SENSE_DESCRIPTOR");
		const before = fstatSync(fd);
		if (!before.isFile() || before.uid !== 0 || before.mode & 0o022 || before.size > 268_435_456)
			throw new Error("OWNER_SENSE_DESCRIPTOR");
		const bytes = Buffer.alloc(before.size);
		for (let offset = 0; offset < bytes.length; ) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
			if (!count) throw new Error("OWNER_SENSE_DESCRIPTOR");
			offset += count;
		}
		const after = fstatSync(fd);
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs ||
			createHash("sha256").update(bytes).digest("hex") !== this.decision.record.sense.sha256
		) {
			throw new Error("OWNER_SENSE_DESCRIPTOR");
		}
		this.assertActive();
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	}

	/** Private Stage B/action observation. Source must still authenticate the
	 * selected operation and test its required remaining budgets. No reservation. */
	inspectCurrentPermission() {
		this.assertActive();
		if (this.#automaticStopped) throw new Error("OWNER_AUTOMATIC_STOPPED");
		this.assertCredentialBinding();
		const permission = this.owner.inspectPermission();
		this.assertActive();
		return Object.freeze({ ...permission, allocationId: this.decision.allocation.id });
	}

	isCurrent(): boolean {
		try {
			this.assertActive();
			return true;
		} catch {
			return false;
		}
	}

	/** The native check retains A's descriptor identity and allocation lifetime.
	 * No issuer-expiry/version claim, ambient owner lookup, or second resolution. */
	assertCredentialBinding(): void {
		this.assertActive();
		this.#credential.assertCurrent();
	}

	/** Private final dispatch only. Models and hooks see the nonsecret placeholder,
	 * never the received key. A copied Request is not an authorization ticket. */
	authorizeProviderRequest(request: Request): Request {
		this.assertActive();
		return this.#credential.authorize(request);
	}

	/** Preparation readiness, NOT a per-request qualification. Inference dispatch
	 * separately consumes the original request's once-issued count receipt. */
	assertNativeTokenReservation(): void {
		this.assertActive();
		if (!this.decision.record.provider.count) throw new Error("OWNER_COUNT_AUTHORITY_UNAVAILABLE");
		assertCountSemantics(this.#countSemantics, Date.now());
	}

	prepareProviderCount(reservation: TokenReservation, projection: Readonly<ResponsesCountProjection>): TokenCountPlan {
		this.assertNativeTokenReservation();
		if (projection.wireModel !== this.decision.record.provider.wireModel) throw new Error("OWNER_COUNT_MODEL_SCOPE");
		const plan = this.#tokenBudget.prepareCount(reservation, projection, Date.now());
		this.within(() =>
			this.owner.manager.appendCustomEntry("smarty-sense:count-reservation-v1", {
				requestId: plan.requestId,
				reservationId: reservation.requestId,
				scope: reservation.scope,
				payloadHash: projection.payloadHash,
				countBodyHash: projection.countBodyHash,
				endpoint: this.decision.record.provider.count!.url,
			}),
		);
		return plan;
	}

	qualifyProviderCount(plan: TokenCountPlan, result: OwnedCountResult): TokenQualification {
		this.assertNativeTokenReservation();
		const receipt = this.#tokenBudget.qualifyCount(plan, result, Date.now());
		this.within(() => this.owner.manager.appendCustomEntry("smarty-sense:count-qualification-v1", receipt));
		return receipt;
	}

	consumeProviderQualification(receipt: TokenQualification, reservation: TokenReservation, bytes: Uint8Array): void {
		this.assertNativeTokenReservation();
		this.#tokenBudget.consumeQualification(receipt, reservation, bytes, Date.now());
	}

	hasNativeTokenReservation(): boolean {
		try {
			this.assertNativeTokenReservation();
			return true;
		} catch {
			return false;
		}
	}

	acceptsFrameReservation(bytes: number): boolean {
		return (
			Number.isSafeInteger(bytes) &&
			bytes >= 0 &&
			bytes <= this.decision.record.limits.frameBudgetBytes &&
			this.hasNativeTokenReservation()
		);
	}

	/** Private host collector binding, not an admission or author-facing API. */
	bindUsageSink(sink: (receipt: TokenSettlement) => void): void {
		this.assertActive();
		if (this.#usageSink) throw new Error("OWNER_USAGE_SINK_BOUND");
		this.#usageSink = sink;
	}

	reserveProviderTokens(requestId: string, payloadHash: string): TokenReservation {
		this.assertActive();
		const reservation = this.#tokenBudget.reserve(requestId, payloadHash, Date.now());
		this.within(() => this.owner.manager.appendCustomEntry("smarty-sense:provider-reservation-v1", reservation));
		return reservation;
	}

	reconcileProviderTokens(reservation: TokenReservation, evidence: Readonly<ResponsesEvidence>): TokenSettlement {
		const receipt = this.#tokenBudget.reconcile(reservation, evidence);
		this.operationalAudit.settlement(receipt);
		// Accounting has no activation effect. Evidence remains charged if journal
		// persistence or the collector fails; neither failure permits a resend.
		return receipt;
	}

	publishProviderUsage(receipt: TokenSettlement): void {
		this.#tokenBudget.assertSettlement(receipt);
		if (this.#publishedUsage.has(receipt)) throw new Error("OWNER_USAGE_DUPLICATE");
		// Do not retry an uncertain journal write or a throwing external sink.
		this.#publishedUsage.add(receipt);
		this.within(() => this.owner.manager.appendCustomEntry("smarty-sense:provider-usage-v1", receipt));
		this.#usageSink?.(receipt);
		this.assertActive();
	}

	canSubmitNative(): boolean {
		try {
			this.assertActive();
			this.assertCredentialBinding();
			this.assertNativeTokenReservation();
			return true;
		} catch {
			return false;
		}
	}

	/** Private SDK/AgentSession join. No extension receives this context. */
	bindSessionAdmission(
		session: AgentSession,
		requestWake: (recheck: () => boolean, enroll?: OriginalAutomaticEnrollment) => Promise<"started" | "suppressed">,
	): void {
		this.assertActive();
		if (this.#admission || session.sessionManager !== this.owner.manager)
			throw new Error("OWNER_SESSION_ADMISSION_BINDING");
		const agent = session.agent;
		this.#admission = Object.freeze({ session, agent, requestWake });
		this.#auditSubscriptions.push(
			agent.observeLifecycle(
				(event) => {
					if (event.type === "run_start") this.requestProvenance.started(agent.signal);
					this.operationalAudit.native(event);
				},
				(stream, signal) =>
					(...args) =>
						this.requestProvenance.stream(signal, () => {
							recordOrdinaryPairedStream(this, ...args);
							return stream(...args);
						}),
			),
		);
	}

	/** Exact host capability; IDs are returned only from original retired reservations. */
	captureRequest(invoke: () => Promise<unknown>): Promise<{ requestId: string }> {
		this.assertActive();
		if (!this.#session) throw new Error("OWNER_RUNTIME_SESSION");
		this.assertSessionStart(this.#session);
		return captureOrdinaryPairMember(this, () =>
			this.requestProvenance.capture(invoke, this.decision.allocation.expiresMs, (reservation) => {
				this.assertActive();
				const row = this.operationalAudit.joinedRequest(reservation);
				if (!row.nativeOperationRetired || !row.nativeAccepted)
					throw new Error("OWNER_REQUEST_CAPTURE_NOT_ACCEPTED");
				return { requestId: row.requestId };
			}),
		);
	}

	bindTuiAudit(
		services: AgentSessionServices,
		session: AgentSession,
		source: object,
		snapshot: () => NativeTuiAuditState,
	): (kind: string) => void {
		this.assertServices(services);
		if (this.#session !== session || this.#admission?.session !== session) throw new Error("OWNER_RUNTIME_SESSION");
		this.operationalAudit.bindTui(source, snapshot);
		return (kind) => this.operationalAudit.tui(source, kind);
	}

	async requestWake(recheck: () => boolean): Promise<"started" | "suppressed"> {
		if (
			this.#automaticStopped ||
			!this.#session ||
			this.#bindingSession ||
			this.#admission?.session !== this.#session ||
			!this.canSubmitNative()
		)
			return "suppressed";
		this.operationalAudit.event("owner", "autonomous-wake-requested");
		try {
			const result = await this.#automaticHold.admit(async (enroll) => {
				this.assertActive();
				if (this.#automaticStopped || !this.canSubmitNative()) return "suppressed";
				return this.#admission!.requestWake(recheck, enroll);
			});
			this.operationalAudit.event("owner", `autonomous-wake-${result}`);
			return result;
		} catch (error) {
			this.operationalAudit.event("owner", "autonomous-wake-failed");
			throw error;
		}
	}

	/** Original session disposal/abort invalidates held evidence synchronously. */
	interruptAutomaticCapture(cause: unknown): void {
		interruptOrdinaryRequestPair(this, cause);
		this.#sc085?.cancel(cause);
		this.#automaticHold.fail(cause);
		this.requestProvenance.interrupt(cause);
	}

	bindPreparedFetch(fetch: typeof globalThis.fetch): void {
		this.assertActive();
		this.#preparedFetches.add(fetch);
	}

	assertPreparedFetch(fetch: typeof globalThis.fetch | undefined): void {
		this.assertActive();
		if (!fetch || !this.#preparedFetches.has(fetch)) throw new Error("OWNER_PROVIDER_GUARD_REQUIRED");
	}

	assertSessionStart(session: AgentSession): void {
		this.assertActive();
		if (
			this.#session !== session ||
			this.#bindingSession ||
			this.#admission?.session !== session ||
			session.sessionManager !== this.owner.manager ||
			session.agent !== this.#admission.agent ||
			!this.#guardInstalled
		) {
			throw new Error("OWNER_SESSION_START_BINDING");
		}
	}

	installProviderGuard(session: AgentSession): void {
		this.assertSenseInstalled();
		if (this.#session !== session || this.#bindingSession || this.#guardInstalled)
			throw new Error("OWNER_PROVIDER_GUARD_BINDING");
		// Record once-only ownership before calling code that can reenter.
		this.#guardInstalled = true;
		try {
			this.#sense!.installProviderGuard(session);
			this.assertActive();
		} catch (error) {
			this.#stopped = true;
			throw error;
		}
	}

	within<T>(action: () => T): T {
		this.assertActive();
		return this.owner.within(action);
	}

	installSense(bridge: OrdinarySenseBridge): void {
		this.assertActive();
		if (this.#sense || bridge.owner !== this.owner) throw new Error("OWNER_SENSE_BINDING");
		const retained = Object.freeze({
			owner: this.owner,
			bindSession: bridge.bindSession.bind(bridge),
			installProviderGuard: bridge.installProviderGuard.bind(bridge),
			canSubmit: bridge.canSubmit.bind(bridge),
			close: bridge.close.bind(bridge),
		});
		this.assertActive();
		if (this.#sense) throw new Error("OWNER_SENSE_BINDING");
		this.#sense = retained;
	}

	assertSenseInstalled(): void {
		this.assertActive();
		if (!this.#sense) throw new Error("OWNER_SENSE_BINDING_REQUIRED");
	}

	bindSession(session: AgentSession): void {
		this.assertSenseInstalled();
		if (this.#session || session.sessionManager !== this.owner.manager) throw new Error("OWNER_RUNTIME_SESSION");
		this.#session = session;
		this.#bindingSession = true;
		try {
			this.#sense!.bindSession(session);
			this.assertActive();
		} catch (error) {
			this.#stopped = true;
			throw error;
		} finally {
			this.#bindingSession = false;
		}
	}

	assertSubmission(): void {
		this.assertActive();
		if (this.#session) this.assertSessionStart(this.#session);
		if (!this.#session || this.#bindingSession || !this.#sense?.canSubmit())
			throw new Error("OWNER_SENSE_NOT_ADMITTED");
		// The bridge can reenter shutdown while answering. Its boolean cannot
		// revive the original owner after that callback returns.
		this.assertSessionStart(this.#session);
	}

	fileTarget(path: string, writable: boolean): { root: number; relativePath: string } {
		this.assertActive();
		if (!isAbsolute(path) || normalize(path) !== path || /[\u0000-\u001f\u007f]/.test(path))
			throw new Error("OWNER_FILE_PATH");
		// Model file tools get W, not the host's scratch/snapshot/state root T
		// or the observer's R/D grants. Those have separate fixed consumers.
		const root = this.decision.record.roots.W;
		if (!path.startsWith(`${root.path}/`) || (writable && root.access !== "read-write"))
			throw new Error("OWNER_FILE_SCOPE");
		return { root: this.decision.roots.W, relativePath: path.slice(root.path.length + 1) };
	}

	assertSdkInputs(
		options: Partial<
			Pick<AgentSessionServices, "cwd" | "agentDir" | "resourceLoader" | "settingsManager" | "modelRuntime">
		>,
	): void {
		this.assertSenseInstalled();
		if (
			!this.#services ||
			options.cwd !== this.#services.cwd ||
			options.agentDir !== this.#services.agentDir ||
			options.resourceLoader !== this.#services.resourceLoader ||
			options.modelRuntime !== this.#services.modelRuntime ||
			options.settingsManager !== this.#services.settingsManager
		) {
			throw new Error("OWNER_RUNTIME_SERVICES");
		}
		this.assertActive();
	}

	/** Host hooks travel with this original owner through resource loading, never settings. */
	get operational(): Readonly<OrdinaryOperationalHooks> | undefined {
		this.assertActive();
		return this.#operational;
	}

	bindFactory(
		factory: CreateAgentSessionRuntimeFactory,
		operational?: OrdinaryOperationalHooks,
	): CreateAgentSessionRuntimeFactory {
		this.assertActive();
		if (this.#runtimeFactory || factories.has(factory)) throw new Error("OWNER_RUNTIME_FACTORY");
		let retained: Readonly<OrdinaryOperationalHooks> | undefined;
		if (operational !== undefined) {
			const { executor, opened, wakeIntention, sc085SetupReceiver } = operational;
			if (
				typeof executor !== "function" ||
				typeof opened !== "function" ||
				typeof wakeIntention !== "function" ||
				(sc085SetupReceiver !== undefined && typeof sc085SetupReceiver !== "function")
			) {
				throw new Error("OWNER_OPERATIONAL_HOOKS");
			}
			retained = Object.freeze({
				executor: executor.bind(operational),
				opened: opened.bind(operational),
				wakeIntention: wakeIntention.bind(operational),
				...(sc085SetupReceiver ? { sc085SetupReceiver: sc085SetupReceiver.bind(operational) } : {}),
			});
		}
		this.assertActive();
		if (this.#runtimeFactory || factories.has(factory)) throw new Error("OWNER_RUNTIME_FACTORY");
		this.#runtimeFactory = factory;
		this.#operational = retained;
		factories.set(factory, this);
		if (this.#sc085Receiving) {
			const receiving = this.#sc085Receiving;
			if (!retained?.sc085SetupReceiver) throw new Error("OWNER_SC085_SETUP_REGISTRATION_REQUIRED");
			const storage = receiveSc085OriginalStorage(receiving, this);
			this.operationalAudit.registerValidatedSetupReceiver(
				retained.sc085SetupReceiver,
				storage.retained,
				(value) => storage.record(value),
				() => checkSc085Operation(receiving, this, "boundary"),
			);
		} else if (retained?.sc085SetupReceiver) throw new Error("OWNER_SC085_RECEIVING_REQUIRED");
		return factory;
	}

	bindServices(services: AgentSessionServices): void {
		this.assertActive();
		if (this.#services || serviceOwners.has(services)) throw new Error("OWNER_RUNTIME_SERVICES");
		const { cwd, agentDir, resourceLoader, settingsManager, modelRuntime } = services;
		this.assertActive();
		if (this.#services || serviceOwners.has(services) || cwd !== this.owner.manager.getCwd())
			throw new Error("OWNER_RUNTIME_SERVICES");
		serviceOwners.set(services, this);
		this.#services = Object.freeze({ value: services, cwd, agentDir, resourceLoader, settingsManager, modelRuntime });
	}

	assertServices(services: AgentSessionServices): void {
		this.assertActive();
		if (serviceOwners.get(services) !== this || this.#services?.value !== services)
			throw new Error("OWNER_RUNTIME_SERVICES");
		this.assertSdkInputs(services);
	}

	stopAutomatic(): void {
		if (!contexts.has(this)) throw new Error("OWNER_NATIVE_CONSTRUCTION");
		if (this.#automaticStopped) return;
		this.#automaticStopped = true;
		this.#sc085?.cancel(new Error("OWNER_AUTOMATIC_STOPPED"));
		this.#automaticHold.fail(new Error("OWNER_AUTOMATIC_STOPPED"));
		this.owner.stopAutomaticTurns();
	}

	spendAutomatic(): boolean {
		this.assertActive();
		if (this.#automaticStopped) return false;
		try {
			this.owner.spendAutomaticTurn();
			return true;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "OWNER_AUTOMATIC_ALLOCATION")
				throw error;
			// Native logical exhaustion leaves A active. A failed durable spend
			// instead fences A, so this check must throw rather than suppress it.
			this.owner.assertActive();
			this.stopAutomatic();
			return false;
		}
	}

	close(hooks: Parameters<SessionOwnership["close"]>[0] = {}): Promise<void> {
		if (!contexts.has(this)) throw new Error("OWNER_NATIVE_CONSTRUCTION");
		if (!this.#closing) {
			this.#stopped = this.#automaticStopped = true;
			interruptOrdinaryRequestPair(this, new Error("OWNER_PAIR_CLOSED"));
			this.#sc085?.cancel(new Error("OWNER_AUTOMATIC_CLOSED"));
			this.#automaticHold.fail(new Error("OWNER_AUTOMATIC_CLOSED"));
			this.requestProvenance.close();
			// Fence synchronously before any stop callback/await.
			this.#credential.revoke();
			let resolve!: () => void;
			let reject!: (error: unknown) => void;
			this.#closing = new Promise<void>((done, failed) => {
				resolve = done;
				reject = failed;
			});
			void this.#close(hooks).then(resolve, reject);
		}
		return this.#closing;
	}

	async #close(hooks: NonNullable<Parameters<SessionOwnership["close"]>[0]>): Promise<void> {
		const errors: unknown[] = [];
		try {
			await this.owner.close({
				...hooks,
				stop: async () => {
					// Native seal runs first. Start common cancellation and session
					// abort together; their persistence can wait for native drain.
					const results = await Promise.allSettled([
						Promise.resolve().then(() => this.#sense?.close()),
						Promise.resolve().then(() => (hooks.stop ? hooks.stop() : this.#session?.abort())),
					]);
					const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
					if (errors.length) throw new AggregateError(errors, "OWNER_STOP_FAILED");
				},
				persist: () => (hooks.persist ? hooks.persist() : this.#session?.dispose()),
			});
		} catch (error) {
			errors.push(error);
		}
		// Unknown native custody retains its deployment descriptors as well as H.
		if (this.owner.phase === "closed")
			for (const fd of this.#files.splice(0)) {
				try {
					closeSync(fd);
				} catch (error) {
					errors.push(error);
				}
			}
		this.operationalAudit.event(
			"owner",
			errors.length || this.owner.phase !== "closed" ? "retirement-unknown" : "original-owner-retired",
		);
		for (const unsubscribe of this.#auditSubscriptions.splice(0)) unsubscribe();
		this.operationalAudit.close(errors.length === 0 && this.owner.phase === "closed");
		if (errors.length === 1) throw errors[0];
		if (errors.length) throw new AggregateError(errors, "OWNER_RECEIVING_CLOSE_FAILED");
	}
}

export function assertOrdinaryOwner(context: OrdinaryOwnerContext): void {
	if (!contexts.has(context)) throw new Error("OWNER_PROFILE_UNAVAILABLE: no received ordinary owner");
	context.assertActive();
}

/** Absence still takes the existing refusal, before any supplied factory. */
export function assertOrdinaryRuntime(
	manager: SessionManager,
	context?: OrdinaryOwnerContext,
	factory?: CreateAgentSessionRuntimeFactory,
): void {
	if (!context) {
		if (factory && factories.has(factory)) throw new Error("OWNER_RUNTIME_OWNERSHIP");
		assertUnownedSessionManager(manager);
		if (currentSessionOwnership()) throw new Error("OWNER_RUNTIME_OWNERSHIP");
		return;
	}
	assertOrdinaryOwner(context);
	const ambient = currentSessionOwnership();
	if (
		(ambient && ambient !== context.owner) ||
		context.owner.manager !== manager ||
		ownershipOf(manager) !== context.owner ||
		(factory && factories.get(factory) !== context)
	) {
		throw new Error("OWNER_RUNTIME_OWNERSHIP");
	}
}

/** Trusted bootstrap only: no settings, auth, package discovery or extension code.
 * The descriptor-held record is not authority by existence: its independent
 * receiving bytes, exact deployment artifacts and observed principal must match. */
export async function receiveOrdinaryOwner(
	profilePath: string,
	applicationPath: string,
	sc085?: Sc085OriginalReceiving,
): Promise<OrdinaryOwnerContext> {
	const files: number[] = [];
	let host: OwnerHost | undefined;
	let owner: SessionOwnership | undefined;
	let context: OrdinaryOwnerContext | undefined;
	try {
		if (sc085) enterSc085OriginalReceiving(sc085, profilePath, applicationPath);
		const directory = openSync(
			dirname(profilePath),
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		files.push(directory);
		const heldDirectory = fstatSync(directory);
		if (heldDirectory.uid !== 0 || heldDirectory.mode & 0o022) throw new Error("OWNER_RELEASE_PARENT");
		const profileFile = openReleaseFile(profilePath, 65_536, directory);
		files.push(profileFile.fd);
		const profile = parseOwnerHostProfile(profileFile.bytes);
		const recordFile = openReleaseFile(join(dirname(profilePath), "ordinary-owner.json"), 65_536, directory);
		files.push(recordFile.fd);
		const record = parseOrdinaryOwnerRecord(recordFile.bytes);
		const receiving = openReleaseFile(record.receiving.path, 65_536);
		files.push(receiving.fd);
		const machine = openReleaseFile("/etc/machine-id", 128);
		let machineId: string;
		try {
			machineId = machine.bytes.toString("utf8").trim();
		} finally {
			closeSync(machine.fd);
		}
		const decision = produceOrdinaryPocDecision(recordFile.bytes, receiving.bytes, profile, {
			profileSha256: ownerProfileDigest(profileFile.bytes),
			applicationPath,
			machineId,
			uid: process.getuid?.() ?? -1,
			gid: process.getgid?.() ?? -1,
			now: Date.now(),
		});
		let countSemantics: Readonly<CountSemantics> | undefined;
		if (record.provider.count) {
			const artifact = record.provider.count.semantics;
			const file = openReleaseFile(artifact.path, 65_536);
			files.push(file.fd);
			if (createHash("sha256").update(file.bytes).digest("hex") !== artifact.sha256)
				throw new Error("OWNER_COUNT_SEMANTICS_HASH");
			countSemantics = parseCountSemantics(file.bytes, record);
		}
		for (const artifact of [record.package, record.application, record.sense]) {
			const file = openReleaseFile(artifact.path, 268_435_456);
			files.push(file.fd);
			if (createHash("sha256").update(file.bytes).digest("hex") !== artifact.sha256)
				throw new Error("OWNER_ARTIFACT_HASH");
		}
		host = OwnerHost.loadNative(profilePath);
		if (
			ownerProfileDigest(Buffer.from(`${JSON.stringify(host.profile, null, 2)}\n`)) !== decision.record.profileSha256
		) {
			throw new Error("OWNER_DECISION_PROFILE_CHANGED");
		}
		owner = SessionOwnership.createAllocated(host, record.roots.W.path, decision.allocation);
		owner.activate(owner.admit(decision.policy));
		context = new OrdinaryOwnerContext(
			constructionKey,
			owner,
			decision,
			profilePath,
			applicationPath,
			files,
			countSemantics,
			sc085,
		);
		if (sc085) bindSc085OriginalChild(sc085, context);
		return context;
	} catch (error) {
		// Failed creation/admission can retain native custody. Never report a clean
		// release, hide host.close refusal, or install another host as a fallback.
		const errors: unknown[] = [error];
		if (context) {
			try {
				await context.close();
			} catch (cleanup) {
				errors.push(cleanup);
			}
		} else if (owner) {
			try {
				await owner.close();
			} catch (cleanup) {
				errors.push(cleanup);
			}
		}
		if (host) {
			try {
				host.close();
			} catch (cleanup) {
				errors.push(cleanup);
			}
		}
		// context.close consumes its files only after known native retirement.
		// Unknown custody retains those descriptors, including on B failure.
		if (!context && (!owner || owner.phase === "closed"))
			for (const fd of files) {
				try {
					closeSync(fd);
				} catch (cleanup) {
					errors.push(cleanup);
				}
			}
		if (errors.length > 1) throw new AggregateError(errors, "OWNER_RECEIVING_FAILED");
		throw error;
	}
}
