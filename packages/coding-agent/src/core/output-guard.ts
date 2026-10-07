import { type ChildProcess, spawn } from "node:child_process";

interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

const RAW_STDOUT_RETRY_DELAY_MS = 10;

let rawStdoutWriteTail: Promise<void> = Promise.resolve();

function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

async function writeRawStdoutChunk(text: string): Promise<void> {
	while (true) {
		try {
			await new Promise<void>((resolve, reject) => {
				try {
					getRawStdoutWrite()(text, (error) => {
						if (error) reject(error);
						else resolve();
					});
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				throw writeError;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

export function writeRawStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	rawStdoutWriteTail = rawStdoutWriteTail.then(() => writeRawStdoutChunk(text));
	void rawStdoutWriteTail.catch(() => {
		process.exit(1);
	});
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		const tail = rawStdoutWriteTail;
		await tail;
		if (tail === rawStdoutWriteTail) {
			return;
		}
	}
}

/**
 * Write final exit output without letting the stdout consumer block this process.
 * A synchronous TTY or pipe write to an unread terminal blocks the event loop forever,
 * so a child process owns the blocking write and this process only waits `timeoutMs`.
 * Returns "incomplete" when the consumer did not take all bytes in time (pi#132 R4-5).
 * One deadline covers both the queued raw stdout writes and the child delivery.
 */
export async function writeStdoutBounded(text: string, timeoutMs: number): Promise<"complete" | "incomplete"> {
	let expired = false;
	let child: ChildProcess | undefined;
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<"incomplete">((resolve) => {
		timer = setTimeout(() => {
			expired = true;
			resolve("incomplete");
		}, timeoutMs);
	});
	const deliver = async (): Promise<"complete" | "incomplete"> => {
		await waitForRawStdoutBackpressure();
		if (expired) return "incomplete";
		// ponytail: `cat` isolates the blocking write on POSIX. Windows consoles keep the direct
		// write; revisit if a Windows console can stall unread at exit.
		if (process.platform === "win32") {
			process.stdout.write(text);
			return "complete";
		}
		const copier = spawn("cat", [], { stdio: ["pipe", "inherit", "ignore"] });
		child = copier;
		return new Promise((resolve) => {
			copier.on("error", () => resolve("incomplete"));
			copier.on("close", (code) => resolve(code === 0 ? "complete" : "incomplete"));
			copier.stdin.on("error", () => resolve("incomplete"));
			copier.stdin.end(text);
		});
	};
	const result = await Promise.race([deliver(), deadline]);
	clearTimeout(timer);
	if (result === "incomplete") child?.kill("SIGKILL");
	return result;
}

export async function flushRawStdout(): Promise<void> {
	await waitForRawStdoutBackpressure();
	await writeRawStdoutChunk("");
}
