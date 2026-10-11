/**
 * Codemode host limits that live in coding-agent (pi#131 round-1 P1-3 and P1-4, smarty-dev#4506).
 * Codemode stays refused, so these call the internals directly.
 */
import { lstatSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsCalls = vi.hoisted(() => ({ rmSync: [] as string[], rm: [] as string[], failWrite: false }));

// Recorded-call probes: the tests never delete anything (smarty-dev#4664).
vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	rmSync: (path: string) => {
		fsCalls.rmSync.push(path);
	},
}));
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
const { getOutputDirectory, MAX_OUTPUT_DIRECTORY_BYTES, removeOutputDirectory, writeOutputFile } = await import(
	"../src/utils/output-files.ts"
);

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

	it("writes output files into a directory this process owns, mode 0700", async () => {
		const path = await writeOutputFile("pi-codemode", ".txt", "private");
		const directory = getOutputDirectory();
		expect(dirname(path)).toBe(directory);
		const stats = lstatSync(directory);
		expect(stats.isDirectory()).toBe(true);
		expect(stats.mode & 0o777).toBe(0o700);
		expect(stats.uid).toBe(process.getuid?.());
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
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

	it("removes the directory when the process exits, including after errors and aborts", async () => {
		await writeOutputFile("pi-codemode", ".txt", "x");
		const directory = getOutputDirectory();
		expect(process.listeners("exit")).toContain(removeOutputDirectory);
		removeOutputDirectory();
		expect(fsCalls.rmSync.at(-1)).toBe(directory);
	});
});
