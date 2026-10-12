import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Write OAuth grants readable only by the owner, whatever the umask or the
 * existing file. A fresh exclusive 0600 file replaces the target by rename, so
 * an existing world-readable file or a symlink is replaced, never followed or truncated.
 */
export function writePrivateAuthFile(path: string, content: string): void {
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}
