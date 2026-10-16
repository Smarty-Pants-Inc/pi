/** Startup exit and TUI handoff on a real PTY slave (pi#160 review P1). */
import { createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { startHerdrInputConsumer } from "../../src/core/herdr/bootstrap.ts";
import { receiptRecord } from "../../src/core/turn-receipts.ts";

const [socketPath, paneId, trustRootPath, out, mode] = process.argv.slice(2);
const report: Record<string, unknown> = { rawBefore: process.stdin.isRaw };
setTimeout(() => process.exit(3), 8000).unref();
const bootstrap = await startHerdrInputConsumer(
	{ HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: paneId },
	{ hardened: () => true, trustRoot: () => ({ key: createPublicKey(readFileSync(trustRootPath!)) }) },
);
report.attested = bootstrap?.attestor !== undefined;
report.diagnostic = bootstrap?.diagnostic?.message;
report.rawAfterEnroll = process.stdin.isRaw;
process.on("exit", () => writeFileSync(out!, JSON.stringify({ ...report, rawAtExit: process.stdin.isRaw })));
if (mode === "handoff" && bootstrap?.attestor) {
	bootstrap.handOff();
	const pending = bootstrap.meter.takePending!();
	const end = pending.epochStart + pending.epoch.length;
	report.record = receiptRecord(await bootstrap.attestor.capture(end, { tainted: false, kind: "submit" }));
}
process.exit(0);
