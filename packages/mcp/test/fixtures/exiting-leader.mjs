// The leader exits on stdin EOF; its same-group descendant ignores SIGTERM and owns no stdio.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const descendant = spawn(process.execPath, [fileURLToPath(new URL("./term-resistant-descendant.mjs", import.meta.url))], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
descendant.once("message", () => {
	console.error(`descendant ${descendant.pid}`);
	descendant.disconnect();
	descendant.unref();
});
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
	const message = JSON.parse(line);
	if (message.method !== "initialize") return;
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "exiting-leader", version: "1" } } })}\n`);
});
lines.on("close", () => process.exit(0));
