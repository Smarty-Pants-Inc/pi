import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type NativeHMeterBinding,
	type NativeHMeterBorrow,
	OriginalHMeter,
	type OriginalHMeterSelection,
} from "../src/core/owner-h-meter.ts";

// MOCK wrapper schedules only. No native Host/lease/tag, SCM_RIGHTS, original
// authority enrollment, admitted runtime, real meter or physical retirement.
const files = vi.hoisted(() => ({
	intent: Buffer.alloc(0),
	closed: [] as number[],
	closeFailure: undefined as { descriptor: number; cause: unknown } | undefined,
}));
vi.mock("node:fs", () => ({
	constants: { O_RDONLY: 0, O_DIRECTORY: 0x10000, O_NOFOLLOW: 0x20000, O_NONBLOCK: 0x800 },
	openSync: (path: string) => {
		if (path === "/MOCK/receiving") return 17;
		if (path === "/proc/self/fd/17/ordinary-h-meter-transfer-intent.json") return 18;
		throw new Error("MOCK_H_PATH");
	},
	fstatSync: (descriptor: number) => ({
		uid: 0,
		mode: descriptor === 17 ? 0o40555 : 0o100400,
		nlink: 1,
		dev: 1,
		ino: descriptor,
		size: files.intent.length,
		mtimeMs: 1,
		ctimeMs: 1,
		isDirectory: () => descriptor === 17,
		isFile: () => descriptor === 18,
	}),
	readSync: (descriptor: number, buffer: Buffer, offset: number, length: number) => {
		if (descriptor !== 18) throw new Error("MOCK_H_DESCRIPTOR");
		return files.intent.copy(buffer, offset, 0, Math.min(length, files.intent.length));
	},
	closeSync: (descriptor: number) => {
		files.closed.push(descriptor);
		if (files.closeFailure?.descriptor === descriptor) throw files.closeFailure.cause;
	},
}));

function model() {
	const ref = (name: string) => ({ path: `/MOCK/receiving/${name}.json`, sha256: "0".repeat(64) });
	const release = ref("release");
	// Literal keys are independently in wire order, including nested records.
	const intent = {
		aggregate: { device: 1, inode: 2 },
		child: { pid: "3", startTicks: "4" },
		clock: {
			bootId: "MOCK",
			captureReleaseDeadlineNs: "100",
			clock: "CLOCK_MONOTONIC",
			joinsDeadlineNs: "90",
			timeNamespace: "6",
			workloadDeadlineNs: "80",
		},
		controller: { pid: "7", startTicks: "8" },
		effect: "send-original-H",
		enforcement: ref("enforcement"),
		entry: ref("entry"),
		epoch: ref("epoch"),
		initial: ref("initial"),
		initialFd: ref("initial-fd"),
		kind: "original-ci-h-meter-transfer-intent/1",
		receiving: ref("receiving"),
		release,
		reservation: ref("reservation"),
		scope: ref("scope"),
		version: 1,
	};
	files.intent = Buffer.from(`${JSON.stringify(intent)}\n`);
	const transfer = {
		path: "/MOCK/receiving/ordinary-h-meter-transfer-intent.json",
		sha256: createHash("sha256").update(files.intent).digest("hex"),
	};
	const packet = Buffer.from(JSON.stringify({ event: "ORIGINAL_H", release, transfer, version: 1 }));
	const original = Object.freeze({ descriptor: 23, device: 1, inode: 2 });
	const controller = new AbortController();
	const selection: OriginalHMeterSelection = {
		receivingPath: ref("receiving").path,
		release,
		intent,
		native: {},
		signal: controller.signal,
	};
	const host = Object.freeze({ MOCK: "Host" });
	const lease = Object.freeze({ MOCK: "Lease" });
	const native = {
		hMeterAbi: 1 as const,
		startOriginalHMeter: vi.fn(
			(_host: object, _directory: number, _selection: Readonly<Record<string, unknown>>) => {},
		),
		pollOriginalHMeter: vi.fn((_host: object): Buffer | undefined => packet),
		cancelOriginalHMeter: vi.fn((_host: object) => {}),
		acceptOriginalHMeter: vi.fn((_lease: object, _packet: Buffer) => {}),
		borrowOriginalHMeter: vi.fn((_lease: object): NativeHMeterBorrow => original),
		returnOriginalHMeter: vi.fn((_borrow: NativeHMeterBorrow, _failed: boolean) => {}),
		finishOriginalHMeter: vi.fn((_host: object, _packet: Buffer) => {}),
	} satisfies NativeHMeterBinding;
	return { native, host, lease, selection, controller, original, packet, transfer };
}

