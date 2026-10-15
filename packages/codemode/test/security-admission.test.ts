import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import {
	CodemodeSandbox,
	CodemodeSandboxBase,
	InlineCodemodeSandbox,
	RemoteCodemodeSandbox,
	serveCodemodeRemote,
} from "../src/index.ts";
import * as portable from "../src/portable.ts";
import { Execution, type ExecutionOptions } from "../src/runtime/execution.ts";
import { type InlineCodemodeSandboxOptions, inlineLauncher } from "../src/runtime/inline.ts";
import type {
	CodemodeRemoteRequest,
	CodemodeServeOptions,
	RemoteCodemodeSandboxOptions,
} from "../src/runtime/remote.ts";
import { type StartVmOptions, startVm } from "../src/runtime/vm.ts";
import type { CodemodeRunOptions } from "../src/types.ts";

// PR #131: the reviewed re-enable must precede all supported Codemode admission.
it("refuses sandbox creation before inspecting options, including explicit attempts", () => {
	const options = new Proxy(
		{},
		{
			get() {
				throw new Error("OPTIONS_INSPECTED");
			},
		},
	);
	expect(() => new CodemodeSandbox(options)).toThrow("CODEMODE_SECURITY_REVIEW_REQUIRED");
});

// PR #131: every new execution entry must refuse before reading caller-controlled properties.
it("refuses base, portable, and remote admission without inspecting options", async () => {
	const unread = new Proxy(
		{},
		{
			get: () => {
				throw new Error("OPTIONS_INSPECTED");
			},
		},
	);
	const denied = "CODEMODE_SECURITY_REVIEW_REQUIRED";
	const launch = () => {
		throw new Error("LAUNCHER_CALLED");
	};
	for (const construct of [
		() => new CodemodeSandboxBase(unread, launch),
		() => new InlineCodemodeSandbox(unread as InlineCodemodeSandboxOptions),
		() => new RemoteCodemodeSandbox(unread as RemoteCodemodeSandboxOptions),
		() => new portable.CodemodeSandboxBase(unread, launch),
		() => new portable.InlineCodemodeSandbox(unread as InlineCodemodeSandboxOptions),
		() => new portable.RemoteCodemodeSandbox(unread as RemoteCodemodeSandboxOptions),
		() => new Execution(unread as ExecutionOptions),
		() => inlineLauncher(unread),
		() => serveCodemodeRemote(unread as CodemodeRemoteRequest, launch, unread as CodemodeServeOptions),
	]) {
		expect(construct).toThrow(denied);
	}
	await expect(startVm(unread as StartVmOptions)).rejects.toThrow(denied);
});

// PR #131: borrowing a method must not bypass constructor refusal or inspect execute/start options.
it("refuses execute and deterministic start before inspecting the receiver or options", () => {
	const unread = new Proxy(
		{},
		{
			get: () => {
				throw new Error("OPTIONS_INSPECTED");
			},
		},
	);
	expect(() => CodemodeSandboxBase.prototype.execute.call(unread as CodemodeSandboxBase, "", unread)).toThrow(
		"CODEMODE_SECURITY_REVIEW_REQUIRED",
	);
	expect(() =>
		CodemodeSandboxBase.prototype.start.call(unread as CodemodeSandboxBase, "", unread as CodemodeRunOptions),
	).toThrow("CODEMODE_SECURITY_REVIEW_REQUIRED");
});

it("refuses the separately exported worker entry before creating a VM", async () => {
	const worker = new Worker(new URL("../src/runtime/worker.ts", import.meta.url), { workerData: {} });
	try {
		const message = await new Promise<{ type: string; message: string }>((resolve, reject) => {
			worker.once("message", resolve);
			worker.once("error", reject);
		});
		expect(message).toMatchObject({
			type: "crash",
			message: expect.stringContaining("CODEMODE_SECURITY_REVIEW_REQUIRED"),
		});
	} finally {
		await worker.terminate();
	}
});
