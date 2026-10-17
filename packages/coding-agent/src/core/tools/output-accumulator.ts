import type { WriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { createOutputFileStream } from "../../utils/output-files.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

// ponytail: match Fabric's 8 MiB shell log cap; preserve a useful head and tail, not an unbounded file.
export const MAX_FULL_OUTPUT_FILE_BYTES = 8 * 1024 * 1024;

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
	/** Raw bytes of the start of the output kept in the full-output log. Defaults to {@link FULL_OUTPUT_HEAD_BYTES}. */
	fullOutputHeadBytes?: number;
	/** Raw bytes of the end of the output kept in the full-output log. Defaults to {@link FULL_OUTPUT_TAIL_BYTES}. */
	fullOutputTailBytes?: number;
}

/** Default raw bytes of the start of the output kept in the full-output log. */
export const FULL_OUTPUT_HEAD_BYTES = 4 * 1024 * 1024;
/** Default raw bytes of the end of the output kept in the full-output log. */
export const FULL_OUTPUT_TAIL_BYTES = 4 * 1024 * 1024;

export interface FullOutputTruncation {
	/** Raw bytes the command produced. */
	totalBytes: number;
	/** Raw bytes left out of the full-output log between its head and tail. */
	omittedBytes: number;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
	/** Raw bytes produced by the command. */
	totalRawBytes: number;
	/** Whether the full-output log omitted bytes because it exceeded its raw-byte cap. */
	fullOutputTruncated: boolean;
	/** Present only when the full-output log omits part of the output. */
	fullOutputTruncation?: FullOutputTruncation;
	/**
	 * Error message when the full-output log failed, with the log's pathname replaced by
	 * `[output log]`. The log is then unavailable:
	 * `fullOutputPath` and `fullOutputTruncation` are absent.
	 */
	fullOutputError?: string;
}

