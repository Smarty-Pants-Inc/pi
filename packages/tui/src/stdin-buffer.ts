/**
 * StdinBuffer buffers input and emits complete sequences.
 *
 * This is necessary because stdin data events can arrive in partial chunks,
 * especially for escape sequences like mouse events. Without buffering,
 * partial sequences can be misinterpreted as regular keypresses.
 *
 * For example, the mouse SGR sequence `\x1b[<35;20;5m` might arrive as:
 * - Event 1: `\x1b`
 * - Event 2: `[<35`
 * - Event 3: `;20;5m`
 *
 * The buffer accumulates these until a complete sequence is detected.
 * Call the `process()` method to feed input data.
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

import { EventEmitter } from "events";

const ESC = "\x1b";
const DEFAULT_SEQUENCE_TIMEOUT_MS = 50;
const DEFAULT_ESCAPE_TIMEOUT_MS = 10;
const MAX_TERMINAL_REPLY_BYTES = 64 * 1024;
const TERMINAL_REPLY_DISCARD_MS = 500;
const INPUT_CHUNK_CHARACTERS = 4096;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
// Color and program-status OSC replies, XTVersion, and Kitty graphics replies.
// Until their header is complete, the input may be batched legacy Alt keystrokes.
const TERMINAL_REPLY_HEADER_PATTERN = /^\x1b(?:\](?:1[01];|4;\d{1,3};|7501;\?)|P>\||_G(?:[a-z]=\d+,)*[a-z]=\d+;)/;

function isControlString(data: string): boolean {
	return (
		data.startsWith(`${ESC}]`) ||
		data.startsWith(`${ESC}P`) ||
		data.startsWith(`${ESC}_`) ||
		data.startsWith(`${ESC}^`) ||
		data.startsWith(`${ESC}X`)
	);
}

/**
 * Check if a string is a complete escape sequence or needs more data
 */
function isCompleteSequence(data: string): "complete" | "incomplete" | "not-escape" {
	if (!data.startsWith(ESC)) {
		return "not-escape";
	}

	if (data.length === 1) {
		return "incomplete";
	}

	const afterEsc = data.slice(1);

	// CSI sequences: ESC [
	if (afterEsc.startsWith("[")) {
		// Check for old-style mouse sequence: ESC[M + 3 bytes
		if (afterEsc.startsWith("[M")) {
			// Old-style mouse needs ESC[M + 3 bytes = 6 total
			return data.length >= 6 ? "complete" : "incomplete";
		}
		return isCompleteCsiSequence(data);
	}

	// OSC sequences: ESC ]
	if (afterEsc.startsWith("]")) {
		return isCompleteOscSequence(data);
	}

	// DCS sequences: ESC P ... ESC \ (includes XTVersion responses)
	if (afterEsc.startsWith("P")) {
		return isCompleteDcsSequence(data);
	}

	// APC sequences: ESC _ ... ESC \ (includes Kitty graphics responses)
	if (afterEsc.startsWith("_")) {
		return isCompleteApcSequence(data);
	}

	// PM and SOS strings also end with ST (ESC \).
	if (afterEsc.startsWith("^") || afterEsc.startsWith("X")) {
		return data.endsWith(`${ESC}\\`) ? "complete" : "incomplete";
	}

	// SS3 sequences: ESC O
	if (afterEsc.startsWith("O")) {
		// ESC O followed by a single character
		return afterEsc.length >= 2 ? "complete" : "incomplete";
	}

	// Meta key sequences: ESC followed by a single character
	if (afterEsc.length === 1) {
		return "complete";
	}

	// Unknown escape sequence - treat as complete
	return "complete";
}

/**
 * Check if CSI sequence is complete
 * CSI sequences: ESC [ ... followed by a final byte (0x40-0x7E)
 */
function isCompleteCsiSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}[`)) {
		return "complete";
	}

	// Need at least ESC [ and one more character
	if (data.length < 3) {
		return "incomplete";
	}

	const payload = data.slice(2);

	// CSI sequences end with a byte in the range 0x40-0x7E (@-~)
	// This includes all letters and several special characters
	const lastChar = payload[payload.length - 1];
	const lastCharCode = lastChar.charCodeAt(0);

	if (lastCharCode >= 0x40 && lastCharCode <= 0x7e) {
		// Special handling for SGR mouse sequences
		// Format: ESC[<B;X;Ym or ESC[<B;X;YM
		if (payload.startsWith("<")) {
			// Must have format: <digits;digits;digits[Mm]
			const mouseMatch = /^<\d+;\d+;\d+[Mm]$/.test(payload);
			if (mouseMatch) {
				return "complete";
			}
			// If it ends with M or m but doesn't match the pattern, still incomplete
			if (lastChar === "M" || lastChar === "m") {
				// Check if we have the right structure
				const parts = payload.slice(1, -1).split(";");
				if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
					return "complete";
				}
			}

			return "incomplete";
		}

		return "complete";
	}

	return "incomplete";
}

/**
 * Check if OSC sequence is complete
 * OSC sequences: ESC ] ... ST (where ST is ESC \ or BEL)
 */
function isCompleteOscSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}]`)) {
		return "complete";
	}

	// OSC sequences end with ST (ESC \) or BEL (\x07)
	if (data.endsWith(`${ESC}\\`) || data.endsWith("\x07")) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Check if DCS (Device Control String) sequence is complete
 * DCS sequences: ESC P ... ST (where ST is ESC \)
 * Used for XTVersion responses like ESC P >| ... ESC \
 */
function isCompleteDcsSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}P`)) {
		return "complete";
	}

	// DCS sequences end with ST (ESC \)
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Check if APC (Application Program Command) sequence is complete
 * APC sequences: ESC _ ... ST (where ST is ESC \)
 * Used for Kitty graphics responses like ESC _ G ... ESC \
 */
function isCompleteApcSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}_`)) {
		return "complete";
	}

	// APC sequences end with ST (ESC \)
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Split accumulated buffer into complete sequences
 */
function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
	if (!match) return undefined;

	const codepoint = parseInt(match[1]!, 10);
	return codepoint >= 32 ? codepoint : undefined;
}

function extractCompleteSequences(
	buffer: string,
	scanOffset = 0,
): { sequences: string[]; remainder: string; scanOffset: number } {
	const sequences: string[] = [];
	let pos = 0;

	while (pos < buffer.length) {
		const remaining = buffer.slice(pos);

		// Try to extract a sequence starting at this position
		if (remaining.startsWith(ESC)) {
			const terminalReply = isControlString(remaining) && TERMINAL_REPLY_HEADER_PATTERN.test(remaining);
			// Find the end of this escape sequence
			// Revisit the last scanned byte: a trailing ESC needs the next byte
			// to distinguish ST from a new sequence. Earlier bytes are settled.
			let seqEnd = Math.max(1, scanOffset);
			scanOffset = 0;
			while (seqEnd <= remaining.length) {
				if (terminalReply && seqEnd > 2) {
					const char = remaining[seqEnd - 1];
					if (char === "\x18" || char === "\x1a") {
						// CAN and SUB cancel the string, not subsequent keyboard input.
						pos += seqEnd;
						break;
					}
					if (char === ESC && seqEnd < remaining.length && remaining[seqEnd] !== "\\") {
						// A new escape sequence aborts an unterminated reply. Keep a
						// trailing ESC buffered until we can distinguish it from ST.
						pos += seqEnd - 1;
						break;
					}
				}
				const candidate = remaining.slice(0, seqEnd);
				const status = isCompleteSequence(candidate);

				if (status === "complete") {
					// WezTerm with enable_kitty_keyboard sends the Escape key press as a
					// raw '\x1b' byte (simple text path in encode_kitty, ignoring
					// DISAMBIGUATE_ESCAPE_CODES) and the release as a full Kitty CSI-u
					// sequence. These arrive concatenated as '\x1b\x1b[27;...u'.
					// The buffer would normally treat '\x1b\x1b' as a complete meta-key
					// sequence (ESC + single char), leaving '[27;...u' to be typed as
					// plain text. If the character immediately following '\x1b\x1b'
					// would begin a new escape sequence, emit only the first ESC and
					// restart from the second.
					if (candidate === "\x1b\x1b") {
						const nextChar = remaining[seqEnd];
						if (
							nextChar === "[" || // CSI
							nextChar === "]" || // OSC
							nextChar === "O" || // SS3
							nextChar === "P" || // DCS
							nextChar === "_" || // APC
							nextChar === "^" || // PM
							nextChar === "X" // SOS
						) {
							sequences.push(ESC);
							pos += 1;
							break;
						}
					}
					sequences.push(candidate);
					pos += seqEnd;
					break;
				} else if (status === "incomplete") {
					seqEnd++;
				} else {
					// Should not happen when starting with ESC
					sequences.push(candidate);
					pos += seqEnd;
					break;
				}
			}

			if (seqEnd > remaining.length) {
				return { sequences, remainder: remaining, scanOffset: remaining.length };
			}
		} else {
			// Not an escape sequence - take a single character
			sequences.push(remaining[0]!);
			pos++;
		}
	}

	return { sequences, remainder: "", scanOffset: 0 };
}

