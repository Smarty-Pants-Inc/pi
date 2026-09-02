import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-exit-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient child process failures", () => {
	test("rejects an in-flight request when the child process exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => {
	process.exit(43);
});
process.stdin.resume();
`),
		});

		await client.start();

		await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
	});
	test("surfaces fatal startup overflow without treating it as an agent event", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdout.write(JSON.stringify({
	type: "response",
	command: "parse",
	success: false,
	error: "RPC startup command queue limit exceeded",
}) + "\\n");
setTimeout(() => process.exit(1), 10);
`),
		});
		const events: unknown[] = [];
		client.onEvent((event) => events.push(event));

		await expect(client.start()).rejects.toThrow("RPC startup command queue limit exceeded");
		expect(events).toEqual([]);
	});
});
