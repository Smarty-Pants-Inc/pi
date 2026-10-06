import { describe, expect, it } from "vitest";
import { createAssistantMessageDiagnostic, extractDiagnosticError } from "../src/utils/diagnostics.ts";

// smarty-dev#5822 / T-N5682: these rows cover the helper boundary, not the full publication matrix.
describe("S3 numeric diagnostic boundary", () => {
	it.each([Number("00123456789"), Number("1.23456789e8")])("drops numeric error code %s", (code) => {
		const error = Object.assign(new Error("synthetic provider failure"), { code });
		const extracted = extractDiagnosticError(error);
		expect(extracted.code).not.toBe(code);
		expect(extracted.code).toBe("provider_request_failed");
		expect(extracted).not.toHaveProperty("stack");
		expect(extracted.message).not.toContain("synthetic provider failure");
	});

	it("drops arbitrary nested diagnostic details", () => {
		const diagnostic = createAssistantMessageDiagnostic("provider_limit", new Error("synthetic"), {
			nested: { code: 123456789, value: "synthetic" },
			array: [123456789],
		});
		expect(diagnostic).not.toHaveProperty("details");
		expect(diagnostic.type).toBe("provider_limit");
		expect(diagnostic.timestamp).toBeGreaterThan(0);
	});
});
