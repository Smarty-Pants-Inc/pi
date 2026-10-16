import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { formatSize } from "../src/core/tools/truncate.ts";
import { removeOutputDirectory } from "../src/utils/output-files.ts";

// Hardcoded on purpose, independent of the source export MAX_FULL_OUTPUT_FILE_BYTES, so this file
// also runs (and fails) against the base revision that predates the cap.
const MiB = 1024 * 1024;
const CAP = 8 * MiB;
const HALF = CAP / 2;
const CHUNK = MiB;

/** Deterministic multi-line output of exactly `size` bytes, distinct per offset region. */
function makeOutput(size: number): Buffer {
	const lines: string[] = [];
	let bytes = 0;
	for (let i = 0; bytes < size; i++) {
		const line = `fake row ${i} ${"abcdefghij".repeat(i % 7)}\n`;
		lines.push(line);
		bytes += line.length;
	}
	return Buffer.from(lines.join(""), "utf-8").subarray(0, size);
}

/** Output where a 4-byte character straddles both the head cut and the tail cut. */
function makeUtf8StraddlingOutput(size: number): Buffer {
	const data = Buffer.alloc(size, 0x61);
	const emoji = Buffer.from("\u{1F600}", "utf-8");
	expect(emoji.length).toBe(4);
	emoji.copy(data, HALF - 2);
	emoji.copy(data, size - HALF - 1);
	return data;
}

function feed(data: Buffer, onData: (chunk: Buffer) => void, chunkSize = CHUNK): void {
	for (let offset = 0; offset < data.length; offset += chunkSize) {
		onData(data.subarray(offset, Math.min(offset + chunkSize, data.length)));
	}
}

async function accumulate(data: Buffer, chunkSize = CHUNK) {
	const output = new OutputAccumulator({ tempFilePrefix: "pi-cap-test" });
	feed(data, (chunk) => output.append(chunk), chunkSize);
	output.finish();
	const snapshot = output.snapshot({ persistIfTruncated: true });
	await output.closeTempFile();
	if (!snapshot.fullOutputPath) throw new Error("No full output file");
	// Existing output-files contract: spill files stay read-only (0400).
	if (process.platform !== "win32") expect(statSync(snapshot.fullOutputPath).mode & 0o777).toBe(0o400);
	return { output, snapshot, file: readFileSync(snapshot.fullOutputPath) };
}

/** First and last 4 MiB raw bytes verbatim around a single-line marker with exact counts. */
function expectCappedFile(file: Buffer, data: Buffer): void {
	expect(file.length).toBeGreaterThan(CAP);
	expect(file.length).toBeLessThan(CAP + 1024);
	expect(file.subarray(0, HALF).equals(data.subarray(0, HALF))).toBe(true);
	expect(file.subarray(file.length - HALF).equals(data.subarray(data.length - HALF))).toBe(true);
	const marker = file.subarray(HALF, file.length - HALF).toString("utf-8");
	// The marker sits on its own line even when the head ends mid-line or mid-character.
	expect(marker.startsWith("\n")).toBe(true);
	expect(marker.endsWith("\n")).toBe(true);
	const text = marker.trim();
	expect(text.length).toBeGreaterThan(0);
	expect(text).not.toContain("\n");
	expect(marker).toBe(`\n[... ${data.length - CAP} bytes omitted; total ${data.length} bytes ...]\n`);
}

function mentionsSize(text: string, bytes: number): boolean {
	const mib = bytes / MiB;
	return [String(bytes), formatSize(bytes), `${mib}MiB`, `${mib} MiB`, `${mib}MB`, `${mib} MB`].some((s) =>
		text.includes(s),
	);
}

