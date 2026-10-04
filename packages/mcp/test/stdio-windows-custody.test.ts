import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), crossSpawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:process", () => ({ default: { platform: "win32", env: {}, stderr: { write: vi.fn() } } }));
vi.mock("cross-spawn", () => ({
	default: Object.assign(mocks.crossSpawn, {
		_parse: (command: string, args: readonly string[], options: SpawnOptions) => ({ command, args, options }),
	}),
}));

import { StdioTransport } from "../src/transports/stdio.ts";

// pi#137 / smarty-dev#3535, A14. This drives the transport, not only the guardian helper.
it("does not report Windows owner cleanup complete when the leader has exited but job termination is pending", async () => {
	const guardian = Object.assign(new EventEmitter(), {
		pid: 123,
		exitCode: 0,
		signalCode: null,
		stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		kill: vi.fn(),
	});
	const cleanup = new EventEmitter();
	mocks.crossSpawn.mockImplementation(() => {
		queueMicrotask(() => guardian.emit("spawn"));
		return guardian;
	});
	mocks.spawn
		.mockImplementationOnce((_command: string, args: string[]) => {
			const script = Buffer.from(args[3], "base64").toString("utf16le");
			const marker = [...script.matchAll(/FromBase64String\('([^']+)'\)/g)]
				.map((match) => Buffer.from(match[1], "base64").toString("utf8"))
				.find((value) => value.startsWith("MCP_JOB_READY_"));
			queueMicrotask(() => {
				guardian.emit("spawn");
				guardian.stderr.emit("data", Buffer.from(`${marker}\n`));
			});
			return guardian;
		})
		.mockReturnValueOnce(cleanup);
	const transport = new StdioTransport({ command: "node", args: ["fixture.js"] });
	const onClose = vi.fn();
	transport.onClose(onClose);
	await transport.start();
	let completed = false;
	const closing = transport.close().then(() => {
		completed = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	guardian.emit("close", 0);
	expect(completed).toBe(false);
	expect(onClose).not.toHaveBeenCalled();
	expect(mocks.spawn).toHaveBeenCalledTimes(2);
	cleanup.emit("close", 0);
	await closing;
	expect(completed).toBe(true);
	expect(onClose).toHaveBeenCalledExactlyOnceWith();
});
