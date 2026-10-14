// smarty-dev#2636: the submit cut is the byte end of the Enter sequence, not of the read.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type InputByteMeter, MeteredInput } from "../src/metered-input.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";

/** A meter whose epoch starts at the first byte (marker already consumed). */
function openMeter(): InputByteMeter & { ended: boolean } {
	let total = 0;
	return {
		ended: false,
		push(chunk) {
			const epochStart = total;
			total += chunk.length;
			return { preEpoch: Buffer.alloc(0), epoch: chunk, epochStart };
		},
		end() {
			this.ended = true;
		},
	};
}

function harness(meter?: InputByteMeter) {
	const parser = new StdinBuffer();
	const input = new MeteredInput((text) => parser.process(text));
	const events: { seq: string; end: number | undefined }[] = [];
	parser.on("data", (seq) => events.push({ seq, end: input.offset }));
	parser.on("paste", (content) => events.push({ seq: `paste:${content}`, end: input.offset }));
	if (meter) input.setMeter(meter);
	return { input, events, parser };
}

describe("MeteredInput", () => {
	it("reports the Enter's own byte end when A, Enter and B arrive in one read", () => {
		const { input, events, parser } = harness(openMeter());
		input.write(Buffer.from("A\rB"));
		parser.destroy();
		assert.deepEqual(events, [
			{ seq: "A", end: 1 },
			{ seq: "\r", end: 2 },
			{ seq: "B", end: 3 },
		]);
	});

	it("counts UTF-8 bytes and reassembles characters split across reads", () => {
		const { input, events, parser } = harness(openMeter());
		for (const byte of Buffer.from("é\r")) input.write(Buffer.from([byte]));
		parser.destroy();
		assert.deepEqual(events, [
			{ seq: "é", end: 2 },
			{ seq: "\r", end: 3 },
		]);
	});

	it("ends a paste at its closing marker byte", () => {
		const { input, events, parser } = harness(openMeter());
		input.write(Buffer.from("\x1b[200~hi\x1b[201~\r"));
		parser.destroy();
		assert.deepEqual(events, [
			{ seq: "paste:hi", end: 14 },
			{ seq: "\r", end: 15 },
		]);
	});

	it("reports no offset without a meter and still decodes split UTF-8", () => {
		const { input, events, parser } = harness();
		for (const byte of Buffer.from("é")) input.write(Buffer.from([byte]));
		parser.destroy();
		assert.deepEqual(events, [{ seq: "é", end: undefined }]);
	});

	// pi#160 review: bytes held from before the marker are in no attested interval.
	it("signals pre-epoch bytes before the parser sees them, and only those", () => {
		const parser = new StdinBuffer();
		const log: string[] = [];
		const input = new MeteredInput((text) => parser.process(text));
		parser.on("data", (seq) => log.push(seq));
		const pending = { preEpoch: Buffer.from("x"), epoch: Buffer.from("hi"), epochStart: 0 };
		input.setMeter({ ...openMeter(), takePending: () => pending }, () => log.push("unmetered"));
		input.write(Buffer.from("\r"));
		parser.destroy();
		assert.deepEqual(log, ["unmetered", "x", "h", "i", "\r"]);
	});

	it("ends the meter and stops reporting offsets when detached", () => {
		const meter = openMeter();
		const { input, events, parser } = harness(meter);
		input.setMeter(undefined);
		input.write(Buffer.from("a"));
		parser.destroy();
		assert.equal(meter.ended, true);
		assert.deepEqual(events, [{ seq: "a", end: undefined }]);
	});
});
