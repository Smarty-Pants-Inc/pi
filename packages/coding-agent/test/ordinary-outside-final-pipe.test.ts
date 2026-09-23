import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import type {
	OriginalOutsideFinalReceiver,
	OriginalOutsideFinalSelection,
	OriginalOutsideOriginalData,
} from "../src/core/ordinary-sc085-source/outside-final.ts";
import type {
	OriginalOutsideFinalData,
	OriginalOutsideStagedData,
} from "../src/core/ordinary-sc085-source/outside-final-data.ts";

const factory = vi.hoisted(() => vi.fn<(selection: OriginalOutsideFinalSelection) => OriginalOutsideFinalReceiver>());
vi.mock("../src/core/ordinary-sc085-source/outside-final.ts", () => ({ createOperationalOutsideFinal: factory }));

import { serveOperationalOutsideFinal } from "../src/core/ordinary-sc085-source/outside-final-pipe.ts";

// Synthetic transport definitions only. The factory is mocked: no root reads,
// issuer, native admission, qualification or Resource parent ledger is exercised.
// Authored for the source-only successor; execution remains separately held.
afterEach(() => factory.mockReset());

function fixture() {
	const raw = { path: "/fixture/original", sha256: createHash("sha256").update("original").digest("hex") };
	const retained = new Map([[raw.path, Buffer.from("original")]]);
	const original = { authorization: raw } as OriginalOutsideOriginalData;
	const staged = { award: null, refusals: ["OPS_OUTSIDE_BILLING_UNKNOWN"] } as OriginalOutsideStagedData;
	const final = { kind: "original-outside-final-data", award: null } as OriginalOutsideFinalData;
	const receiveStaged = vi.fn(() => structuredClone(staged));
	const receiveFinal = vi.fn(() => structuredClone(final));
	const close = vi.fn();
	const receiver: OriginalOutsideFinalReceiver = {
		original,
		receiveStaged,
		receiveFinal,
		get retained() {
			return new Map(retained);
		},
		failure: () => undefined,
		close,
	};
	factory.mockReturnValue(receiver);
	const output: Buffer[] = [];
	const sink = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			output.push(Buffer.from(chunk));
			callback();
		},
	});
	const selection = {} as OriginalOutsideFinalSelection;
	const run = (chunks: Buffer[], remainingLogBytes = 16 * 1024 * 1024) =>
		serveOperationalOutsideFinal(selection, { input: Readable.from(chunks), output: sink, remainingLogBytes });
	return { raw, retained, original, staged, final, receiveStaged, receiveFinal, close, output, selection, run };
}

const line = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const closeLine = () => line({ operation: "close" });

test("bound exposes original DATA and exact retained bytes; same pipe forwards actual refs and Sense DATA", async () => {
	const f = fixture();
	const offer = { version: 1, kind: "sense-operational-staged", stage: f.raw };
	const refs = {
		call: { path: "/fixture/call", sha256: "a".repeat(64) },
		returned: { path: "/fixture/return", sha256: "b".repeat(64) },
	};
	// This is a forwarding marker, not an executed Sense graph or an award.
	Object.assign(f.final, { sense: { graph: { award: null }, staged: f.raw }, result: { finalRef: f.raw } });
	await f.run([line({ operation: "staged", offer }), line({ operation: "final", refs }), closeLine()]);
	expect(factory).toHaveBeenCalledExactlyOnceWith(f.selection);
	expect(f.receiveStaged).toHaveBeenCalledExactlyOnceWith(offer);
	expect(f.receiveFinal).toHaveBeenCalledExactlyOnceWith(refs);
	expect(f.receiveStaged.mock.invocationCallOrder[0]).toBeLessThan(f.receiveFinal.mock.invocationCallOrder[0]);
	const replies = f.output.map((body) => JSON.parse(body.toString("utf8")));
	expect(replies).toEqual([
		{
			operation: "bound",
			data: f.original,
			records: [{ raw: f.raw, base64: Buffer.from("original").toString("base64") }],
		},
		{ operation: "staged", data: f.staged, records: [] },
		{ operation: "final", data: f.final, records: [] },
		{ operation: "closed", records: [] },
	]);
});

test.each([
	["partial", [Buffer.from('{"operation":')], "OPS_OUTSIDE_PIPE_PARTIAL_OR_MISSING_CLOSE"],
	["missing close", [], "OPS_OUTSIDE_PIPE_PARTIAL_OR_MISSING_CLOSE"],
	["extra same chunk", [Buffer.concat([closeLine(), closeLine()])], "OPS_OUTSIDE_PIPE_EXTRA_MESSAGE"],
	["late chunk", [closeLine(), closeLine()], "OPS_OUTSIDE_PIPE_AFTER_CLOSE"],
] as const)("pipe refuses %s without reconstructing or retrying final", async (_name, chunks, code) => {
	const f = fixture();
	await expect(f.run([...chunks])).rejects.toThrow(code);
	expect(f.receiveFinal).not.toHaveBeenCalled();
	expect(factory).toHaveBeenCalledTimes(1);
	expect(f.close).toHaveBeenCalled();
});

