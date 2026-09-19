/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { waitForChildProcess } from "../utils/child-process.ts";
import type { OwnedProcessRequest } from "./owner-effects.ts";
import { currentSessionOwnership, ownershipOf, type SessionOwnership } from "./session-ownership.ts";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/** Private host request scope, not an extension option or a permission grant. */
export type OwnedExecScope = Pick<OwnedProcessRequest, "roots" | "environment" | "readOnly">;

/** Capture the original owner during construction. Missing scope never falls
 * back to an unowned process. Native admission checks every request. */
export function createExecCommand(owner: SessionOwnership | undefined, scope?: OwnedExecScope): typeof execCommand {
	if (!owner) {
		if (scope) throw new Error("OWNER_PROCESS_SCOPE_REQUIRED");
		return execCommand;
	}
	if (ownershipOf(owner.manager) !== owner) throw new Error("OWNER_NATIVE_CONSTRUCTION");
	owner.assertActive();
	const requestScope = scope && {
		roots: [...scope.roots],
		environment: [...scope.environment],
		readOnly: scope.readOnly,
	};
	owner.assertActive();
	return async (command, args, cwd, options) => {
		owner.assertActive();
		if (!requestScope) throw new Error("OWNER_PROCESS_SCOPE_REQUIRED");
		const result = await owner.runProcess(
			{ ...requestScope, command, argv0: command, args, cwd },
			{ signal: options?.signal, timeoutMs: options?.timeout },
		);
		// Native retirement is required. Timeout or unknown custody rejects.
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			code: result.signal ? 128 + result.signal : result.code,
			killed: result.signal !== 0,
		};
	};
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	if (currentSessionOwnership()) throw new Error("OWNER_PROCESS_SCOPE_REQUIRED");
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;

		const killProcess = () => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
				// Force kill after 5 seconds if SIGTERM doesn't work
				setTimeout(() => {
					if (!proc.killed) {
						proc.kill("SIGKILL");
					}
				}, 5000);
			}
		};

		// Handle abort signal
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// Handle timeout
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcess(proc)
			.then((code) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: code ?? 0, killed });
			})
			.catch((_err) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: 1, killed });
			});
	});
}
