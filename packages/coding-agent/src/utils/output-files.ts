/**
 * Output files: files pi writes so the model can use output it was not shown in full, such as the
 * full text of truncated tool output, binary MCP resources, and images shown by codemode scripts.
 * Every output file is created here, so where they are stored can change in one place. Streamed
 * files go to the OS temp directory. Whole files from {@link writeOutputFile} go to one directory
 * this process owns, which is bounded in size and removed when the process exits.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, mkdtempSync, rmSync, type WriteStream } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Output can carry private data, so only the user may read the files. */
const OUTPUT_FILE_MODE = 0o600;

/** Bytes the files in the owned output directory may hold together. */
export const MAX_OUTPUT_DIRECTORY_BYTES = 512 * 1024 * 1024;

let ownedDirectory: string | undefined;
let ownedBytes = 0;

/** A new, unused path: `<dir>/<prefix>-<random hex><extension>`. `extension` includes the dot. */
function createOutputFilePath(prefix: string, extension: string, directory = tmpdir()): string {
	return join(directory, `${prefix}-${randomBytes(8).toString("hex")}${extension}`);
}

/** Remove the owned output directory. Runs on process exit; exported for tests. */
export function removeOutputDirectory(): void {
	if (ownedDirectory === undefined) return;
	rmSync(ownedDirectory, { recursive: true, force: true });
	ownedDirectory = undefined;
	ownedBytes = 0;
}

/**
 * The owned output directory, created on first use. `mkdtemp` creates it exclusively with mode 0700,
 * so other accounts cannot list it or read its files, and it is never a directory someone else made.
 */
export function getOutputDirectory(): string {
	if (ownedDirectory === undefined) {
		ownedDirectory = mkdtempSync(join(tmpdir(), "pi-output-"));
		// `exit` also runs after an uncaught error and after pi's signal and abort handlers call process.exit().
		process.once("exit", removeOutputDirectory);
	}
	return ownedDirectory;
}

/**
 * Write `data` to a new file in the owned output directory and return its path. Throws, writing
 * nothing, when the directory would exceed {@link MAX_OUTPUT_DIRECTORY_BYTES}; a failed write leaves
 * no partial file.
 */
export async function writeOutputFile(prefix: string, extension: string, data: string | Uint8Array): Promise<string> {
	const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
	if (ownedBytes + bytes > MAX_OUTPUT_DIRECTORY_BYTES) {
		throw new Error(`output files would exceed ${MAX_OUTPUT_DIRECTORY_BYTES} bytes for this session`);
	}
	const path = createOutputFilePath(prefix, extension, getOutputDirectory());
	ownedBytes += bytes;
	try {
		// `wx` never follows a link someone else placed at the path.
		await writeFile(path, data, { mode: OUTPUT_FILE_MODE, flag: "wx" });
	} catch (error) {
		ownedBytes -= bytes;
		// EEXIST means the path belongs to an earlier file, which stays.
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") await rm(path, { force: true }).catch(() => undefined);
		throw error;
	}
	return path;
}

/** Open a new output file for streamed output. */
export function createOutputFileStream(prefix: string, extension: string): { path: string; stream: WriteStream } {
	const path = createOutputFilePath(prefix, extension);
	return { path, stream: createWriteStream(path, { mode: OUTPUT_FILE_MODE, flags: "wx" }) };
}
