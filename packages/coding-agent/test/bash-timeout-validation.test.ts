import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { type BashOperations, type BashToolInput, createBashTool } from "../src/core/tools/bash.ts";
import { createPowerShellTool } from "../src/core/tools/powershell.ts";

// Schema validation never calls execute(), so no command is spawned.
function validate(args: BashToolInput): unknown {
	const tool = createBashTool(process.cwd());
	return validateToolArguments(tool, { type: "toolCall", id: "call-1", name: "bash", arguments: args });
}

// Regression for #10913: the bash schema must bound timeout so oversized values are
// rejected at argument validation (agent-loop prepareToolCall -> error toolResult)
// instead of reaching execution.
describe("bash timeout schema validation (#10913)", () => {
	it("rejects timeout 10000 with an error naming timeout and the bound", () => {
		let message = "";
		try {
			validate({ command: "echo hi", timeout: 10000 });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain('Validation failed for tool "bash"');
		expect(message).toMatch(/- timeout: /);
		expect(message).toContain("600");
	});

	it("accepts timeout 600", () => {
		expect(validate({ command: "echo hi", timeout: 600 })).toEqual({ command: "echo hi", timeout: 600 });
	});

	it("accepts timeout 30", () => {
		expect(validate({ command: "echo hi", timeout: 30 })).toEqual({ command: "echo hi", timeout: 30 });
	});

	it("accepts omitted timeout", () => {
		expect(validate({ command: "echo hi" })).toEqual({ command: "echo hi" });
	});

	it("rejects negative timeout naming timeout", () => {
		expect(() => validate({ command: "echo hi", timeout: -5 })).toThrow(/- timeout: /);
	});

	it("shares the seconds-unit bound with PowerShell", () => {
		const tool = createPowerShellTool(process.cwd());
		const call = {
			type: "toolCall" as const,
			id: "call-ps",
			name: "powershell",
			arguments: { command: "echo hi", timeout: 10000 },
		};
		expect(() => validateToolArguments(tool, call)).toThrow(/- timeout: .*600/);
		call.arguments.timeout = 600;
		expect(validateToolArguments(tool, call)).toEqual(call.arguments);
	});
});

// Regression for #10913 / pi#229: SDK, extensions, and codemode can bypass schema validation.
describe("bash timeout direct execution (#10913)", () => {
	it.each([601, 1e9])("rejects timeout %s before invoking command operations", async (timeout) => {
		const exec = vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 0 }));
		const tool = createBashTool(process.cwd(), { operations: { exec } });
		await expect(tool.execute("call-direct", { command: "echo hi", timeout })).rejects.toThrow(
			"Invalid timeout: maximum is 600 seconds (the value is in seconds, not milliseconds)",
		);
		expect(exec).not.toHaveBeenCalled();
	});

	it.each([600, 2])("accepts timeout %s without changing it", async (timeout) => {
		const exec = vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 0 }));
		const cwd = process.cwd();
		const tool = createBashTool(cwd, { operations: { exec } });
		await expect(tool.execute("call-direct", { command: "echo hi", timeout })).resolves.toMatchObject({
			structuredContent: { exit_code: 0 },
		});
		expect(exec).toHaveBeenCalledExactlyOnceWith("echo hi", cwd, expect.objectContaining({ timeout }));
	});
});
