/** smarty-dev#2636 decisions 1 and 3: epoch byte cuts and the server trust root. */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EpochByteCounter, epochMarker } from "../src/core/herdr/epoch-bytes.ts";
import { encodeFields, loadServerTrustRoot } from "../src/core/herdr/server-auth.ts";
import {
	captureKeyboardTurnReceipt,
	captureSiblingTerminalTurnReceipt,
	captureTerminalSubmitReceipt,
	receiptRecord,
} from "../src/core/turn-receipts.ts";

const NONCE = "0123456789abcdef";

function armed(): EpochByteCounter {
	const counter = new EpochByteCounter();
	counter.hold();
	counter.arm(NONCE);
	return counter;
}

describe("EpochByteCounter (decision 1 test vector)", () => {
	it("cuts A and B from one read without B entering A's interval", () => {
		const counter = armed();
		const pushed = counter.push(Buffer.concat([epochMarker(NONCE), Buffer.from([0x41, 0x0d, 0x42, 0x0d])]));
		expect(pushed.preEpoch.length).toBe(0);
		expect(pushed.epochStart).toBe(0);
		expect(counter.cut(2)).toEqual({
			cut: 2,
			digest: "d5bb8bd014e448a612372e955d5180bae3fb6d5fc3a1668e754a65c2abc341be",
		});
		expect(counter.cut(4)).toEqual({
			cut: 4,
			digest: "6ffbe7896bc9f2f122ee4cb1ffa75c2cb91a8836479366bce84669ef81c4f925",
		});
	});

	it("finds a marker split byte by byte and keeps pre-marker bytes out of the epoch", () => {
		const counter = new EpochByteCounter();
		counter.hold();
		const stream = Buffer.concat([Buffer.from("x"), epochMarker(NONCE), Buffer.from("A\r")]);
		const pre: number[] = [];
		const epoch: number[] = [];
		for (const byte of stream.subarray(0, 5)) counter.push(Buffer.from([byte]));
		const armedResult = counter.arm(NONCE);
		pre.push(...armedResult.preEpoch);
		for (const byte of stream.subarray(5)) {
			const result = counter.push(Buffer.from([byte]));
			pre.push(...result.preEpoch);
			epoch.push(...result.epoch);
		}
		expect(Buffer.from(pre).toString()).toBe("x");
		expect(Buffer.from(epoch).toString()).toBe("A\r");
		expect(counter.cut(2)?.cut).toBe(2);
	});

	it("refuses stale, empty and future cuts", () => {
		const counter = armed();
		counter.push(Buffer.concat([epochMarker(NONCE), Buffer.from("A\rB\r")]));
		expect(counter.cut(5)).toBeUndefined();
		expect(counter.cut(2)).toBeDefined();
		expect(counter.cut(2)).toBeUndefined();
		expect(counter.cut(1)).toBeUndefined();
	});

	it("delivers held input as ordinary input when enrollment fails, and counts nothing after", () => {
		const counter = new EpochByteCounter();
		counter.hold();
		counter.push(Buffer.from("typed early"));
		expect(counter.abandon().preEpoch.toString()).toBe("typed early");
		expect(counter.push(Buffer.from("later")).preEpoch.toString()).toBe("later");
		expect(counter.active).toBe(false);
		expect(counter.cut(1)).toBeUndefined();
	});

	it("passes input straight through when never enrolled", () => {
		const counter = new EpochByteCounter();
		expect(counter.push(Buffer.from("hi")).preEpoch.toString()).toBe("hi");
	});
});

describe("submit receipt issuers", () => {
	const token = "0123456789abcdef0123456789abcdef";
	const at = "2026-10-07T09:00:00.000Z";

	it("issue keyboard only with a valid principal, Pi token and time", () => {
		expect(receiptRecord(captureKeyboardTurnReceipt("paul", token, at))).toMatchObject({
			channel: "keyboard",
			principal: { id: "paul", binding: "herdr-client" },
			submissionToken: token,
			receivedAt: at,
		});
		expect(() => captureKeyboardTurnReceipt("**Paul (in Herdr):**", token, at)).toThrow();
		expect(() => captureKeyboardTurnReceipt("paul", "not-a-token", at)).toThrow();
		expect(() => captureTerminalSubmitReceipt("x".repeat(32))).toThrow();
	});

	it("never gives a hook-created sibling the keyboard attribution", () => {
		const sibling = receiptRecord(captureSiblingTerminalTurnReceipt(captureKeyboardTurnReceipt("paul", token, at)));
		expect(sibling.channel).toBe("terminal");
		expect(sibling).not.toHaveProperty("principal");
		expect(sibling).not.toHaveProperty("submissionToken");
	});
});

describe("server trust root", () => {
	it("encodes fields with length prefixes so field lists cannot collide", () => {
		expect(encodeFields(["ab", "c"]).equals(encodeFields(["a", "bc"]))).toBe(false);
	});

	it("rejects a key file that a non-root user owns (agents could swap it)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-root-"));
		try {
			const path = join(dir, "server.pub");
			writeFileSync(path, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }));
			expect(loadServerTrustRoot(path)).toBeUndefined();
			expect(loadServerTrustRoot(join(dir, "missing.pub"))).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
