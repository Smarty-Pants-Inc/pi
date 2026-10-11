/**
 * Herdr's newline-delimited JSON API over its Unix socket (smarty-dev#2636):
 * `{id, method, params}` -> `{id, result}` or `{id, error}`. An error, timeout or close rejects.
 */
import { createConnection, type Socket } from "node:net";

export type Rpc = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export function connectRpc(socketPath: string, timeoutMs: number): { rpc: Rpc; close(): void } {
	const socket: Socket = createConnection(socketPath);
	socket.setEncoding("utf8");
	const pending = new Map<string, { resolve(v: Record<string, unknown>): void; reject(e: Error): void }>();
	let buffer = "";
	let next = 0;
	const failAll = (error: Error) => {
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
	};
	socket.on("data", (data: string) => {
		buffer += data;
		for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
			const line = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof message !== "object" || message === null) continue;
			const { id, result } = message as { id?: unknown; result?: unknown };
			const waiter = typeof id === "string" ? pending.get(id) : undefined;
			if (!waiter) continue;
			pending.delete(id as string);
			if (typeof result === "object" && result !== null) waiter.resolve(result as Record<string, unknown>);
			else waiter.reject(new Error("refused"));
		}
	});
	socket.on("error", (error) => failAll(error));
	socket.on("close", () => failAll(new Error("closed")));
	const rpc: Rpc = (method, params) =>
		new Promise((resolve, reject) => {
			const id = `pi-ic-${++next}`;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error("timeout"));
			}, timeoutMs);
			pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			socket.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	return { rpc, close: () => socket.destroy() };
}
