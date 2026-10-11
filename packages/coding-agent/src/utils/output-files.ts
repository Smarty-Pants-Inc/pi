/**
 * Output files: files pi writes so the model can use output it was not shown in full, such as the
 * full text of truncated tool output, binary MCP resources, and images shown by codemode scripts.
 * Every output file is created here, in one directory this process owns, which is bounded in size
 * and removed when the process exits.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { chmodSync, createWriteStream, mkdtempSync, rmSync, unlinkSync, type WriteStream } from "node:fs";
import { chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Output can carry private data, so only the user may read the files. */
const OUTPUT_FILE_MODE = 0o600;

/** Bytes the files in the owned output directory may hold together. */
export const MAX_OUTPUT_DIRECTORY_BYTES = 512 * 1024 * 1024;

/**
 * Only writes through this module count toward the bound, so the owned files and directory are
 * read-only at rest: an append to a returned path, or a rename into the directory, fails with EACCES.
 * ponytail: a tool running as the same user can chmod them back on purpose. This stops accidental
 * growth through the returned paths, not a hostile process.
 */
const READ_ONLY_FILE_MODE = 0o400;
const SEALED_DIRECTORY_MODE = 0o500;
const OPEN_DIRECTORY_MODE = 0o700;

let ownedDirectory: string | undefined;
let ownedBytes = 0;
/** Writes in progress; the directory is writable only while there is one. */
let activeWrites = 0;

/** Bytes counted toward {@link MAX_OUTPUT_DIRECTORY_BYTES}. Exported for tests. */
export function getOutputDirectoryBytes(): number {
	return ownedBytes;
}

function limitError(): Error {
	return new Error(`output files would exceed ${MAX_OUTPUT_DIRECTORY_BYTES} bytes for this session`);
}

/**
 * A new, unused path: `<owned dir>/<prefix>-<random hex><extension>`. `extension` includes the dot.
 * A prefix or extension with a path separator or `..` could leave the owned directory, so it is refused.
 */
function createOutputFilePath(prefix: string, extension: string): string {
	for (const part of [prefix, extension]) {
		if (/[\\/]|\.\./.test(part)) throw new Error(`Invalid output file name part ${JSON.stringify(part)}`);
	}
	return join(getOutputDirectory(), `${prefix}-${randomBytes(8).toString("hex")}${extension}`);
}

/** Run `fn` with the owned directory writable, unless a write in progress already opened it. */
function withOpenDirectory<T>(fn: () => T): T {
	const directory = getOutputDirectory();
	if (activeWrites === 0) chmodSync(directory, OPEN_DIRECTORY_MODE);
	try {
		return fn();
	} finally {
		if (activeWrites === 0) chmodSync(directory, SEALED_DIRECTORY_MODE);
	}
}

/** Remove the owned output directory. Runs on process exit; exported for tests. */
export function removeOutputDirectory(): void {
	if (ownedDirectory === undefined) return;
	// The sealed directory's entries cannot be removed until it is writable again.
	try {
		chmodSync(ownedDirectory, OPEN_DIRECTORY_MODE);
	} catch {
		// Already gone; rmSync with force accepts that.
	}
	rmSync(ownedDirectory, { recursive: true, force: true });
	ownedDirectory = undefined;
	ownedBytes = 0;
}

/**
 * The owned output directory, created on first use. `mkdtemp` creates it exclusively with mode 0700,
 * so other accounts cannot list it or read its files, and it is never a directory someone else made.
 * At rest it is sealed to 0500.
 */
export function getOutputDirectory(): string {
	if (ownedDirectory === undefined) {
		ownedDirectory = mkdtempSync(join(tmpdir(), "pi-output-"));
		chmodSync(ownedDirectory, SEALED_DIRECTORY_MODE);
		// `exit` also runs after an uncaught error and after pi's signal and abort handlers call process.exit().
		process.once("exit", removeOutputDirectory);
	}
	return ownedDirectory;
}

