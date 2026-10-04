import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpClient, StdioTransport } from "../src/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));
const stubborn = fileURLToPath(new URL("./fixtures/stubborn-server.mjs", import.meta.url));

describe("StdioTransport", () => {
	// pi#137 / smarty-dev#3535, security finding 9 and A14 (Windows Job Object custody).
	it(
		"retains descendant custody after the stdio leader exits",
		async () => {
			const transport = new StdioTransport({
				command: process.execPath,
				args: [fileURLToPath(new URL("./fixtures/exiting-leader.mjs", import.meta.url))],
				closeTimeoutMs: 100,
			});
			const client = new McpClient({ name: "test", version: "1" });
			let descendant: number | undefined;
			try {
				await client.connect(transport);
				for (let i = 0; i < 100 && descendant === undefined; i++) {
					const match = /descendant (\d+)/.exec(transport.stderr);
					if (match) descendant = Number(match[1]);
					else await new Promise((resolve) => setTimeout(resolve, 10));
				}
				expect(descendant).toBeTypeOf("number");
				await client.close();
				let running = true;
				for (let i = 0; i < 100 && running; i++) {
					try {
						process.kill(descendant as number, 0);
						// Linux may retain a killed orphan as a zombie until the host reaps it.
						if (process.platform === "linux" && /\) Z /.test(readFileSync(`/proc/${descendant}/stat`, "utf8")))
							running = false;
						else await new Promise((resolve) => setTimeout(resolve, 10));
					} catch {
						running = false;
					}
				}
				expect(running).toBe(false);
			} finally {
				await client.close();
				if (descendant !== undefined) {
					try {
						process.kill(descendant, "SIGKILL");
					} catch {}
				}
			}
		},
		process.platform === "win32" ? 40000 : 10000,
	);

	it("connects to a newline-delimited MCP server and captures stderr", async () => {
		const stderr: string[] = [];
		const transport = new StdioTransport({
			command: process.execPath,
			args: [fixture],
			onStderr: (chunk) => stderr.push(chunk),
		});
		const client = new McpClient({ name: "stdio-test", version: "1.0.0" });
		await client.connect(transport);
		expect(await client.listTools()).toEqual([{ name: "echo", inputSchema: { type: "object" } }]);
		expect(await client.callTool("echo", { text: "hello" })).toEqual({
			content: [{ type: "text", text: "hello" }],
		});
		expect(transport.pid).toBeTypeOf("number");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(stderr.join("")).toContain("stdio fixture ready");
		expect(transport.stderr).toContain("stdio fixture ready");
		await client.close();
		expect(client.connectionState).toBe("closed");
	});

	it.skipIf(process.platform === "win32")(
		"kills a server that ignores shutdown, including its children",
		async () => {
			const transport = new StdioTransport({
				command: process.execPath,
				args: [stubborn],
				closeTimeoutMs: 100,
			});
			const client = new McpClient({ name: "stdio-test", version: "1.0.0" });
			await client.connect(transport);
			let grandchild: number | undefined;
			for (let i = 0; i < 100 && grandchild === undefined; i++) {
				const match = /grandchild (\d+)/.exec(transport.stderr);
				if (match) grandchild = Number(match[1]);
				else await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(grandchild).toBeTypeOf("number");

			const startedAt = Date.now();
			await client.close();
			expect(Date.now() - startedAt).toBeLessThan(5_000);
			let alive = true;
			for (let i = 0; i < 100 && alive; i++) {
				try {
					process.kill(grandchild as number, 0);
					await new Promise((resolve) => setTimeout(resolve, 20));
				} catch {
					alive = false;
				}
			}
			expect(alive).toBe(false);
		},
		10_000,
	);
});
