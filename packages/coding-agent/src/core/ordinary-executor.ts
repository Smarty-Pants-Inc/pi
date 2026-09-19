import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { isJsonValue } from "@earendil-works/chord";
import type { createOrdinaryDefinitionPorts, OrdinarySenseScope } from "./ordinary-definitions.ts";
import { assertOrdinaryOwner, type OrdinaryOwnerContext } from "./ordinary-owner-context.ts";
import type { OrdinaryOwnerRecord } from "./ordinary-owner-policy.ts";

export interface OrdinaryExecutionRequest {
	scope: OrdinarySenseScope & { watchId?: string; generation?: number; readId?: string };
	ownerEpoch: string;
	execution: {
		source: string;
		revision: string;
		policyId: string;
		runtimeId: string;
		snapshotDir: string;
		run: readonly string[];
	};
	/** Original Core content key; required for SC085 association, not an issuer. */
	executionKey?: string;
	stateNamespace: string;
	input: Record<string, unknown>;
	sampleTime: string;
	deadline: string;
	limits: OrdinaryOwnerRecord["limits"];
	signal: AbortSignal;
}

type Outcome =
	| "OK"
	| "EMPTY"
	| "EXIT_NONZERO"
	| "TIMEOUT"
	| "OUTPUT_LIMIT"
	| "INVALID_OUTPUT"
	| "CANCELLED"
	| "UNAVAILABLE";
export interface OrdinaryExecutionResult {
	outcome: Outcome;
	body: string;
	startedAt: string;
	completedAt: string;
	diagnosticRef?: string;
}