test("record path rebound refuses before a changed byte delta is sent", async () => {
	const f = fixture();
	f.receiveStaged.mockImplementation(() => {
		f.retained.set(f.raw.path, Buffer.from("changed"));
		return f.staged;
	});
	await expect(f.run([line({ operation: "staged", offer: {} })])).rejects.toThrow("OPS_OUTSIDE_PIPE_REBOUND");
	expect(f.output).toHaveLength(1);
	expect(f.receiveFinal).not.toHaveBeenCalled();
});

test("one local remainder debits both directions, not a fresh output allocation", async () => {
	const first = fixture();
	await first.run([closeLine()]);
	const total = closeLine().length + first.output.reduce((sum, body) => sum + body.length, 0);
	const exact = fixture();
	await exact.run([closeLine()], total);
	const short = fixture();
	await expect(short.run([closeLine()], total - 1)).rejects.toThrow("OPS_OUTSIDE_ORIGINAL_LOG_EXHAUSTED");
	// Resource's child-stdout interleaving/shared ledger still needs its own tests.
	expect(short.output.map((body) => JSON.parse(body.toString()).operation)).toEqual(["bound"]);
});

test.each([0, -1, 0.5, 16 * 1024 * 1024 + 1, Number.NaN])(
	"invalid original remainder %s refuses before binding",
	async (remainder) => {
		const f = fixture();
		await expect(f.run([], remainder)).rejects.toThrow("OPS_OUTSIDE_ORIGINAL_LOG_REMAINDER_REQUIRED");
		expect(factory).not.toHaveBeenCalled();
	},
);

test.each([
	"OPS_OUTSIDE_STAGE_ONCE",
	"OPS_OUTSIDE_FINAL_ORDER",
	"OPS_OUTSIDE_ORIGINAL_DEADLINE",
	"OPS_OUTSIDE_FINAL_STAGED_REFUSED",
])("original receiver refusal %s propagates without retry or later final call", async (code) => {
	const f = fixture(),
		failure = new Error(code);
	f.receiveStaged.mockImplementation(() => {
		throw failure;
	});
	await expect(f.run([line({ operation: "staged", offer: {} }), line({ operation: "final", refs: {} })])).rejects.toBe(
		failure,
	);
	expect(f.receiveStaged).toHaveBeenCalledTimes(1);
	expect(f.receiveFinal).not.toHaveBeenCalled();
	expect(f.close).toHaveBeenCalledTimes(1);
});

test("a thrown undefined remains a failed pipe result", async () => {
	const f = fixture();
	f.receiveStaged.mockImplementation(() => {
		throw undefined;
	});
	await expect(f.run([line({ operation: "staged", offer: {} })])).rejects.toBeUndefined();
	expect(f.close).toHaveBeenCalledTimes(1);
});

test("uncertain close cannot emit successful closed DATA", async () => {
	const f = fixture(),
		failure = new Error("synthetic close uncertainty");
	f.close.mockImplementationOnce(() => {
		throw failure;
	});
	await expect(f.run([closeLine()])).rejects.toBe(failure);
	expect(f.output.map((body) => JSON.parse(body.toString()).operation)).toEqual(["bound"]);
});

test("transport and cleanup failures both remain observable", async () => {
	const f = fixture(),
		first = new Error("synthetic stage deadline"),
		closing = new Error("synthetic close failure");
	f.receiveStaged.mockImplementation(() => {
		throw first;
	});
	f.close.mockImplementationOnce(() => {
		throw closing;
	});
	await expect(f.run([line({ operation: "staged", offer: {} })])).rejects.toMatchObject({
		message: "OPS_OUTSIDE_PIPE_CLOSE_UNKNOWN",
		cause: first,
		errors: [first, closing],
	});
});

test("a real Writable callback/error failure is contained, closes once and never retries the response", async () => {
	const f = fixture(),
		failure = new Error("synthetic output failure"),
		writes: Buffer[] = [];
	const output = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			writes.push(Buffer.from(chunk));
			callback(failure);
		},
	});
	await expect(
		serveOperationalOutsideFinal(f.selection, {
			input: Readable.from([line({ operation: "staged", offer: {} }), closeLine()]),
			output,
			remainingLogBytes: 65536,
		}),
	).rejects.toBe(failure);
	expect(writes).toHaveLength(1);
	expect(f.receiveStaged).not.toHaveBeenCalled();
	expect(f.close).toHaveBeenCalledTimes(1);
});

test("a Readable failure preserves its cause and stops before final or a closed reply", async () => {
	const f = fixture(),
		failure = new Error("synthetic input failure");
	const input = new Readable({
		read() {
			this.destroy(failure);
		},
	});
	const replies: Buffer[] = [];
	const output = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			replies.push(Buffer.from(chunk));
			callback();
		},
	});
	await expect(serveOperationalOutsideFinal(f.selection, { input, output, remainingLogBytes: 65536 })).rejects.toBe(
		failure,
	);
	expect(f.receiveFinal).not.toHaveBeenCalled();
	expect(f.close).toHaveBeenCalledTimes(1);
	expect(replies.map((body) => JSON.parse(body.toString()).operation)).toEqual(["bound"]);
});
