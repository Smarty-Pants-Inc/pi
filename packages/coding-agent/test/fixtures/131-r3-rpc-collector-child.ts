import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../../src/modes/rpc/rpc-client.ts";

const scenario = process.argv[3];
const fixturePath = fileURLToPath(import.meta.url);

if (process.argv[2] === "--caller") {
	const client = new RpcClient({ cliPath: fixturePath });
	const listeners = () => (client as unknown as { eventListeners: unknown[] }).eventListeners.length;
	await client.start();
	try {
		switch (scenario) {
			case "handled": {
				const events = await client.promptAndWait("handled", undefined, 100);
				assert.deepEqual(events, [], "handled input must finish without a settlement");
				assert.equal(listeners(), 0);
				await sleep(150);
				break;
			}
			case "rejected": {
				await assert.rejects(client.promptAndWait("rejected", undefined, 80), /mock preflight rejection/);
				// PR #131: no unhandledRejection handler here; a detached timer kills this real Node caller.
				await sleep(150);
				assert.equal(listeners(), 0, "rejected input must retire its listener");
				break;
			}
			case "rejected-listener": {
				await assert.rejects(client.promptAndWait("rejected", undefined, 80), /mock preflight rejection/);
				assert.equal(listeners(), 0, "rejected input must immediately retire its listener");
				await sleep(150);
				break;
			}
			case "early": {
				const events = await client.promptAndWait("early", undefined, 500);
				assert.deepEqual(
					events.map((event) => event.type),
					["agent_start", "agent_settled"],
				);
				assert.equal(listeners(), 0);
				break;
			}
			case "started":
			case "queued": {
				const events = await client.promptAndWait(scenario, undefined, 500);
				assert.deepEqual(
					events.map((event) => event.type),
					["agent_start", "agent_end", "agent_settled"],
				);
				assert.equal(listeners(), 0);
				break;
			}
			case "timeout": {
				await assert.rejects(client.promptAndWait("never", undefined, 80), /Timeout collecting events/);
				assert.equal(listeners(), 0);
				break;
			}
			case "timeout-before-response": {
				await assert.rejects(client.promptAndWait("slow", undefined, 30), /Timeout collecting events/);
				assert.equal(listeners(), 0);
				break;
			}
			case "exit": {
				await assert.rejects(client.promptAndWait("exit", undefined, 500), /Agent process exited \(code=43/);
				assert.equal(listeners(), 0);
				break;
			}
			case "stop": {
				const waiting = client.promptAndWait("never", undefined, 500);
				const observed = assert.rejects(waiting, /Agent process (exited|stopped)/);
				await sleep(30);
				await client.stop();
				await observed;
				assert.equal(listeners(), 0);
				break;
			}
			default:
				throw new Error(`Unknown caller scenario: ${scenario}`);
		}
	} finally {
		await client.stop();
	}
	process.stdout.write(`PASS ${scenario}\n`);
} else {
	const output = (record: unknown) => process.stdout.write(`${JSON.stringify(record)}\n`);
	const input = createInterface({ input: process.stdin });
	input.once("close", () => process.exit(0));
	input.on("line", (line) => {
		const command = JSON.parse(line) as { id: string; type: string; message: string };
		const respond = (disposition: "handled" | "started" | "queued") =>
			output({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition } });
		switch (command.message) {
			case "handled":
				respond("handled");
				break;
			case "rejected":
				output({
					id: command.id,
					type: "response",
					command: "prompt",
					success: false,
					error: "mock preflight rejection",
				});
				break;
			case "early":
				output({ type: "agent_start" });
				output({ type: "agent_settled", outcome: "completed" });
				respond("started");
				break;
			case "started":
			case "queued":
				respond(command.message);
				output({ type: "agent_start" });
				output({ type: "agent_end", messages: [] });
				setTimeout(() => output({ type: "agent_settled", outcome: "completed" }), 40);
				break;
			case "slow":
				setTimeout(() => respond("started"), 100);
				break;
			case "exit":
				respond("started");
				setTimeout(() => process.exit(43), 30);
				break;
			case "never":
				respond("started");
				break;
			default:
				throw new Error(`Unknown mock prompt: ${command.message}`);
		}
	});
}
