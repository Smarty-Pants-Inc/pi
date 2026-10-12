/**
 * pi#160 review (Astra P2): Herdr RPC framing is bounded. Before enrollment the peer is
 * unauthenticated, so an oversized frame, a flood of unconsumed bytes or a malformed frame must
 * close the socket and reject every pending call once with a typed error.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	connectRpc,
	FrameReader,
	HerdrRpcProtocolError,
	MAX_FRAME_BYTES,
	MAX_PENDING_BYTES,
} from "../src/core/herdr/rpc.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const step of cleanup.splice(0)) step();
});

interface FakeHerdr {
	socketPath: string;
	/** Resolves when the server sees Pi's side of the connection close. */
	closed: Promise<void>;
	requests: { id: string; method: string }[];
}

/** A fake Herdr that hands every request line to `answer`. */
async function fakeHerdr(
	answer: (socket: Socket, request: { id: string; method: string }) => void,
): Promise<FakeHerdr> {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-rpc-"));
	const socketPath = join(dir, "herdr.sock");
	const requests: { id: string; method: string }[] = [];
	let markClosed: () => void = () => {};
	const closed = new Promise<void>((resolve) => {
		markClosed = resolve;
	});
	const server: Server = createServer((socket) => {
		let buffered = "";
		socket.on("error", () => {});
		socket.on("close", () => markClosed());
		socket.on("data", (data) => {
			buffered += data.toString("utf8");
			for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
				const request = JSON.parse(buffered.slice(0, at)) as { id: string; method: string };
				buffered = buffered.slice(at + 1);
				requests.push(request);
				answer(socket, request);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	cleanup.push(() => {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { socketPath, closed, requests };
}

async function protocolError(promise: Promise<unknown>): Promise<HerdrRpcProtocolError> {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(HerdrRpcProtocolError);
	return error as HerdrRpcProtocolError;
}

describe("Herdr RPC framing bounds (pi#160 review)", () => {
	it("keeps the caps far above the largest real frame", () => {
		// Worst-case frames Herdr sends here (herdr src/app/api/input_consumer.rs), at the field
		// limits Pi accepts: nonce 128 chars, 20-digit dev/ino, display name 80 four-byte chars.
		const enroll = JSON.stringify({
			id: "pi-ic-99999",
			result: {
				epoch: "e".repeat(64),
				epoch_key: "a".repeat(64),
				nonce: "n".repeat(128),
				tty: { dev: "9".repeat(20), ino: "9".repeat(20) },
				sig: "s".repeat(88),
			},
		});
		const cut = JSON.stringify({
			id: "pi-ic-99999",
			result: {
				result: "unknown",
				reason: "r".repeat(64),
				principal: { smarty_id: "i".repeat(64), display_name: "\u{1F600}".repeat(80) },
				mac: "m".repeat(64),
			},
		});
		const largest = Math.max(Buffer.byteLength(enroll), Buffer.byteLength(cut));
		expect(largest).toBeLessThan(1024);
		expect(MAX_FRAME_BYTES).toBe(1024 * 1024);
		expect(MAX_PENDING_BYTES).toBeGreaterThanOrEqual(MAX_FRAME_BYTES);
	});

	it("closes and rejects every pending call once on an oversized frame with no newline", async () => {
		const herdr = await fakeHerdr((socket, request) => {
			// Answer only the second call, so both are pending, with one frame that never ends.
			if (request.id === "pi-ic-2") socket.write(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61));
		});
		const connection = connectRpc(herdr.socketPath, 5000);
		cleanup.push(() => connection.close());
		const first = protocolError(connection.rpc("pane.input_consumer.enroll", {}));
		const second = protocolError(connection.rpc("pane.input_consumer.enroll", {}));
		const [a, b] = await Promise.all([first, second]);
		expect(a.code).toBe("herdr_rpc_protocol_error");
		expect(a.reason).toBe("frame_too_large");
		// The same error object reaches both waiters: one failure, one rejection each.
		expect(b).toBe(a);
		await herdr.closed;
		// A later call fails fast with the same typed error instead of waiting for a timeout.
		expect(await protocolError(connection.rpc("pane.input_consumer.cut", {}))).toBe(a);
	});

	it("bounds the buffer and reports the oversized frame once (reader)", () => {
		const errors: HerdrRpcProtocolError[] = [];
		const frames: unknown[] = [];
		const limits = { maxFrameBytes: 64, maxPendingBytes: 256 };
		const reader = new FrameReader(
			limits,
			(frame) => frames.push(frame),
			(error) => errors.push(error),
		);
		reader.push(Buffer.alloc(40, 0x61));
		expect(reader.pendingBytes).toBe(40);
		reader.push(Buffer.alloc(40, 0x61));
		expect(errors.map((e) => e.reason)).toEqual(["frame_too_large"]);
		expect(reader.pendingBytes).toBe(0);
		// Further data is ignored, including a valid frame.
		reader.push(Buffer.from('{"id":"x","result":{}}\n'));
		reader.push(Buffer.alloc(1000, 0x61));
		expect(reader.pendingBytes).toBe(0);
		expect(frames).toEqual([]);
		expect(errors).toHaveLength(1);
	});

	it("rejects a complete line longer than the frame cap", () => {
		const errors: HerdrRpcProtocolError[] = [];
		const reader = new FrameReader(
			{ maxFrameBytes: 16, maxPendingBytes: 256 },
			() => {},
			(error) => errors.push(error),
		);
		reader.push(Buffer.from(`{"id":"${"x".repeat(32)}"}\n`));
		expect(errors.map((e) => e.reason)).toEqual(["frame_too_large"]);
	});

	it("closes on a flood of small frames over the aggregate cap", async () => {
		const limits = { maxFrameBytes: 64, maxPendingBytes: 256 };
		const flood = Buffer.from('{"id":"noise","result":{}}\n'.repeat(300));
		const herdr = await fakeHerdr((socket) => socket.write(flood));
		const connection = connectRpc(herdr.socketPath, 5000, limits);
		cleanup.push(() => connection.close());
		const [a, b] = await Promise.all([
			protocolError(connection.rpc("pane.input_consumer.enroll", {})),
			protocolError(connection.rpc("pane.input_consumer.enroll", {})),
		]);
		expect(a.reason).toBe("pending_overflow");
		expect(b).toBe(a);
		await herdr.closed;

		// The same flood, deterministically, against the reader: nothing is parsed or held.
		const errors: HerdrRpcProtocolError[] = [];
		const frames: unknown[] = [];
		const reader = new FrameReader(
			limits,
			(frame) => frames.push(frame),
			(error) => errors.push(error),
		);
		reader.push(flood);
		reader.push(flood);
		expect(errors.map((e) => e.reason)).toEqual(["pending_overflow"]);
		expect(frames).toEqual([]);
		expect(reader.pendingBytes).toBe(0);
	});

	it("copies each byte once when a frame just under the cap arrives 1 byte at a time", () => {
		// pi#160 review: concatenating the whole buffer per chunk copied O(n^2) bytes (about 512 GiB
		// here). Count every byte Buffer.concat produces; a linear reader copies the frame once.
		const prefix = '{"id":"drip","result":{"pad":"';
		const suffix = '"}}';
		const body = `${prefix}${"a".repeat(MAX_FRAME_BYTES - prefix.length - suffix.length)}${suffix}`;
		const wire = Buffer.from(`${body}\nnext`);
		expect(Buffer.byteLength(body)).toBe(MAX_FRAME_BYTES);
		let copied = 0;
		const concat = Buffer.concat;
		const spy = vi.spyOn(Buffer, "concat").mockImplementation((list, totalLength) => {
			const result = concat(list, totalLength);
			copied += result.length;
			return result;
		});
		cleanup.push(() => spy.mockRestore());
		const errors: HerdrRpcProtocolError[] = [];
		const frames: Record<string, unknown>[] = [];
		const reader = new FrameReader(
			{ maxFrameBytes: MAX_FRAME_BYTES, maxPendingBytes: MAX_PENDING_BYTES },
			(frame) => frames.push(frame),
			(error) => errors.push(error),
		);
		const started = performance.now();
		for (let at = 0; at < wire.length; at++) {
			reader.push(wire.subarray(at, at + 1));
			if (at === MAX_FRAME_BYTES - 1) expect(reader.pendingBytes).toBe(MAX_FRAME_BYTES);
		}
		const elapsed = performance.now() - started;
		expect(errors).toEqual([]);
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ id: "drip" });
		// The remainder after the newline is kept for the next frame.
		expect(reader.pendingBytes).toBe(4);
		expect(copied).toBeLessThanOrEqual(MAX_FRAME_BYTES);
		// Generous wall-clock bound: the quadratic reader takes minutes here.
		expect(elapsed).toBeLessThan(10_000);
	});

	it("enforces the frame cap on the running length of a dripped frame", () => {
		const errors: HerdrRpcProtocolError[] = [];
		const frames: unknown[] = [];
		const reader = new FrameReader(
			{ maxFrameBytes: 64, maxPendingBytes: 256 },
			(frame) => frames.push(frame),
			(error) => errors.push(error),
		);
		for (let i = 0; i < 64; i++) reader.push(Buffer.from("a"));
		expect(errors).toEqual([]);
		expect(reader.pendingBytes).toBe(64);
		reader.push(Buffer.from("a"));
		expect(errors.map((e) => e.reason)).toEqual(["frame_too_large"]);
		expect(reader.pendingBytes).toBe(0);
		reader.push(Buffer.from('{"id":"x","result":{}}\n'));
		expect(frames).toEqual([]);
		expect(errors).toHaveLength(1);
	});

	it("splits several frames and a remainder out of fragmented chunks", () => {
		const errors: HerdrRpcProtocolError[] = [];
		const frames: unknown[] = [];
		const reader = new FrameReader(
			{ maxFrameBytes: 64, maxPendingBytes: 256 },
			(frame) => frames.push(frame),
			(error) => errors.push(error),
		);
		reader.push(Buffer.from('{"id":'));
		reader.push(Buffer.from('"a"'));
		reader.push(Buffer.from('}\n{"id":"b"}\n{"id"'));
		expect(frames).toEqual([{ id: "a" }, { id: "b" }]);
		expect(reader.pendingBytes).toBe(5);
		reader.push(Buffer.from(':"c"}\n'));
		expect(frames).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
		expect(reader.pendingBytes).toBe(0);
		// A line over the cap that completes in a later chunk is still too large.
		reader.push(Buffer.alloc(40, 0x61));
		reader.push(Buffer.from(`${"a".repeat(30)}\n`));
		expect(errors.map((e) => e.reason)).toEqual(["frame_too_large"]);
	});

	it("closes and rejects on a malformed JSON line", async () => {
		const herdr = await fakeHerdr((socket) => socket.write("{not json\n"));
		const connection = connectRpc(herdr.socketPath, 5000);
		cleanup.push(() => connection.close());
		const error = await protocolError(connection.rpc("pane.input_consumer.enroll", {}));
		expect(error.reason).toBe("malformed_frame");
		await herdr.closed;
	});

	it.each(["42", "null", '"text"', "[1,2]", ""])("treats the non-object frame %j as malformed", (line) => {
		const errors: HerdrRpcProtocolError[] = [];
		const reader = new FrameReader(
			{ maxFrameBytes: MAX_FRAME_BYTES, maxPendingBytes: MAX_PENDING_BYTES },
			() => {},
			(error) => errors.push(error),
		);
		reader.push(Buffer.from(`${line}\n`));
		expect(errors.map((e) => e.reason)).toEqual(["malformed_frame"]);
	});

	it("still runs a normal enroll, cut and release flow (counterexample)", async () => {
		const herdr = await fakeHerdr((socket, request) => {
			const results: Record<string, object> = {
				"pane.input_consumer.enroll": { epoch: "e1", epoch_key: "ab".repeat(32), nonce: "n".repeat(128) },
				"pane.input_consumer.cut": {
					result: "client",
					principal: { smarty_id: "paul", display_name: "P\u00e4ul".repeat(20) },
					mac: "cd".repeat(32),
				},
				"pane.input_consumer.release": {},
			};
			// An unsolicited frame for no pending call is ignored, and the answer arrives split in two
			// writes, with a multi-byte character straddling the split.
			const frame = Buffer.from(`${JSON.stringify({ id: request.id, result: results[request.method] })}\n`);
			socket.write('{"id":"late","result":{}}\n');
			const split = frame.indexOf(Buffer.from("\u00e4")) + 1;
			socket.write(frame.subarray(0, split));
			setTimeout(() => socket.write(frame.subarray(split)), 10);
		});
		const connection = connectRpc(herdr.socketPath, 5000);
		cleanup.push(() => connection.close());
		expect(await connection.rpc("pane.input_consumer.enroll", {})).toMatchObject({ epoch: "e1" });
		expect(await connection.rpc("pane.input_consumer.cut", {})).toMatchObject({
			result: "client",
			principal: { display_name: "P\u00e4ul".repeat(20) },
		});
		expect(await connection.rpc("pane.input_consumer.release", {})).toEqual({});
		expect(herdr.requests.map((r) => r.method)).toEqual([
			"pane.input_consumer.enroll",
			"pane.input_consumer.cut",
			"pane.input_consumer.release",
		]);
	});
});
