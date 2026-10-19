// Exercise the socket-file fallback on every Unix host, including Linux's abstract-socket hosts.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { ChordError } from "../../src/errors.ts";
import { processLock } from "../../src/manager.ts";

const [mode, value] = process.argv.slice(2);
if (mode === "stale") {
	createServer().listen(value, () => process.exit(0));
} else {
	if (mode !== "fail") Object.defineProperty(process, "platform", { value: "darwin" });
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
		if (mode === "fail") throw new Error("synthetic process-lock failure");
		const release = await processLock(value);
		process.send?.("held");
		if (mode === "crash") await new Promise<void>(() => {});
		process.once("message", () => {
			void release().then(() => process.exit(0));
		});
	} catch (error) {
		const locked = error instanceof ChordError && error.code === "unavailable" && error.reason === "locked";
		const message = locked
			? "locked"
			: { type: "error", message: error instanceof Error ? error.message : String(error) };
		const exitCode = locked ? 0 : 1;
		if (process.send) process.send(message, () => process.exit(exitCode));
		else process.exit(exitCode);
	}
}
