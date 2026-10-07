/**
 * Runs Pi's startup enrollment on a real PTY slave, then leaves the way main can (pi#160 review P1).
 * `exit`: like `pi --help`, `--list-models` or a startup error, exit before the TUI takes the input.
 * `handoff`: the TUI takes over, then a submit is attested.
 * Writes the tty mode the process exits with, after the bootstrap's own exit handling.
 * Usage: node herdr-bootstrap-child.ts SOCKET PANE_ID TRUST_ROOT_PEM OUT_JSON exit|handoff
 */
import { createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { startHerdrInputConsumer } from "../../src/core/herdr/bootstrap.ts";
import { receiptRecord } from "../../src/core/turn-receipts.ts";

const [socketPath, paneId, trustRootPath, out, mode] = process.argv.slice(2);
const report: Record<string, unknown> = { rawBefore: process.stdin.isRaw };
setTimeout(() => process.exit(3), 8000).unref();

const bootstrap = await startHerdrInputConsumer(
	{ HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: paneId },
	{ hardened: () => true, trustRoot: () => createPublicKey(readFileSync(trustRootPath!)) },
);
report.attested = bootstrap?.attestor !== undefined;
report.rawAfterEnroll = process.stdin.isRaw;
process.on("exit", () => writeFileSync(out!, JSON.stringify({ ...report, rawAtExit: process.stdin.isRaw })));
if (mode === "handoff" && bootstrap?.attestor) {
	bootstrap.handOff();
	const pending = bootstrap.meter.takePending!();
	const end = pending.epochStart + pending.epoch.length;
	report.record = receiptRecord(await bootstrap.attestor.capture(end, { tainted: false, kind: "submit" }));
}
process.exit(0);
