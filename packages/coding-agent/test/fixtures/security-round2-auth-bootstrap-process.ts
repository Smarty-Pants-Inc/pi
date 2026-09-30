import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { FileAuthStorageBackend } from "../../src/core/auth-storage.ts";

const [directory, role, kind, committedBytes] = process.argv.slice(2);
const path = join(directory, "mcp-auth.json");
const write = fs.writeFileSync;
const marker = (name: string, value: unknown) => write(join(directory, name), JSON.stringify(value));

// #2241: split the real exclusive open and first native write, keeping the same descriptor/inode.
if (role === "A") {
	fs.writeFileSync = (candidate, data, options) => {
		if (candidate !== path || data !== "{}" || typeof options !== "object" || options?.flag !== "wx") {
			return write(candidate, data, options);
		}
		const fd = fs.openSync(path, "wx", options.mode);
		try {
			marker("opened", { inode: fs.fstatSync(fd).ino, locked: fs.existsSync(`${path}.lock`) });
			const deadline = Date.now() + 10_000;
			const sleeper = new Int32Array(new SharedArrayBuffer(4));
			while (!fs.existsSync(join(directory, "resume-A"))) {
				if (Date.now() >= deadline) throw new Error("Native bootstrap gate timed out");
				Atomics.wait(sleeper, 0, 0, 5);
			}
			fs.writeSync(fd, "{}", 0, "utf8");
			marker("initialized", { bytes: fs.readFileSync(path, "utf8"), inode: fs.fstatSync(fd).ino });
		} finally {
			fs.closeSync(fd);
		}
	};
	syncBuiltinESMExports();
} else {
	const lock = lockfile.lock;
	lockfile.lock = async (file, options) => {
		try {
			const release = await lock(file, options);
			marker("B-acquired", { initialized: fs.existsSync(join(directory, "initialized")) });
			return release;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ELOCKED") marker("B-contended", true);
			throw error;
		}
	};
}

try {
	const backend = new FileAuthStorageBackend(path);
	const operation = (current: string | undefined) => {
		if (role === "A") return { result: undefined };
		// This is the actual MCP parser's empty-input behavior, followed by its pretty JSON write.
		const parsed: unknown = current?.trim() ? JSON.parse(current) : {};
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Invalid state");
		marker("B-callback", { current, inode: fs.statSync(path).ino, locked: fs.existsSync(`${path}.lock`) });
		return { result: undefined, next: committedBytes };
	};
	if (role === "A" && kind === "sync") backend.withLock(operation);
	else await backend.withLockAsync(async (current) => operation(current));
	marker(`${role}-done`, { bytes: fs.readFileSync(path, "utf8"), inode: fs.statSync(path).ino });
} catch (error) {
	marker(`${role}-error`, String(error));
	process.exitCode = 1;
}
