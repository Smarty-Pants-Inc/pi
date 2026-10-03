import { expect, it } from "vitest";
import { CodemodeSandbox } from "../src/index.ts";

// pi#127 F5/A2: native retention is independent of reusable guest values.
it("bounds output and fire-and-forget call floods", async () => {
	const sandbox = new CodemodeSandbox({ tools: [{ name: "noop", execute: async () => 1 }] });
	try {
		const output = await sandbox.execute('for (let i = 0; i < 2000; i++) text("x".repeat(8192));');
		expect(output.ok).toBe(false);
		expect(output.output.length).toBeLessThanOrEqual(256);
		const calls = await sandbox.execute("for (let i = 0; i < 2000; i++) tools.noop({});");
		expect(calls.ok).toBe(false);
		expect(calls.calls.length).toBeLessThanOrEqual(64);
	} finally {
		await sandbox.close();
	}
});

it("does not allow a guest execution option to raise the trusted deadline", async () => {
	const sandbox = new CodemodeSandbox({ timeoutMs: 50 });
	try {
		const result = await sandbox.execute("while (true) {}", { timeoutMs: Infinity });
		expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
	} finally {
		await sandbox.close();
	}
});

// pi#127 F5: reply transit is bounded independently of guest output/call argument size.
it("bounds aggregate host reply bytes", async () => {
	const sandbox = new CodemodeSandbox({ tools: [{ name: "medium", execute: () => "x".repeat(512 * 1024) }] });
	try {
		const result = await sandbox.execute("for (let i = 0; i < 40; i++) await tools.medium({}); return true;");
		expect(result).toMatchObject({ ok: false, error: { kind: "sandbox", message: "Sandbox reply budget exceeded" } });
	} finally {
		await sandbox.close();
	}
});

it("bounds result serialization before constructing the reply", async () => {
	const sandbox = new CodemodeSandbox({ tools: [{ name: "large", execute: () => "x".repeat(10 * 1024 * 1024) }] });
	try {
		const result = await sandbox.execute("return await tools.large({});");
		expect(result.ok).toBe(false);
		expect(result.calls).toMatchObject([{ name: "large", status: "error" }]);
	} finally {
		await sandbox.close();
	}
});
