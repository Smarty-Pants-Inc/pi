/**
 * Codemode host limits that live in coding-agent (pi#131 round-1 P1-3 and P1-4, smarty-dev#4506).
 * Codemode stays refused, so these call the internals directly.
 */
import { appendFileSync, lstatSync, mkdtempSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsCalls = vi.hoisted(() => ({
	rmSync: [] as { path: string; mode: number | undefined }[],
	rm: [] as string[],
	unlinkSync: [] as string[],
	failWrite: false,
}));

// Recorded-call probes: the tests never delete anything (smarty-dev#4664).
vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	return {
		...original,
		// Records the directory's mode at removal time, to show it was made writable first.
		rmSync: (path: string) => {
			fsCalls.rmSync.push({ path, mode: original.statSync(path, { throwIfNoEntry: false })?.mode });
		},
		unlinkSync: (path: string) => {
			fsCalls.unlinkSync.push(path);
		},
	};
});
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...original,
		rm: async (path: string) => {
			fsCalls.rm.push(path);
		},
		writeFile: async (...args: Parameters<typeof original.writeFile>) => {
			if (!fsCalls.failWrite) return original.writeFile(...args);
			await original.writeFile(...args);
			throw Object.assign(new Error("no space"), { code: "ENOSPC" });
		},
	};
});

const { createLimiter } = await import("../src/extensions/codemode/execute.ts");
const {
	createOutputFileStream,
	getOutputDirectory,
	getOutputDirectoryBytes,
	MAX_OUTPUT_DIRECTORY_BYTES,
	removeOutputDirectory,
	writeOutputFile,
} = await import("../src/utils/output-files.ts");
const { finished } = await import("node:stream/promises");

describe("model call limiter", () => {
	it("drops a queued waiter as soon as its signal aborts", async () => {
		const limit = createLimiter(1);
		let release!: () => void;
		const first = limit(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
			new AbortController().signal,
		);
		const controller = new AbortController();
		let ran = false;
		const queued = limit(async () => {
			ran = true;
		}, controller.signal);
		controller.abort(new Error("script finished"));
		await expect(queued).rejects.toThrow("script finished");
		release();
		await first;
		expect(ran).toBe(false);
		// The slot is free again for a live caller.
		await expect(limit(async () => "next", new AbortController().signal)).resolves.toBe("next");
	});

	it("rejects at once when the signal is already aborted and the limiter is full", async () => {
		const limit = createLimiter(1);
		const hold = limit(() => new Promise(() => {}), new AbortController().signal);
		void hold;
		await expect(limit(async () => 1, AbortSignal.abort(new Error("gone")))).rejects.toThrow("gone");
	});
});

