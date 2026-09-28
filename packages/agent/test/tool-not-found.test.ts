import { describe, expect, it } from "vitest";
import { toolNotFoundMessage } from "../src/agent-loop.ts";

describe("toolNotFoundMessage", () => {
	it("lists the tools valid in this session, sorted", () => {
		expect(toolNotFoundMessage("read_file", [{ name: "write" }, { name: "read" }, { name: "bash" }])).toBe(
			"Tool read_file not found. Available tools in this session: bash, read, write",
		);
	});

	it("bounds the list to 40 names", () => {
		const tools = Array.from({ length: 45 }, (_, i) => ({ name: `t${String(i).padStart(2, "0")}` }));
		const message = toolNotFoundMessage("x", tools);
		expect(message).toContain("t39, ... (5 more)");
		expect(message).not.toContain("t40");
	});
});
