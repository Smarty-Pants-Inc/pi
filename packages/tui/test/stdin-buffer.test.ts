/**
 * Tests for StdinBuffer
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { matchesKey } from "../src/keys.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";

describe("StdinBuffer", () => {
	let buffer: StdinBuffer;
	let emittedSequences: string[];

	beforeEach(() => {
		buffer = new StdinBuffer({ timeout: 10 });

		// Collect emitted sequences
		emittedSequences = [];
		buffer.on("data", (sequence) => {
			emittedSequences.push(sequence);
		});
	});

	afterEach(() => buffer.destroy());

	// Helper to process data through the buffer
	function processInput(data: string | Buffer): void {
		buffer.process(data);
	}

	// Helper to wait for async operations
	async function wait(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	describe("Regular Characters", () => {
		it("should pass through regular characters immediately", () => {
			processInput("a");
			assert.deepStrictEqual(emittedSequences, ["a"]);
		});

		it("should pass through multiple regular characters", () => {
			processInput("abc");
			assert.deepStrictEqual(emittedSequences, ["a", "b", "c"]);
		});

		it("should handle unicode characters", () => {
			processInput("hello 世界");
			assert.deepStrictEqual(emittedSequences, ["h", "e", "l", "l", "o", " ", "世", "界"]);
		});
	});

	describe("Complete Escape Sequences", () => {
		it("should pass through complete mouse SGR sequences", () => {
			const mouseSeq = "\x1b[<35;20;5m";
			processInput(mouseSeq);
			assert.deepStrictEqual(emittedSequences, [mouseSeq]);
		});

		it("should pass through complete arrow key sequences", () => {
			const upArrow = "\x1b[A";
			processInput(upArrow);
			assert.deepStrictEqual(emittedSequences, [upArrow]);
		});

		it("should pass through complete function key sequences", () => {
			const f1 = "\x1b[11~";
			processInput(f1);
			assert.deepStrictEqual(emittedSequences, [f1]);
		});

		it("should pass through meta key sequences", () => {
			const metaA = "\x1ba";
			processInput(metaA);
			assert.deepStrictEqual(emittedSequences, [metaA]);
		});

		it("should pass through SS3 sequences", () => {
			const ss3 = "\x1bOA";
			processInput(ss3);
			assert.deepStrictEqual(emittedSequences, [ss3]);
		});
	});

	describe("Partial Escape Sequences", () => {
		it("should buffer incomplete mouse SGR sequence", async () => {
			processInput("\x1b");
			assert.deepStrictEqual(emittedSequences, []);
			assert.strictEqual(buffer.getBuffer(), "\x1b");

			processInput("[<35");
			assert.deepStrictEqual(emittedSequences, []);
			assert.strictEqual(buffer.getBuffer(), "\x1b[<35");

			processInput(";20;5m");
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;20;5m"]);
			assert.strictEqual(buffer.getBuffer(), "");
		});

		it("should buffer incomplete CSI sequence", () => {
			processInput("\x1b[");
			assert.deepStrictEqual(emittedSequences, []);

			processInput("1;");
			assert.deepStrictEqual(emittedSequences, []);

			processInput("5H");
			assert.deepStrictEqual(emittedSequences, ["\x1b[1;5H"]);
		});

		it("should buffer split across many chunks", () => {
			processInput("\x1b");
			processInput("[");
			processInput("<");
			processInput("3");
			processInput("5");
			processInput(";");
			processInput("2");
			processInput("0");
			processInput(";");
			processInput("5");
			processInput("m");

			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;20;5m"]);
		});

		// smarty-dev#12091: chunk timers must not flush a later event before its own deadline.
		it("keeps one timer for a many-chunk event ending in an incomplete sequence", (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const timers = t.mock.method(globalThis, "setTimeout");
			const reply = `\x1b]0;${"x".repeat(12 * 4096)}`;
			processInput(reply);
			t.mock.timers.tick(5);
			processInput("\x07\x1b[");
			t.mock.timers.tick(5);
			assert.deepStrictEqual(emittedSequences, [`${reply}\x07`]);
			assert.equal(buffer.getBuffer(), "\x1b[");
			t.mock.timers.tick(4);
			assert.deepStrictEqual(emittedSequences, [`${reply}\x07`]);
			t.mock.timers.tick(1);
			assert.deepStrictEqual(emittedSequences, [`${reply}\x07`, "\x1b["]);
			assert.equal(timers.mock.callCount(), 2);
		});

		// smarty-dev#12091: completion/cancellation cannot transfer a reply's deadline.
		it("gives a new recognized reply its own deadline after completion or cancellation", (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			for (const boundary of ["\x07", "\x18", "\x1a"]) {
				buffer.clear();
				emittedSequences.length = 0;
				processInput("\x1b]10;");
				t.mock.timers.tick(5);
				processInput(`${"x".repeat(3 * 4096)}${boundary}\x1b]11;`);
				t.mock.timers.tick(5);
				assert.equal(buffer.getBuffer(), "\x1b]11;", JSON.stringify(boundary));
				t.mock.timers.tick(4);
				assert.equal(buffer.getBuffer(), "\x1b]11;");
				t.mock.timers.tick(1);
				assert.equal(buffer.getBuffer(), "");
				processInput("tail\r\n\x07q");
				assert.equal(emittedSequences.at(-1), "q");
			}
		});

		// smarty-dev#12091: all buffer consumers cancel its only timer.
		it("cancels chunk timers on completion, explicit flush and clear", (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			for (const action of ["complete", "flush", "clear"] as const) {
				buffer.clear();
				emittedSequences.length = 0;
				const reply = `\x1b]0;${"x".repeat(3 * 4096)}`;
				processInput(reply);
				t.mock.timers.tick(5);
				if (action === "complete") processInput("\x07");
				else if (action === "flush") assert.deepStrictEqual(buffer.flush(), [reply]);
				else buffer.clear();
				const completed = action === "complete" ? [`${reply}\x07`] : [];
				processInput("\x1b[");
				t.mock.timers.tick(5);
				assert.deepStrictEqual(emittedSequences, completed, action);
				assert.equal(buffer.getBuffer(), "\x1b[", action);
				t.mock.timers.tick(5);
				assert.deepStrictEqual(emittedSequences, [...completed, "\x1b["], action);
			}
		});

		it("should flush incomplete sequence after timeout", async () => {
			processInput("\x1b[<35");
			assert.deepStrictEqual(emittedSequences, []);

			// Wait for timeout
			await wait(15);

			assert.deepStrictEqual(emittedSequences, ["\x1b[<35"]);
		});

		it("should flush a lone ESC as Escape when CR arrives after the timeout", async () => {
			// Legacy-mode Alt+Enter is ESC + CR; when the terminal/transport splits
			// the bytes further apart than the timeout, ESC is flushed alone and the
			// host sees Escape (interrupt) instead of Alt+Enter. This locks in the
			// behavior so the configurable timeout in ProcessTerminal stays honest.
			processInput("\x1b");
			await wait(20); // buffer timeout is 10ms in beforeEach
			processInput("\r");

			assert.deepStrictEqual(emittedSequences, ["\x1b", "\r"]);
			assert.equal(matchesKey(emittedSequences[0] ?? "", "escape"), true);
		});

		it("should merge ESC + CR split across chunks within a larger timeout", async () => {
			buffer = new StdinBuffer({ escapeTimeout: 100 });
			emittedSequences = [];
			buffer.on("data", (sequence) => {
				emittedSequences.push(sequence);
			});

			processInput("\x1b");
			await wait(20); // > 10ms default escapeTimeout, < 100ms configured escapeTimeout
			processInput("\r");

			assert.deepStrictEqual(emittedSequences, ["\x1b\r"]);
			assert.equal(matchesKey(emittedSequences[0] ?? "", "alt+enter"), true);
		});

		it("does not apply the sequence timeout to a lone ESC", async () => {
			buffer = new StdinBuffer({ timeout: 100 });
			emittedSequences = [];
			buffer.on("data", (sequence) => {
				emittedSequences.push(sequence);
			});

			processInput("\x1b");
			await wait(20);
			processInput("\r");

			assert.deepStrictEqual(emittedSequences, ["\x1b", "\r"]);
			assert.equal(matchesKey(emittedSequences[0] ?? "", "escape"), true);
		});

		it("keeps fragmented mouse sequences buffered across delayed chunks by default", async () => {
			const delayedBuffer = new StdinBuffer();
			const delayedSequences: string[] = [];
			delayedBuffer.on("data", (sequence) => delayedSequences.push(sequence));

			delayedBuffer.process("\x1b[");
			await wait(20);
			assert.deepStrictEqual(delayedSequences, []);
			delayedBuffer.process("<65;48;39M");
			assert.deepStrictEqual(delayedSequences, ["\x1b[<65;48;39M"]);
			delayedBuffer.destroy();
		});
	});

	describe("Terminal Reply Strings", () => {
		const replies = [
			{ header: "\x1b]4;1;", reply: "\x1b]4;1;rgb:eaea/6c6c/6d6d\x07" }, // Ghostty's Ayu Light palette color 1.
			{ header: "\x1b]10;", reply: "\x1b]10;rgb:ffff/ffff/ffff\x1b\\" },
			{ header: "\x1b]11;", reply: "\x1b]11;rgb:0000/0000/0000\x07" },
			{ header: "\x1b]4;1;", reply: "\x1b]4;1;rgb:6464/6464/4d4d\x07" }, // Another reported color-reply tail.
			{ header: "\x1bP>|", reply: "\x1bP>|Ghostty 1.3.1\x1b\\" },
			{ header: "\x1b_Gi=1;", reply: "\x1b_Gi=1;OK\x1b\\" },
			{ header: "\x1b]7501;?", reply: "\x1b]7501;?\x1b\\" },
		];

		for (const { header, reply } of replies) {
			it(`keeps delayed ${JSON.stringify(reply)} intact within the deadline at every split after its reply header`, (t) => {
				t.mock.timers.enable({ apis: ["setTimeout"] });
				for (let split = header.length; split < reply.length; split++) {
					const delayedBuffer = new StdinBuffer();
					const sequences: string[] = [];
					delayedBuffer.on("data", (sequence) => sequences.push(sequence));
					try {
						delayedBuffer.process(reply.slice(0, split));
						t.mock.timers.tick(49);
						delayedBuffer.process(`${reply.slice(split)}x`);
						assert.equal(
							sequences.some((sequence) => matchesKey(sequence, "ctrl+g")),
							false,
						);
						assert.deepStrictEqual(sequences, [reply, "x"]);
					} finally {
						delayedBuffer.destroy();
					}
				}
			});
		}

		it("discards an OSC reply across multiple expired sequence timeouts", (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			processInput("\x1b]4;1;rgb:eaea/6c");
			t.mock.timers.tick(100);
			assert.deepStrictEqual(emittedSequences, []);
			processInput("6c/6d6d");
			t.mock.timers.tick(100);
			assert.deepStrictEqual(emittedSequences, []);
			processInput("\x07x");
			assert.deepStrictEqual(emittedSequences, ["x"]);
		});

		it("still times out bare string introducers as Alt keys", (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			for (const prefix of ["\x1b]", "\x1bP", "\x1b_"]) {
				processInput(prefix);
				t.mock.timers.tick(10);
			}
			assert.deepStrictEqual(emittedSequences, ["\x1b]", "\x1bP", "\x1b_"]);
		});

		for (const ambiguous of [
			"\x1b]a",
			"\x1b]1",
			"\x1b]10",
			"\x1b]0;title",
			"\x1b]4;",
			"\x1b]4;a;",
			"\x1bPa",
			"\x1bP>",
			"\x1b_a",
			"\x1b_G",
			"\x1b_Gi=1",
		]) {
			it(`recovers batched legacy Alt input ${JSON.stringify(ambiguous)} within the sequence timeout`, (t) => {
				t.mock.timers.enable({ apis: ["setTimeout"] });
				const legacyBuffer = new StdinBuffer();
				const sequences: string[] = [];
				legacyBuffer.on("data", (sequence) => sequences.push(sequence));
				try {
					legacyBuffer.process(ambiguous);
					t.mock.timers.tick(20);
					legacyBuffer.process("x\r\x03\x04");
					t.mock.timers.tick(49);
					assert.deepStrictEqual(sequences, []);
					t.mock.timers.tick(1);
					assert.deepStrictEqual(sequences, [
						ambiguous.slice(0, 2),
						...ambiguous.slice(2),
						"x",
						"\r",
						"\x03",
						"\x04",
					]);
					assert.strictEqual(legacyBuffer.getBuffer(), "");

					legacyBuffer.process("y\r\x03\x04");
					assert.deepStrictEqual(sequences.slice(-4), ["y", "\r", "\x03", "\x04"]);
				} finally {
					legacyBuffer.destroy();
				}
			});
		}

		it("recognizes a reply header assembled within the ambiguous-input timeout", (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			processInput("\x1b]1");
			t.mock.timers.tick(5);
			processInput("0;");
			t.mock.timers.tick(9);
			assert.deepStrictEqual(emittedSequences, []);
			processInput("rgb:ffff/ffff/ffff\x1b\\");
			assert.deepStrictEqual(emittedSequences, [replies[1].reply]);
		});

		// pi#244: recognized replies have an absolute deadline and a bounded discard window.
		it("expires an unterminated recognized reply before delivering later keys", (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			processInput("\x1b]10;");
			t.mock.timers.tick(9);
			processInput("abc");
			t.mock.timers.tick(1);
			assert.equal(buffer.getBuffer(), "");
			processInput("tail\r\n");
			assert.deepStrictEqual(emittedSequences, []);
			t.mock.timers.tick(499);
			processInput("late");
			assert.deepStrictEqual(emittedSequences, []);
			t.mock.timers.tick(1);
			processInput("xyz\r\n");
			assert.deepStrictEqual(emittedSequences, ["x", "y", "z"]);
		});
		it("discards an over-cap reply without retaining or emitting its tail", (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			processInput(`\x1b]10;${"é".repeat(32 * 1024)}`);
			assert.equal(buffer.getBuffer(), "");
			assert.deepStrictEqual(emittedSequences, []);
			processInput("tail\r\n\x07q");
			assert.deepStrictEqual(emittedSequences, ["q"]);
		});
		it("discards a complete oversized reply and resumes input in the same event", () => {
			processInput(`\x1b]11;${"x".repeat(70 * 1024)}\x07z`);
			assert.equal(buffer.getBuffer(), "");
			assert.deepStrictEqual(emittedSequences, ["z"]);
		});
		// smarty-dev#12091: unknown strings must be linear, bounded and never auto-submit.
		it("processes one 1 MiB unterminated unknown OSC within the linear-time budget", (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const input = `\x1b]0;${"\r\n".repeat((1024 * 1024 - 4) / 2)}`;
			assert.equal(Buffer.byteLength(input), 1024 * 1024);
			const start = performance.now();
			processInput(input);
			const elapsed = performance.now() - start;
			assert.ok(elapsed < 200, `1 MiB scan took ${elapsed.toFixed(1)}ms (budget: 200ms)`);
			assert.equal(buffer.getBuffer(), "");
			assert.deepStrictEqual(emittedSequences, []);
			processInput("keys\r\n");
			assert.deepStrictEqual(emittedSequences, [..."keys"]);
			processInput("\x07\r");
			assert.deepStrictEqual(emittedSequences, [..."keys", "\r"]);
		});
		for (const header of ["\x1b]0;", "\x1bPunknown;", "\x1b_unknown;", "\x1b^unknown;", "\x1bXunknown;"]) {
			it(`caps unknown ${JSON.stringify(header)} and resumes keys after the discard window`, (t) => {
				t.mock.timers.enable({ apis: ["setTimeout"] });
				processInput(`a${header}${"é".repeat(32 * 1024)}`);
				assert.equal(buffer.getBuffer(), "");
				assert.deepStrictEqual(emittedSequences, ["a"]);
				processInput("tail\r\n");
				t.mock.timers.tick(499);
				processInput("late\r\n");
				assert.deepStrictEqual(emittedSequences, ["a"]);
				t.mock.timers.tick(1);
				processInput("q\r\n");
				assert.deepStrictEqual(emittedSequences, ["a", "q"]);
				processInput("\x1b");
				processInput("\\\r\x1b[A");
				assert.deepStrictEqual(emittedSequences, ["a", "q", "\r", "\x1b[A"]);
			});
		}
		it("resumes split terminators and recognized-reply resynchronization after many chunks", () => {
			for (const header of [
				"\x1b]10;",
				"\x1b]0;",
				"\x1bPunknown;",
				"\x1b_unknown;",
				"\x1b^unknown;",
				"\x1bXunknown;",
			]) {
				const reply = `${header}${"x".repeat(3 * 4096)}`;
				processInput(`${reply}\x1b`);
				assert.equal(buffer.getBuffer(), `${reply}\x1b`);
				processInput("\\q");
				assert.deepStrictEqual(emittedSequences.slice(-2), [`${reply}\x1b\\`, "q"]);
			}
			processInput(`\x1b]11;${"x".repeat(3 * 4096)}\x1b`);
			processInput("[Ar");
			assert.deepStrictEqual(emittedSequences.slice(-2), ["\x1b[A", "r"]);
		});
		it("discards a recognized reply on explicit flush", () => {
			processInput("\x1bP>|reply");
			assert.deepStrictEqual(buffer.flush(), []);
			processInput("tail\x1b\\x");
			assert.deepStrictEqual(emittedSequences, ["x"]);
		});
		for (const boundary of ["\x07", "\x1b\\", "\x18", "\x1a", "\x1b[A"]) {
			it(`ends expired reply discard on ${JSON.stringify(boundary)}`, (t) => {
				t.mock.timers.enable({ apis: ["setTimeout"] });
				processInput("\x1b]11;");
				t.mock.timers.tick(10);
				processInput(`tail\r\n${boundary}x`);
				assert.deepStrictEqual(emittedSequences, boundary === "\x1b[A" ? [boundary, "x"] : ["x"]);
			});
		}
		it("ends the discard window at its byte cap and resumes plain typing", (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			processInput("\x1bP>|");
			t.mock.timers.tick(10);
			for (let i = 0; i < 16; i++) {
				processInput("x".repeat(4096));
				assert.equal(buffer.getBuffer(), "");
				assert.deepStrictEqual(emittedSequences, []);
			}
			processInput("plain\r\n");
			assert.deepStrictEqual(emittedSequences, [..."plain"]);
			processInput("\x1b");
			processInput("\\\r");
			assert.deepStrictEqual(emittedSequences, [..."plain", "\r"]);
		});
		it("discards a split late ST and clears quarantine on explicit clear", (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			processInput("\x1b_Gi=1;");
			t.mock.timers.tick(10);
			processInput("tail\x1b");
			processInput("\\x");
			assert.deepStrictEqual(emittedSequences, ["x"]);
			processInput("\x1b]10;");
			t.mock.timers.tick(10);
			buffer.clear();
			processInput("\r");
			assert.deepStrictEqual(emittedSequences, ["x", "\r"]);
		});

		it("recovers from an unterminated reply when a new escape sequence arrives", (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			processInput("\x1b]4;1;rgb:eaea/6c");
			t.mock.timers.tick(100);
			processInput("\x1b");
			t.mock.timers.tick(100);
			processInput("[Ahello");
			assert.deepStrictEqual(emittedSequences, ["\x1b[A", "h", "e", "l", "l", "o"]);
		});

		it("discards a canceled reply without swallowing subsequent input", () => {
			for (const cancel of ["\x18", "\x1a"]) {
				processInput(`\x1b]11;rgb:0000${cancel}x`);
			}
			assert.deepStrictEqual(emittedSequences, ["x", "x"]);
		});
	});

	describe("Mixed Content", () => {
		it("should handle characters followed by escape sequence", () => {
			processInput("abc\x1b[A");
			assert.deepStrictEqual(emittedSequences, ["a", "b", "c", "\x1b[A"]);
		});

		it("should handle escape sequence followed by characters", () => {
			processInput("\x1b[Aabc");
			assert.deepStrictEqual(emittedSequences, ["\x1b[A", "a", "b", "c"]);
		});

		it("should handle multiple complete sequences", () => {
			processInput("\x1b[A\x1b[B\x1b[C");
			assert.deepStrictEqual(emittedSequences, ["\x1b[A", "\x1b[B", "\x1b[C"]);
		});

		it("should handle partial sequence with preceding characters", () => {
			processInput("abc\x1b[<35");
			assert.deepStrictEqual(emittedSequences, ["a", "b", "c"]);
			assert.strictEqual(buffer.getBuffer(), "\x1b[<35");

			processInput(";20;5m");
			assert.deepStrictEqual(emittedSequences, ["a", "b", "c", "\x1b[<35;20;5m"]);
		});
	});

	describe("Kitty Keyboard Protocol", () => {
		it("should handle Kitty CSI u press events", () => {
			// Press 'a' in Kitty protocol
			processInput("\x1b[97u");
			assert.deepStrictEqual(emittedSequences, ["\x1b[97u"]);
		});

		it("should handle Kitty CSI u release events", () => {
			// Release 'a' in Kitty protocol
			processInput("\x1b[97;1:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b[97;1:3u"]);
		});

		it("should handle batched Kitty press and release", () => {
			// Press 'a', release 'a' batched together (common over SSH)
			processInput("\x1b[97u\x1b[97;1:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b[97u", "\x1b[97;1:3u"]);
		});

		it("should handle multiple batched Kitty events", () => {
			// Press 'a', release 'a', press 'b', release 'b'
			processInput("\x1b[97u\x1b[97;1:3u\x1b[98u\x1b[98;1:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b[97u", "\x1b[97;1:3u", "\x1b[98u", "\x1b[98;1:3u"]);
		});

		it("should handle Kitty arrow keys with event type", () => {
			// Up arrow press with event type
			processInput("\x1b[1;1:1A");
			assert.deepStrictEqual(emittedSequences, ["\x1b[1;1:1A"]);
		});

		it("should handle Kitty functional keys with event type", () => {
			// Delete key release
			processInput("\x1b[3;1:3~");
			assert.deepStrictEqual(emittedSequences, ["\x1b[3;1:3~"]);
		});

		it("should split ESC+ESC+CSI into standalone ESC and the CSI sequence (WezTerm Escape key regression)", () => {
			// WezTerm with enable_kitty_keyboard sends Escape key press as raw \x1b
			// and the release as a full Kitty CSI-u sequence, concatenated.
			// The buffer must not treat \x1b\x1b as a complete meta-key when the
			// following byte starts a new escape sequence.
			processInput("\x1b\x1b[27;129:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b", "\x1b[27;129:3u"]);
		});

		it("should split ESC+ESC+CSI with no modifier (no num_lock)", () => {
			processInput("\x1b\x1b[27;1:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b", "\x1b[27;1:3u"]);
		});

		it("should still emit ESC+ESC as a single sequence when not followed by a new escape", () => {
			// \x1b\x1b alone (no following CSI) stays as-is — e.g. ctrl+alt+[
			processInput("\x1b\x1b");
			assert.deepStrictEqual(emittedSequences, ["\x1b\x1b"]);
		});

		it("should handle plain characters mixed with Kitty sequences", () => {
			// Plain 'a' followed by Kitty release
			processInput("a\x1b[97;1:3u");
			assert.deepStrictEqual(emittedSequences, ["a", "\x1b[97;1:3u"]);
		});

		it("should drop raw duplicate character after matching Kitty printable sequence", () => {
			processInput("\x1b[224uà");
			assert.deepStrictEqual(emittedSequences, ["\x1b[224u"]);
		});

		it("should drop raw duplicate character after matching Kitty printable sequence across chunks", () => {
			processInput("\x1b[64u");
			processInput("@");
			assert.deepStrictEqual(emittedSequences, ["\x1b[64u"]);
		});

		it("should keep non-matching plain character after Kitty printable sequence", () => {
			processInput("\x1b[97ub");
			assert.deepStrictEqual(emittedSequences, ["\x1b[97u", "b"]);
		});

		it("should keep raw character after modified Kitty printable sequence", () => {
			processInput("\x1b[64;3u@");
			assert.deepStrictEqual(emittedSequences, ["\x1b[64;3u", "@"]);
		});

		it("should handle rapid typing simulation with Kitty protocol", () => {
			// Simulates typing "hi" quickly with releases interleaved
			processInput("\x1b[104u\x1b[104;1:3u\x1b[105u\x1b[105;1:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b[104u", "\x1b[104;1:3u", "\x1b[105u", "\x1b[105;1:3u"]);
		});
	});

	describe("Mouse Events", () => {
		it("should handle mouse press event", () => {
			processInput("\x1b[<0;10;5M");
			assert.deepStrictEqual(emittedSequences, ["\x1b[<0;10;5M"]);
		});

		it("should handle mouse release event", () => {
			processInput("\x1b[<0;10;5m");
			assert.deepStrictEqual(emittedSequences, ["\x1b[<0;10;5m"]);
		});

		it("should handle mouse move event", () => {
			processInput("\x1b[<35;20;5m");
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;20;5m"]);
		});

		it("should handle split mouse events", () => {
			processInput("\x1b[<3");
			processInput("5;1");
			processInput("5;");
			processInput("10m");
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;15;10m"]);
		});

		it("should handle multiple mouse events", () => {
			processInput("\x1b[<35;1;1m\x1b[<35;2;2m\x1b[<35;3;3m");
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;1;1m", "\x1b[<35;2;2m", "\x1b[<35;3;3m"]);
		});

		it("should handle old-style mouse sequence (ESC[M + 3 bytes)", () => {
			processInput("\x1b[M abc");
			assert.deepStrictEqual(emittedSequences, ["\x1b[M ab", "c"]);
		});

		it("should buffer incomplete old-style mouse sequence", () => {
			processInput("\x1b[M");
			assert.strictEqual(buffer.getBuffer(), "\x1b[M");

			processInput(" a");
			assert.strictEqual(buffer.getBuffer(), "\x1b[M a");

			processInput("b");
			assert.deepStrictEqual(emittedSequences, ["\x1b[M ab"]);
		});
	});

	describe("Edge Cases", () => {
		it("should handle empty input", () => {
			processInput("");
			// Empty string emits an empty data event
			assert.deepStrictEqual(emittedSequences, [""]);
		});

		it("should handle lone escape character with timeout", async () => {
			processInput("\x1b");
			assert.deepStrictEqual(emittedSequences, []);

			// After timeout, should emit
			await wait(15);
			assert.deepStrictEqual(emittedSequences, ["\x1b"]);
		});

		it("flushes a lone escape promptly with the longer default sequence timeout", async () => {
			const defaultBuffer = new StdinBuffer();
			const defaultSequences: string[] = [];
			defaultBuffer.on("data", (sequence) => defaultSequences.push(sequence));

			defaultBuffer.process("\x1b");
			await wait(20);
			assert.deepStrictEqual(defaultSequences, ["\x1b"]);
			defaultBuffer.destroy();
		});

		it("should handle lone escape character with explicit flush", () => {
			processInput("\x1b");
			assert.deepStrictEqual(emittedSequences, []);

			const flushed = buffer.flush();
			assert.deepStrictEqual(flushed, ["\x1b"]);
		});

		it("should handle buffer input", () => {
			processInput(Buffer.from("\x1b[A"));
			assert.deepStrictEqual(emittedSequences, ["\x1b[A"]);
		});

		it("should handle very long sequences", () => {
			const longSeq = `\x1b[${"1;".repeat(50)}H`;
			processInput(longSeq);
			assert.deepStrictEqual(emittedSequences, [longSeq]);
		});
	});

	describe("Flush", () => {
		it("should flush incomplete sequences", () => {
			processInput("\x1b[<35");
			const flushed = buffer.flush();
			assert.deepStrictEqual(flushed, ["\x1b[<35"]);
			assert.strictEqual(buffer.getBuffer(), "");
		});

		it("should return empty array if nothing to flush", () => {
			const flushed = buffer.flush();
			assert.deepStrictEqual(flushed, []);
		});

		it("should emit flushed data via timeout", async () => {
			processInput("\x1b[<35");
			assert.deepStrictEqual(emittedSequences, []);

			// Wait for timeout to flush
			await wait(15);

			assert.deepStrictEqual(emittedSequences, ["\x1b[<35"]);
		});
	});

	describe("Clear", () => {
		it("should clear buffered content without emitting", () => {
			processInput("\x1b[<35");
			assert.strictEqual(buffer.getBuffer(), "\x1b[<35");

			buffer.clear();
			assert.strictEqual(buffer.getBuffer(), "");
			assert.deepStrictEqual(emittedSequences, []);
		});
	});

	describe("Bracketed Paste", () => {
		let emittedPaste: string[] = [];

		beforeEach(() => {
			buffer = new StdinBuffer({ timeout: 10 });

			// Collect emitted sequences
			emittedSequences = [];
			buffer.on("data", (sequence) => {
				emittedSequences.push(sequence);
			});

			// Collect paste events
			emittedPaste = [];
			buffer.on("paste", (data) => {
				emittedPaste.push(data);
			});
		});

		it("should emit paste event for complete bracketed paste", () => {
			const pasteStart = "\x1b[200~";
			const pasteEnd = "\x1b[201~";
			const content = "hello world";

			processInput(pasteStart + content + pasteEnd);

			assert.deepStrictEqual(emittedPaste, ["hello world"]);
			assert.deepStrictEqual(emittedSequences, []); // No data events during paste
		});

		it("should handle paste arriving in chunks", () => {
			processInput("\x1b[200~");
			assert.deepStrictEqual(emittedPaste, []);

			processInput("hello ");
			assert.deepStrictEqual(emittedPaste, []);

			processInput("world\x1b[201~");
			assert.deepStrictEqual(emittedPaste, ["hello world"]);
			assert.deepStrictEqual(emittedSequences, []);
		});

		it("should handle paste with input before and after", () => {
			processInput("a");
			processInput("\x1b[200~pasted\x1b[201~");
			processInput("b");

			assert.deepStrictEqual(emittedSequences, ["a", "b"]);
			assert.deepStrictEqual(emittedPaste, ["pasted"]);
		});

		it("should handle paste with newlines", () => {
			processInput("\x1b[200~line1\nline2\nline3\x1b[201~");

			assert.deepStrictEqual(emittedPaste, ["line1\nline2\nline3"]);
			assert.deepStrictEqual(emittedSequences, []);
		});

		it("should handle paste with unicode", () => {
			processInput("\x1b[200~Hello 世界 🎉\x1b[201~");

			assert.deepStrictEqual(emittedPaste, ["Hello 世界 🎉"]);
			assert.deepStrictEqual(emittedSequences, []);
		});
	});

	describe("Destroy", () => {
		it("should clear buffer on destroy", () => {
			processInput("\x1b[<35");
			assert.strictEqual(buffer.getBuffer(), "\x1b[<35");

			buffer.destroy();
			assert.strictEqual(buffer.getBuffer(), "");
		});

		it("should clear pending timeouts on destroy", async () => {
			processInput("\x1b[<35");
			buffer.destroy();

			// Wait longer than timeout
			await wait(15);

			// Should not have emitted anything
			assert.deepStrictEqual(emittedSequences, []);
		});
	});
});
