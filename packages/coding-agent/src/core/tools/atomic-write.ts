import { randomBytes } from "node:crypto";
import { type FileHandle, lstat, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

function errorCode(error: unknown): unknown {
	return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/**
 * Replace a file so that no reader sees it truncated or half written (smarty-dev#977).
 * Writes a unique temp file next to the real target, fsyncs it, keeps the existing mode,
 * then renames it over the target. A symlink stays a symlink; its real file gets the content.
 *
 * ponytail: rename gives the file a new inode, so hard links to it split and the owner
 * becomes the current user. Three cases keep the old in-place write: a target that is not
 * a regular file (FIFO, socket, device), a dangling symlink, and a directory where we may
 * not create the temp file (EACCES/EPERM). Revisit if a user needs these atomic too.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
	let target = resolve(path);
	let mode: number | undefined;
	try {
		target = await realpath(target);
		const stats = await stat(target);
		if (!stats.isFile()) return writeFile(target, content, "utf-8");
		mode = stats.mode & 0o7777;
	} catch (error) {
		const code = errorCode(error);
		if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
		const link = await lstat(target).catch(() => undefined);
		if (link?.isSymbolicLink()) return writeFile(path, content, "utf-8");
	}

	// Fixed-length name: a target name near the 255-byte limit must still get a temp file.
	const temp = join(dirname(target), `.pi-${randomBytes(8).toString("hex")}.tmp`);
	let handle: FileHandle;
	try {
		handle = await open(temp, "wx", mode ?? 0o666);
	} catch (error) {
		const code = errorCode(error);
		if (code === "EACCES" || code === "EPERM") return writeFile(target, content, "utf-8");
		throw error;
	}
	try {
		try {
			await handle.writeFile(content, "utf-8");
			// open() applies the umask; chmod restores the exact existing mode.
			if (mode !== undefined) await handle.chmod(mode);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, target);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}
