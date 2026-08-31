import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponseBody } from "../src/modes/rpc/rpc-types.ts";

const tempDirs: string[] = [];

type RpcClientPrivate = {
	process: {
		exitCode: number | null;
		signalCode: NodeJS.Signals | null;
		stdin: {
			destroyed: boolean;
			writable: boolean;
			write: (line: string) => void;
		};
	} | null;
};

function writeChildScript(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-extension-ui-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(
		path,
		`import readline from "node:readline";
const output = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
let startupResponse;
output({
	type: "extension_ui_request",
	id: "startup-confirm",
	method: "confirm",
	title: "Continue",
	message: "Continue?",
});
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
	const record = JSON.parse(line);
	if (record.type === "extension_ui_response") {
		startupResponse = record;
		return;
	}
	if (record.type !== "get_state") return;
	if (startupResponse?.id !== "startup-confirm" || startupResponse.confirmed !== true) {
		output({ id: record.id, type: "response", command: "get_state", success: false, error: "startup response missing" });
		return;
	}
	output({
		id: record.id,
		type: "response",
		command: "get_state",
		success: true,
		data: {
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			sessionId: "startup-session",
			sessionName: startupResponse.id,
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		},
	});
});
`,
	);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient extension UI", () => {
	test("answers startup UI before sending commands", async () => {
		const client = new RpcClient({ cliPath: writeChildScript() });
		const requests: RpcExtensionUIRequest[] = [];
		let startFinished = false;
		let requestReceivedDuringStart = false;
		let responsePromise: Promise<void> | undefined;

		client.onEvent((event) => {
			if (event.type !== "extension_ui_request") return;
			requests.push(event);
			requestReceivedDuringStart = !startFinished;
			responsePromise = client.respondToExtensionUI(event.id, { confirmed: true });
		});

		try {
			const starting = client.start().then(() => {
				startFinished = true;
			});
			await vi.waitFor(() => expect(responsePromise).toBeDefined());
			const response = responsePromise;
			if (!response) throw new Error("Expected a response to the startup UI request");
			await response;
			await starting;

			const state = await client.getState();

			expect(requestReceivedDuringStart).toBe(true);
			expect(requests).toEqual([
				{
					type: "extension_ui_request",
					id: "startup-confirm",
					method: "confirm",
					title: "Continue",
					message: "Continue?",
				},
			]);
			expect(state).toMatchObject({ sessionId: "startup-session", sessionName: "startup-confirm" });
		} finally {
			await client.stop();
		}
	});

	test("keeps extension UI protocol fields over structurally extra response fields", async () => {
		const client = new RpcClient();
		const write = vi.fn();
		const privateClient = client as unknown as RpcClientPrivate;
		privateClient.process = {
			exitCode: null,
			signalCode: null,
			stdin: { destroyed: false, writable: true, write },
		};
		const response = {
			confirmed: true,
			type: "body-type",
			id: "body-id",
		} as unknown as RpcExtensionUIResponseBody;

		await client.respondToExtensionUI("request-id", response);

		expect(write).toHaveBeenCalledTimes(1);
		expect(JSON.parse(write.mock.calls[0]![0] as string)).toEqual({
			confirmed: true,
			type: "extension_ui_response",
			id: "request-id",
		});
	});
});
