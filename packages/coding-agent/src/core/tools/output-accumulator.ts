import type { WriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { createOutputFileStream } from "../../utils/output-files.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

// ponytail: match Fabric's 8 MiB shell log cap; preserve a useful head and tail, not an unbounded file.
export const MAX_FULL_OUTPUT_FILE_BYTES = 8 * 1024 * 1024;
const FULL_OUTPUT_HALF_BYTES = MAX_FULL_OUTPUT_FILE_BYTES / 2;

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
	totalRawBytes: number;
	fullOutputTruncated: boolean;
}

export interface FullOutput {
	content: string;
	/** Whether `content` omits part of the output. */
	truncated: boolean;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
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
	private tempFileCompletion: Promise<Error | undefined> | undefined;
	private fileHeadBytes = 0;
	private fileTail: Buffer | undefined;
	private fileTailBytes = 0;
	private fileTailOffset = 0;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.tempFileStream || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.appendToTempFile(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
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
		this.flushFileTail();
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

		return {
			content: truncation.content,
			truncation,
			fullOutputPath: this.tempFilePath,
			totalRawBytes: this.totalRawBytes,
			fullOutputTruncated: this.tempFilePath !== undefined && this.totalRawBytes > MAX_FULL_OUTPUT_FILE_BYTES,
		};
	}

	async closeTempFile(): Promise<void> {
		if (!this.tempFileStream) {
			return;
		}

		const stream = this.tempFileStream;
		this.tempFileStream = undefined;

		stream.end();
		const error = await this.tempFileCompletion;
		if (error) throw error;
	}

	/**
	 * The saved output, for callers that can take more than the display snapshot. Call after
	 * `finish()` and `closeTempFile()`. The file itself is capped at MAX_FULL_OUTPUT_FILE_BYTES;
	 * this reader keeps its first and last `maxBytes / 2` bytes if it exceeds the caller's limit.
	 */
	async readFullOutput(maxBytes: number): Promise<FullOutput> {
		if (!this.tempFilePath) {
			return { content: new TextDecoder().decode(Buffer.concat(this.rawChunks)), truncated: false };
		}
		const file = await open(this.tempFilePath, "r");
		try {
			const size = (await file.stat()).size;
			if (size <= maxBytes) {
				return {
					content: new TextDecoder().decode(await file.readFile()),
					truncated: this.totalRawBytes > MAX_FULL_OUTPUT_FILE_BYTES,
				};
			}
			// A near-cap budget must not sample the saved omission marker as original output.
			const readBytes = Math.min(maxBytes, MAX_FULL_OUTPUT_FILE_BYTES);
			const headBytes = Math.floor(readBytes / 2);
			const tailBytes = readBytes - headBytes;
			const head = Buffer.alloc(headBytes);
			const tail = Buffer.alloc(tailBytes);
			await file.read(head, 0, headBytes, 0);
			await file.read(tail, 0, tailBytes, size - tailBytes);
			// Cut at character boundaries: streaming decode holds back an incomplete trailing sequence,
			// and the tail skips leading continuation bytes.
			const headText = new TextDecoder().decode(head, { stream: true });
			let tailStart = 0;
			while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart++;
			const tailText = new TextDecoder().decode(tail.subarray(tailStart));
			const omitted = this.totalRawBytes - headBytes - tailBytes;
			return { content: `${headText}\n\n[... ${omitted} bytes omitted ...]\n\n${tailText}`, truncated: true };
		} finally {
			await file.close();
		}
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
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private appendToTempFile(data: Buffer): void {
		const headBytes = Math.min(data.length, FULL_OUTPUT_HALF_BYTES - this.fileHeadBytes);
		if (headBytes > 0) {
			this.tempFileStream?.write(data.subarray(0, headBytes));
			this.fileHeadBytes += headBytes;
		}
		const rest = data.subarray(headBytes);
		if (rest.length === 0) return;
		this.fileTail ??= Buffer.allocUnsafe(FULL_OUTPUT_HALF_BYTES);
		if (rest.length >= FULL_OUTPUT_HALF_BYTES) {
			rest.copy(this.fileTail, 0, rest.length - FULL_OUTPUT_HALF_BYTES);
			this.fileTailOffset = 0;
			this.fileTailBytes = FULL_OUTPUT_HALF_BYTES;
			return;
		}
		const firstBytes = Math.min(rest.length, FULL_OUTPUT_HALF_BYTES - this.fileTailOffset);
		rest.copy(this.fileTail, this.fileTailOffset, 0, firstBytes);
		rest.copy(this.fileTail, 0, firstBytes);
		this.fileTailOffset = (this.fileTailOffset + rest.length) % FULL_OUTPUT_HALF_BYTES;
		this.fileTailBytes = Math.min(FULL_OUTPUT_HALF_BYTES, this.fileTailBytes + rest.length);
	}

	private flushFileTail(): void {
		if (!this.tempFileStream || !this.fileTail || this.fileTailBytes === 0) return;
		if (this.totalRawBytes > MAX_FULL_OUTPUT_FILE_BYTES) {
			const omitted = this.totalRawBytes - MAX_FULL_OUTPUT_FILE_BYTES;
			// Retain raw bytes even if a UTF-8 character straddles a cut; the marker stays on its own line.
			this.tempFileStream.write(`\n[... ${omitted} bytes omitted; total ${this.totalRawBytes} bytes ...]\n`);
		}
		const start = this.fileTailBytes === FULL_OUTPUT_HALF_BYTES ? this.fileTailOffset : 0;
		const firstBytes = Math.min(this.fileTailBytes, FULL_OUTPUT_HALF_BYTES - start);
		this.tempFileStream.write(this.fileTail.subarray(start, start + firstBytes));
		if (firstBytes < this.fileTailBytes) {
			this.tempFileStream.write(this.fileTail.subarray(0, this.fileTailBytes - firstBytes));
		}
		this.fileTail = undefined;
		this.fileTailBytes = 0;
	}

	private ensureTempFile(): void {
		if (this.tempFilePath) {
			return;
		}
		const { path, stream } = createOutputFileStream(this.tempFilePrefix, ".log");
		this.tempFilePath = path;
		this.tempFileStream = stream;
		// Capture even early open errors, then report them when the caller closes the file.
		this.tempFileCompletion = finished(this.tempFileStream).then(
			() => undefined,
			(error: Error) => error,
		);
		for (const chunk of this.rawChunks) {
			this.appendToTempFile(chunk);
		}
		this.rawChunks = [];
		if (this.finished) this.flushFileTail();
	}
}
