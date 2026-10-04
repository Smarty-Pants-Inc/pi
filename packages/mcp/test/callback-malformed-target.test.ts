import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

// pi#137 / smarty-dev#3535, earlier security 4 (MCP, not AI).
it("rejects a malformed raw callback target without crashing or consuming pending state", async () => {
	const { stdout } = await promisify(execFile)(
		process.execPath,
		[fileURLToPath(new URL("./fixtures/callback-malformed-target.mjs", import.meta.url))],
		{ timeout: 10000 },
	);
	expect(JSON.parse(stdout)).toEqual({ malformedStatus: 400, validStatus: 200, code: "abc", state: "pending" });
});
