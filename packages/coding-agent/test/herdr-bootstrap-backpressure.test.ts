/** #3155: bound startup input without losing bytes; keep the real enrollment, counter and TUI meter path. */
import { createHash, generateKeyPairSync } from "node:crypto";
import { fstatSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { setImmediate } from "node:timers";
import { MeteredInput } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HerdrInputBootstrap, startHerdrInputConsumer } from "../src/core/herdr/bootstrap.ts";
import { epochMarker } from "../src/core/herdr/epoch-bytes.ts";
import { receiptRecord } from "../src/core/turn-receipts.ts";
import { cutRequestOf, cutResult, enrollResult } from "./fixtures/herdr-v2-answers.ts";

// Only the OS transport is replaced: rpc.ts and signed-v2 enrollment/cuts run unchanged.
vi.mock("node:net", () => ({ createConnection: vi.fn() }));

const LIMIT = 64 * 1024;
const NONCE = "0123456789abcdef";
const PANE = "w1:p1";
const trusted = generateKeyPairSync("ed25519");
const env = { HERDR_SOCKET_PATH: "/unused/herdr.sock", HERDR_PANE_ID: PANE };
const host = { hardened: () => true, trustRoot: () => ({ key: trusted.publicKey }) };

interface Request {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

class Input extends PassThrough {
	readonly isTTY = true;
	isRaw = false;
	setRawMode(mode: boolean): this {
		this.isRaw = mode;
		return this;
	}
}

let stdin: Input;
let stdinDescriptor: PropertyDescriptor | undefined;
let enrollment: { socket: Duplex; request: Request } | undefined;
let requests: Request[];
let sockets: Duplex[];
let bootstraps: HerdrInputBootstrap[];
let exitListeners: number;

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function answerEnrollment(): void {
	if (!enrollment) throw new Error("enrollment request not received");
	const { socket, request } = enrollment;
	const tty = fstatSync(0, { bigint: true });
	const result = enrollResult(trusted.privateKey, String(request.params.challenge), PANE, {
		epoch: "01".repeat(16),
		nonce: NONCE,
		tty: { dev: tty.dev, ino: tty.ino },
		peer: { pid: BigInt(process.pid), pidns: statSync("/proc/self/ns/pid", { bigint: true }).ino },
	});
	socket.push(`${JSON.stringify({ id: request.id, result })}\n`);
}

async function keepBootstrap(pending: ReturnType<typeof startHerdrInputConsumer>): Promise<HerdrInputBootstrap> {
	const bootstrap = await pending;
	if (!bootstrap) throw new Error("bootstrap preconditions unexpectedly failed");
	bootstraps.push(bootstrap);
	// #3155: release is fire-and-forget; let its mocked reply clear the RPC timer before counting timers.
	await nextTurn();
	expect(stdin.listenerCount("data")).toBe(0);
	expect(stdin.isPaused()).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
	return bootstrap;
}

async function replay(bootstrap: HerdrInputBootstrap): Promise<string> {
	const text: string[] = [];
	const input = new MeteredInput((part) => text.push(part));
	input.setMeter(bootstrap.meter);
	const onData = (chunk: Buffer) => input.write(chunk);
	bootstrap.handOff();
	stdin.on("data", onData);
	stdin.resume();
	await nextTurn();
	stdin.off("data", onData);
	stdin.pause();
	return text.join("");
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	stdin = new Input({ highWaterMark: 16 * 1024 });
	stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
	Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
	enrollment = undefined;
	requests = [];
	sockets = [];
	bootstraps = [];
	exitListeners = process.listenerCount("exit");
	vi.mocked(createConnection).mockImplementation(() => {
		const socket = new Duplex({
			read() {},
			write(chunk: Buffer, _encoding, callback) {
				const request = JSON.parse(chunk.toString("utf8")) as Request;
				requests.push(request);
				if (request.method === "pane.input_consumer.enroll") enrollment = { socket, request };
				else {
					const result =
						request.method === "pane.input_consumer.cut"
							? cutResult(trusted.privateKey, cutRequestOf(request.params), {
									result: "client",
									principal: { smarty_id: "paul", display_name: "Paul" },
								})
							: {};
					socket.push(`${JSON.stringify({ id: request.id, result })}\n`);
				}
				callback();
			},
		});
		sockets.push(socket);
		return socket as unknown as Socket;
	});
});

