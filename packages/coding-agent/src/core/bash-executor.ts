/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { splitIncompleteAnsiSuffix, stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import { appendErrorNotice, type BashOperations } from "./tools/bash.ts";
import { type FullOutputTruncation, OutputAccumulator } from "./tools/output-accumulator.ts";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
	/** Present only when the full-output log omits part of the output. */
	fullOutputTruncation?: FullOutputTruncation;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	// The accumulator receives sanitized text, so its display tail and its capped log both hold
	// the sanitized output, as before.
	const output = new OutputAccumulator({ tempFilePrefix: "pi-bash" });

	const decoder = new TextDecoder();
	// Unfinished escape sequence at the end of the previous chunk, completed by the next chunk.
	let pendingAnsi = "";

	const appendText = (rawText: string) => {
		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		const text = sanitizeBinaryOutput(stripAnsi(rawText)).replace(/\r/g, "");
		if (!text) return;
		output.append(Buffer.from(text, "utf-8"));
		options?.onChunk?.(text);
	};

	const onData = (data: Buffer) => {
		const { complete, pending } = splitIncompleteAnsiSuffix(pendingAnsi + decoder.decode(data, { stream: true }));
		pendingAnsi = pending;
		appendText(complete);
	};

	let bashResult: BashResult | undefined;
	let execError: { error: unknown } | undefined;
	let tempFileError: unknown;
	try {
		let exitCode: number | null = null;
		try {
			({ exitCode } = await operations.exec(command, cwd, { onData, signal: options?.signal }));
		} catch (error) {
			// An aborted command still returns the output it produced so far. Other errors are rethrown
			// after the log is closed, carrying the cap notice when the log omits output.
			if (!options?.signal?.aborted) execError = { error };
		}
		const rest = pendingAnsi + decoder.decode();
		pendingAnsi = "";
		appendText(rest);
		output.finish();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		const cancelled = options?.signal?.aborted ?? false;
		let text = snapshot.content;
		const logTruncation = snapshot.fullOutputTruncation;
		let notice: string | undefined;
		if (logTruncation && snapshot.fullOutputPath) {
			// Session and RPC copies keep only the output text, so the notice must live in it.
			notice = `[Output log capped: ${logTruncation.omittedBytes} of ${logTruncation.totalBytes} bytes omitted from ${snapshot.fullOutputPath}]`;
			text += `\n\n${notice}`;
		}
		if (execError) {
			if (notice) execError.error = appendErrorNotice(execError.error, notice);
		} else {
			bashResult = {
				output: text,
				exitCode: cancelled ? undefined : (exitCode ?? undefined),
				cancelled,
				truncated: snapshot.truncation.truncated,
				fullOutputPath: snapshot.fullOutputPath,
				...(notice && logTruncation ? { fullOutputTruncation: logTruncation } : {}),
			};
		}
	} finally {
		// Always flush and close the log, also after errors and cancellation.
		try {
			await output.closeTempFile();
		} catch (error) {
			tempFileError = error;
		}
	}
	// The command's own failure outranks a later log close failure.
	if (execError) throw execError.error;
	if (tempFileError) throw tempFileError;
	if (!bashResult) throw new Error("Bash execution produced no result");
	// An abort can arrive while the full-output stream is being flushed.
	if (options?.signal?.aborted) {
		bashResult.cancelled = true;
		bashResult.exitCode = undefined;
	}
	return bashResult;
}
