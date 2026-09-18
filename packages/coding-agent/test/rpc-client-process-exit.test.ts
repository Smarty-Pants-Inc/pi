import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

type RpcClientPrivate = {
	exitError: Error | null;
};

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
	fatal: true,
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
	test("keeps an uncorrelated parse error nonfatal after startup", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
let input = "";
let sentParseError = false;

process.stdin.on("data", (chunk) => {
	input += chunk;
	while (true) {
		const newlineIndex = input.indexOf("\\n");
		if (newlineIndex === -1) return;
		const line = input.slice(0, newlineIndex);
		input = input.slice(newlineIndex + 1);
		if (!line) continue;
		const command = JSON.parse(line);
		if (!sentParseError) {
			sentParseError = true;
			process.stdout.write(JSON.stringify({
				type: "response",
				command: "parse",
				success: false,
				error: "Failed to parse command: Unexpected token",
			}) + "\\n");
		}
		process.stdout.write(JSON.stringify({
			id: command.id,
			type: "response",
			command: command.type,
			success: true,
			data: { commands: [] },
		}) + "\\n");
	}
});
`),
		});
		// Reach private state to verify the uncorrelated error did not become terminal.
		const privateClient = client as unknown as RpcClientPrivate;
		const events: unknown[] = [];
		client.onEvent((event) => events.push(event));

		try {
			await client.start();

			await expect(client.getCommands()).resolves.toEqual([]);
			await expect(client.getCommands()).resolves.toEqual([]);
			expect(privateClient.exitError).toBeNull();
			expect(events).toEqual([
				{
					type: "response",
					command: "parse",
					success: false,
					error: "Failed to parse command: Unexpected token",
				},
			]);
		} finally {
			await client.stop();
		}
	});
});
