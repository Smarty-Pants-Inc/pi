import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import { spawnWindowsJob } from "../src/transports/windows-job.ts";

beforeEach(() => mocks.spawn.mockReset());

// pi#137 / smarty-dev#3535, A14. Native exiting-leader coverage is in stdio.test.ts.
it("retains named-job custody after leader exit and awaits the termination helper", async () => {
	const guardian = Object.assign(new EventEmitter(), {
		pid: 123,
		exitCode: 0,
		signalCode: null,
		stdin: new EventEmitter(),
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		kill: vi.fn(),
	});
	const terminator = new EventEmitter();
	mocks.spawn.mockReturnValueOnce(guardian).mockReturnValueOnce(terminator);
	const job = spawnWindowsJob("node", ["fixture.js"], { env: { PATH: "test-path" } });
	const encoded = mocks.spawn.mock.calls[0][1][3] as string;
	const script = Buffer.from(encoded, "base64").toString("utf16le");
	const marker = [...script.matchAll(/FromBase64String\('([^']+)'\)/g)]
		.map((match) => Buffer.from(match[1], "base64").toString("utf8"))
		.find((value) => value.startsWith("MCP_JOB_READY_"));
	expect(marker).toBeDefined();
	guardian.stderr.emit("data", Buffer.from(`${marker}\n`));
	await job.ready;
	let completed = false;
	const closing = job.close().then(() => {
		completed = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(mocks.spawn).toHaveBeenCalledTimes(2);
	expect(completed).toBe(false);
	expect(guardian.kill).not.toHaveBeenCalled();
	const cleanup = Buffer.from(mocks.spawn.mock.calls[1][1][3] as string, "base64").toString("utf16le");
	expect(cleanup).toContain("TerminateAndWait");
	expect(cleanup).toContain("OpenJobObject");
	terminator.emit("close", 0);
	await closing;
	expect(completed).toBe(true);
});

// pi#137 / smarty-dev#3535, A14: a trusted guardian must not widen inheritEnv:false.
it("keeps target environment values out of command-line scripts and preserves Windows key selection", async () => {
	const guardian = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn() });
	const cleanup = new EventEmitter();
	mocks.spawn.mockReturnValueOnce(guardian).mockReturnValueOnce(cleanup);
	const job = spawnWindowsJob("node", [], {
		env: { PATH: undefined, Path: "must-not-fall-back", VALUE: "private-environment-value" },
	});
	const call = mocks.spawn.mock.calls[0];
	const script = Buffer.from(call[1][3] as string, "base64").toString("utf16le");
	const environment = call[2].env as Record<string, string>;
	const metadataKey = Object.keys(environment).find((key) => key.startsWith("PI_MCP_JOB_ENV_"));
	if (!metadataKey) throw new Error("Missing private environment metadata");
	expect(JSON.parse(environment[metadataKey])).toEqual({ VALUE: "private-environment-value" });
	expect(script).not.toContain("private-environment-value");
	expect(script).not.toContain(Buffer.from("private-environment-value").toString("base64"));
	expect(script).toContain("info.EnvironmentVariables.Clear()");
	const marker = [...script.matchAll(/FromBase64String\('([^']+)'\)/g)]
		.map((match) => Buffer.from(match[1], "base64").toString("utf8"))
		.find((value) => value.startsWith("MCP_JOB_READY_"));
	guardian.stderr.emit("data", Buffer.from(`${marker}\n`));
	await job.ready;
	const closing = job.close();
	await new Promise<void>((resolve) => setImmediate(resolve));
	cleanup.emit("close", 0);
	await closing;
});

// pi#137 / smarty-dev#3535, A14: disable/unregister may race guardian startup.
it("waits for startup custody before terminating and removes split readiness bytes from stderr", async () => {
	const guardian = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn() });
	const terminator = new EventEmitter();
	mocks.spawn.mockReturnValueOnce(guardian).mockReturnValueOnce(terminator);
	const stderr: string[] = [];
	const job = spawnWindowsJob("node", ["a b", 'quote"', "trailing\\"], {}, (chunk) => stderr.push(chunk.toString()));
	const script = Buffer.from(mocks.spawn.mock.calls[0][1][3] as string, "base64").toString("utf16le");
	const encodedStrings = [...script.matchAll(/FromBase64String\('([^']+)'\)/g)].map((match) =>
		Buffer.from(match[1], "base64").toString("utf8"),
	);
	const marker = encodedStrings.find((value) => value.startsWith("MCP_JOB_READY_"));
	expect(encodedStrings.at(-1)).toBe('"a b" "quote\\"" "trailing\\\\"');
	const closing = job.close();
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(mocks.spawn).toHaveBeenCalledTimes(1);
	guardian.stderr.emit("data", Buffer.from(marker?.slice(0, 10) ?? ""));
	guardian.stderr.emit("data", Buffer.from(`${marker?.slice(10)}\r\nserver ready\n`));
	await job.ready;
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(stderr).toEqual(["server ready\n"]);
	expect(mocks.spawn).toHaveBeenCalledTimes(2);
	const rejected = expect(closing).rejects.toThrow("cleanup failed (1)");
	terminator.emit("close", 1);
	await rejected;
});