describe("owned output directory", () => {
	afterEach(() => {
		fsCalls.failWrite = false;
		removeOutputDirectory();
	});

	it("writes output files into a directory this process owns, read-only at rest", async () => {
		const path = await writeOutputFile("pi-codemode", ".txt", "private");
		const directory = getOutputDirectory();
		expect(dirname(path)).toBe(directory);
		const stats = lstatSync(directory);
		expect(stats.isDirectory()).toBe(true);
		expect(stats.mode & 0o777).toBe(0o500);
		expect(stats.uid).toBe(process.getuid?.());
		expect(lstatSync(path).mode & 0o777).toBe(0o400);
	});

	// pi#203 R2: only writeOutputFile counts toward the bound, so nothing else may grow the directory.
	it("rejects an append to a returned path, leaving its size unchanged", async () => {
		const path = await writeOutputFile("pi-codemode", ".txt", "private");
		const size = statSync(path).size;
		expect(() => appendFileSync(path, "more")).toThrow(expect.objectContaining({ code: "EACCES" }));
		expect(statSync(path).size).toBe(size);
	});

	it("rejects a rename of another file into the directory", async () => {
		await writeOutputFile("pi-codemode", ".txt", "x");
		const directory = getOutputDirectory();
		const outside = join(mkdtempSync(join(tmpdir(), "pi-output-test-")), "big.bin");
		writeFileSync(outside, "big");
		const before = readdirSync(directory).length;
		expect(() => renameSync(outside, join(directory, "big.bin"))).toThrow(
			expect.objectContaining({ code: "EACCES" }),
		);
		expect(readdirSync(directory)).toHaveLength(before);
	});

	it("still writes new files after a rejected append and rename", async () => {
		const first = await writeOutputFile("pi-codemode", ".txt", "one");
		const directory = getOutputDirectory();
		expect(() => appendFileSync(first, "more")).toThrow();
		const outside = join(mkdtempSync(join(tmpdir(), "pi-output-test-")), "f");
		writeFileSync(outside, "f");
		expect(() => renameSync(outside, join(directory, "f"))).toThrow();
		const [second, third] = await Promise.all([
			writeOutputFile("pi-codemode", ".txt", "two"),
			writeOutputFile("pi-codemode", ".txt", "three"),
		]);
		expect(readdirSync(directory).sort()).toEqual(
			[first, second, third].map((path) => path.slice(directory.length + 1)).sort(),
		);
		expect(lstatSync(directory).mode & 0o777).toBe(0o500);
	});

	it("refuses a write that would pass the size bound, writing nothing", async () => {
		await writeOutputFile("pi-codemode", ".txt", "x");
		const directory = getOutputDirectory();
		const before = readdirSync(directory).length;
		await expect(writeOutputFile("pi-codemode", ".bin", new Uint8Array(MAX_OUTPUT_DIRECTORY_BYTES))).rejects.toThrow(
			/would exceed/,
		);
		expect(readdirSync(directory)).toHaveLength(before);
	});

	it("removes a partial file when a write fails", async () => {
		fsCalls.failWrite = true;
		await expect(writeOutputFile("pi-codemode", ".txt", "partial")).rejects.toThrow("no space");
		expect(fsCalls.rm.at(-1)).toMatch(/pi-codemode-[0-9a-f]+\.txt$/);
		expect(dirname(fsCalls.rm.at(-1) ?? "")).toBe(getOutputDirectory());
	});

	// pi#203 R2 SEC P1: streamed output counts toward the same bound.
	it("fails a stream that passes the size bound, removes its file, and uncounts its bytes", async () => {
		const before = getOutputDirectoryBytes();
		const { path, stream } = createOutputFileStream("pi-bash", ".log");
		expect(dirname(path)).toBe(getOutputDirectory());
		stream.write("start\n");
		stream.write(new Uint8Array(MAX_OUTPUT_DIRECTORY_BYTES));
		stream.end();
		await expect(finished(stream)).rejects.toThrow(/would exceed/);
		await new Promise((resolve) => setImmediate(resolve));
		// Recorded-call probe for the removal (smarty-dev#4664).
		expect(fsCalls.unlinkSync).toContain(path);
		expect(getOutputDirectoryBytes()).toBe(before);
	});

	it("counts a stream that fits and keeps its file read-only to later opens", async () => {
		const { path, stream } = createOutputFileStream("pi-bash", ".log");
		stream.end("hello\n");
		await finished(stream);
		expect(getOutputDirectoryBytes()).toBe(6);
		expect(() => appendFileSync(path, "more")).toThrow(expect.objectContaining({ code: "EACCES" }));
	});

	// pi#203 R2 SEC P2: a name part must not leave the owned directory.
	it("refuses a prefix or extension with a path segment", async () => {
		await expect(writeOutputFile("../x", ".txt", "x")).rejects.toThrow(/Invalid output file name/);
		await expect(writeOutputFile("x", "/../../y", "x")).rejects.toThrow(/Invalid output file name/);
		expect(() => createOutputFileStream("a\\b", ".log")).toThrow(/Invalid output file name/);
		expect(getOutputDirectoryBytes()).toBe(0);
	});

	it("removes the directory when the process exits, including after errors and aborts", async () => {
		await writeOutputFile("pi-codemode", ".txt", "x");
		const directory = getOutputDirectory();
		expect(process.listeners("exit")).toContain(removeOutputDirectory);
		removeOutputDirectory();
		// Made writable again before the removal, so the read-only entries can be removed.
		expect(fsCalls.rmSync.at(-1)).toEqual({ path: directory, mode: expect.any(Number) });
		expect((fsCalls.rmSync.at(-1)?.mode ?? 0) & 0o777).toBe(0o700);
	});
});
