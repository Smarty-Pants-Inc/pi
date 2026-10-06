import { describe, expect, it } from "vitest";
import { createAssistantMessageDiagnostic, extractDiagnosticError } from "../src/utils/diagnostics.ts";

describe("S3 numeric diagnostic boundary", () => {
  it("drops numeric error codes and arbitrary nested diagnostic details", () => {
    const error = new Error("synthetic provider failure") as Error & { code?: unknown };
    error.code = 123456789;
    const extracted = extractDiagnosticError(error);
    expect(extracted).not.toHaveProperty("code");

    const diagnostic = createAssistantMessageDiagnostic("provider_limit", error, {
      nested: { code: 123456789, value: "synthetic" },
      array: [123456789],
    } as never);
    expect(diagnostic).not.toHaveProperty("details");
  });
});
