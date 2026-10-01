import { describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

// smarty-dev#3048: public input methods must not resolve when the native CLI returns success:false.
describe("RpcClient authoritative input rejection", () => {
	it.each(["prompt", "steer", "followUp"] as const)("%s rejects a fenced native input response", async (entry) => {
		const client = new RpcClient();
		const receive = Reflect.get(client, "handleLine") as (line: string) => void;
		Reflect.set(client, "process", {
			exitCode: null,
			signalCode: null,
			stdin: {
				writable: true,
				destroyed: false,
				write: (line: string) => {
					const command = JSON.parse(line) as { id: string; type: string };
					receive.call(
						client,
						JSON.stringify({
							id: command.id,
							type: "response",
							command: command.type,
							success: false,
							error: "INPUT_ADMISSION_FENCED: input was not accepted",
						}),
					);
				},
			},
		});
		await expect(client[entry]("not accepted")).rejects.toThrow("INPUT_ADMISSION_FENCED");
	});
});
