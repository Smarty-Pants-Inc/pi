import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { McpClient, StdioTransport } from "../src/index.ts";

const CLOSE_TIMEOUT_MS = 300;

// These finite child programs run only on the test host. The descendant closes the wrapper's
// inherited output pipes, reports readiness over IPC, and stays in its parent's process group.
const descendantSource = `
import { closeSync } from "node:fs";
process.on("SIGTERM", () => {});
closeSync(1);
closeSync(2);
process.send({ pid: process.pid, parentPid: process.ppid });
process.disconnect();
setTimeout(() => process.exit(0), 15000);
`;

const wrapperSource = String.raw`
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const mode = process.argv[1];
const descendant = spawn(process.execPath, ["--input-type=module", "-e", process.argv[2]], {
  stdio: ["ignore", 1, 2, "ipc"],
});
descendant.on("error", () => process.exit(1));
descendant.on("message", (ready) => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "fixture/ready", params: {
    leaderPid: process.pid, descendantPid: ready.pid, parentPid: ready.parentPid,
  } }) + "\n");
});
descendant.unref();
process.on("SIGTERM", () => process.exit(0));
const lines = createInterface({ input: process.stdin });
lines.on("close", () => { if (mode === "eof") process.exit(0); });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "fixture/exit") process.exit(0);
});
setTimeout(() => process.exit(0), 15000);
`;

interface ProcessInfo {
	pid: number;
	parentPid: number;
	group: number;
	state: string;
}

function processInfo(pid: number): ProcessInfo | undefined {
	let output: string;
	try {
		output = execFileSync("ps", ["-o", "pid=,ppid=,pgid=,stat=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 1_000,
			maxBuffer: 4_096,
		});
	} catch (error) {
		// ps exits 1 with no output when the PID has already been reaped.
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		if (failure.status === 1 && !failure.stdout?.trim() && !failure.stderr?.trim()) return undefined;
		throw error;
	}
	const fields = output.trim().split(/\s+/);
	if (!output.trim()) return undefined;
	if (fields.length !== 4) throw new Error(`Unexpected ps output: ${output}`);
	return { pid: Number(fields[0]), parentPid: Number(fields[1]), group: Number(fields[2]), state: fields[3] };
}

function running(pid: number): boolean {
	const info = processInfo(pid);
	// kill(pid, 0) also succeeds for zombies; an unreaped zombie cannot execute server work.
	return info !== undefined && !info.state.startsWith("Z");
}

