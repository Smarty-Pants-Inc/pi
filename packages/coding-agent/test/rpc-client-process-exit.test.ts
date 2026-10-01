import type { ChildProcess } from "node:child_process";
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
	// smarty-dev#3048: the client must read authoritative shutdown receipts before detaching stdout.
	test("stop drains the complete attachment-bearing rejection receipt before child close", async () => {
		const attachment = "x".repeat(2 * 1024 * 1024);
		const receipt = {
			type: "input_rejected",
			reason: "shutdown",
			sessionId: "outgoing",
			error: "INPUT_ADMISSION_SHUTDOWN",
			messages: [
				{ role: "user", content: [{ type: "image", data: attachment, mimeType: "image/png" }], timestamp: 0 },
			],
		};
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.on("SIGTERM", () => {
	process.stdout.write(JSON.stringify(${JSON.stringify(receipt)}) + "\\n", () => process.exit(0));
});
process.stdin.resume();
`),
		});
		const events: unknown[] = [];
		client.onEvent((event) => events.push(event));
		let closed: Promise<void> | undefined;
		try {
			await client.start();
			const child = Reflect.get(client, "process") as ChildProcess;
			closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
			await client.stop();
			expect(events).toHaveLength(1);
			expect(events).toEqual([receipt]);
		} finally {
			await client.stop();
			await closed;
		}
	});
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
