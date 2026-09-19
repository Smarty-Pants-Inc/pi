import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, parse, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import {
	assertOrdinaryRuntime,
	bindOrdinaryOptions,
	type OrdinaryOwnerContext,
	ordinaryOwnerForFactory,
	ordinaryOwnerOf,
} from "./ordinary-owner-context.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { assertUnownedSessionManager, SessionManager } from "./session-manager.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

interface OutgoingSession {
	session: AgentSession;
	sessionManager: SessionManager;
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods tear down the current runtime first, then create
 * and apply the next runtime. If creation fails, the error is propagated to the
 * caller. The caller is responsible for user-facing error handling.
 */
export class AgentSessionRuntime {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;
	readonly #owner?: OrdinaryOwnerContext;
	#ownerDisposal?: Promise<void>;

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
	) {
		const owner = ordinaryOwnerForFactory(createRuntime);
		assertOrdinaryRuntime(_session.sessionManager, owner, createRuntime);
		owner?.assertServices(_services);
		owner?.assertSessionStart(_session);
		this.#owner = owner;
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	#captureOutgoing(allowOwned = false): OutgoingSession {
		if (this.#owner && !allowOwned)
			throw new Error("OWNER_FRESH_ALLOCATION_REQUIRED: replacement requires separate receiving");
		const session = this.session;
		const sessionManager = session.sessionManager;
		assertOrdinaryRuntime(sessionManager, this.#owner, this.createRuntime);
		this.#owner?.assertSessionStart(session);
		return { session, sessionManager };
	}

	#assertIdentity(outgoing: OutgoingSession): void {
		if (this.session !== outgoing.session || outgoing.session.sessionManager !== outgoing.sessionManager) {
			throw new Error("OWNER_RUNTIME_SESSION_CHANGED");
		}
	}

	#assertCurrent(outgoing: OutgoingSession): void {
		this.#assertIdentity(outgoing);
		assertOrdinaryRuntime(outgoing.sessionManager, this.#owner, this.createRuntime);
	}

	private async emitBeforeSwitch(
		outgoing: OutgoingSession,
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = outgoing.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		outgoing: OutgoingSession,
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = outgoing.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async teardownCurrent(
		outgoing: OutgoingSession,
		reason: SessionShutdownEvent["reason"],
		targetSessionFile?: string,
	): Promise<void> {
		// Settle any active response first so the aborted turn (including tool
		// results) is persisted to the outgoing session before it is replaced.
		this.#assertCurrent(outgoing);
		await outgoing.session.abort();
		this.#assertCurrent(outgoing);
		await emitSessionShutdownEvent(outgoing.session.extensionRunner, {
			type: "session_shutdown",
			reason,
			targetSessionFile,
		});
		this.#assertCurrent(outgoing);
		this.beforeSessionInvalidate?.();
		this.#assertCurrent(outgoing);
		outgoing.session.dispose();
	}

	async #replace(outgoing: OutgoingSession, options: Parameters<CreateAgentSessionRuntimeFactory>[0]): Promise<void> {
		this.#assertCurrent(outgoing);
		assertUnownedSessionManager(options.sessionManager);
		const { session, services, diagnostics, modelFallbackMessage } = await this.createRuntime(Object.freeze(options));
		this.#assertCurrent(outgoing);
		assertUnownedSessionManager(session.sessionManager);
		this._session = session;
		this._services = services;
		this._diagnostics = diagnostics;
		this._modelFallbackMessage = modelFallbackMessage;
	}

	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		const outgoing = this.#captureOutgoing();
		if (this.rebindSession) {
			await this.rebindSession(outgoing.session);
			this.#assertCurrent(outgoing);
		}
		if (withSession) {
			await withSession(outgoing.session.createReplacedSessionContext());
			this.#assertCurrent(outgoing);
		}
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		const outgoing = this.#captureOutgoing();
		const beforeResult = await this.emitBeforeSwitch(outgoing, "resume", sessionPath);
		this.#assertCurrent(outgoing);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = outgoing.session.sessionFile;
		const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.teardownCurrent(outgoing, "resume", sessionManager.getSessionFile());
		this.#assertCurrent(outgoing);
		await this.#replace(outgoing, {
			cwd: sessionManager.getCwd(),
			agentDir: this.services.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
		});
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const outgoing = this.#captureOutgoing();
		const beforeResult = await this.emitBeforeSwitch(outgoing, "new");
		this.#assertCurrent(outgoing);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = outgoing.session.sessionFile;
		const sessionDir = outgoing.sessionManager.getSessionDir();
		const sessionManager = outgoing.sessionManager.isPersisted()
			? SessionManager.create(this.cwd, sessionDir)
			: SessionManager.inMemory(this.cwd);
		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		await this.teardownCurrent(outgoing, "new", sessionManager.getSessionFile());
		this.#assertCurrent(outgoing);
		await this.#replace(outgoing, {
			cwd: this.cwd,
			agentDir: this.services.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
		});
		if (options?.setup) {
			const replacement = this.#captureOutgoing();
			await options.setup(replacement.sessionManager);
			this.#assertCurrent(replacement);
			replacement.session.agent.state.messages = replacement.sessionManager.buildSessionContext().messages;
		}
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const outgoing = this.#captureOutgoing();
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(outgoing, entryId, { position });
		this.#assertCurrent(outgoing);
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = outgoing.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = outgoing.session.sessionFile;
		if (outgoing.sessionManager.isPersisted()) {
			const currentSessionFile = outgoing.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = outgoing.sessionManager.getSessionDir();
			if (!targetLeafId) {
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				sessionManager.newSession({ parentSession: currentSessionFile });
				await this.teardownCurrent(outgoing, "fork", sessionManager.getSessionFile());
				this.#assertCurrent(outgoing);
				await this.#replace(outgoing, {
					cwd: this.cwd,
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				});
				await this.finishSessionReplacement(options?.withSession);
				return { cancelled: false, selectedText };
			}

			if (!existsSync(currentSessionFile)) {
				throw new Error(
					"This session has not been saved yet. Wait for the first assistant response before cloning or forking it.",
				);
			}
			const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
			const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			await this.teardownCurrent(outgoing, "fork", sessionManager.getSessionFile());
			this.#assertCurrent(outgoing);
			await this.#replace(outgoing, {
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
			});
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false, selectedText };
		}

		const sessionManager = outgoing.sessionManager;
		await this.teardownCurrent(outgoing, "fork", sessionManager.getSessionFile());
		this.#assertCurrent(outgoing);
		if (!targetLeafId) {
			sessionManager.newSession({ parentSession: previousSessionFile });
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
		await this.#replace(outgoing, {
			cwd: this.cwd,
			agentDir: this.services.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
		});
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const outgoing = this.#captureOutgoing();
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const sessionDir = outgoing.sessionManager.getSessionDir();
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		let destinationPath = join(sessionDir, basename(resolvedPath));
		const sourceAlreadyStored = resolve(destinationPath) === resolvedPath;
		if (!sourceAlreadyStored) {
			const { name, ext } = parse(destinationPath);
			let suffix = 1;
			while (existsSync(destinationPath)) {
				destinationPath = join(sessionDir, `${name}-${suffix++}${ext}`);
			}
		}
		const beforeResult = await this.emitBeforeSwitch(outgoing, "resume", destinationPath);
		this.#assertCurrent(outgoing);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = outgoing.session.sessionFile;
		if (!sourceAlreadyStored) {
			copyFileSync(resolvedPath, destinationPath, constants.COPYFILE_EXCL);
		}

		const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.teardownCurrent(outgoing, "resume", sessionManager.getSessionFile());
		this.#assertCurrent(outgoing);
		await this.#replace(outgoing, {
			cwd: sessionManager.getCwd(),
			agentDir: this.services.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
		});
		await this.finishSessionReplacement();
		return { cancelled: false };
	}

	async dispose(): Promise<void> {
		if (this.#ownerDisposal) return this.#ownerDisposal;
		const outgoing = this.#captureOutgoing(true);
		if (this.#owner) {
			// Publish the shared task before invoking close callbacks. Sealed-owner
			// terminal persistence checks identity, not active-owner permission.
			let resolve!: () => void;
			let reject!: (cause: unknown) => void;
			this.#ownerDisposal = new Promise<void>((done, failed) => {
				resolve = done;
				reject = failed;
			});
			try {
				void this.#owner
					.close({
						stop: () => {
							this.#assertIdentity(outgoing);
							return outgoing.session.abort();
						},
						persist: async () => {
							this.#assertIdentity(outgoing);
							await emitSessionShutdownEvent(outgoing.session.extensionRunner, {
								type: "session_shutdown",
								reason: "quit",
							});
							this.#assertIdentity(outgoing);
							this.beforeSessionInvalidate?.();
							this.#assertIdentity(outgoing);
							outgoing.session.dispose();
						},
					})
					.then(resolve, reject);
			} catch (cause) {
				reject(cause);
			}
			return this.#ownerDisposal;
		}
		await emitSessionShutdownEvent(outgoing.session.extensionRunner, {
			type: "session_shutdown",
			reason: "quit",
		});
		this.#assertCurrent(outgoing);
		this.beforeSessionInvalidate?.();
		this.#assertCurrent(outgoing);
		outgoing.session.dispose();
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	const owner = ordinaryOwnerOf(options);
	const sessionManager = options.sessionManager;
	assertOrdinaryRuntime(sessionManager, owner, createRuntime);
	const { cwd, agentDir, sessionStartEvent } = options;
	const retained = Object.freeze({ cwd, agentDir, sessionStartEvent, sessionManager });
	assertSessionCwdExists(sessionManager, retained.cwd);
	const { session, services, diagnostics, modelFallbackMessage } = await (owner
		? owner.within(() => createRuntime(bindOrdinaryOptions(retained, owner)))
		: createRuntime(retained));
	assertOrdinaryRuntime(session.sessionManager, owner, createRuntime);
	return new AgentSessionRuntime(session, services, createRuntime, diagnostics, modelFallbackMessage);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