export interface FullOutput {
	content: string;
	/** Whether `content` omits part of the output. */
	truncated: boolean;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/** Length of the longest prefix of `bytes` that does not end inside a UTF-8 sequence. */
function completeUtf8Length(bytes: Uint8Array): number {
	let lead = bytes.length - 1;
	while (lead >= 0 && bytes.length - lead < 4 && (bytes[lead] & 0xc0) === 0x80) lead--;
	if (lead < 0) return bytes.length;
	const byte = bytes[lead];
	const needed = byte >= 0xf8 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
	return bytes.length - lead < needed ? lead : bytes.length;
}

/** Continuation bytes (at most 3) at the start of `bytes`, left from a character cut before it. */
function leadingContinuationBytes(bytes: Uint8Array): number {
	let count = 0;
	while (count < bytes.length && count < 3 && (bytes[count] & 0xc0) === 0x80) count++;
	return count;
}

/**
 * Decode a head and a tail cut from a larger byte sequence. Partial characters at the cuts are
 * dropped instead of becoming U+FFFD, and the marker counts every original byte not in the result.
 */
function joinHeadAndTail(head: Uint8Array, tail: Uint8Array, totalBytes: number): string {
	const headEnd = completeUtf8Length(head);
	const tailStart = leadingContinuationBytes(tail);
	const omitted = totalBytes - headEnd - (tail.length - tailStart);
	const headText = new TextDecoder().decode(head.subarray(0, headEnd));
	const tailText = new TextDecoder().decode(tail.subarray(tailStart));
	return `${headText}\n\n[... ${omitted} bytes omitted ...]\n\n${tailText}`;
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new RangeError(`${name} must be a positive integer, got ${value}`);
	}
	return value;
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved. The temp file is capped: it streams the first
 * `fullOutputHeadBytes` raw bytes, keeps the last `fullOutputTailBytes` in
 * memory, and writes them on close after a marker naming the omitted byte
 * count. Output that fits both is written byte-identically.
 *
 * A failed log is not fatal: the error message, with the log's pathname
 * replaced by `[output log]`, is recorded in `fullOutputError`, the log's
 * buffers are released, and {@link readFullOutput} falls back to the decoded
 * display tail.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly headCap: number;
	private readonly tailCap: number;
	private readonly decoder = new TextDecoder();

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;
	private tempFileCompletion: Promise<void> | undefined;
	private fullOutputError: string | undefined;
	/** Raw bytes routed to the log so far (head written plus tail candidates). */
	private logRoutedBytes = 0;
	private logHead: Buffer | undefined;
	private logTail: Buffer | undefined;
	private logTailBytes = 0;
	private logTailNext = 0;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
		this.headCap = positiveInteger(options.fullOutputHeadBytes ?? FULL_OUTPUT_HEAD_BYTES, "fullOutputHeadBytes");
		this.tailCap = positiveInteger(options.fullOutputTailBytes ?? FULL_OUTPUT_TAIL_BYTES, "fullOutputTailBytes");
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.fullOutputError !== undefined) {
			// The log failed; only the decoded display tail is kept.
			return;
		}
		if (this.tempFilePath || this.shouldUseTempFile()) {
			this.ensureTempFile();
			if (this.fullOutputError === undefined) this.routeToLog(data);
		} else if (data.length > 0) {
			// Copy so a small view cannot pin a larger input buffer.
			this.rawChunks.push(Buffer.from(data));
		}
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		const fullOutputTruncation = this.getFullOutputTruncation();
		const fullOutputError = this.fullOutputError;
		return {
			content: truncation.content,
			truncation,
			fullOutputPath: fullOutputError === undefined ? this.tempFilePath : undefined,
			totalRawBytes: this.totalRawBytes,
			fullOutputTruncated: fullOutputTruncation !== undefined,
			...(fullOutputTruncation ? { fullOutputTruncation } : {}),
			...(fullOutputError !== undefined ? { fullOutputError } : {}),
		};
	}

	/**
	 * Write the kept tail and close the log. Never rejects: a log failure is recorded in the
	 * snapshot's `fullOutputError`.
	 */
	async closeTempFile(): Promise<void> {
		if (!this.tempFileStream) {
			return;
		}

		const stream = this.tempFileStream;
		this.tempFileStream = undefined;

		const truncation = this.getFullOutputTruncation();
		if (this.fullOutputError === undefined && !stream.destroyed) {
			if (this.logHead) stream.write(this.logHead.subarray(0, this.logRoutedBytes));
			if (truncation) {
				const marker =
					this.headCap === FULL_OUTPUT_HEAD_BYTES && this.tailCap === FULL_OUTPUT_TAIL_BYTES
						? `\n[... ${truncation.omittedBytes} bytes omitted; total ${truncation.totalBytes} bytes ...]\n`
						: `\n\n[... ${truncation.omittedBytes} bytes omitted from this log (output was ${truncation.totalBytes} bytes; first ${this.headCap} and last ${this.tailCap} bytes kept) ...]\n\n`;
				stream.write(marker);
			}
			if (this.logTail) {
				const start = this.logTailBytes === this.tailCap ? this.logTailNext : 0;
				stream.write(this.logTail.subarray(start, this.logTailBytes));
				if (start > 0) stream.write(this.logTail.subarray(0, start));
			}
		}
		this.logHead = undefined;
		this.logTail = undefined;
		this.logTailBytes = 0;
		stream.end();
		// The completion handler records a failure; it never rejects.
		await this.tempFileCompletion;
	}

	/**
	 * The complete output, for callers that can take more than the display snapshot. Call after
	 * `finish()` and `closeTempFile()`. Output longer than `maxBytes` raw bytes keeps its first and
	 * last `maxBytes / 2` bytes around an omission marker. When the log itself omits bytes, the
	 * result is truncated and the omitted count refers to the original raw output. Head and tail are
	 * decoded separately, so a character cut by either boundary is dropped and counted as omitted.
	 * When the log failed, the result is the decoded display tail; it is marked truncated only when
	 * that tail omits decoded bytes.
	 */
	async readFullOutput(maxBytes: number): Promise<FullOutput> {
		if (this.fullOutputError !== undefined) {
			return this.readDisplayTail(maxBytes);
		}
		if (!this.tempFilePath) {
			return { content: new TextDecoder().decode(Buffer.concat(this.rawChunks)), truncated: false };
		}
		try {
			return await this.readLog(this.tempFilePath, maxBytes);
		} catch (error) {
			this.recordLogFailure(error);
			return this.readDisplayTail(maxBytes);
		}
	}

	private async readLog(path: string, maxBytes: number): Promise<FullOutput> {
		const file = await open(path, "r");
		try {
			const size = (await file.stat()).size;
			const logTruncation = this.getFullOutputTruncation();
			if (size <= maxBytes) {
				const content = await file.readFile();
				if (!logTruncation) {
					return { content: new TextDecoder().decode(content), truncated: false };
				}
				// The log is head, marker, tail. Decode the head and tail separately so characters cut by
				// the log's own boundaries do not become U+FFFD next to the marker.
				const head = content.subarray(0, Math.min(this.headCap, size));
				const tail = content.subarray(Math.max(size - this.tailCap, head.length));
				return { content: joinHeadAndTail(head, tail, logTruncation.totalBytes), truncated: true };
			}
			let headBytes = Math.floor(maxBytes / 2);
			let tailBytes = maxBytes - headBytes;
			if (logTruncation) {
				// Read only the kept head and tail, never the log's marker.
				headBytes = Math.min(headBytes, this.headCap, size);
				tailBytes = Math.min(tailBytes, this.tailCap, size - headBytes);
			}
			const head = Buffer.alloc(headBytes);
			const tail = Buffer.alloc(tailBytes);
			await file.read(head, 0, headBytes, 0);
			await file.read(tail, 0, tailBytes, size - tailBytes);
			const totalBytes = logTruncation ? logTruncation.totalBytes : size;
			return { content: joinHeadAndTail(head, tail, totalBytes), truncated: true };
		} finally {
			await file.close();
		}
	}

	/**
	 * Fallback when the log failed: the last `maxBytes` of the decoded display tail. Truncated only
	 * when decoded bytes are omitted; the log failure alone does not lose bytes from the result.
	 */
	private readDisplayTail(maxBytes: number): FullOutput {
		const bytes = Buffer.from(this.tailText, "utf-8");
		let start = Math.max(0, bytes.length - Math.max(0, maxBytes));
		if (start > 0) start += leadingContinuationBytes(bytes.subarray(start));
		const text = bytes.subarray(start).toString("utf-8");
		const omitted = this.totalDecodedBytes - (bytes.length - start);
		const content = omitted > 0 ? `[... ${omitted} bytes omitted ...]\n\n${text}` : text;
		return { content, truncated: omitted > 0 };
	}

	/** Record the first log failure and release the log's buffers; later output is not logged. */
	private recordLogFailure(error: unknown): void {
		if (this.fullOutputError !== undefined) return;
		this.fullOutputError = this.describeLogFailure(error);
		this.rawChunks = [];
		this.logHead = undefined;
		this.logTail = undefined;
		this.logTailBytes = 0;
		this.logTailNext = 0;
		const stream = this.tempFileStream;
		if (stream && !stream.destroyed) stream.destroy();
	}

	/**
	 * The failure message with every known log pathname replaced by `[output log]`. Builds a new
	 * string; the error object, its message, path and code are left unchanged.
	 */
	private describeLogFailure(error: unknown): string {
		const paths = new Set<string>();
		if (this.tempFilePath) paths.add(this.tempFilePath);
		if (error instanceof Error) {
			// Native fs errors name the failed path, which can differ from the fallback temp path.
			for (const key of ["path", "dest"]) {
				const value: unknown = Reflect.get(error, key);
				if (typeof value === "string" && value.length > 0) paths.add(value);
			}
		}
		let message = error instanceof Error ? error.message : String(error);
		// Longest first, so a path that contains another is replaced whole.
		for (const path of [...paths].sort((a, b) => b.length - a.length)) {
			message = message.split(path).join("[output log]");
		}
		return message;
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes ||
			this.totalDecodedBytes > this.maxBytes ||
			this.totalLines > this.maxLines ||
			// Bound bytes and chunk metadata even when the display limits are huge.
			this.totalRawBytes > this.headCap ||
			this.rawChunks.length >= 1024
		);
	}

	private getFullOutputTruncation(): FullOutputTruncation | undefined {
		const omittedBytes = this.totalRawBytes - this.headCap - this.tailCap;
		if (!this.tempFilePath || this.fullOutputError !== undefined || omittedBytes <= 0) return undefined;
		return { totalBytes: this.totalRawBytes, omittedBytes };
	}

	/** Fixed buffers bound payload and object overhead, including millions of tiny source chunks. */
	private routeToLog(data: Buffer): void {
		if (data.length === 0) return;
		let rest = data;
		const headRoom = this.headCap - this.logRoutedBytes;
		if (headRoom > 0) {
			const head = rest.subarray(0, headRoom);
			this.logHead ??= Buffer.allocUnsafe(this.headCap);
			head.copy(this.logHead, this.logRoutedBytes);
			rest = rest.subarray(head.length);
			if (head.length === headRoom) {
				this.tempFileStream?.write(this.logHead);
				this.logHead = undefined;
			}
		}
		this.logRoutedBytes += data.length;
		if (rest.length === 0) return;
		this.logTail ??= Buffer.allocUnsafe(this.tailCap);
		if (rest.length >= this.tailCap) {
			rest.copy(this.logTail, 0, rest.length - this.tailCap);
			this.logTailBytes = this.tailCap;
			this.logTailNext = 0;
			return;
		}
		const first = Math.min(rest.length, this.tailCap - this.logTailNext);
		rest.copy(this.logTail, this.logTailNext, 0, first);
		if (first < rest.length) rest.copy(this.logTail, 0, first);
		this.logTailNext = (this.logTailNext + rest.length) % this.tailCap;
		this.logTailBytes = Math.min(this.logTailBytes + rest.length, this.tailCap);
	}

	private ensureTempFile(): void {
		if (this.tempFilePath || this.fullOutputError !== undefined) {
			return;
		}
		let created: ReturnType<typeof createOutputFileStream>;
		try {
			created = createOutputFileStream(this.tempFilePrefix, ".log");
		} catch (error) {
			// Recorded, not thrown: the caller's append or snapshot still succeeds.
			this.recordLogFailure(error);
			return;
		}
		const { path, stream } = created;
		this.tempFilePath = path;
		this.tempFileStream = stream;
		// Capture even early open errors and record them as soon as they occur.
		this.tempFileCompletion = finished(stream).then(
			() => undefined,
			(error: unknown) => this.recordLogFailure(error),
		);
		const chunks = this.rawChunks;
		this.rawChunks = [];
		for (const chunk of chunks) {
			this.routeToLog(chunk);
		}
	}
}
