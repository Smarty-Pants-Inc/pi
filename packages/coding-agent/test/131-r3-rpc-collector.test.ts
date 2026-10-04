import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const fixturePath = fileURLToPath(new URL("./fixtures/131-r3-rpc-collector-child.ts", import.meta.url));

async function runCaller(
	scenario: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
	const child = spawn(process.execPath, ["--unhandled-rejections=strict", fixturePath, "--caller", scenario], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	return await new Promise((resolve, reject) => {
		// Foreground child is always joined, including a failed caller. No filesystem cleanup.
		const timer = setTimeout(() => child.kill("SIGTERM"), 5000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, output });
		});
	});
}

describe("PR #131 F15 RPC event collector ownership", () => {
	// PR #131: handled input owns no run; neither unrelated settlement nor timeout may finish it.
	test("handled input completes without an unrelated settlement", async () => {
		const result = await runCaller("handled");
		expect(result, result.output).toMatchObject({ code: 0, signal: null });
	});

	// PR #131: rejected preflight must retire the pre-send subscription immediately.
	test("prompt rejection retires its listener immediately", async () => {
		const result = await runCaller("rejected-listener");
		expect(result, result.output).toMatchObject({ code: 0, signal: null });
	});

	// PR #131: prove by real caller exit that no unowned rejection kills Node later.
	test("prompt rejection leaves no timer rejection that terminates the caller", async () => {
		const result = await runCaller("rejected");
		expect(result, result.output).toMatchObject({ code: 0, signal: null });
	});

	// PR #131: observe collector rejection while the prompt response is still pending.
	test("collector timeout before prompt response is immediately observed", async () => {
		const result = await runCaller("timeout-before-response");
		expect(result, result.output).toMatchObject({ code: 0, signal: null });
	});

	// PR #131: keep subscription before send and keep started/queued drain ownership.
	test.each(["early", "started", "queued", "timeout"])("preserves %s collection semantics", async (scenario) => {
		const result = await runCaller(scenario);
		expect(result, result.output).toMatchObject({ code: 0, signal: null });
	});

	// PR #131: process loss and explicit stop retire collectors instead of waiting for their timeout.
	test.each(["exit", "stop"])("cleans up collector on process %s", async (scenario) => {
		const result = await runCaller(scenario);
		expect(result, result.output).toMatchObject({ code: 0, signal: null });
	});
});
