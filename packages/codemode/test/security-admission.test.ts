import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { CodemodeSandbox } from "../src/index.ts";

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
