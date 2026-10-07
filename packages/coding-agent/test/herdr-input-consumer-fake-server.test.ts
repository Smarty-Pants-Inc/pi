/**
 * smarty-dev#2636 F1 (herdr-lead Luna review): an agent owns a PTY master, runs Pi on the slave and
 * answers as a fake Herdr, writing the real marker itself. Pi must label nothing unless the server
 * proves it holds the Herdr server key (decision 3 B). Real PTY, real Unix socket, fake server.
 */
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { epochMarker } from "../src/core/herdr/epoch-bytes.ts";
import { type CutAnswer, cutMac, enrollMessage, type TtyId } from "../src/core/herdr/server-auth.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const trusted = generateKeyPairSync("ed25519");
const attacker = generateKeyPairSync("ed25519");

interface Scenario {
	signWith: KeyObject;
	trustRoot: "trusted" | "none";
	tty?: (real: TtyId) => TtyId;
	badMac?: boolean;
	/** Run Pi's startup bootstrap (fixtures/herdr-bootstrap-child.ts) in this mode instead. */
	bootstrap?: "exit" | "handoff";
}

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const step of cleanup.splice(0)) step();
});

async function run(
	scenario: Scenario,
): Promise<{ result: Record<string, any>; cutRequests: number; methods: string[] }> {
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
	const type = (bytes: Buffer) => host.stdin.write(`${bytes.toString("hex")}\n`);
	const lines = createInterface({ input: host.stdout });
	let slave = "";
	let cutRequests = 0;
	const methods: string[] = [];
	const closed: Promise<void>[] = [];
	const exited = new Promise<void>((resolve) => {
		lines.on("line", (line) => {
			const message = JSON.parse(line) as { slave?: string; exit?: number };
			if (message.slave) slave = message.slave;
			if (message.exit !== undefined) resolve();
		});
	});
	const server: Server = createServer((socket) => {
		let epochKey = Buffer.alloc(0);
		let buffered = "";
		// The child exits right after its answer; a reset of the fake's side is expected.
		socket.on("error", () => {});
		closed.push(new Promise((resolve) => socket.on("close", () => resolve())));
		socket.on("data", (data) => {
			buffered += data.toString("utf8");
			for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
				const request = JSON.parse(buffered.slice(0, at));
				buffered = buffered.slice(at + 1);
				methods.push(request.method);
				const reply = (result: object) => socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
				if (request.method === "pane.input_consumer.enroll") {
					const stat = statSync(slave, { bigint: true });
					const real = { dev: stat.dev, ino: stat.ino };
					const tty = scenario.tty ? scenario.tty(real) : real;
					epochKey = randomBytes(32);
					const answer = { epoch: "e1", epochKey, nonce: randomBytes(16).toString("hex"), tty };
					const sig = sign(
						null,
						enrollMessage(Buffer.from(request.params.challenge, "hex"), paneId, answer),
						scenario.signWith,
					);
					reply({
						type: "input_consumer_enrolled",
						epoch: answer.epoch,
						epoch_key: epochKey.toString("hex"),
						nonce: answer.nonce,
						tty: { dev: tty.dev.toString(), ino: tty.ino.toString() },
						sig: sig.toString("base64"),
					});
					// The fake owns the master: it writes the real marker and types for "Paul".
					setTimeout(() => {
						type(Buffer.from("x"));
						type(Buffer.concat([epochMarker(answer.nonce), Buffer.from("hi\r")]));
					}, 50);
				} else if (request.method === "pane.input_consumer.cut") {
					cutRequests++;
					const answer: CutAnswer = { result: "client", principal: { smartyId: "paul", displayName: "Paul" } };
					const { params } = request;
					const mac = cutMac(epochKey, { ...params, epoch: params.epoch }, answer);
					if (scenario.badMac) mac[0] ^= 1;
					reply({
						type: "input_consumer_cut",
						result: answer.result,
						principal: { smarty_id: "paul", display_name: "Paul" },
						mac: mac.toString("hex"),
					});
				} else reply({ type: "ok" });
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	cleanup.push(() => server.close());
	await exited;
	// Everything the child wrote before it exited has arrived once its sockets close.
	await Promise.all(closed);
	return { result: JSON.parse(readFileSync(out, "utf8")), cutRequests, methods };
}

describe("herdr input consumer against a fake server on a real PTY (smarty-dev#2636 F1)", () => {
	it("refuses a fake server that writes the marker but cannot sign with the Herdr key", async () => {
		const { result, cutRequests } = await run({ signWith: attacker.privateKey, trustRoot: "trusted" });
		expect(result.reason).toBe("server-unauthenticated");
		expect(result.record.channel).toBe("terminal");
		expect(result.record.principal).toBeUndefined();
		expect(cutRequests).toBe(0);
	});

	it("attributes the typed turn when the server signs with the trusted key (counterexample)", async () => {
		const { result } = await run({ signWith: trusted.privateKey, trustRoot: "trusted" });
		expect(result.record).toMatchObject({
			channel: "keyboard",
			principal: { id: "paul", binding: "herdr-client" },
			submissionToken: result.token,
		});
		expect(result.cut).toEqual({ cut: 3, digest: createHash("sha256").update("hi\r").digest("hex") });
		// Bytes before the marker are delivered as ordinary input, never counted in the epoch.
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

	it("records terminal when a cut answer fails its MAC", async () => {
		const { result } = await run({ signWith: trusted.privateKey, trustRoot: "trusted", badMac: true });
		expect(result.reason).toBe("bad-mac");
		expect(result.record.channel).toBe("terminal");
		expect(result.record.principal).toBeUndefined();
	});

	// pi#160 review P1: `pi --help`, `--list-models` or a startup error exits after enrollment but
	// before InteractiveMode.init() hands the input off.
	it("restores the tty mode and releases the epoch when Pi exits before the TUI takes the input", async () => {
		const { result, methods } = await run({ signWith: trusted.privateKey, trustRoot: "trusted", bootstrap: "exit" });
		expect(result).toMatchObject({ rawBefore: false, attested: true, rawAfterEnroll: true, rawAtExit: false });
		expect(methods).toEqual(["pane.input_consumer.enroll", "pane.input_consumer.release"]);
	});

	it("keeps the epoch for the TUI after the hand-off (counterexample)", async () => {
		const { result, methods } = await run({
			signWith: trusted.privateKey,
			trustRoot: "trusted",
			bootstrap: "handoff",
		});
		expect(result).toMatchObject({ attested: true, rawAtExit: false });
		expect(result.record).toMatchObject({ channel: "keyboard", principal: { id: "paul" } });
		expect(methods).toEqual(["pane.input_consumer.enroll", "pane.input_consumer.cut"]);
	});

	it("enrolls nothing without a trust root", async () => {
		const { result } = await run({ signWith: trusted.privateKey, trustRoot: "none" });
		expect(result.reason).toBe("no-trust-root");
		expect(result.record.channel).toBe("terminal");
	});
});
