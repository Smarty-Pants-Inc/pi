/**
 * Protocol E' v2 on Pi's side (smarty-dev#2636, design dp2636 "Acceptance tests"): Pi holds no
 * secret; Herdr signs the enroll transcript (pinning Pi's pid and pid namespace) and every cut answer.
 * A fake Herdr in this process runs the v2 logic with a test key over a real Unix socket. The tty Pi
 * checks is any open file here: the check compares dev and ino only. The real-PTY path is covered by
 * herdr-input-consumer-fake-server.test.ts.
 */
import {
	createHash,
	createHmac,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	randomBytes,
	sign,
} from "node:crypto";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attestedPrincipal, enrollHerdrInputConsumer, type HerdrEpoch } from "../src/core/herdr/input-consumer.ts";
import {
	type CutAnswer,
	type CutRequest,
	cutMessage,
	encodeFields,
	enrollMessage,
	type PeerId,
	verifyCut,
	verifyEnroll,
} from "../src/core/herdr/server-auth.ts";
import { cutRequestOf, cutResult, cutSignature, enrollResult } from "./fixtures/herdr-v2-answers.ts";

const trusted = generateKeyPairSync("ed25519");
const PANE = "w1:p1";
const PAUL = { smarty_id: "paul", display_name: "Paul" };

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const step of cleanup.splice(0)) step();
});

interface Exchange {
	readonly method: string;
	readonly params: Record<string, unknown>;
}

/** What the fake answers instead of the genuine answer; undefined keeps the genuine one. */
interface FakeHerdr {
	enroll?: (genuine: Record<string, unknown>, params: Record<string, unknown>) => Record<string, unknown>;
	cut?: (genuine: Record<string, unknown>, params: Record<string, unknown>) => Record<string, unknown>;
	peer?: (real: PeerId) => PeerId;
}

