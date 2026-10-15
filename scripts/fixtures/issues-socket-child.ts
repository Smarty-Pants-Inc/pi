import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { listenSocket } from "../issues/socket.ts";

const [path, mode] = process.argv.slice(2);
const rename = fs.rename;
if (mode === "recover-race") {
	fs.rename = async (from, to) => {
		if (String(from).includes(".candidate-") && String(to).includes(".recovery-")) {
			process.send?.("stale");
			await new Promise<void>((resolve) => process.once("message", () => resolve()));
		}
		return rename(from, to);
	};
	syncBuiltinESMExports();
}
const server = createServer((socket) => socket.end());
try {
	await listenSocket(server, path);
	process.send?.("held");
	process.once("message", () => server.close(() => process.exit(0)));
} catch {
	process.send?.("blocked");
	process.exit(0);
}