export type StdinBufferOptions = {
	/**
	 * Maximum time to wait for an incomplete keyboard or mouse sequence
	 * (default: 50ms). Recognized terminal replies also use this finite deadline,
	 * then discard their tail for at most 500ms or 64 KiB, or until resynchronization.
	 * All control strings share the 64 KiB size cap and bounded tail discard.
	 * Ambiguous legacy Alt-key input below that cap still uses this timeout.
	 */
	timeout?: number;
	/**
	 * Maximum time to wait after a lone ESC before treating it as Escape
	 * (default: 10ms). Increase for high-latency Alt+key input (SSH).
	 */
	escapeTimeout?: number;
};

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

/**
 * Buffers stdin input and emits complete sequences via the 'data' event.
 * Handles partial escape sequences that arrive across multiple chunks.
 */
export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	private buffer: string = "";
	private scanOffset = 0;
	private timeout: ReturnType<typeof setTimeout> | null = null;
	private readonly timeoutMs: number;
	private readonly escapeTimeoutMs: number;
	private pasteMode: boolean = false;
	private pasteBuffer: string = "";
	private pendingKittyPrintableCodepoint: number | undefined;
	private replyDeadline = false;
	private discardTimeout: ReturnType<typeof setTimeout> | null = null;
	private discardedReply: "osc" | "other" | undefined;
	private discardWindow = false;
	private discardBytes = 0;
	private discardEscape = false;

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.timeoutMs = options.timeout ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
		this.escapeTimeoutMs = options.escapeTimeout ?? DEFAULT_ESCAPE_TIMEOUT_MS;
	}

	public process(data: string | Buffer): void {
		// Keyboard deadlines restart per event; recognized replies keep an absolute deadline.
		if (!this.replyDeadline && this.timeout !== null) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		// Handle high-byte conversion (for compatibility with parseKeypress)
		// If buffer has single byte > 127, convert to ESC + (byte - 128)
		let str: string;
		if (Buffer.isBuffer(data)) {
			if (data.length === 1 && data[0]! > 127) {
				const byte = data[0]! - 128;
				str = `\x1b${String.fromCharCode(byte)}`;
			} else {
				str = data.toString();
			}
		} else {
			str = data;
		}

		if (str.length === 0 && this.buffer.length === 0) {
			this.emitDataSequence("");
			return;
		}

		// Bound transient reply accumulation even when one data event contains a huge payload.
		for (let offset = 0; offset < str.length; offset += INPUT_CHUNK_CHARACTERS) {
			this.processChunk(str.slice(offset, offset + INPUT_CHUNK_CHARACTERS));
		}
		this.armTimeout();
	}

	private processChunk(str: string): void {
		if (this.discardedReply !== undefined) str = this.consumeDiscardedReply(str);
		if (str.length === 0) return;
		this.buffer += str;
		if (isControlString(this.buffer) && Buffer.byteLength(this.buffer) > MAX_TERMINAL_REPLY_BYTES) {
			const overflow = this.buffer.slice(2);
			this.discardReply();
			const remaining = this.consumeDiscardedReply(overflow, false);
			if (remaining.length > 0) this.processChunk(remaining);
			return;
		}

		if (this.pasteMode) {
			// Search only where the end marker can newly appear: input may arrive one byte at a time.
			const searchFrom = Math.max(0, this.pasteBuffer.length - BRACKETED_PASTE_END.length + 1);
			this.pasteBuffer += this.buffer;
			this.buffer = "";
			this.scanOffset = 0;

			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END, searchFrom);
			if (endIndex !== -1) {
				const pastedContent = this.pasteBuffer.slice(0, endIndex);
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				this.pasteMode = false;
				this.pasteBuffer = "";
				this.pendingKittyPrintableCodepoint = undefined;

				this.emit("paste", pastedContent);

				if (remaining.length > 0) {
					this.processChunk(remaining);
				}
			}
			return;
		}

		const startIndex = this.buffer.indexOf(
			BRACKETED_PASTE_START,
			Math.max(0, this.scanOffset - BRACKETED_PASTE_START.length + 1),
		);
		if (startIndex !== -1) {
			if (this.timeout !== null) clearTimeout(this.timeout);
			this.timeout = null;
			this.replyDeadline = false;
			if (startIndex > 0) {
				const beforePaste = this.buffer.slice(0, startIndex);
				const result = extractCompleteSequences(beforePaste, Math.min(this.scanOffset, beforePaste.length));
				for (const sequence of result.sequences) {
					this.emitDataSequence(sequence);
				}
			}

			this.pendingKittyPrintableCodepoint = undefined;
			this.buffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			this.pasteMode = true;
			this.pasteBuffer = this.buffer;
			this.buffer = "";
			this.scanOffset = 0;

			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				const pastedContent = this.pasteBuffer.slice(0, endIndex);
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				this.pasteMode = false;
				this.pasteBuffer = "";
				this.pendingKittyPrintableCodepoint = undefined;

				this.emit("paste", pastedContent);

				if (remaining.length > 0) {
					this.processChunk(remaining);
				}
			}
			return;
		}

		const result = extractCompleteSequences(this.buffer, this.scanOffset);
		if (result.remainder.length < this.buffer.length || !TERMINAL_REPLY_HEADER_PATTERN.test(result.remainder)) {
			// A consumed or canceled reply cannot lend its deadline to the next sequence.
			if (this.timeout !== null) clearTimeout(this.timeout);
			this.timeout = null;
			this.replyDeadline = false;
		}
		this.buffer = result.remainder;
		this.scanOffset = result.scanOffset;

		for (const sequence of result.sequences) {
			this.emitDataSequence(sequence);
		}
	}

	private armTimeout(): void {
		// Only the final remainder of a data event gets a timer, never its chunks.
		// An absolute reply deadline survives trickling input until that reply is consumed.
		if (this.replyDeadline && this.timeout !== null) return;
		if (this.timeout !== null) clearTimeout(this.timeout);
		this.timeout = null;
		this.replyDeadline = false;
		if (this.buffer.length > 0) {
			if (TERMINAL_REPLY_HEADER_PATTERN.test(this.buffer)) {
				this.replyDeadline = true;
				this.timeout = setTimeout(() => this.discardReply(), this.timeoutMs);
				return;
			}
			const timeoutMs = this.buffer === ESC ? this.escapeTimeoutMs : this.timeoutMs;
			this.timeout = setTimeout(() => {
				const flushed = this.flush();

				for (const sequence of flushed) {
					if (sequence.length > 2 && isControlString(sequence)) {
						// Recover the Alt key and reparse its tail so batched text,
						// Enter, and control keys are not swallowed as one event.
						this.emitDataSequence(sequence.slice(0, 2));
						this.process(sequence.slice(2));
					} else {
						this.emitDataSequence(sequence);
					}
				}
			}, timeoutMs);
		}
	}

	private discardReply(): void {
		this.discardedReply = this.buffer.startsWith(`${ESC}]`) ? "osc" : "other";
		this.buffer = "";
		this.scanOffset = 0;
		if (this.timeout !== null) clearTimeout(this.timeout);
		this.timeout = null;
		this.pendingKittyPrintableCodepoint = undefined;
		this.replyDeadline = false;
		this.discardWindow = true;
		this.discardBytes = 0;
		this.discardEscape = false;
		if (this.discardTimeout !== null) clearTimeout(this.discardTimeout);
		this.discardTimeout = setTimeout(() => {
			this.discardTimeout = null;
			this.discardWindow = false;
		}, TERMINAL_REPLY_DISCARD_MS);
	}

	private endDiscard(): void {
		if (this.discardTimeout !== null) clearTimeout(this.discardTimeout);
		this.discardTimeout = null;
		this.discardedReply = undefined;
		this.discardWindow = false;
		this.discardEscape = false;
		this.discardBytes = 0;
	}

	private consumeDiscardedReply(str: string, countBytes = true): string {
		if (this.discardEscape) {
			this.endDiscard();
			return str.startsWith("\\") ? str.slice(1) : ESC + str;
		}
		let printable = "";
		for (let i = 0; i < str.length; i++) {
			const char = str[i]!;
			if (char === "\x18" || char === "\x1a" || (char === "\x07" && this.discardedReply === "osc")) {
				this.endDiscard();
				return printable + str.slice(i + 1);
			}
			if (char === ESC) {
				if (i + 1 === str.length) {
					this.discardEscape = true;
					return printable;
				}
				this.endDiscard();
				return printable + str.slice(str[i + 1] === "\\" ? i + 2 : i);
			}
			if (this.discardWindow) {
				if (countBytes) {
					this.discardBytes += Buffer.byteLength(char);
					if (this.discardBytes >= MAX_TERMINAL_REPLY_BYTES) {
						this.discardWindow = false;
						if (this.discardTimeout !== null) clearTimeout(this.discardTimeout);
						this.discardTimeout = null;
					}
				}
			} else if (char !== "\r" && char !== "\n") {
				// Residual: a tail later than the bounded discard window can become editor text.
				// Keep CR/LF quarantined until a protocol boundary, so it cannot auto-submit.
				printable += char;
			}
		}
		return printable;
	}

	private emitDataSequence(sequence: string): void {
		const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
		if (rawCodepoint !== undefined && rawCodepoint === this.pendingKittyPrintableCodepoint) {
			this.pendingKittyPrintableCodepoint = undefined;
			return;
		}

		this.pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
		this.emit("data", sequence);
	}

	flush(): string[] {
		if (this.timeout !== null) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
		this.replyDeadline = false;

		if (this.buffer.length === 0) {
			return [];
		}

		if (TERMINAL_REPLY_HEADER_PATTERN.test(this.buffer)) {
			this.discardReply();
			return [];
		}
		const sequences = [this.buffer];
		this.buffer = "";
		this.scanOffset = 0;
		this.pendingKittyPrintableCodepoint = undefined;
		return sequences;
	}

	clear(): void {
		if (this.timeout !== null) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
		this.replyDeadline = false;
		this.endDiscard();
		this.buffer = "";
		this.scanOffset = 0;
		this.pasteMode = false;
		this.pasteBuffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
	}

	getBuffer(): string {
		return this.buffer;
	}

	destroy(): void {
		this.clear();
	}
}
