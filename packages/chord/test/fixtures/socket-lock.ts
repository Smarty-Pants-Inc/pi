// Exercise the socket-file fallback on every Unix host, including Linux's abstract-socket hosts.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { processLock } from "../../src/manager.ts";

const [mode, value] = process.argv.slice(2);
if (mode === "stale") {
	createServer().listen(value, () => process.exit(0));
} else {
	Object.defineProperty(process, "platform", { value: "darwin" });
	const remove = fs.rm;
	const rename = fs.rename;
	if (mode === "race") {
		fs.rm = async (path, options) => {
			process.send?.("stale");
			await new Promise<void>((resolve) => process.once("message", () => resolve()));
			return remove(path, options);
		};
	} else if (mode === "recover-race" || mode === "recover-crash") {
		fs.rename = async (from, to) => {
			if (mode === "recover-race" ? String(from).includes(".candidate-") : String(from).endsWith(".lock")) {
				process.send?.("stale");
				await new Promise<void>((resolve) => process.once("message", () => resolve()));
			}
			return rename(from, to);
		};
	}
	syncBuiltinESMExports();
	try {
		const release = await processLock(value);
		process.send?.("held");
		if (mode === "crash") await new Promise<void>(() => {});
		process.once("message", () => {
			void release().then(() => process.exit(0));
		});
	} catch {
		process.send?.("locked");
		process.exit(0);
	}
}
