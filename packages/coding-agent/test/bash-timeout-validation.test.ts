import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type BashToolInput, createBashTool } from "../src/core/tools/bash.ts";
import { createPowerShellTool } from "../src/core/tools/powershell.ts";

// Validation only: these tests never call execute(), so no command is spawned.
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
