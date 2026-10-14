import { lstat, unlink } from "node:fs/promises";
import { connect, type Server } from "node:net";
import { acquireFileLock } from "../../packages/chord/src/file-lock.ts";

/** Serialize stale cleanup and binding, retaining the guard until close/exit. Stale guards are atomically renamed. */
export async function listenSocket(server: Server, path: string): Promise<void> {
	const removeGuard = process.platform === "win32" ? () => {} : await acquireFileLock(`${path}.lock`);
	let released = false;
	const release = (): void => {
		if (released) return;
		released = true;
		process.removeListener("exit", release);
		server.removeListener("close", release);
		try {
			removeGuard();
		} catch (error) {
			console.error(`TRIAGE_SOCKET ${path} guard cleanup:`, error);
		}
	};
	process.once("exit", release);
	try {
		if (process.platform !== "win32") await prepareSocket(path);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, () => {
				server.removeListener("error", reject);
				server.once("close", release);
				resolve();
			});
		});
	} catch (error) {
		release();
		throw error;
	}
}

/** Refuse non-sockets and live servers; only a stale socket may be removed before listening. */
async function prepareSocket(path: string): Promise<void> {
	try {
		const original = await lstat(path);
		if (!original.isSocket()) throw new Error(`TRIAGE_SOCKET ${path} is not a socket; refusing to remove it`);
		await new Promise<void>((resolve, reject) => {
			const socket = connect(path);
			socket.once("connect", () => {
				socket.destroy();
				reject(new Error(`TRIAGE_SOCKET ${path} is in use`));
			});
			socket.once("error", (error: NodeJS.ErrnoException) => {
				if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve();
				else reject(error);
			});
			socket.setTimeout(1000, () => {
				socket.destroy();
				reject(new Error(`TRIAGE_SOCKET ${path} could not be probed; refusing to remove it`));
			});
		});
		// The probe yielded: do not delete a path replaced while it was in flight.
		const current = await lstat(path);
		if (!current.isSocket() || current.dev !== original.dev || current.ino !== original.ino) {
			throw new Error(`TRIAGE_SOCKET ${path} changed while probing; refusing to remove it`);
		}
		await unlink(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}