afterEach(() => {
	for (const bootstrap of bootstraps) {
		bootstrap.shutdown();
		bootstrap.meter.end();
	}
	for (const socket of sockets) socket.destroy();
	stdin.destroy();
	if (stdinDescriptor) Object.defineProperty(process, "stdin", stdinDescriptor);
	vi.mocked(createConnection).mockReset();
	vi.useRealTimers();
	expect(process.listenerCount("exit")).toBe(exitListeners);
});

describe.runIf(process.platform === "linux")("Herdr bootstrap backpressure (#3155)", () => {
	it.each(["enrollment", "marker"] as const)(
		"backpressures over-limit input during the %s wait without losing a split UTF-8 byte",
		async (phase) => {
			const pending = startHerdrInputConsumer(env, host);
			if (phase === "marker") {
				answerEnrollment();
				await nextTurn();
				expect(vi.getTimerCount()).toBe(1);
			}
			// One read crosses the cap inside a UTF-8 character. The suffix must go back to stdin.
			const bytes = Buffer.concat([Buffer.alloc(LIMIT - 1, "a"), Buffer.from("€\rlater")]);
			stdin.write(bytes);
			await nextTurn();
			expect(stdin.isPaused()).toBe(true);
			expect(stdin.readableLength).toBe(bytes.length - LIMIT);
			if (phase === "enrollment") answerEnrollment();
			const bootstrap = await keepBootstrap(pending);
			expect(bootstrap.attestor).toBeUndefined();
			expect(bootstrap.diagnostic?.message).toContain("no-marker");
			expect(stdin.isRaw).toBe(false);
			const held = bootstrap.meter.takePending?.();
			expect(held?.preEpoch).toEqual(bytes.subarray(0, LIMIT));
			expect(held?.epoch.length).toBe(0);
			expect(bootstrap.meter.takePending?.()?.preEpoch.length).toBe(0);
			// Restore exactly the taken result to test the real TUI UTF-8 decoder across handoff.
			const meter = { ...bootstrap.meter, takePending: () => held! };
			expect(await replay({ ...bootstrap, meter })).toBe(bytes.toString("utf8"));
			expect(requests.map((request) => request.method)).toEqual([
				"pane.input_consumer.enroll",
				"pane.input_consumer.release",
			]);
		},
	);

	it("keeps later input in the stream after reaching the exact cap in small reads", async () => {
		const pending = startHerdrInputConsumer(env, host);
		for (let i = 0; i < 16; i++) stdin.write(Buffer.alloc(4096, "x"));
		const tail = Buffer.from("tail\r");
		stdin.write(tail);
		await nextTurn();
		expect(stdin.isPaused()).toBe(true);
		expect(stdin.readableLength).toBe(tail.length);
		answerEnrollment();
		const bootstrap = await keepBootstrap(pending);
		expect(await replay(bootstrap)).toBe(`${"x".repeat(LIMIT)}tail\r`);
	});

	it.each(["enrollment", "marker"] as const)("replays normal bounded input after the %s timeout", async (phase) => {
		const pending = startHerdrInputConsumer(env, host);
		stdin.write(Buffer.from("early é\r"));
		await nextTurn();
		if (phase === "marker") {
			answerEnrollment();
			await nextTurn();
		}
		await vi.advanceTimersByTimeAsync(2000);
		const bootstrap = await keepBootstrap(pending);
		expect(bootstrap.attestor).toBeUndefined();
		expect(bootstrap.diagnostic?.message).toContain(phase === "marker" ? "no-marker" : "transport");
		expect(stdin.isRaw).toBe(false);
		expect(await replay(bootstrap)).toBe("early é\r");
		expect(requests.map((request) => request.method)).toEqual(
			phase === "marker"
				? ["pane.input_consumer.enroll", "pane.input_consumer.release"]
				: ["pane.input_consumer.enroll"],
		);
	});

	it("preserves bounded replay and raw epoch cut accounting, and cancels the marker timer on success", async () => {
		const pending = startHerdrInputConsumer(env, host);
		answerEnrollment();
		await nextTurn();
		expect(vi.getTimerCount()).toBe(1);
		const bytes = Buffer.from("é\rA\r");
		stdin.write(Buffer.concat([epochMarker(NONCE), bytes]));
		const bootstrap = await keepBootstrap(pending);
		expect(bootstrap.attestor).toBeDefined();
		expect(bootstrap.diagnostic).toBeUndefined();
		expect(stdin.isRaw).toBe(true);
		const captures: ReturnType<NonNullable<HerdrInputBootstrap["attestor"]>["capture"]>[] = [];
		const text: string[] = [];
		const input = new MeteredInput((part) => {
			text.push(part);
			if (part === "\r")
				captures.push(bootstrap.attestor!.capture(input.offset, { tainted: false, kind: "submit" }));
		});
		input.setMeter(bootstrap.meter);
		bootstrap.handOff();
		expect(stdin.isRaw).toBe(false);
		expect(process.listenerCount("exit")).toBe(exitListeners);
		expect(text.join("")).toBe("é\rA\r");
		expect((await Promise.all(captures)).map((receipt) => receiptRecord(receipt).channel)).toEqual([
			"keyboard",
			"keyboard",
		]);
		expect(
			requests
				.filter((request) => request.method === "pane.input_consumer.cut")
				.map((request) => ({ cut: request.params.cut, digest: request.params.digest })),
		).toEqual([
			{ cut: 3, digest: createHash("sha256").update("é\r").digest("hex") },
			{ cut: 5, digest: createHash("sha256").update("A\r").digest("hex") },
		]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("counts only consumed raw bytes when a valid epoch crosses the backpressure boundary", async () => {
		const pending = startHerdrInputConsumer(env, host);
		const marker = epochMarker(NONCE);
		const epochBytes = Buffer.concat([Buffer.alloc(LIMIT - marker.length - 1, "a"), Buffer.from("€\r")]);
		const bytes = Buffer.concat([marker, epochBytes]);
		stdin.write(bytes);
		await nextTurn();
		expect(stdin.isPaused()).toBe(true);
		expect(stdin.readableLength).toBe(bytes.length - LIMIT);
		answerEnrollment();
		const bootstrap = await keepBootstrap(pending);
		expect(bootstrap.attestor).toBeDefined();
		const text: string[] = [];
		let capture: ReturnType<NonNullable<HerdrInputBootstrap["attestor"]>["capture"]> | undefined;
		const input = new MeteredInput((part) => {
			text.push(part);
			if (part === "\r") capture = bootstrap.attestor!.capture(input.offset, { tainted: false, kind: "submit" });
		});
		input.setMeter(bootstrap.meter);
		const onData = (chunk: Buffer) => input.write(chunk);
		bootstrap.handOff();
		stdin.on("data", onData);
		stdin.resume();
		await nextTurn();
		stdin.off("data", onData);
		stdin.pause();
		expect(text.join("")).toBe(epochBytes.toString("utf8"));
		expect(input.offset).toBe(epochBytes.length);
		expect(capture).toBeDefined();
		expect(receiptRecord(await capture!).channel).toBe("keyboard");
		expect(requests.find((request) => request.method === "pane.input_consumer.cut")?.params).toMatchObject({
			cut: epochBytes.length,
			digest: createHash("sha256").update(epochBytes).digest("hex"),
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancels an enrolled bootstrap before handoff and removes its exit listener", async () => {
		const pending = startHerdrInputConsumer(env, host);
		stdin.write(epochMarker(NONCE));
		await nextTurn();
		answerEnrollment();
		const bootstrap = await keepBootstrap(pending);
		expect(process.listenerCount("exit")).toBe(exitListeners + 1);
		bootstrap.shutdown();
		bootstrap.shutdown();
		expect(stdin.isRaw).toBe(false);
		expect(process.listenerCount("exit")).toBe(exitListeners);
		expect(bootstrap.meter.push(Buffer.from("after cancel\r")).preEpoch.toString()).toBe("after cancel\r");
		expect(requests.map((request) => request.method)).toEqual([
			"pane.input_consumer.enroll",
			"pane.input_consumer.release",
		]);
	});
});
