/**
 * Runs on a real PTY slave in raw mode (smarty-dev#2636 F1). Enrolls through Pi's input consumer,
 * waits for the first Enter in epoch bytes, sends that cut and writes the resulting turn record.
 * Usage: node herdr-pty-child.ts SOCKET PANE_ID TRUST_ROOT_PEM|none OUT_JSON
 */
import { createPublicKey, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { EpochByteCounter, type PushResult } from "../../src/core/herdr/epoch-bytes.ts";
import { attestedPrincipal, enrollHerdrInputConsumer, type HerdrEpoch } from "../../src/core/herdr/input-consumer.ts";
import {
	captureKeyboardTurnReceipt,
	captureTerminalSubmitReceipt,
	receiptRecord,
} from "../../src/core/turn-receipts.ts";

const [socketPath, paneId, trustRootPath, out] = process.argv.slice(2);
const token = randomBytes(16).toString("hex");
let preEpoch = "";

function done(result: Record<string, unknown>): never {
	writeFileSync(out!, JSON.stringify({ ...result, preEpoch }));
	process.exit(0);
}

setTimeout(() => done({ record: receiptRecord(captureTerminalSubmitReceipt(token)), reason: "timeout" }), 8000);
process.stdin.setRawMode(true);
const counter = new EpochByteCounter();
counter.hold();
let epoch: HerdrEpoch | undefined;
let submitted = false;

async function submit(end: number): Promise<void> {
	submitted = true;
	const cut = counter.cut(end);
	if (!epoch || !cut) done({ record: receiptRecord(captureTerminalSubmitReceipt(token)), reason: "no-cut" });
	const answer = await epoch.cut({ seq: 1, token, cut: cut.cut, digest: cut.digest, kind: "submit" });
	const principal = attestedPrincipal(answer);
	const receipt = principal
		? captureKeyboardTurnReceipt(principal.smartyId, token, new Date().toISOString())
		: captureTerminalSubmitReceipt(token);
	done({ record: receiptRecord(receipt), reason: answer.reason, cut, token });
}

function handle(result: PushResult): void {
	preEpoch += result.preEpoch.toString("latin1");
	const at = result.epoch.indexOf(0x0d);
	if (at >= 0 && epoch && !submitted) void submit(result.epochStart + at + 1);
}

process.stdin.on("data", (chunk: Buffer) => handle(counter.push(chunk)));
const trustRoot = trustRootPath === "none" ? undefined : createPublicKey(readFileSync(trustRootPath!));
const enrolled = await enrollHerdrInputConsumer({ socketPath: socketPath!, paneId: paneId!, trustRoot });
if (!enrolled.ok) {
	handle(counter.abandon());
	done({ record: receiptRecord(captureTerminalSubmitReceipt(token)), reason: enrolled.reason });
}
epoch = enrolled.epoch;
handle(counter.arm(epoch.nonce));