function runTool(data: Buffer, finish: () => Promise<{ exitCode: number | null }>) {
	const operations: BashOperations = {
		exec: async (_command, _cwd, { onData }) => {
			feed(data, onData);
			return finish();
		},
	};
	const tool = wrapToolDefinition(createBashToolDefinition(process.cwd(), { operations }));
	return tool.execute("cap-bash", { command: "fake" });
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

describe("bash full output file cap", () => {
	beforeAll(() => {
		// Spill files land in a private scratch directory; nothing is deleted by this test.
		vi.stubEnv("TMPDIR", mkdtempSync(join(tmpdir(), "pi-bash-full-output-cap-")));
	});
	afterAll(() => {
		vi.unstubAllEnvs();
		// Keep the owned output directory: detach the module's exit-time rmSync so this test never deletes.
		process.removeListener("exit", removeOutputDirectory);
	});

	// #6418: a 20 MiB command must not write a 20 MiB spill file.
	it("keeps the first and last 4 MiB of 20 MiB output around an exact marker", async () => {
		const data = makeOutput(20 * MiB);
		const { snapshot, file } = await accumulate(data);
		expectCappedFile(file, data);
		expect(snapshot.totalRawBytes).toBe(20 * MiB);
		expect(snapshot.fullOutputTruncated).toBe(true);
	}, 60_000);

	// #6418: a single chunk larger than the cap takes the same bounded path; readers see truncation.
	it("caps a single oversized chunk and reports the original total to structured readers", async () => {
		const data = makeOutput(20 * MiB);
		const { output, file } = await accumulate(data, data.length);
		expectCappedFile(file, data);
		const saved = await output.readFullOutput(CAP + 1024);
		expect(saved.truncated).toBe(true);
		expect(saved.content).toBe(file.toString("utf-8"));
		const smaller = await output.readFullOutput(MiB);
		expect(smaller.truncated).toBe(true);
		expect(smaller.content).toContain(`[... ${data.length - MiB} bytes omitted ...]`);
	}, 60_000);

	// #6418: output up to the cap stays byte-identical (control: passes before and after the cap).
	it.each([
		["below half the cap", 128 * 1024],
		["over half the cap", 5 * MiB],
		["exactly the cap", CAP],
	])(
		"keeps %s byte-identical",
		async (_label, size) => {
			const data = makeOutput(size);
			const { file } = await accumulate(data);
			expect(file.length).toBe(size);
			expect(file.equals(data)).toBe(true);
		},
		60_000,
	);

	// #6418: the snapshot reports the raw total and that the file is not capped at the cap.
	it("reports totalRawBytes and fullOutputTruncated=false at exactly the cap", async () => {
		const { snapshot } = await accumulate(makeOutput(CAP));
		expect(snapshot.totalRawBytes).toBe(CAP);
		expect(snapshot.fullOutputTruncated).toBe(false);
	}, 60_000);

	// #6418: one byte over the cap omits exactly one byte.
	it("caps output one byte over the cap", async () => {
		const data = makeOutput(CAP + 1);
		const { snapshot, file } = await accumulate(data);
		expectCappedFile(file, data);
		expect(snapshot.totalRawBytes).toBe(CAP + 1);
		expect(snapshot.fullOutputTruncated).toBe(true);
	}, 60_000);

	// #6418: a near-cap read budget must not sample the saved marker or count it as output bytes.
	it("clamps a near-cap reader budget without changing an uncapped read", async () => {
		const data = Buffer.alloc(CAP + 1, 0x61);
		const { output } = await accumulate(data);
		const result = await output.readFullOutput(CAP + 10);
		expect(result.truncated).toBe(true);
		expect(result.content).toBe(`${"a".repeat(HALF)}\n\n[... 1 bytes omitted ...]\n\n${"a".repeat(HALF)}`);
		const control = await accumulate(data.subarray(0, CAP));
		const whole = await control.output.readFullOutput(CAP + 10);
		expect(whole.truncated).toBe(false);
		expect(whole.content).toBe(data.subarray(0, CAP).toString("utf-8"));
	}, 60_000);

	// #6418: cuts are raw-byte cuts; split UTF-8 sequences are preserved verbatim.
	it("preserves raw bytes of characters split by the head and tail cuts", async () => {
		const data = makeUtf8StraddlingOutput(CAP + 3 * MiB);
		// Odd chunk size so chunk boundaries also split characters.
		const { snapshot, file } = await accumulate(data, 65_537);
		expectCappedFile(file, data);
		expect(snapshot.totalRawBytes).toBe(data.length);
		expect(snapshot.fullOutputTruncated).toBe(true);
	}, 60_000);

	// #6418: every model-facing notice states the cap and the total size.
	describe("bash tool notices for capped output", () => {
		const size = 20 * MiB;
		const expectNotice = (text: string) => {
			expect(text).toContain("Full output:");
			expect(mentionsSize(text, CAP), `cap missing in: ${text.slice(-400)}`).toBe(true);
			expect(mentionsSize(text, size), `total missing in: ${text.slice(-400)}`).toBe(true);
		};

		it("on success", async () => {
			const data = makeOutput(size);
			const result = await runTool(data, async () => ({ exitCode: 0 }));
			expectNotice(textOf(result));
			const path = result.details?.fullOutputPath;
			if (!path) throw new Error("No full output path");
			expectCappedFile(readFileSync(path), data);
		}, 60_000);

		it("on a nonzero exit code", async () => {
			const result = await runTool(makeOutput(size), async () => ({ exitCode: 1 }));
			expectNotice(textOf(result));
		}, 60_000);

		it.each([
			["abort", "aborted"],
			["timeout", "timeout:5"],
		])(
			"on %s",
			async (_label, message) => {
				const run = runTool(makeOutput(size), async () => {
					throw new Error(message);
				});
				const error = await run.then(
					() => undefined,
					(err: unknown) => err,
				);
				if (!(error instanceof Error)) throw new Error("Expected the tool to reject");
				expectNotice(error.message);
			},
			60_000,
		);
	});
});
