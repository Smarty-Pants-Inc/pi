/** smarty-dev#2636 F1 / pi#160: a PTY master alone cannot forge signed-v2 keyboard attribution. */
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { epochMarker } from "../src/core/herdr/epoch-bytes.ts";
import type { PeerId, TtyId } from "../src/core/herdr/server-auth.ts";
import { cutRequestOf, cutResult, enrollResult } from "./fixtures/herdr-v2-answers.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const trusted = generateKeyPairSync("ed25519");
const attacker = generateKeyPairSync("ed25519");
interface Scenario {
	signWith: KeyObject;
	trustRoot: "trusted" | "none";
	tty?: (real: TtyId) => TtyId;
	peer?: (real: PeerId) => PeerId;
	badSig?: boolean;
	bootstrap?: "exit" | "handoff";
}
interface ChildResult {
	reason?: string;
	record: { channel: string; principal?: { id: string; binding?: string }; submissionToken?: string };
	token?: string;
	cut?: { cut: number; digest: string };
	preEpoch?: string;
	attested?: boolean;
	diagnostic?: string;
}
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const step of cleanup.splice(0)) step();
});
async function run(scenario: Scenario): Promise<{ result: ChildResult; cutRequests: number; methods: string[] }> {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-f1-"));
	const socketPath = join(dir, "herdr.sock");
	const pubPath = join(dir, "server.pub");
	const out = join(dir, "out.json");
	writeFileSync(pubPath, trusted.publicKey.export({ type: "spki", format: "pem" }));
	const paneId = "w1:p1";
	const host = spawn("python3", [
		join(fixtures, "herdr-pty-host.py"),
		process.execPath,
		join(fixtures, scenario.bootstrap ? "herdr-bootstrap-child.ts" : "herdr-pty-child.ts"),
		socketPath,
		paneId,
		scenario.trustRoot === "none" ? "none" : pubPath,
		out,
		...(scenario.bootstrap ? [scenario.bootstrap] : []),
	]);
	cleanup.push(() => {
		host.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	});
	host.stdin.on("error", () => {});
	const type = (bytes: Buffer) => {
		if (host.stdin.writable && !host.stdin.destroyed) host.stdin.write(`${bytes.toString("hex")}\n`);
	};
	const lines = createInterface({ input: host.stdout });
	let slave = "";
	let childPid = 0;
	let cutRequests = 0;
	const methods: string[] = [];
	const closed: Promise<void>[] = [];
	const pidns = statSync("/proc/self/ns/pid", { bigint: true }).ino;
	const exited = new Promise<void>((resolve) => {
		lines.on("line", (line) => {
			const message = JSON.parse(line) as { slave?: string; pid?: number; exit?: number };
			if (message.slave) slave = message.slave;
			if (message.pid) childPid = message.pid;
			if (message.exit !== undefined) resolve();
		});
	});
	// One request per connection, like Herdr; close after the answer.
	const server: Server = createServer((socket) => {
		let buffered = "";
		let answered = false;
		socket.on("error", () => {});
		closed.push(new Promise((resolve) => socket.on("close", () => resolve())));
		socket.on("data", (data) => {
			if (answered) return;
			buffered += data.toString("utf8");
			const at = buffered.indexOf("\n");
			if (at >= 0) {
				answered = true;
				const request = JSON.parse(buffered.slice(0, at));
				methods.push(request.method);
				const reply = (result: object) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
				if (request.method === "pane.input_consumer.enroll") {
					const stat = statSync(slave, { bigint: true });
					const real = { dev: stat.dev, ino: stat.ino };
					const tty = scenario.tty ? scenario.tty(real) : real;
					const pinned = { pid: BigInt(childPid), pidns };
					const peer = scenario.peer ? scenario.peer(pinned) : pinned;
					const answer = {
						epoch: randomBytes(16).toString("hex"),
						nonce: randomBytes(32).toString("hex"),
						tty,
						peer,
					};
					reply(enrollResult(scenario.signWith, request.params.challenge, paneId, answer));
					const typing = setTimeout(() => {
						type(Buffer.from("x"));
						type(Buffer.concat([epochMarker(answer.nonce), Buffer.from("hi\r")]));
					}, 50);
					cleanup.push(() => clearTimeout(typing));
				} else if (request.method === "pane.input_consumer.cut") {
					cutRequests++;
					const answer = cutResult(scenario.signWith, cutRequestOf(request.params), {
						result: "client",
						principal: { smarty_id: "paul", display_name: "Paul" },
					});
					if (scenario.badSig) {
						const sig = Buffer.from(answer.sig as string, "base64");
						sig[0] ^= 1;
						answer.sig = sig.toString("base64");
					}
					reply(answer);
				} else reply({});
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	cleanup.push(() => server.close());
	await exited;
	await Promise.all(closed);
	return { result: JSON.parse(readFileSync(out, "utf8")) as ChildResult, cutRequests, methods };
}

describe("Herdr signed-v2 fake server on a real PTY (smarty-dev#2636 F1)", () => {
	it("refuses a fake that writes the marker but cannot sign with the server key", async () => {
		const { result, cutRequests } = await run({ signWith: attacker.privateKey, trustRoot: "trusted" });
		expect(result.reason).toBe("server-unauthenticated");
		expect(result.record.channel).toBe("terminal");
		expect(result.record.principal).toBeUndefined();
		expect(cutRequests).toBe(0);
	});
	it("attributes the typed turn when the server signs for this child", async () => {
		const { result, methods } = await run({ signWith: trusted.privateKey, trustRoot: "trusted" });
		expect(methods).toEqual(["pane.input_consumer.enroll", "pane.input_consumer.cut"]);
		expect(result.record).toMatchObject({
			channel: "keyboard",
			principal: { id: "paul", binding: "herdr-client" },
			submissionToken: result.token,
		});
		expect(result.cut).toEqual({ cut: 3, digest: createHash("sha256").update("hi\r").digest("hex") });
		expect(result.preEpoch).toBe("x");
	});
	it("refuses a valid signature for a different tty", async () => {
		const { result } = await run({
			signWith: trusted.privateKey,
			trustRoot: "trusted",
			tty: (real) => ({ dev: real.dev, ino: real.ino + 1n }),
		});
		expect(result.reason).toBe("server-unauthenticated");
		expect(result.record.channel).toBe("terminal");
	});
	it("refuses a valid signature pinning another process", async () => {
		const { result, cutRequests } = await run({
			signWith: trusted.privateKey,
			trustRoot: "trusted",
			peer: (real) => ({ pid: BigInt(process.pid), pidns: real.pidns }),
		});
		expect(result.reason).toBe("server-unauthenticated");
		expect(result.record.channel).toBe("terminal");
		expect(cutRequests).toBe(0);
	});
	it("refuses a valid signature for another pid namespace", async () => {
		const { result } = await run({
			signWith: trusted.privateKey,
			trustRoot: "trusted",
			peer: (real) => ({ pid: real.pid, pidns: real.pidns + 1n }),
		});
		expect(result.reason).toBe("server-unauthenticated");
		expect(result.record.channel).toBe("terminal");
	});
	it("records terminal when a cut answer fails its signature", async () => {
		const { result } = await run({ signWith: trusted.privateKey, trustRoot: "trusted", badSig: true });
		expect(result.reason).toBe("bad-signature");
		expect(result.record.channel).toBe("terminal");
		expect(result.record.principal).toBeUndefined();
	});
	it("restores raw mode when Pi exits before TUI handoff (pi#160 P1)", async () => {
		const { result, methods } = await run({ signWith: trusted.privateKey, trustRoot: "trusted", bootstrap: "exit" });
		expect(result).toMatchObject({ rawBefore: false, attested: true, rawAfterEnroll: true, rawAtExit: false });
		expect(methods).toEqual(["pane.input_consumer.enroll"]);
	});
	it("keeps the epoch after TUI handoff", async () => {
		const { result, methods } = await run({
			signWith: trusted.privateKey,
			trustRoot: "trusted",
			bootstrap: "handoff",
		});
		expect(result).toMatchObject({ attested: true, rawAtExit: false });
		expect(result.record).toMatchObject({ channel: "keyboard", principal: { id: "paul" } });
		expect(methods).toEqual(["pane.input_consumer.enroll", "pane.input_consumer.cut"]);
	});
	it("reports why bootstrap attests nothing", async () => {
		const { result } = await run({ signWith: attacker.privateKey, trustRoot: "trusted", bootstrap: "exit" });
		expect(result.attested).toBe(false);
		expect(result.diagnostic).toContain("server-unauthenticated");
	});
	it("enrolls nothing without a trust root", async () => {
		const { result } = await run({ signWith: trusted.privateKey, trustRoot: "none" });
		expect(result.reason).toBe("no-trust-root");
		expect(result.record.channel).toBe("terminal");
	});
});