/**
 * Write `data` to a new output file and return its path. Throws, writing nothing, when the directory
 * would exceed {@link MAX_OUTPUT_DIRECTORY_BYTES}; a failed write leaves no partial file.
 */
export async function writeOutputFile(prefix: string, extension: string, data: string | Uint8Array): Promise<string> {
	const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
	if (ownedBytes + bytes > MAX_OUTPUT_DIRECTORY_BYTES) throw limitError();
	const path = createOutputFilePath(prefix, extension);
	const directory = getOutputDirectory();
	ownedBytes += bytes;
	if (activeWrites++ === 0) chmodSync(directory, OPEN_DIRECTORY_MODE);
	try {
		// `wx` never follows a link someone else placed at the path.
		await writeFile(path, data, { mode: OUTPUT_FILE_MODE, flag: "wx" });
		await chmod(path, READ_ONLY_FILE_MODE);
	} catch (error) {
		ownedBytes -= bytes;
		// EEXIST means the path belongs to an earlier file, which stays.
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") await rm(path, { force: true }).catch(() => undefined);
		throw error;
	} finally {
		if (--activeWrites === 0) chmodSync(directory, SEALED_DIRECTORY_MODE);
	}
	return path;
}

/**
 * Open a new output file for streamed output. Every chunk counts toward
 * {@link MAX_OUTPUT_DIRECTORY_BYTES}; a chunk past it fails the stream with the limit error. A failed
 * stream's file is removed and its bytes are no longer counted.
 */
export function createOutputFileStream(prefix: string, extension: string): { path: string; stream: WriteStream } {
	let path: string;
	try {
		path = createOutputFilePath(prefix, extension);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Invalid output file name")) throw error;
		// The owned directory could not be made. Report it on the stream, like any other open error.
		path = join(tmpdir(), `${prefix}-unavailable${extension}`);
		const failOpen = (...args: unknown[]) => (args.at(-1) as (error: unknown) => void)(error);
		return { path, stream: createWriteStream(path, { fs: { ...fs, open: failOpen } }) };
	}
	// The directory stays writable until the stream's asynchronous open has created the file.
	const directory = getOutputDirectory();
	if (activeWrites++ === 0) chmodSync(directory, OPEN_DIRECTORY_MODE);
	let opening = true;
	const opened = () => {
		if (!opening) return;
		opening = false;
		if (--activeWrites === 0 && ownedDirectory === directory) chmodSync(directory, SEALED_DIRECTORY_MODE);
	};
	// Created read-only: the stream's descriptor can write, later opens cannot. `wx` never follows a
	// link someone else placed at the path.
	const stream = createWriteStream(path, { mode: READ_ONLY_FILE_MODE, flags: "wx" });
	let created = false;
	stream.once("open", () => {
		created = true;
		opened();
	});
	let counted = 0;
	const charge = (bytes: number): Error | undefined => {
		if (ownedBytes + bytes > MAX_OUTPUT_DIRECTORY_BYTES) return limitError();
		ownedBytes += bytes;
		counted += bytes;
		return undefined;
	};
	const write = stream._write.bind(stream);
	stream._write = (chunk: Buffer, encoding, callback) => {
		const error = charge(chunk.length);
		if (error) callback(error);
		else write(chunk, encoding, callback);
	};
	const writev = stream._writev?.bind(stream);
	if (writev) {
		stream._writev = (chunks, callback) => {
			const error = charge(chunks.reduce((sum, { chunk }) => sum + (chunk as Buffer).length, 0));
			if (error) callback(error);
			else writev(chunks, callback);
		};
	}
	stream.once("close", () => {
		opened();
		// Only a file this stream created is removed, never one that was already at the path.
		if (!stream.errored || !created || ownedDirectory !== directory) return;
		ownedBytes -= counted;
		try {
			withOpenDirectory(() => unlinkSync(path));
		} catch {
			// Already gone.
		}
	});
	return { path, stream };
}
