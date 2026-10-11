/**
 * Output files: files pi writes so the model can use output it was not shown in full, such as the
 * full text of truncated tool output, binary MCP resources, and images shown by codemode scripts.
 * Every output file is created here, in one directory this process owns, which is bounded in size
 * and removed when the process exits.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { chmodSync, createWriteStream, mkdtempSync, openSync, rmSync, unlinkSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Bytes the files in the owned output directory may hold together. */
export const MAX_OUTPUT_DIRECTORY_BYTES = 512 * 1024 * 1024;

/**
 * Only writes through this module count toward the bound, so the owned files and directory are
 * read-only at rest: an append to a returned path, or a rename into the directory, fails with EACCES.
 * The directory is writable only inside {@link withOpenDirectory}, which never spans an await.
 * ponytail: a tool running as the same user can chmod them back on purpose. This stops accidental
 * growth through the returned paths, not a hostile process.
 */
const READ_ONLY_FILE_MODE = 0o400;
const SEALED_DIRECTORY_MODE = 0o500;
const OPEN_DIRECTORY_MODE = 0o700;

let ownedDirectory: string | undefined;
let ownedBytes = 0;

/** Bytes counted toward {@link MAX_OUTPUT_DIRECTORY_BYTES}. Exported for tests. */
export function getOutputDirectoryBytes(): number {
	return ownedBytes;
}

function limitError(): Error {
	return new Error(`output files would exceed ${MAX_OUTPUT_DIRECTORY_BYTES} bytes for this session`);
}

/** A prefix or extension that could leave the owned directory, or that the filesystem rejects. */
function checkNamePart(part: string): void {
	if (/[\\/\0]|\.\./.test(part)) throw new Error(`Invalid output file name part ${JSON.stringify(part)}`);
}

/** Run synchronous `fn` with the owned directory writable, and seal it again before returning. */
function withOpenDirectory<T>(directory: string, fn: () => T): T {
	chmodSync(directory, OPEN_DIRECTORY_MODE);
	try {
		return fn();
	} finally {
		chmodSync(directory, SEALED_DIRECTORY_MODE);
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
		const directory = mkdtempSync(join(tmpdir(), "pi-output-"));
		chmodSync(directory, SEALED_DIRECTORY_MODE);
		ownedDirectory = directory;
		// `exit` also runs after an uncaught error and after pi's signal and abort handlers call process.exit().
		process.once("exit", removeOutputDirectory);
	}
	return ownedDirectory;
}

/**
 * Write `data` to a new output file and return its path. Throws, writing nothing, when the directory
 * would exceed {@link MAX_OUTPUT_DIRECTORY_BYTES}; a failed write leaves no file.
 */
export async function writeOutputFile(prefix: string, extension: string, data: string | Uint8Array): Promise<string> {
	const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
	if (ownedBytes + bytes > MAX_OUTPUT_DIRECTORY_BYTES) throw limitError();
	const { path, stream } = createOutputFileStream(prefix, extension);
	await new Promise<void>((resolve, reject) => {
		// Rejects after the stream's own close handler, which removes the file of a failed stream.
		stream.on("error", () => undefined);
		stream.once("close", () => (stream.errored ? reject(stream.errored) : resolve()));
		stream.end(data);
	});
	return path;
}

/**
 * Open a new output file for streamed output. The file is created synchronously, so the directory is
 * sealed again before this returns. Every chunk counts toward {@link MAX_OUTPUT_DIRECTORY_BYTES}; a
 * chunk past it fails the stream with the limit error. A failed stream's file is removed and its
 * bytes are no longer counted. Other failures, such as an existing file at the path, arrive on the
 * stream like any open error.
 */
export function createOutputFileStream(prefix: string, extension: string): { path: string; stream: WriteStream } {
	checkNamePart(prefix);
	checkNamePart(extension);
	const name = `${prefix}-${randomBytes(8).toString("hex")}${extension}`;
	let directory: string;
	let path: string;
	let fd: number;
	try {
		directory = getOutputDirectory();
		path = join(directory, name);
		const target = path;
		// Created read-only: this descriptor can write, later opens cannot. `wx` never follows a link
		// someone else placed at the path.
		fd = withOpenDirectory(directory, () => openSync(target, "wx", READ_ONLY_FILE_MODE));
	} catch (error) {
		const failOpen = (...args: unknown[]) => (args.at(-1) as (error: unknown) => void)(error);
		path ??= join(tmpdir(), name);
		return { path, stream: createWriteStream(path, { fs: { ...fs, open: failOpen } }) };
	}
	const stream = createWriteStream(path, { fd });
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
	const created = path;
	stream.once("close", () => {
		if (!stream.errored || ownedDirectory !== directory) return;
		ownedBytes -= counted;
		try {
			withOpenDirectory(directory, () => unlinkSync(created));
		} catch {
			// Already gone.
		}
	});
	return { path, stream };
}