function cleanupOwnedGroup(group: number | undefined, descendantPid?: number): void {
	if (group === undefined) return;
	const members = [group, descendantPid].filter((pid): pid is number => pid !== undefined);
	if (
		!members.some((pid) => {
			const info = processInfo(pid);
			return info?.group === group && !info.state.startsWith("Z");
		})
	)
		return;
	try {
		process.kill(-group, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("stdio retirement exceeded 5 seconds")), 5_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

describe.skipIf(process.platform === "win32")("StdioTransport owned POSIX group retirement", () => {
	// #2241 F12/A5: leader close must not cancel escalation for a pipe-detached stubborn descendant.
	it.each(["eof", "term", "already-closed"])(
		"joins descendant retirement when the wrapper exits via %s",
		async (mode) => {
			const transport = new StdioTransport({
				command: process.execPath,
				args: ["--input-type=module", "-e", wrapperSource, mode, descendantSource],
				closeTimeoutMs: CLOSE_TIMEOUT_MS,
			});
			const ready = Promise.withResolvers<{ leaderPid: number; descendantPid: number; parentPid: number }>();
			const leaderClosed = Promise.withResolvers<void>();
			const errors: Error[] = [];
			let group: number | undefined;
			let descendantPid: number | undefined;
			let descendantAliveAtLeaderClose = false;
			let closeSettled = false;
			let leaderClosedAt: number | undefined;
			transport.onError((error) => errors.push(error));
			transport.onMessage((message) => {
				if (!("method" in message) || message.method !== "fixture/ready") return;
				const params = message.params;
				if (
					params !== null &&
					typeof params === "object" &&
					"leaderPid" in params &&
					typeof params.leaderPid === "number" &&
					"descendantPid" in params &&
					typeof params.descendantPid === "number" &&
					"parentPid" in params &&
					typeof params.parentPid === "number"
				) {
					ready.resolve({
						leaderPid: params.leaderPid,
						descendantPid: params.descendantPid,
						parentPid: params.parentPid,
					});
				}
			});
			transport.onClose(() => {
				leaderClosedAt = Date.now();
				descendantAliveAtLeaderClose = descendantPid !== undefined && running(descendantPid);
				leaderClosed.resolve();
			});
			try {
				await bounded(transport.start());
				group = transport.pid;
				const owned = await bounded(ready.promise);
				descendantPid = owned.descendantPid;
				expect(group).toBe(owned.leaderPid);
				expect(owned.parentPid).toBe(group);
				expect(owned.descendantPid).not.toBe(group);
				expect(processInfo(owned.leaderPid)?.group).toBe(group);
				expect(processInfo(owned.descendantPid)).toMatchObject({
					pid: owned.descendantPid,
					parentPid: owned.leaderPid,
					group,
				});
				if (mode === "already-closed") {
					await bounded(transport.send({ jsonrpc: "2.0", method: "fixture/exit" }));
					await bounded(leaderClosed.promise);
					expect(transport.pid).toBeUndefined();
				}
				const closing = transport.close().then(() => {
					closeSettled = true;
				});
				// Concurrent close callers must join the same retirement, not report completion early.
				const joined = transport.close();
				expect(transport.close()).toBe(joined);
				await bounded(leaderClosed.promise);
				expect(descendantAliveAtLeaderClose).toBe(true);
				expect(closeSettled).toBe(false);
				expect(leaderClosedAt).toBeTypeOf("number");
				await bounded(Promise.all([closing, joined]));
				expect(Date.now() - (leaderClosedAt as number)).toBeGreaterThanOrEqual(CLOSE_TIMEOUT_MS - 50);
				// SIGKILL delivery and OS reaping are separate; allow a bounded scheduling turn,
				// but never confuse a zombie with a surviving executable descendant.
				for (let attempt = 0; attempt < 100 && running(owned.descendantPid); attempt++) await delay(10);
				expect(running(owned.descendantPid)).toBe(false);
				expect(running(owned.leaderPid)).toBe(false);
				expect(errors).toEqual([]);
			} finally {
				// Revalidate a known member before signalling only our transport's process group.
				cleanupOwnedGroup(group, descendantPid);
				await bounded(transport.close());
			}
		},
		15_000,
	);

	// #2241 F12/A5: a normal cooperative MCP server still accepts notifications and closes promptly.
	it("preserves cooperative close and notification delivery", async () => {
		const source = String.raw`
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "cooperative", version: "1" },
    } }) + "\n");
  } else if (message.method === "fixture/notify") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "fixture/received" }) + "\n");
  }
});
lines.on("close", () => process.exit(0));
setTimeout(() => process.exit(0), 15000).unref();
`;
		const transport = new StdioTransport({
			command: process.execPath,
			args: ["--input-type=module", "-e", source],
			closeTimeoutMs: 2_000,
		});
		const client = new McpClient({ name: "retirement-test", version: "1" });
		const received = Promise.withResolvers<void>();
		client.onNotification("fixture/received", () => received.resolve());
		let group: number | undefined;
		try {
			await bounded(client.connect(transport));
			group = transport.pid;
			await bounded(client.notify("fixture/notify"));
			await bounded(received.promise);
			const startedAt = Date.now();
			await bounded(client.close());
			expect(Date.now() - startedAt).toBeLessThan(1_500);
			expect(client.connectionState).toBe("closed");
			expect(group).toBeTypeOf("number");
			expect(running(group as number)).toBe(false);
		} finally {
			cleanupOwnedGroup(group);
			await bounded(client.close());
		}
	}, 10_000);
});