async function fakeHerdr(behaviour: FakeHerdr = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-v2-"));
	const socketPath = join(dir, "herdr.sock");
	const ttyFd = openSync(join(dir, "tty"), "w");
	const tty = fstatSync(ttyFd, { bigint: true });
	const real: PeerId = { pid: BigInt(process.pid), pidns: statSync("/proc/self/ns/pid", { bigint: true }).ino };
	const raw: string[] = [];
	const exchanges: Exchange[] = [];
	const server = createServer((socket) => {
		let buffered = "";
		socket.on("error", () => {});
		socket.on("data", (data) => {
			buffered += data.toString("utf8");
			const at = buffered.indexOf("\n");
			if (at < 0) return;
			raw.push(buffered);
			const request = JSON.parse(buffered.slice(0, at));
			exchanges.push({ method: request.method, params: request.params });
			const reply = (result: object) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
			if (request.method === "pane.input_consumer.enroll") {
				const answer = enrollResult(trusted.privateKey, request.params.challenge, PANE, {
					epoch: randomBytes(16).toString("hex"),
					nonce: randomBytes(32).toString("hex"),
					tty: { dev: tty.dev, ino: tty.ino },
					peer: behaviour.peer ? behaviour.peer(real) : real,
				});
				reply(behaviour.enroll ? behaviour.enroll(answer, request.params) : answer);
			} else if (request.method === "pane.input_consumer.cut") {
				const answer = cutResult(trusted.privateKey, cutRequestOf(request.params), {
					result: "client",
					principal: PAUL,
				});
				reply(behaviour.cut ? behaviour.cut(answer, request.params) : answer);
			} else reply({});
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	cleanup.push(() => {
		server.close();
		closeSync(ttyFd);
		rmSync(dir, { recursive: true, force: true });
	});
	const enroll = () => enrollHerdrInputConsumer({ socketPath, paneId: PANE, trustRoot: trusted.publicKey, ttyFd });
	return { raw, exchanges, enroll };
}

async function enrolled(fake: Awaited<ReturnType<typeof fakeHerdr>>): Promise<HerdrEpoch> {
	const result = await fake.enroll();
	if (!result.ok) throw new Error(`enroll failed: ${result.reason}`);
	return result.epoch;
}

const digest = createHash("sha256").update("hi\r").digest("hex");
const cutOf = (seq: number) => ({
	seq,
	token: randomBytes(16).toString("hex"),
	cut: 3 * seq,
	digest,
	kind: "submit" as const,
});

async function released(fake: Awaited<ReturnType<typeof fakeHerdr>>): Promise<void> {
	for (let i = 0; i < 100 && !fake.exchanges.some((e) => e.method === "pane.input_consumer.release"); i++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("E' v2 shared vectors V1-V3 (smarty-dev#2636)", () => {
	// Pinned copy of dp2636/vectors-v2.json; Herdr checks the same bytes (H1).
	const vectors = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "herdr-vectors-v2.json"), "utf8"));
	const seed = Buffer.from(vectors.key.seed_hex, "hex");
	const privateKey = createPrivateKey({
		key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
		format: "der",
		type: "pkcs8",
	});
	const publicKey = createPublicKey(vectors.key.public_key_pem);

	it("uses the fixed test key (seed 0x01..0x20)", () => {
		expect(vectors.key.seed_hex).toBe(Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString("hex"));
		const raw = (createPublicKey(privateKey).export({ type: "spki", format: "der" }) as Buffer).subarray(12);
		expect(raw.toString("hex")).toBe(vectors.key.public_key_hex);
		expect(createPublicKey(privateKey).export({ type: "spki", format: "pem" })).toBe(vectors.key.public_key_pem);
	});

	it("builds and signs the enroll transcript T byte for byte (V1, V3)", () => {
		const f = vectors.enroll.fields;
		const answer = {
			epoch: f.epoch,
			nonce: f.nonce,
			tty: { dev: BigInt(f.tty.dev), ino: BigInt(f.tty.ino) },
			peer: { pid: BigInt(f.peer.pid), pidns: BigInt(f.peer.pidns) },
		};
		const challenge = Buffer.from(f.challenge, "hex");
		const message = enrollMessage(challenge, f.pane_id, answer);
		expect(message.toString("hex")).toBe(vectors.enroll.message_hex);
		expect(createHash("sha256").update(message).digest("hex")).toBe(vectors.enroll.message_sha256);
		expect(
			encodeFields([
				"herdr-enroll-v2",
				f.challenge,
				f.epoch,
				f.nonce,
				f.pane_id,
				f.tty.dev,
				f.tty.ino,
				f.peer.pid,
				f.peer.pidns,
			]).toString("hex"),
		).toBe(vectors.enroll.message_hex);
		expect(sign(null, message, privateKey).toString("base64")).toBe(vectors.enroll.sig_b64);
		const sig = Buffer.from(vectors.enroll.sig_b64, "base64");
		expect(verifyEnroll(publicKey, challenge, f.pane_id, { ...answer, sig }, answer)).toBe(true);
	});

	it("builds and signs each cut answer kind byte for byte (V2, V3)", () => {
		expect(vectors.cut.map((v: { name: string }) => v.name)).toEqual([
			"client-principal",
			"client-null-principal",
			"api",
			"unknown-reason",
		]);
		for (const v of vectors.cut) {
			const request: CutRequest = v.request;
			const sig = cutSignature(privateKey, request, v.answer);
			const answer: CutAnswer = {
				result: v.answer.result,
				reason: v.answer.reason,
				principal: v.answer.principal
					? { smartyId: v.answer.principal.smarty_id, displayName: v.answer.principal.display_name }
					: undefined,
			};
			const message = cutMessage(request, answer);
			expect(message.toString("hex"), v.name).toBe(v.message_hex);
			expect(createHash("sha256").update(message).digest("hex"), v.name).toBe(v.message_sha256);
			expect(sig.toString("base64"), v.name).toBe(v.sig_b64);
			expect(verifyCut(publicKey, request, answer, Buffer.from(v.sig_b64, "base64")), v.name).toBe(true);
		}
	});
});

describe("E' v2 input consumer against a fake Herdr (smarty-dev#2636)", () => {
	it("P1: the genuine signer attributes the cut to the principal (counterexample)", async () => {
		const fake = await fakeHerdr();
		const epoch = await enrolled(fake);
		const answer = await epoch.cut(cutOf(1));
		expect(answer).toMatchObject({ result: "client", principal: { smartyId: "paul" } });
		expect(attestedPrincipal(answer)).toEqual({ smartyId: "paul", displayName: "Paul" });
	});

	it("P2: everything Pi writes is in the v2 request schemas, with no epoch_key", async () => {
		const fake = await fakeHerdr();
		const epoch = await enrolled(fake);
		expect(attestedPrincipal(await epoch.cut(cutOf(1)))).toBeDefined();
		expect(attestedPrincipal(await epoch.cut(cutOf(2)))).toBeDefined();
		epoch.release();
		await released(fake);
		expect(fake.exchanges.map((e) => e.method)).toEqual([
			"pane.input_consumer.enroll",
			"pane.input_consumer.cut",
			"pane.input_consumer.cut",
			"pane.input_consumer.release",
		]);
		const schemas: Record<string, string[]> = {
			"pane.input_consumer.enroll": ["challenge", "pane_id"],
			"pane.input_consumer.cut": ["cut", "digest", "epoch", "kind", "seq", "token"],
			"pane.input_consumer.release": ["epoch"],
		};
		for (const frame of fake.raw) {
			expect(frame).not.toContain("epoch_key");
			expect(frame.indexOf("\n")).toBe(frame.length - 1);
			const request = JSON.parse(frame);
			expect(Object.keys(request).sort()).toEqual(["id", "method", "params"]);
			expect(Object.keys(request.params).sort()).toEqual(schemas[request.method]);
		}
		const enrollParams = fake.exchanges[0]!.params;
		expect(enrollParams.challenge).toMatch(/^[0-9a-f]{64}$/);
		expect(fake.exchanges[3]!.params).toEqual({ epoch: epoch.epoch });
	});

	it("P3: a signed peer pid of another process is server-unauthenticated", async () => {
		const fake = await fakeHerdr({ peer: (real) => ({ pid: BigInt(process.ppid), pidns: real.pidns }) });
		expect(await fake.enroll()).toEqual({ ok: false, reason: "server-unauthenticated" });
	});

	it("P4: a signed pid namespace other than Pi's is server-unauthenticated", async () => {
		const fake = await fakeHerdr({ peer: (real) => ({ pid: real.pid, pidns: real.pidns + 1n }) });
		expect(await fake.enroll()).toEqual({ ok: false, reason: "server-unauthenticated" });
	});

	it("P5: a replayed earlier genuine enroll answer is server-unauthenticated", async () => {
		let first: Record<string, unknown> | undefined;
		const fake = await fakeHerdr({
			enroll: (genuine) => {
				first ??= genuine;
				return first;
			},
		});
		expect((await fake.enroll()).ok).toBe(true);
		expect(await fake.enroll()).toEqual({ ok: false, reason: "server-unauthenticated" });
	});

	it("P6: a v1-shaped answer with a valid v1 signature is malformed", async () => {
		const v1 = (genuine: Record<string, unknown>, params: Record<string, unknown>) => {
			const epochKey = randomBytes(32);
			const tty = genuine.tty as { dev: string; ino: string };
			const message = encodeFields([
				"herdr-enroll-v1",
				String(params.challenge),
				String(genuine.epoch),
				createHash("sha256").update(epochKey).digest("hex"),
				String(genuine.nonce),
				PANE,
				tty.dev,
				tty.ino,
			]);
			return {
				epoch: genuine.epoch,
				epoch_key: epochKey.toString("hex"),
				nonce: genuine.nonce,
				tty,
				sig: sign(null, message, trusted.privateKey).toString("base64"),
			};
		};
		expect(await (await fakeHerdr({ enroll: v1 })).enroll()).toEqual({ ok: false, reason: "malformed" });
		const extra = await fakeHerdr({ enroll: (genuine) => ({ ...genuine, epoch_key: "ab".repeat(32) }) });
		expect(await extra.enroll()).toEqual({ ok: false, reason: "malformed" });
	});

	it("rejects malformed v2 enroll fields", async () => {
		const cases: ((g: Record<string, unknown>) => Record<string, unknown>)[] = [
			({ peer: _peer, ...rest }) => rest,
			(g) => ({ ...g, epoch: `${g.epoch}${g.epoch}` }),
			(g) => ({ ...g, peer: { ...(g.peer as object), pid: 7 } }),
			(g) => ({ ...g, peer: { ...(g.peer as object), pid: "007" } }),
			(g) => ({ ...g, tty: { ...(g.tty as object), extra: "1" } }),
			(g) => ({ ...g, sig: String(g.sig).replace(/=+$/, "") }),
			(g) => ({ ...g, sig: randomBytes(63).toString("base64") }),
		];
		for (const tamper of cases) {
			const fake = await fakeHerdr({ enroll: tamper });
			expect(await fake.enroll()).toEqual({ ok: false, reason: "malformed" });
		}
	});

	it("P7: forged client answers after enroll are terminal, and the first ends the epoch", async () => {
		const forgeries: ((genuine: Record<string, unknown>, params: Record<string, unknown>) => object)[] = [
			() => ({
				result: "client",
				principal: PAUL,
			}),
			() => ({ result: "client", principal: PAUL, sig: randomBytes(64).toString("base64") }),
			() => ({ result: "client", principal: PAUL, sig: enrollSig }),
			(_genuine, params) => ({
				result: "client",
				principal: PAUL,
				mac: createHmac("sha256", randomBytes(32))
					.update(encodeFields(["herdr-cut-v1", String(params.epoch)]))
					.digest("hex"),
			}),
		];
		let enrollSig = "";
		for (const forge of forgeries) {
			const fake = await fakeHerdr({
				enroll: (genuine) => {
					enrollSig = String(genuine.sig);
					return genuine;
				},
				cut: forge as FakeHerdr["cut"],
			});
			const epoch = await enrolled(fake);
			const first = await epoch.cut(cutOf(1));
			expect(first).toEqual({ result: "unknown", reason: "bad-signature" });
			expect(attestedPrincipal(first)).toBeUndefined();
			expect(await epoch.cut(cutOf(2))).toEqual({ result: "unknown", reason: "epoch-ended" });
			await released(fake);
			expect(fake.exchanges.map((e) => e.method)).toEqual([
				"pane.input_consumer.enroll",
				"pane.input_consumer.cut",
				"pane.input_consumer.release",
			]);
		}
	});

	it("a genuinely signed answer with an unknown field is rejected (strict v2)", async () => {
		const fake = await fakeHerdr({ cut: (genuine) => ({ ...genuine, mac: "00".repeat(32) }) });
		const epoch = await enrolled(fake);
		expect(await epoch.cut(cutOf(1))).toEqual({ result: "unknown", reason: "bad-signature" });
	});

	it("P8: a genuine answer for cut n replayed onto cut n+1 is bad-signature", async () => {
		let first: Record<string, unknown> | undefined;
		const fake = await fakeHerdr({
			cut: (genuine) => {
				first ??= genuine;
				return first;
			},
		});
		const epoch = await enrolled(fake);
		expect(attestedPrincipal(await epoch.cut(cutOf(1)))).toBeDefined();
		expect(await epoch.cut(cutOf(2))).toEqual({ result: "unknown", reason: "bad-signature" });
	});

	it("P9: a genuine signed client answer with a null principal is terminal", async () => {
		const fake = await fakeHerdr({
			cut: (_genuine, params) =>
				cutResult(trusted.privateKey, cutRequestOf(params), { result: "client", principal: null }),
		});
		const epoch = await enrolled(fake);
		const answer = await epoch.cut(cutOf(1));
		expect(answer.result).toBe("client");
		expect(answer.principal).toBeUndefined();
		expect(attestedPrincipal(answer)).toBeUndefined();
	});

	it("P10: an answer signed for epoch A is bad-signature for a Pi enrolled in epoch B", async () => {
		let epochA = "";
		const fake = await fakeHerdr({
			cut: (_genuine, params) =>
				cutResult(
					trusted.privateKey,
					{ ...cutRequestOf(params), epoch: epochA },
					{ result: "client", principal: PAUL },
				),
		});
		epochA = (await enrolled(fake)).epoch;
		const epochB = await enrolled(fake);
		expect(epochB.epoch).not.toBe(epochA);
		expect(await epochB.cut(cutOf(1))).toEqual({ result: "unknown", reason: "bad-signature" });
	});

	it("signed api and unknown answers are verified but never attributed", async () => {
		for (const cut of [{ result: "api" as const }, { result: "unknown" as const, reason: "digest_mismatch" }]) {
			const fake = await fakeHerdr({
				cut: (_genuine, params) => cutResult(trusted.privateKey, cutRequestOf(params), cut),
			});
			const epoch = await enrolled(fake);
			const answer = await epoch.cut(cutOf(1));
			expect(answer.result).toBe(cut.result);
			expect(attestedPrincipal(answer)).toBeUndefined();
			expect((await epoch.cut(cutOf(2))).reason).not.toBe("epoch-ended");
		}
	});
});
