import { expect, it } from "vitest";
import { CodemodeSandbox, type CodemodeSandboxBase, loadQuickJSWasm } from "../src/index.ts";
import { InlineCodemodeSandbox, RemoteCodemodeSandbox, serveCodemodeRemote } from "../src/portable.ts";

const echo = { name: "echo", execute: (args: unknown) => args };
const backends: [string, () => CodemodeSandboxBase][] = [
	[
		"worker entry",
		() =>
			new CodemodeSandbox({
				tools: [echo],
				workerUrl: new URL("../src/runtime/worker.ts", import.meta.url),
			}),
	],
	["portable inline", () => new InlineCodemodeSandbox({ tools: [echo], wasm: loadQuickJSWasm() })],
	[
		"portable remote",
		() =>
			new RemoteCodemodeSandbox({
				tools: [echo],
				remote: () => ({
					execute: (request, exchange) =>
						serveCodemodeRemote(
							structuredClone(request),
							async (messages) => structuredClone(await exchange(structuredClone(messages))),
							{ wasm: loadQuickJSWasm() },
						),
				}),
			}),
	],
];

// smarty-dev#4506 step 2: replace the shipping refusal with real execution, never an admission mock.
it.each(backends)(
	"admits %s through tools, output, and store while keeping host globals absent",
	async (_name, create) => {
		const sandbox = create();
		try {
			const result = await sandbox.execute(`
				const value = await tools.echo({ answer: 42 });
				store("answer", value.answer);
				text(value);
				return [typeof process, typeof require, typeof fetch, load("answer")];
			`);
			expect(result).toMatchObject({
				ok: true,
				value: ["undefined", "undefined", "undefined", 42],
				output: [{ type: "text", text: '{"answer":42}' }],
				calls: [{ name: "echo", status: "ok" }],
				storeWrites: { set: { answer: 42 }, delete: [] },
			});
		} finally {
			await sandbox.close();
		}
	},
);

// smarty-dev#4506: deterministic start/deliver also crosses the actual admitted host/VM boundary.
it.each(backends)("admits deterministic start and delivery through %s", async (_name, create) => {
	const sandbox = create();
	try {
		const run = sandbox.start("return await tools.echo(41);", {
			startedAt: 0,
			seed: 1,
			tools: [{ name: "echo" }],
			onCall: (call) => {
				queueMicrotask(() => run.deliver(1, 1, call.id, { ok: true, value: call.args }));
			},
		});
		expect(await run.result).toMatchObject({ ok: true, value: 41, calls: [{ name: "echo", status: "ok" }] });
		expect(run.finished).toBe(true);
	} finally {
		await sandbox.close();
	}
});