beforeEach(() => {
	files.closed.length = 0;
	files.closeFailure = undefined;
});

describe("MOCK original H wrapper, not native receiving", () => {
	it("joins the independent consumer-close task before returning the SAME modeled native borrow and finishing", async () => {
		const m = model();
		const meter = await OriginalHMeter.receive(m.native, m.host, m.selection);
		expect(files.closed).toEqual([18, 17]);
		meter.accept(m.lease);
		expect(m.native.acceptOriginalHMeter).toHaveBeenCalledWith(
			m.lease,
			Buffer.from(JSON.stringify({ event: "H_ACCEPTED", transfer: m.transfer, version: 1 })),
		);
		const borrow = meter.borrow(m.lease);
		expect(borrow.aggregate).toEqual(m.original);
		expect(borrow.aggregate).not.toBe(m.original);
		let done!: () => void;
		const consumerClose = new Promise<void>((resolve) => {
			done = resolve;
		});
		const closed = consumerClose.then(() => borrow.close());
		let joined = false;
		const join = meter.joinBorrow().then(() => {
			joined = true;
		});
		await Promise.resolve();
		expect(joined).toBe(false);
		expect(m.native.returnOriginalHMeter).not.toHaveBeenCalled();
		expect(() => meter.finish()).toThrow("OWNER_H_CLOSE_PHASE");
		expect(m.native.finishOriginalHMeter).not.toHaveBeenCalled();
		done();
		await closed;
		await join;
		expect(m.native.returnOriginalHMeter).toHaveBeenCalledExactlyOnceWith(m.original, false);
		meter.finish();
		expect(m.native.finishOriginalHMeter).toHaveBeenCalledExactlyOnceWith(
			m.host,
			Buffer.from(JSON.stringify({ event: "H_CLOSED", transfer: m.transfer, version: 1 })),
		);
		borrow.close();
		expect(() => meter.finish()).toThrow("OWNER_H_CLOSE_PHASE");
		expect(m.native.returnOriginalHMeter).toHaveBeenCalledTimes(1);
	});

	it.each([new Error("MOCK_METER_CLOSE"), undefined])(
		"keeps the first consumer failure including %s and never retries return",
		async (cause) => {
			const m = model();
			const meter = await OriginalHMeter.receive(m.native, m.host, m.selection);
			meter.accept(m.lease);
			const borrow = meter.borrow(m.lease);
			let caught = false;
			try {
				borrow.fail(cause);
			} catch (error) {
				caught = true;
				expect(error).toBe(cause);
			}
			expect(caught).toBe(true);
			await expect(meter.joinBorrow()).rejects.toBe(cause);
			try {
				borrow.fail(new Error("LATER"));
			} catch (error) {
				expect(error).toBe(cause);
			}
			expect(m.native.returnOriginalHMeter).toHaveBeenCalledExactlyOnceWith(m.original, true);
			expect(() => meter.finish()).toThrow("OWNER_H_CLOSE_PHASE");
			expect(m.native.finishOriginalHMeter).not.toHaveBeenCalled();
		},
	);

	it("aggregates an actual return failure after the original undefined consumer cause", async () => {
		const m = model();
		const cleanup = new Error("MOCK_NATIVE_RETURN");
		m.native.returnOriginalHMeter.mockImplementation(() => {
			throw cleanup;
		});
		const meter = await OriginalHMeter.receive(m.native, m.host, m.selection);
		meter.accept(m.lease);
		const borrow = meter.borrow(m.lease);
		let failure: unknown;
		try {
			borrow.fail(undefined);
		} catch (cause) {
			failure = cause;
		}
		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toEqual([undefined, cleanup]);
		expect(Object.hasOwn(failure as AggregateError, "cause")).toBe(true);
		expect((failure as AggregateError).cause).toBeUndefined();
		await expect(meter.joinBorrow()).rejects.toBe(failure);
		expect(() => borrow.close()).toThrow(failure as Error);
		expect(m.native.returnOriginalHMeter).toHaveBeenCalledTimes(1);
	});

	it("rejects a late failure without poisoning an already completed return", async () => {
		const m = model();
		const meter = await OriginalHMeter.receive(m.native, m.host, m.selection);
		meter.accept(m.lease);
		const borrow = meter.borrow(m.lease);
		borrow.close();
		expect(() => borrow.fail(undefined)).toThrow("OWNER_H_BORROW_RETURNED");
		await meter.joinBorrow();
		meter.finish();
		expect(m.native.returnOriginalHMeter).toHaveBeenCalledExactlyOnceWith(m.original, false);
		expect(m.native.finishOriginalHMeter).toHaveBeenCalledTimes(1);
	});

	it("does not equate acceptance without any actual consumer join with H_CLOSED", async () => {
		const m = model();
		const meter = await OriginalHMeter.receive(m.native, m.host, m.selection);
		meter.accept(m.lease);
		await expect(meter.joinBorrow()).rejects.toThrow("OWNER_H_CONSUMER_NOT_JOINED");
		expect(() => meter.finish()).toThrow("OWNER_H_CLOSE_PHASE");
		expect(m.native.finishOriginalHMeter).not.toHaveBeenCalled();
	});

	it("preserves the original signal reason during the nonblocking receive wait", async () => {
		const m = model();
		const reason = new Error("ORIGINAL_ABORT_REASON");
		m.native.pollOriginalHMeter.mockImplementationOnce(() => {
			m.controller.abort(reason);
			return undefined;
		});
		await expect(OriginalHMeter.receive(m.native, m.host, m.selection)).rejects.toBe(reason);
		expect(m.native.startOriginalHMeter).toHaveBeenCalledTimes(1);
		expect(m.native.cancelOriginalHMeter).toHaveBeenCalledExactlyOnceWith(m.host);
		expect(files.closed).toEqual([17]);
	});

	it.each(["lf", "duplicate"])("rejects a noncanonical socket packet (%s) before the intent read", async (kind) => {
		const m = model();
		const text = m.packet.toString();
		m.native.pollOriginalHMeter.mockReturnValue(
			Buffer.from(
				kind === "lf"
					? `${text}\n`
					: text.replace('"event":"ORIGINAL_H"', '"event":"ORIGINAL_H","event":"ORIGINAL_H"'),
			),
		);
		await expect(OriginalHMeter.receive(m.native, m.host, m.selection)).rejects.toThrow("OWNER_H_CANONICAL");
		expect(files.closed).toEqual([17]);
		expect(m.native.cancelOriginalHMeter).toHaveBeenCalledTimes(1);
	});

	it("retains undefined start failure before directory-close and native-cancel failures in order", async () => {
		const m = model();
		const directoryClose = new Error("MOCK_DIRECTORY_CLOSE");
		const cancel = new Error("MOCK_CANCEL");
		m.native.startOriginalHMeter.mockImplementation(() => {
			throw undefined;
		});
		m.native.cancelOriginalHMeter.mockImplementation(() => {
			throw cancel;
		});
		files.closeFailure = { descriptor: 17, cause: directoryClose };
		let failure: unknown;
		try {
			await OriginalHMeter.receive(m.native, m.host, m.selection);
		} catch (cause) {
			failure = cause;
		}
		expect(failure).toBeInstanceOf(AggregateError);
		const outer = failure as AggregateError;
		const inner = outer.errors[0] as AggregateError;
		expect(outer.errors).toEqual([inner, cancel]);
		expect(outer.cause).toBe(inner);
		expect(inner.errors).toEqual([undefined, directoryClose]);
		expect(Object.hasOwn(inner, "cause")).toBe(true);
		expect(inner.cause).toBeUndefined();
		expect(files.closed).toEqual([17]);
		expect(m.native.cancelOriginalHMeter).toHaveBeenCalledTimes(1);
	});

	it("cannot accept after the unaccepted cancellation latch, and does not repeat cancellation", async () => {
		const m = model();
		const meter = await OriginalHMeter.receive(m.native, m.host, m.selection);
		meter.cancelUnaccepted();
		meter.cancelUnaccepted();
		expect(() => meter.accept(m.lease)).toThrow("OWNER_H_ACCEPT_ONCE");
		expect(m.native.acceptOriginalHMeter).not.toHaveBeenCalled();
		expect(m.native.cancelOriginalHMeter).toHaveBeenCalledTimes(1);
	});
});