/** Uses native process-tree/pipe custody, never the old unrestricted ProcessExecutor. */
export function createOrdinaryExecutor(
	context: OrdinaryOwnerContext,
	originalScope: OrdinarySenseScope,
	definitions: ReturnType<typeof createOrdinaryDefinitionPorts>,
) {
	assertOrdinaryOwner(context);
	const scope = Object.freeze({ ...originalScope });
	const owner = context.owner;
	const record = context.decision.record;
	const state = new Map<string, { binding: string; directory: Promise<string> }>();
	const running = new Set<string>();
	let active = 0;
	return Object.freeze({
		async retained() {
			if (active || running.size) throw new Error("OWNER_OBSERVER_NOT_SETTLED");
			return Promise.all(
				[...state.entries()].map(async ([namespace, value]) => ({
					namespace: createHash("sha256").update(namespace).digest("hex"),
					binding: value.binding,
					relativePath: await value.directory,
				})),
			);
		},
		async execute(original: OrdinaryExecutionRequest) {
			context.assertActive();
			const request = { ...original, scope: { ...original.scope } };
			const startedAt = new Date().toISOString();
			const started = performance.now();
			const approved = definitions.approval(request.execution.snapshotDir);
			if (
				request.ownerEpoch !== owner.grant ||
				Object.keys(scope).some(
					(key) => request.scope[key as keyof OrdinarySenseScope] !== scope[key as keyof OrdinarySenseScope],
				) ||
				request.execution.source !== approved.source ||
				request.execution.revision !== approved.revision ||
				request.execution.policyId !== approved.policyId ||
				request.execution.runtimeId !== approved.runtimeId ||
				JSON.stringify(request.execution.run) !== JSON.stringify(approved.run) ||
				!request.stateNamespace ||
				!isJsonValue(request.input) ||
				Object.keys(record.limits).some(
					(key) =>
						request.limits[key as keyof OrdinaryOwnerRecord["limits"]] !==
						record.limits[key as keyof OrdinaryOwnerRecord["limits"]],
				)
			) {
				throw new Error("OWNER_OBSERVER_REQUEST");
			}
			const temporary = request.scope.readId !== undefined;
			if (
				temporary
					? typeof request.scope.readId !== "string" ||
						!request.scope.readId ||
						request.scope.watchId !== undefined ||
						request.scope.generation !== undefined
					: typeof request.scope.watchId !== "string" ||
						!request.scope.watchId ||
						!Number.isSafeInteger(request.scope.generation) ||
						request.scope.generation! < 1
			) {
				throw new Error("OWNER_OBSERVER_SCOPE");
			}
			const input = Buffer.from(JSON.stringify(request.input));
			const namespace = request.stateNamespace;
			const binding = createHash("sha256")
				.update(JSON.stringify({ scope: request.scope, execution: approved, input: request.input }))
				.digest("hex");
			if (input.length > record.limits.maxInputBytes) throw new Error("OWNER_OBSERVER_LIMIT");
			request.signal.throwIfAborted();
			const stop = new AbortController();
			const signal = AbortSignal.any([request.signal, stop.signal]);
			const remaining = Math.min(
				record.limits.timeoutMs,
				Date.parse(request.deadline) - Date.now(),
				record.admission.allocation.expiresMs - Date.now(),
			);
			context.assertActive();
			if (active >= record.limits.maxConcurrent || running.has(namespace)) throw new Error("OWNER_OBSERVER_LIMIT");
			const diagnostic = context.operationalAudit.beginDiagnostic(original);
			const retainSetupExecution = context.operationalAudit.beginSetupExecution(original);
			active++;
			running.add(namespace);
			let outcome: Outcome = "UNAVAILABLE";
			let body = "";
			let statePath: string | undefined;
			let output = Buffer.alloc(0);
			let outputLimited = false;
			let stderrBytes = 0;
			let stderr = Buffer.alloc(0);
			let processJoined = false;
			let stderrComplete = true;
			let diagnosticRef: string | undefined;
			let timedOut = false;
			const timer = setTimeout(
				() => {
					timedOut = true;
					stop.abort();
				},
				Number.isFinite(remaining) ? Math.max(0, remaining) : 0,
			);
			const guard = () => {
				context.assertActive();
				if (!Number.isFinite(remaining) || performance.now() - started >= remaining) {
					timedOut = true;
					stop.abort();
				}
				signal.throwIfAborted();
			};
			try {
				guard();
				let retained = state.get(namespace);
				if (retained && retained.binding !== binding) throw new Error("OWNER_OBSERVER_STATE_SCOPE");
				if (!retained) {
					if (state.size >= owner.host.profile.limits.inodes) throw new Error("OWNER_OBSERVER_STATE_LIMIT");
					const key = createHash("sha256").update(namespace).digest("hex");
					const directory = owner.effect({ kind: "write", root: context.decision.roots.T }, (effect) =>
						effect.createSnapshot(`ordinary-${owner.grant}/state`, key, []),
					);
					retained = { binding, directory };
					state.set(namespace, retained);
				}
				statePath = await retained.directory;
				guard();
				const capture = await definitions.options.io.readClosure(approved.snapshotDir, definitions.options.limits);
				if (capture.revision !== approved.revision) throw new Error("OWNER_SNAPSHOT_REVISION");
				guard();
				const stateDir = join(record.roots.T.path, statePath);
				const observationContext = JSON.stringify({
					protocol: 1,
					scope: request.scope,
					workspaceDir: scope.workspaceDir,
					stateDir,
					sampleTime: request.sampleTime,
					deadline: request.deadline,
				});
				const result = await owner.runProcess(
					{
						command: record.bun.path,
						argv0: basename(record.bun.path),
						args: ["--no-install", "--no-env-file", ...approved.run.slice(1)],
						cwd: approved.snapshotDir,
						environment: [...record.environment, `SMARTY_SENSE_CONTEXT=${observationContext}`],
						roots: [],
						readOnly: false,
						mounts: [
							{ root: context.decision.roots.W, relativePath: "", access: "read-only" },
							{ root: context.decision.roots.R, relativePath: "", access: "read-only" },
							{
								root: context.decision.roots.T,
								relativePath: approved.snapshotDir.slice(record.roots.T.path.length + 1),
								access: "read-only",
							},
							{ root: context.decision.roots.T, relativePath: statePath, access: "read-write" },
						],
					},
					{
						signal,
						stdin: input,
						timeoutMs: Math.max(1, Math.floor(remaining - (performance.now() - started))),
						capture: false,
						onData(stream, bytes) {
							if (stream === "stderr") {
								stderrBytes += bytes.length;
								if (stderrBytes > record.limits.maxStderrBytes) {
									stderrComplete = false;
									stderr = Buffer.alloc(0);
									outputLimited = true;
									stop.abort();
								} else if (stderrComplete) stderr = Buffer.concat([stderr, bytes]);
								return;
							}
							output = Buffer.concat([
								output,
								bytes.subarray(0, Math.max(0, record.limits.maxBodyBytes + 1 - output.length)),
							]);
							if (output.length > record.limits.maxBodyBytes) {
								outputLimited = true;
								stop.abort();
							}
						},
					},
				);
				processJoined = true; // runProcess fulfills only after native subtree/pipe/effect retirement.
				context.assertActive();
				if (outputLimited) outcome = "OUTPUT_LIMIT";
				else if (result.code !== 0) outcome = "EXIT_NONZERO";
				else {
					try {
						body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
							.decode(output)
							.replace(/\r\n/g, "\n")
							.replace(/\n+$/, "");
						if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(body)) {
							outcome = "INVALID_OUTPUT";
							body = "";
						} else outcome = body.length ? "OK" : "EMPTY";
					} catch {
						outcome = "INVALID_OUTPUT";
						body = "";
					}
				}
			} catch (error) {
				// runProcess rejection is a sample outcome only after real native
				// settlement. Unknown subtree/pipe/file custody must remain visible.
				if (owner.phase !== "active") throw error;
				outcome = outputLimited
					? "OUTPUT_LIMIT"
					: timedOut
						? "TIMEOUT"
						: request.signal.aborted
							? "CANCELLED"
							: "UNAVAILABLE";
				body = "";
			} finally {
				clearTimeout(timer);
				try {
					// Sealing revokes writes, including cleanup. Keep an exact terminal
					// retention record instead of reopening T or claiming deletion.
					if (temporary && statePath && owner.phase === "active") {
						const directory = statePath;
						await owner.effect({ kind: "write", root: context.decision.roots.T }, (effect) =>
							effect.removeSnapshot(directory),
						);
						state.delete(namespace);
					}
					// Outside the routine-outcome catch: recorder failure is fatal and
					// retains this invocation until its accepted sink work settles.
					if (processJoined && stderrComplete && stderr.length && !signal.aborted && !timedOut) {
						context.assertActive();
						diagnosticRef = await diagnostic(stderr);
					}
				} finally {
					active--;
					running.delete(namespace);
				}
			}
			context.assertActive();
			const result: OrdinaryExecutionResult = {
				outcome,
				body,
				startedAt,
				completedAt: new Date().toISOString(),
				...(diagnosticRef === undefined ? {} : { diagnosticRef }),
			};
			retainSetupExecution(result);
			return result;
		},
	});
}
